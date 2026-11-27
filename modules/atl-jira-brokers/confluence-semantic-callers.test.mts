// The callers of the semantic seam through the real dispatcher (issue #1020):
// related, search and stitch hand the loaded inventory to the model backend,
// search matches a hit by id first, and related prints a stdout marker when the
// semantic half did not run, so an exact-only list never reads as "none found".
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli as runClaude, type Injected } from "./atl-confluence-ccoder.mts";
import { runCli as runCodex } from "./atl-confluence.mts";
import type { ConfluenceSession, RequestSpec } from "./confluence-contract.mts";
import { reportRelated, type NeighbourDeps } from "./confluence-neighbours.mts";
import { semanticSearch, type Proposals, type SemanticDeps } from "./confluence-semantic.mts";
import type { HttpResponse } from "./confluence-session.mts";
import { stitchCandidates, type StitchDeps } from "./confluence-stitch.mts";
import { claudeEnvelope, fakeChild, fakeGate } from "./semantic-model.fixture.mts";

const ROWS = [
  { id: "900", title: "Acme", parentId: null },
  { id: "1", title: "Rotating the service account credential", parentId: "900" },
  { id: "2", title: "Credential file expired in the nightly job", parentId: "900" },
  { id: "3", title: "Printer setup", parentId: "900" },
];

function session(specs: RequestSpec[], text: unknown[] = []): ConfluenceSession {
  return {
    async request(spec) {
      specs.push(spec);
      if (spec.path.includes("/spaces/")) return { status: 200, json: { results: ROWS, _links: {} } };
      if (spec.path.includes("/search")) return { status: 200, json: { results: spec.path.includes("excerpt=indexed") ? [] : text } };
      return { status: 200, json: { body: { storage: { value: "<p>body</p>" } } } };
    },
  };
}

function modelSemantic(answer: string, seen: SemanticDeps[] = []) {
  const child = fakeChild({ stdout: claudeEnvelope(answer) });
  const semantic = (query: string, limit?: number, options: SemanticDeps = {}) => {
    seen.push(options);
    return semanticSearch(query, limit, {
      ...options, runtime: "claude-code", env: { KHEREP_SEMANTIC_BACKEND: "model", KHEREP_CLAUDE_BIN: path.join(tmpdir(), "c.exe") },
      exists: () => true, gateExec: fakeGate().exec, spawn: child.spawn, trace: () => {},
      tmp: mkdtempSync(path.join(tmpdir(), "kherep-callers-")), workspace: path.join(tmpdir(), "no-workspace"),
    });
  };
  return { semantic, child };
}

function neighbourDeps(log: string[], semantic: NeighbourDeps["semantic"], specs: RequestSpec[] = [], text: unknown[] = []): NeighbourDeps {
  return { session: session(specs, text), spaceId: "42", spaceKey: "KB", log: (l) => log.push(l), logError: (l) => log.push(`error: ${l}`),
    semantic, update: async () => { throw new Error("no write"); } };
}

test("related: the model backend gets the loaded inventory and the space; its ranking becomes the rows", async () => {
  const seen: SemanticDeps[] = [];
  const { semantic, child } = modelSemantic('{"ranked":[2,1]}', seen);
  const log: string[] = [];
  const code = await reportRelated(neighbourDeps(log, semantic), { title: "Credential rotation", topic: "service account credential expired" });
  assert.equal(code, 0);
  assert.equal(seen[0].pool?.pages.byId.size, 4);
  assert.equal(seen[0].spaceKey, "KB");
  assert.equal(child.runs.length, 1);
  assert.deepEqual(log.filter((l) => l.startsWith("related\t")).map((l) => l.split("\t")[1]), ["2", "1"]);
  assert.equal(log.some((l) => l.startsWith("semantic\t")), false, "no marker when the semantic half ran");
});

test("related: a semantic half that did not run prints the marker on stdout, keeps exact hits and exit 0", async () => {
  const log: string[] = [];
  const failing = async (): Promise<Proposals> => ({ titles: [], items: [], error: "semantic search did not run: claude CLI 2.1.289 is older\tthan 2.1.293" });
  const code = await reportRelated(neighbourDeps(log, failing, [], [{ content: { title: ROWS[2].title } }]), { title: "Credential file expired" });
  assert.equal(code, 0);
  const marker = log.findIndex((l) => l.startsWith("semantic\t"));
  assert.equal(log[marker], "semantic\tunavailable\tsemantic search did not run: claude CLI 2.1.289 is older than 2.1.293");
  assert.ok(marker < log.findIndex((l) => l.startsWith("count: ")), "the marker comes before count");
  assert.ok(log.some((l) => l.startsWith("related\t2\t")));
});

