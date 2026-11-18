// Issue #965: session failures, argument guards and unconfirmed outcomes of the Claude Jira broker,
// plus the entry point reached through a linked directory. Route-table fetch, synthetic values only.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "./atl-jira-ccoder.mts";
import { bytes, reply, routed as route, type Route } from "./broker-route.fixture.mts";

const JIRA_ENV = {
  KHEREP_ATL_SITE: "https://jira.example.com",
  KHEREP_ATL_PROJECT_ID: "20202",
  KHEREP_ATL_PROJECT_KEY: "OP",
  KHEREP_ATL_ISSUE_TYPES: JSON.stringify({ Task: "31002", "Sub-task": "31003" }),
  KHEREP_ATL_CRED_FILE_CLAUDE: "synthetic-credential-path",
};
const TOKEN: Route = ["POST", /oauth\/token$/, reply(200, { access_token: "synthetic-token", expires_in: 3600 })];
const TENANT: Route = ["GET", /_edge\/tenant_info$/, reply(200, { cloudId: "synthetic-cloud" })];

async function run(argv: string[], routes: Route[]) {
  const out: string[] = [];
  const err: string[] = [];
  const { calls, fetchImpl } = route(routes, [TOKEN, TENANT]);
  const code = await runCli(argv, {
    env: JIRA_ENV,
    readFile: async () => "Client ID: synthetic-client\nClient Secret: synthetic-secret-1234\n",
    readBytes: async () => Buffer.from("synthetic bytes"),
    fetch: fetchImpl,
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
    stdoutIsTty: () => false,
    writeOut: () => { throw new Error("no bytes expected"); },
  });
  return { code, out, err, calls };
}

const get1 = ["get", "--key", "OP-1"];

test("token and tenant failures name the HTTP status and stop before any Jira call", async () => {
  const cases: [Route, string][] = [
    [["POST", /oauth\/token$/, reply(401, { error: "access_denied" })], "Token-Request fehlgeschlagen: HTTP 401 access_denied"],
    [["POST", /oauth\/token$/, reply(502, "<html>")], "Token-Request fehlgeschlagen: HTTP 502"],
    [["GET", /_edge\/tenant_info$/, reply(503, {})], "tenant_info fehlgeschlagen: HTTP 503"],
    [["GET", /_edge\/tenant_info$/, reply(200, {})], "tenant_info lieferte keine cloudId."],
  ];
  for (const [override, message] of cases) {
    const h = await run(get1, [override]);
    assert.equal(h.code, 1);
    assert.deepEqual(h.err, [message]);
    assert.equal(h.calls.some((call) => call.url.includes("/rest/api/3/")), false);
  }
});

test("an error page that is not JSON is reported by status only", async () => {
  const h = await run(get1, [["GET", /\/issue\/OP-1\?fields=/, reply(502, "<html>bad gateway</html>")]]);
  assert.equal(h.code, 1);
  assert.deepEqual(h.out, ["status: 502"]);
  assert.deepEqual(h.err, []);
});

test("argument guards refuse before any request", async () => {
  const cases: [string[], RegExp][] = [
    [["create", "--type", "Epic", "--summary", "s", "--body", "b"], /^Unbekannter --type\. Erlaubt: Task, Sub-task$/],
    [["create", "--summary", "s", "--assignee", "a".repeat(129)], /hoechstens 128/],
    [["update", "--key", "OP-1", "--assignee", "a".repeat(129)], /hoechstens 128/],
    [["attach", "--key", "OP-1", "--file", "/nowhere/a.md", "--content-type", "not a type"], /--content-type ist kein einfacher Medientyp/],
  ];
  for (const [argv, message] of cases) {
    const h = await run(argv, []);
    assert.equal(h.code, 1, argv.join(" "));
    assert.match(h.err.join("\n"), message);
    assert.equal(h.calls.length, 0, argv.join(" "));
  }
});

test("create with an empty --assignee confirms that nobody is assigned", async () => {
  const h = await run(["create", "--summary", "s", "--assignee", ""], [
    ["POST", /\/issue$/, reply(201, { key: "OP-40" })],
    ["GET", /\/issue\/OP-40\?fields=assignee$/, reply(200, { fields: { assignee: null } })],
  ]);
  assert.equal(h.code, 0, h.err.join("\n"));
  assert.equal(h.out.at(-1), "assignee danach: niemand");
});

