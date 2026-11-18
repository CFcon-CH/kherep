// Issue #965: argument guards, unconfirmed readbacks and selftest verdicts of the Codex Jira broker,
// plus the entry point reached through a linked directory. Route-table fetch, synthetic values only.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli, type BrokerDeps, type FetchLike } from "./atl-jira.mts";
import { reply, routed as route, sequence, type Route } from "./broker-route.fixture.mts";

const JIRA_ENV = {
  KHEREP_ATL_SITE: "https://jira.example.com",
  KHEREP_ATL_PROJECT_ID: "20202",
  KHEREP_ATL_PROJECT_KEY: "OP",
  KHEREP_ATL_ISSUE_TYPES: JSON.stringify({ Task: "31002", "Sub-task": "31003" }),
  KHEREP_ATL_CRED_FILE_CODEX: "synthetic-credential-path",
};
const routed = (routes: Route[]) => route(routes, [
  ["POST", /oauth\/token$/, reply(200, { access_token: "synthetic-token" })],
  ["GET", /_edge\/tenant_info$/, reply(200, { cloudId: "synthetic-cloud" })],
]);

function deps(fetchImpl: FetchLike, secret = "synthetic-secret-1234"): Partial<BrokerDeps> {
  return {
    env: JIRA_ENV,
    readFile: async () => `Client ID: synthetic-client\nClient Secret: ${secret}\n`,
    readBytes: async () => Buffer.from("synthetic bytes"),
    stdoutIsTty: () => false,
    fetch: fetchImpl,
  };
}

test("argument guards refuse before any credential read or request", async () => {
  const cases: [string[], RegExp][] = [
    [["create", "--type", "Epic", "--summary", "s", "--body", "b"], /^Unbekannter --type\. Erlaubt: Task, Sub-task\.$/],
    [["create", "--summary", "s", "--body", "b", "--assignee", "a".repeat(129)], /hoechstens 128/],
    [["create", "--summary", "s", "--body", "b", "--parent", "OP-1"], /^--parent ist nur für Sub-task erlaubt\.$/],
    [["update", "--key", "OP-1", "--assignee", "a".repeat(129)], /hoechstens 128/],
    [["attach", "--key", "OP-1", "--file", "/nowhere/a.md", "--content-type", "not a type"], /--content-type ist kein einfacher Medientyp/],
  ];
  for (const [argv, message] of cases) {
    const { calls, fetchImpl } = routed([]);
    const result = await runCli(argv, deps(fetchImpl));
    assert.equal(result.exitCode, 1, argv.join(" "));
    assert.match(String(result.output.error), message);
    assert.equal(calls.length, 0, argv.join(" "));
  }
});

test("selftest refuses a secret too short to tamper with, after one token request", async () => {
  const { calls, fetchImpl } = routed([]);
  const result = await runCli(["selftest"], deps(fetchImpl, "abc"));
  assert.deepEqual(result.output, { status: 0, error: "Client Secret ist zu kurz für den Kontroll-Lauf." });
  assert.equal(calls.length, 1);
});

test("selftest tampers a secret ending in X and reports FAIL when only the real one is refused", async () => {
  const sent: string[] = [];
  const { fetchImpl } = routed([["POST", /oauth\/token$/, sequence(reply(500, { error: "server_error" }), reply(401, { error: "access_denied" }))]]);
  const recording: FetchLike = async (url, options) => {
    if (options?.body) sent.push(JSON.parse(options.body.toString("utf8")).client_secret);
    return fetchImpl(url, options);
  };
  const result = await runCli(["selftest"], deps(recording, "synthetic-secretXXXX"));
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.verdict, "FAIL");
  assert.deepEqual(sent, ["synthetic-secretXXXX", "synthetic-secretYYYY"]);
});

test("selftest fails when the identity behind the token is not an app", async () => {
  const { fetchImpl } = routed([
    ["POST", /oauth\/token$/, sequence(reply(200, { access_token: "synthetic-token" }), reply(401, { error: "access_denied" }))],
    ["GET", /\/myself$/, reply(200, { accountType: "atlassian", displayName: "Person" })],
  ]);
  const result = await runCli(["selftest"], deps(fetchImpl));
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.verdict, "FAIL");
  assert.deepEqual(result.output.myself, { status: 200, accountType: "atlassian", displayName: "Person" });
});

test("create fails on a readback without the parent and on a creator that is not an app", async () => {
  const subtask = ["create", "--type", "Sub-task", "--parent", "OP-1", "--summary", "s", "--body", "b"];
  const noParent = routed([["POST", /\/issue$/, reply(201, { key: "OP-30" })],
    ["GET", /\/issue\/OP-30\?fields=creator,parent$/, reply(200, { key: "OP-30", fields: { creator: { accountType: "app" } } })]]);
  const missing = await runCli(subtask, deps(noParent.fetchImpl));
  assert.equal(missing.output.error, "Readback bestätigt den Elternvorgang nicht: erwartet OP-1, gelesen keinen.");

  const human = routed([["POST", /\/issue$/, reply(201, { key: "OP-31" })],
    ["GET", /\/issue\/OP-31\?fields=creator$/, reply(200, { key: "OP-31", fields: { creator: { accountType: "atlassian" } } })]]);
  const notApp = await runCli(["create", "--summary", "s", "--body", "b"], deps(human.fetchImpl));
  assert.equal(notApp.exitCode, 1);
  assert.equal(notApp.output.error, "Create-Readback hat keinen App-Creator bestätigt.");
});

