// Issue #965: the refusal and error branches of the Claude Jira broker, driven through runCli with an
// injected fetch and captured log lines. Every request is answered by a route table; credentials are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { runCli, type BrokerContext } from "./atl-jira-ccoder.mts";
import { reply, routed as route, type Route } from "./broker-route.fixture.mts";

const SEED_ENV = {
  KHEREP_ATL_SITE: "https://jira.example.com",
  KHEREP_ATL_PROJECT_KEY: "OP",
  KHEREP_ATL_CRED_FILE_CLAUDE: "synthetic-credential-path",
};
const JIRA_ENV = { ...SEED_ENV, KHEREP_ATL_PROJECT_ID: "20202", KHEREP_ATL_ISSUE_TYPES: JSON.stringify({ Task: "31002", "Sub-task": "31003" }) };
const CREDENTIAL = "Client ID: synthetic-client\nClient Secret: synthetic-secret-1234\n";

function run(routes: Route[], options: { env?: Record<string, string | undefined>; files?: Record<string, string> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const { calls, fetchImpl } = route(routes, [
    ["POST", /oauth\/token$/, reply(200, { access_token: "synthetic-token", expires_in: 3600 })],
    ["GET", /_edge\/tenant_info$/, reply(200, { cloudId: "synthetic-cloud" })],
  ]);
  const files: Record<string, string> = { "synthetic-credential-path": CREDENTIAL, ...options.files };
  const injected: Partial<BrokerContext> = {
    env: options.env ?? JIRA_ENV,
    readFile: async (file: string) => {
      if (!(file in files)) throw new Error("ENOENT synthetic");
      return files[file];
    },
    readBytes: async () => Buffer.from("synthetic bytes"),
    fetch: fetchImpl,
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
    stdoutIsTty: () => false,
    writeOut: () => { throw new Error("no bytes expected"); },
  };
  return { out, err, calls, cli: (argv: string[]) => runCli(argv, injected) };
}

test("an unreadable credential file is refused without naming the path", async () => {
  const h = run([], { files: {}, env: { ...JIRA_ENV, KHEREP_ATL_CRED_FILE_CLAUDE: "missing-credential" } });
  assert.equal(await h.cli(["get", "--key", "OP-1"]), 1);
  assert.deepEqual(h.err, ["Credentials-Datei nicht lesbar."]);
  assert.equal(h.calls.length, 0);
});

test("a host with only site and project key discovers the binding before the verb runs", async () => {
  const h = run([
    ["GET", /\/project\/search\?keys=OP$/, reply(200, { values: [{ key: "OP", id: "10111" }] })],
    ["GET", /\/issue\/createmeta\/OP\/issuetypes$/, reply(200, { issueTypes: [{ id: "10002", name: "Task" }] })],
    ["GET", /\/issue\/OP-1\?fields=/, reply(200, { key: "OP-1", fields: { summary: "s" } })],
  ], { env: SEED_ENV });
  assert.equal(await h.cli(["get", "--key", "OP-1"]), 0, h.err.join("\n"));
  assert.ok(h.out.includes("summary: s"));
  // One run, one token and one tenant_info: discovery shares the session cache with the verb.
  assert.equal(h.calls.filter((call) => call.url.includes("oauth/token")).length, 1);
});

test("a refused project discovery stops before the verb runs", async () => {
  const h = run([["GET", /\/project\/search\?keys=OP$/, reply(403, {})]], { env: SEED_ENV });
  assert.equal(await h.cli(["get", "--key", "OP-1"]), 1);
  assert.deepEqual(h.err, ["Projektauflösung fehlgeschlagen: HTTP 403"]);
  assert.equal(h.calls.some((call) => call.url.includes("/issue/OP-1")), false);
});

test("--body-file is read through the injected reader and an unreadable one is refused unnamed", async () => {
  const h = run([["POST", /\/issue\/OP-2\/comment$/, reply(201, { id: "77" })]], { files: { "synthetic-body.md": "Text aus Datei" } });
  assert.equal(await h.cli(["comment", "--key", "OP-2", "--body-file", "synthetic-body.md"]), 0);
  const sent = JSON.parse(h.calls.find((call) => call.method === "POST" && call.url.endsWith("/comment"))?.body ?? "{}");
  assert.match(JSON.stringify(sent.body), /Text aus Datei/);

  const missing = run([]);
  assert.equal(await missing.cli(["comment", "--key", "OP-2", "--body-file", "synthetic-missing.md"]), 1);
  assert.deepEqual(missing.err, ["--body-file nicht lesbar."]);
  assert.equal(missing.calls.length, 0);
});

test("field errors of a refused write are reported per field", async () => {
  const h = run([["POST", /\/issue$/, reply(400, { errorMessages: ["bad"], errors: { summary: "too long" } })]]);
  assert.equal(await h.cli(["create", "--summary", "x", "--body", "y"]), 1);
  assert.deepEqual(h.err, ["errorMessage: bad", "error summary: too long"]);
});

test("a Sub-task create fails when its readback does not load or shows another assignee", async () => {
  const created: Route = ["POST", /\/issue$/, reply(201, { key: "OP-20" })];
  const argv = ["create", "--type", "Sub-task", "--parent", "OP-1", "--summary", "x", "--body", "y", "--assignee", "acc-1"];

  const unread = run([created, ["GET", /\/issue\/OP-20\?fields=/, reply(500, {})]]);
  assert.equal(await unread.cli(argv), 1);
  assert.deepEqual(unread.err, ["Readback nach dem Create fehlgeschlagen."]);

  const other = run([created, ["GET", /\/issue\/OP-20\?fields=/, reply(200, {
    fields: { parent: { key: "OP-1" }, assignee: { accountId: "acc-2" } },
  })]]);
  assert.equal(await other.cli(argv), 1);
  assert.equal(other.err.length, 1);
  assert.match(other.err[0], /acc-1/);
});

test("update fails when the readback after the write does not load", async () => {
  const h = run([
    ["PUT", /\/issue\/OP-3$/, reply(204)],
    ["GET", /\/issue\/OP-3\?fields=/, reply(502, {})],
  ]);
  assert.equal(await h.cli(["update", "--key", "OP-3", "--summary", "neu"]), 1);
  assert.deepEqual(h.err, ["Readback nach dem Update fehlgeschlagen."]);
  assert.ok(h.out.includes("summary danach: unlesbar"));
});

test("attach fails when the readback after an accepted upload does not load", async () => {
  const h = run([
    ["POST", /\/issue\/OP-4\/attachments$/, reply(200, [{ id: "1", filename: "a.md" }])],
    ["GET", /\/issue\/OP-4\?fields=attachment$/, reply(503, {})],
  ]);
  assert.equal(await h.cli(["attach", "--key", "OP-4", "--file", "/nowhere/a.md"]), 1);
  assert.deepEqual(h.err, ["Readback nach dem Upload fehlgeschlagen."]);
});

test("get prints the creator identity it read", async () => {
  const h = run([["GET", /\/issue\/OP-5\?fields=/, reply(200, {
    key: "OP-5", fields: { creator: { accountType: "app", displayName: "Synthetic App" } },
  })]]);
  assert.equal(await h.cli(["get", "--key", "OP-5"]), 0);
  assert.ok(h.out.includes("creator.accountType: app"));
  assert.ok(h.out.includes("creator.displayName: Synthetic App"));
});

test("transition reports an unreadable transition list and writes nothing", async () => {
  const h = run([["GET", /\/issue\/OP-6\/transitions$/, reply(403, { errorMessages: ["no browse"] })]]);
  assert.equal(await h.cli(["transition", "--key", "OP-6", "--to", "indeterminate"]), 1);
  assert.ok(h.out.includes("status: 403"));
  assert.deepEqual(h.err, ["errorMessage: no browse"]);
  assert.equal(h.calls.some((call) => call.method === "POST" && call.url.endsWith("/transitions")), false);
});

test("unlink refuses when the links of the work item cannot be read", async () => {
  const h = run([
    ["GET", /\/issueLinkType$/, reply(200, { issueLinkTypes: [{ id: "1000", name: "Duplicate", inward: "is duplicated by", outward: "duplicates" }] })],
    ["GET", /\/issue\/OP-8\?fields=issuelinks$/, reply(500, { errorMessages: ["down"] })],
  ]);
  assert.equal(await h.cli(["unlink", "--type", "Duplicate", "--outward", "OP-8", "--inward", "OP-9"]), 1);
  assert.deepEqual(h.err, ["errorMessage: down", "Verknüpfungen des Vorgangs sind nicht lesbar."]);
  assert.equal(h.calls.some((call) => call.method === "DELETE"), false);
});

const BROKER = path.join(import.meta.dirname, "atl-jira-ccoder.mts");

test("the broker run as a process prints help and exits 0", () => {
  const proc = spawnSync(process.execPath, [BROKER, "help"], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "" } });
  assert.equal(proc.status, 0);
  assert.match(proc.stdout, /download/);
});

test("the broker run as a process sets exit code 1 on a refused call", () => {
  const proc = spawnSync(process.execPath, [BROKER, "nonsense"], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "" } });
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /Nutzung:/);
});

test("imported without its own script path the module stays a library and prints nothing", () => {
  // No script path at all, and one that does not exist: neither may run the entry point.
  for (const argv of [[], [path.join(os.tmpdir(), `kherep-absent-${process.pid}`, "entry.mts")]]) {
    const proc = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(BROKER)});`, ...argv], {
      encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "" },
    });
    assert.equal(proc.status, 0);
    assert.equal(proc.stdout, "");
  }
});