test("get prints the state and names unreadable attachment entries", async () => {
  const h = await run(get1, [["GET", /\/issue\/OP-1\?fields=/, reply(200, {
    key: "OP-1", fields: { status: { name: "In Progress" }, attachment: [{ id: "x" }] },
  })]]);
  assert.equal(h.code, 0);
  assert.ok(h.out.includes("state: In Progress"));
  assert.deepEqual(h.err, ["1 Anhang/Anhaenge am Vorgang sind nicht lesbar."]);
});

test("download names a content status other than 200", async () => {
  const meta = { id: "10224", filename: "note.md", mimeType: "text/markdown", size: 4 };
  const h = await run(["download", "--key", "OP-9", "--id", "10224"], [
    ["GET", /\?fields=attachment$/, reply(200, { fields: { attachment: [meta] } })],
    ["GET", /\/attachment\/content\/10224/, reply(404, {})],
  ]);
  assert.equal(h.code, 1);
  assert.deepEqual(h.err, ["Download fehlgeschlagen: HTTP 404"]);
});

const transitionTo = ["transition", "--key", "OP-7", "--to", "indeterminate"];
const listing = (transitions: unknown): Route => ["GET", /\/issue\/OP-7\/transitions$/, reply(200, transitions === undefined ? {} : { transitions })];
const START = { id: "21", to: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } } };

test("transition refuses a missing, an ambiguous and an unverifiable target before writing", async () => {
  const cases: [Route, RegExp][] = [
    [listing(undefined), /^Statuskategorie "indeterminate" nicht verfuegbar\.$/],
    [listing([START, { ...START, id: "22", to: { ...START.to, id: "5", name: "Review" } }]), /trifft mehrere Uebergaenge: 21 In Progress, 22 Review/],
    [listing([{ id: "21", to: { statusCategory: { key: "indeterminate" } } }]), /^Zielstatus hat keine verifizierbare Status-ID\.$/],
  ];
  for (const [route_, message] of cases) {
    const h = await run(transitionTo, [route_]);
    assert.equal(h.code, 1);
    assert.match(h.err.join("\n"), message);
    assert.equal(h.calls.some((call) => call.method === "POST" && call.url.endsWith("/transitions")), false);
  }
});

test("transition reports a refused write, an unreadable readback and a wrong target", async () => {
  const refused = await run(transitionTo, [listing([START]), ["POST", /\/transitions$/, reply(409, { errorMessages: ["conflict"] })]]);
  assert.deepEqual([refused.code, refused.err], [1, ["errorMessage: conflict"]]);

  const unread = await run(transitionTo, [listing([START]), ["POST", /\/transitions$/, reply(204)], ["GET", /\?fields=status$/, reply(500, {})]]);
  assert.deepEqual([unread.code, unread.err], [1, ["Readback nach dem Statuswechsel fehlgeschlagen."]]);

  const wrong = await run(transitionTo, [listing([START]), ["POST", /\/transitions$/, reply(204)],
    ["GET", /\?fields=status$/, reply(200, { fields: { status: { name: "Elsewhere" } } })]]);
  assert.deepEqual([wrong.code, wrong.err], [1, ["Readback bestaetigt den Zielstatus nicht: erwartet Status-ID 3, gelesen keine."]]);
});

test("unlink reports a refused delete and reads nothing back", async () => {
  const type = { id: "1000", name: "Duplicate", inward: "is duplicated by", outward: "duplicates" };
  const h = await run(["unlink", "--type", "Duplicate", "--outward", "OP-8", "--inward", "OP-9"], [
    ["GET", /\/issueLinkType$/, reply(200, { issueLinkTypes: [type] })],
    ["GET", /\/issue\/OP-8\?fields=issuelinks$/, reply(200, { fields: { issuelinks: [{ id: "10501", type, inwardIssue: { key: "OP-9" } }] } })],
    ["DELETE", /\/issueLink\/10501$/, reply(403, { errorMessages: ["not allowed"] })],
  ]);
  assert.equal(h.code, 1);
  assert.deepEqual(h.err, ["errorMessage: not allowed"]);
  assert.equal(h.calls.filter((call) => call.url.includes("fields=issuelinks")).length, 1);
});