test("update writes a new body as ADF and accepts the confirmed readback", async () => {
  const { calls, fetchImpl } = routed([["PUT", /\/issue\/OP-2$/, reply(204)], ["GET", /\/issue\/OP-2\?fields=/, reply(200, { fields: {} })]]);
  const result = await runCli(["update", "--key", "OP-2", "--body", "# Titel"], deps(fetchImpl));
  assert.equal(result.exitCode, 0);
  const put = calls.find((call) => call.method === "PUT");
  assert.equal(JSON.parse(put?.body ?? "{}").fields.description.type, "doc");
});

test("comment fails when the readback author is not an app", async () => {
  const { fetchImpl } = routed([["POST", /\/issue\/OP-3\/comment$/, reply(201, { id: 9 })],
    ["GET", /\/comment\/9$/, reply(200, { id: "9", author: { accountType: "atlassian" } })]]);
  const result = await runCli(["comment", "--key", "OP-3", "--body", "x"], deps(fetchImpl));
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.error, "Comment-Readback hat keinen App-Autor bestätigt.");
});

test("attach refuses an upload answer that is not a list of attachments", async () => {
  const { fetchImpl } = routed([["POST", /\/attachments$/, reply(200, { id: "1" })]]);
  const result = await runCli(["attach", "--key", "OP-4", "--file", "/nowhere/a.md"], deps(fetchImpl));
  assert.deepEqual(result.output, { status: 200, issueKey: "OP-4", error: "Die Upload-Antwort ist keine Anhangsliste." });
});

test("download reports a content status other than 200 without bytes", async () => {
  const meta = { id: "10224", filename: "note.md", mimeType: "text/markdown", size: 4 };
  const { fetchImpl } = routed([["GET", /\?fields=attachment$/, reply(200, { fields: { attachment: [meta] } })],
    ["GET", /\/attachment\/content\/10224/, reply(404, {})]]);
  const result = await runCli(["download", "--key", "OP-9", "--id", "10224"], deps(fetchImpl));
  assert.deepEqual(result.output, { status: 404, attachmentId: "10224", error: "Download fehlgeschlagen." });
});

test("get reports unreadable attachment entries and search passes the site's warnings on", async () => {
  const get = routed([["GET", /\/issue\/OP-5\?fields=/, reply(200, {
    key: "OP-5", fields: { status: { name: "In Progress" }, attachment: [{ id: "x" }] },
  })]]);
  const read = await runCli(["get", "--key", "OP-5"], deps(get.fetchImpl));
  assert.equal(read.exitCode, 0);
  assert.equal(read.output.state, "In Progress");
  assert.equal(read.output.attachmentsError, "1 Anhang/Anhaenge am Vorgang sind nicht lesbar.");
  assert.equal("summary" in read.output, false);

  const search = routed([["GET", /\/search\/jql\?/, reply(200, { issues: [], isLast: true, warnings: ["field ignored"] })]]);
  const found = await runCli(["search", "--jql", "project = OP"], deps(search.fetchImpl));
  assert.deepEqual(found.output.warnings, ["field ignored"]);
});

test("transition names no statuses when the site lists no transitions, and refuses a wrong readback", async () => {
  const argv = ["transition", "--key", "OP-7", "--to", "indeterminate"];
  const empty = routed([["GET", /\/transitions$/, reply(200, {})]]);
  const none = await runCli(argv, deps(empty.fetchImpl));
  assert.deepEqual(none.output, { status: 200, issueKey: "OP-7", error: "Zielstatus ist nicht verfügbar.", availableStatusNames: [] });

  const moved = routed([
    ["GET", /\/transitions$/, reply(200, { transitions: [{ id: "21", to: { id: "3", statusCategory: { key: "indeterminate" } } }] })],
    ["POST", /\/transitions$/, reply(204)],
    ["GET", /\?fields=status$/, reply(200, { fields: { status: { id: "4", name: "Elsewhere" } } })],
  ]);
  const wrong = await runCli(argv, deps(moved.fetchImpl));
  assert.equal(wrong.exitCode, 1);
  assert.equal(wrong.output.error, "Transition-Readback bestätigt die Zielstatus-ID nicht.");
});

test("the broker started through a linked directory still runs as the entry point", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "atl-jira-link-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const linked = path.join(home, "brokers");
  fs.symlinkSync(import.meta.dirname, linked, "junction");
  const run = spawnSync(process.execPath, [path.join(linked, "atl-jira.mts"), "help"], {
    encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(String(JSON.parse(run.stdout).usage), /selftest/);
});