test("stitch candidate mode hands the inventory to the model backend", async () => {
  const seen: SemanticDeps[] = [];
  const { semantic } = modelSemantic('{"ranked":[1]}', seen);
  const log: string[] = [];
  const written: string[] = [];
  const deps: StitchDeps = { ...neighbourDeps(log, semantic), now: () => 0, readText: async () => "", writeNew: async (_p, t) => { written.push(t); } };
  const code = await stitchCandidates(deps, { id: "2", topic: "credential expired in the nightly job", out: "r.json" });
  assert.equal(code, 0);
  assert.equal(seen[0].pool?.pages.byId.size, 4);
  assert.equal(written.length, 1);
});

// The command line: search through both entries, with the model backend
// selected and the binary override pointing at a non-existent file (C5) or at
// node itself, which answers --version but no claude or codex verb.
function api(url: string): HttpResponse {
  const json = url.includes("/spaces?keys=") ? { results: [{ id: "42", key: "KB", name: "K" }] }
    : url.includes("/spaces/42/pages") ? { results: ROWS } : url.includes("/rest/api/search") ? { results: [] } : {};
  return { status: 200, ok: true, async json() { return json; }, async text() { return JSON.stringify(json); } };
}

function cli(credEnv: string, env: Record<string, string>) {
  const out: string[] = [], err: string[] = [];
  const injected: Injected = {
    env: { KHEREP_ATL_SITE: "https://wiki.example.com", [credEnv]: "/creds", SystemRoot: process.env.SystemRoot ?? "", ...env },
    readFile: async () => "Client ID: client-id-for-tests\nSecret: secret-for-tests-1234\n",
    fetch: async (url) => (url.startsWith("https://auth.atlassian.com") ? { status: 200, ok: true, async json() { return { access_token: "t", expires_in: 3600 }; }, async text() { return ""; } }
      : url.endsWith("/_edge/tenant_info") ? { status: 200, ok: true, async json() { return { cloudId: "c" }; }, async text() { return ""; } } : api(url)),
    log: (l) => out.push(l), logError: (l) => err.push(l), now: () => 1_000_000,
  };
  return { out, err, injected };
}

test("search through each entry: the Claude entry runs claude, the Codex entry codex; a failure is exit 2, never twg", async () => {
  const twgTrap = path.join(tmpdir(), "no-such-twg.exe");
  const claude = cli("KHEREP_ATL_CRED_FILE_CLAUDE", { KHEREP_SEMANTIC_BACKEND: "model", KHEREP_CLAUDE_BIN: process.execPath, KHEREP_TWG_BIN: twgTrap });
  assert.equal(await runClaude(["search", "--space", "KB", "--query", "credential rotation"], claude.injected), 2);
  assert.match(claude.err.join("\n"), /semantic search did not run: claude exited with code /);
  const codex = cli("KHEREP_ATL_CRED_FILE_CODEX", { KHEREP_SEMANTIC_BACKEND: "model", KHEREP_CODEX_BIN: process.execPath, KHEREP_TWG_BIN: twgTrap });
  assert.equal(await runCodex(["search", "--space", "KB", "--query", "credential rotation"], codex.injected), 2);
  assert.match(codex.err.join("\n"), /semantic search did not run: codex feature list is unreadable/);
  const missing = cli("KHEREP_ATL_CRED_FILE_CLAUDE", { KHEREP_SEMANTIC_BACKEND: "model", KHEREP_CLAUDE_BIN: path.join(tmpdir(), "absent", "claude.exe"), KHEREP_TWG_BIN: twgTrap });
  assert.equal(await runClaude(["search", "--space", "KB", "--query", "credential rotation"], missing.injected), 2);
  assert.match(missing.err.join("\n"), /KHEREP_CLAUDE_BIN is not an absolute path to an existing file/);
  for (const run of [claude, codex, missing]) assert.doesNotMatch(run.err.join("\n"), /twg/);
});

test("search matches a hit by id first, so a renamed page is still found", async () => {
  const run = cli("KHEREP_ATL_CRED_FILE_CLAUDE", {});
  run.injected.semantic = async () => ({ titles: ["Old title"], items: [{ id: "2", title: "Old title", snippet: "" }] });
  assert.equal(await runClaude(["search", "--space", "KB", "--query", "credential"], run.injected), 0);
  assert.ok(run.out.some((l) => l.startsWith("hit\t2\tCredential file expired in the nightly job\t")));
});