test("refused writes and searches exit 1 with the site's messages", async () => {
  const update = await run(["update", "--key", "OP-2", "--summary", "neu"], [["PUT", /\/issue\/OP-2$/, reply(400, { errorMessages: ["no"] })]]);
  assert.deepEqual([update.code, update.out, update.err], [1, ["status: 400"], ["errorMessage: no"]]);
  const search = await run(["search", "--jql", "project = OP"], [["GET", /\/search\/jql\?/, reply(400, { errorMessages: ["jql invalid"] })]]);
  assert.deepEqual([search.code, search.out, search.err], [1, ["status: 400"], ["errorMessage: jql invalid"]]);
});

test("a blank download id is refused before any request", async () => {
  const h = await run(["download", "--key", "OP-9", "--id", "  "], []);
  assert.deepEqual([h.code, h.err, h.calls.length], [1, ["--id fehlt."], 0]);
});

test("download names unreadable list entries and still delivers the readable one", async () => {
  const meta = { id: "10224", filename: "note.md", mimeType: "text/markdown", size: 6 };
  const written: Buffer[] = [];
  const { fetchImpl } = route([
    ["GET", /\?fields=attachment$/, reply(200, { fields: { attachment: [{ id: "x" }, meta] } })],
    ["GET", /\/attachment\/content\/10224/, bytes(200, Buffer.from("# Note"))],
  ], [TOKEN, TENANT]);
  const err: string[] = [];
  const code = await runCli(["download", "--key", "OP-9", "--id", "10224"], {
    env: JIRA_ENV, readFile: async () => "Client ID: synthetic-client\nClient Secret: synthetic-secret-1234\n",
    fetch: fetchImpl, log: () => undefined, logError: (line) => err.push(line), stdoutIsTty: () => false,
    writeOut: (chunk) => { written.push(chunk); },
  });
  assert.equal(code, 0, err.join("\n"));
  assert.deepEqual(err, ["1 Anhang/Anhaenge am Vorgang sind nicht lesbar."]);
  assert.equal(Buffer.concat(written).toString("utf8"), "# Note");
});

test("ambiguous transitions without a target name are listed with a placeholder", async () => {
  const h = await run(transitionTo, [listing([{ id: "21", to: { id: "3", statusCategory: { key: "indeterminate" } } },
    { id: "22", to: { id: "5", statusCategory: { key: "indeterminate" } } }])]);
  assert.equal(h.code, 1);
  assert.match(h.err.join("\n"), /trifft mehrere Uebergaenge: 21 \?, 22 \?/);
});

test("a Sub-task readback without a parent is refused", async () => {
  const h = await run(["create", "--type", "Sub-task", "--parent", "OP-1", "--summary", "s"], [
    ["POST", /\/issue$/, reply(201, { key: "OP-41" })],
    ["GET", /\/issue\/OP-41\?fields=parent$/, reply(200, { fields: {} })],
  ]);
  assert.deepEqual([h.code, h.err], [1, ["Readback bestätigt den Elternvorgang nicht: erwartet OP-1, gelesen keinen."]]);
});

test("search prints the next page token and the site's warnings", async () => {
  const h = await run(["search", "--jql", "project = OP"], [["GET", /\/search\/jql\?/, reply(200, {
    issues: [], isLast: false, nextPageToken: "synthetic-next", warnings: ["field ignored"],
  })]]);
  assert.equal(h.code, 0);
  assert.ok(h.out.includes("nextPageToken: synthetic-next"));
  assert.ok(h.out.includes("warning: field ignored"));
});

test("the broker started through a linked directory still runs as the entry point", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "atl-jira-ccoder-link-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const linked = path.join(home, "brokers");
  fs.symlinkSync(import.meta.dirname, linked, "junction");
  const proc = spawnSync(process.execPath, [path.join(linked, "atl-jira-ccoder.mts"), "help"], {
    encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /selftest/);
});
