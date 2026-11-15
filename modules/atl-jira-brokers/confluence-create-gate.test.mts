// #760 contract A: Claude broker create is observation-only, gated before any
// network call. The Codex broker keeps generic create. Synthetic values only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli as claude, type Injected } from "./atl-confluence-ccoder.mts";
import { runCli as codex } from "./atl-confluence.mts";
import type { HttpResponse } from "./confluence-session.mts";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const CRED = "/nowhere/credentials-for-tests";
const FILE = "C:/assigned/body 'quoted'.xml";
const LABELS = "type-observation,evidence-assumed,status-author-model";
const BODY = '<p>Finding: It\'s "short", ‘quoted’ and “exact”.</p>\n<p>Origin: synthetic turn.</p>\n'
  + "<p>Source: fixture.</p>\n<p>Timestamp: now.</p>\n";
const PAGE = { id: "5001", title: "T", status: "current", spaceId: "9001", authorId: "svc", version: { number: 1 } };

const response = (status: number, body: unknown): HttpResponse => ({
  status, ok: status < 300, async json() { return body; }, async text() { return JSON.stringify(body); },
});

function harness(bytes: Uint8Array, env: Record<string, string>) {
  let reads = 0, byteReads = 0;
  const posts: string[] = [], fetches: string[] = [], err: string[] = [], out: string[] = [];
  const injected: Injected = {
    env: { KHEREP_ATL_SITE: "https://wiki.example.com", ...env },
    // Serves the body on both read paths, so a refusal can never come from an unreadable file.
    async readFile(file) {
      if (file === FILE) { reads++; return Buffer.from(bytes).toString("utf8"); }
      if (file !== CRED) throw Error("no such file"); return "Client ID: id\nSecret: secret-1234\n";
    },
    async readBodyBytes(file) { assert.equal(file, FILE); reads++; byteReads++; return bytes; },
    async fetch(url, options) {
      fetches.push(url);
      if (url.startsWith("https://auth.atlassian.com")) return response(200, { access_token: "t", expires_in: 3600 });
      if (url.endsWith("/_edge/tenant_info")) return response(200, { cloudId: "c" });
      if (url.includes("/spaces?keys=")) return response(200, { results: [{ id: "9001", key: "KB" }] });
      if (options?.method === "POST" && url.endsWith("/wiki/api/v2/pages")) { posts.push(String(options.body)); return response(200, PAGE); }
      if (url.includes("/labels")) return response(200, { results: LABELS.split(",").map(name => ({ name })) });
      return response(200, PAGE);
    },
    log: line => { out.push(line); }, logError: line => { err.push(line); }, now: () => 1_000_000,
  };
  return { injected, posts, fetches, err, out, reads: () => ({ reads, byteReads }) };
}
const claudeHarness = (bytes: Uint8Array) => harness(bytes, { KHEREP_ATL_CRED_FILE_CLAUDE: CRED });
const create = (extra: string[], labels: string | null = LABELS, format = "storage") => ["create", "--space", "KB", "--title", "T",
  "--format", format, ...(labels === null ? [] : ["--labels", labels]), ...extra];

test("Claude create refuses an inline --body with exit 1 and zero fetch calls", async () => {
  const h = claudeHarness(Buffer.from(BODY));
  assert.equal(await claude(create(["--body", BODY]), h.injected), 1);
  assert.deepEqual(h.fetches, []);
  assert.match(h.err.join("\n"), /create does not take --body/);
});

test("Claude create refuses a 'Test body.' file with valid labels and sends no POST", async () => {
  const h = claudeHarness(Buffer.from("Test body."));
  assert.equal(await claude(create(["--body-file", FILE]), h.injected), 1);
  assert.deepEqual(h.fetches, []);
  assert.deepEqual(h.posts, []);
  assert.ok(!h.err.join("\n").includes("Test body."), "content must not be echoed");
});

test("Claude create refuses missing, non-observation and double-evidence labels before any request", async () => {
  for (const labels of [null, "evidence-assumed,status-author-model", LABELS + ",evidence-confirmed"]) {
    const h = claudeHarness(Buffer.from(BODY));
    assert.equal(await claude(create(["--body-file", FILE], labels), h.injected), 1, String(labels));
    assert.deepEqual(h.fetches, [], String(labels));
  }
});

test("Claude create refuses --format wiki and adf before any network call", async () => {
  for (const format of ["wiki", "adf"]) {
    const h = claudeHarness(Buffer.from(BODY));
    assert.equal(await claude(create(["--body-file", FILE], LABELS, format), h.injected), 1, format);
    assert.deepEqual(h.fetches, [], format);
    assert.match(h.err.join("\n"), /--format storage/);
  }
});

test("Claude create sends a valid observation in exactly one POST with identical bytes, reading the file once", async () => {
  const bytes = Buffer.from(BODY), h = claudeHarness(bytes);
  assert.equal(await claude(create(["--body-file", FILE]), h.injected), 0, h.err.join("\n"));
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.reads(), { reads: 1, byteReads: 1 }, "one read, through the byte reader the validator hashes");
  assert.deepEqual(Buffer.from(JSON.parse(h.posts[0]).body.value), bytes);
});

test("Claude help lists labels and body-file as required for create", async () => {
  const h = claudeHarness(Buffer.from(BODY));
  assert.equal(await claude(["help"], h.injected), 0);
  assert.ok(h.out.includes("  create --space <key> --title <title> --format <storage> --body-file <path> --labels <a,b> [--parent <id>]"),
    h.out.join("\n"));
});

test("the Codex CLI's generic create still works with an inline wiki body and no labels", async () => {
  const h = harness(Buffer.from(BODY), { KHEREP_ATL_CRED_FILE_CODEX: CRED });
  assert.equal(await codex(create(["--body", "plain"], null, "wiki"), h.injected), 0, h.err.join("\n"));
  assert.equal(h.posts.length, 1);
  assert.equal(JSON.parse(h.posts[0]).body.value, "plain");
});

test("texts state the create gate instead of a missing one", () => {
  const read = (...parts: string[]) => fs.readFileSync(path.join(REPO, ...parts), "utf8");
  for (const parts of [["claude", "agents", "claude-obs.md"], ["claude", "teams", "kherep", "ROUTING.md"], ["codex", "ROUTING.md"],
    ["modules", "atl-jira-brokers", "README.md"]]) {
    const text = read(...parts);
    assert.doesNotMatch(text, /mechanical gate (is )?missing|Generic broker create remains available|generic create does not enforce/i, parts.join("/"));
    assert.match(text, /create is observation-only/i, parts.join("/"));
  }
  assert.match(read("claude", "agents", "atlassian-broker.md"), /`create` nur fuer Beobachtungen/);
});

test("the create gate reads a real body file through the default byte reader", async () => {
  const { observationCreateBody } = await import("./confluence-observation-validate.mts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-760-gate-"));
  try {
    const file = path.join(dir, "body.xml");
    fs.writeFileSync(file, BODY);
    const fail = (message: string): never => { throw new Error(message); };
    assert.equal(await observationCreateBody({}, { format: "storage", "body-file": file, labels: LABELS }, fail), BODY);
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00]));
    await assert.rejects(observationCreateBody({}, { format: "storage", "body-file": file, labels: LABELS }, fail), /Body is not valid UTF-8\./);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
