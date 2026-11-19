// Issue #965: the refusal and error branches of the Codex Jira broker, driven through runCli with an
// injected fetch. Every request is answered by a route table; nothing reaches a network or a real file.
import test from "node:test";
import assert from "node:assert/strict";

import { runCli, type BrokerDeps, type FetchLike } from "./atl-jira.mts";
import { reply, routed as route, sequence, throwing, type Route } from "./broker-route.fixture.mts";

const JIRA_ENV = {
  KHEREP_ATL_SITE: "https://jira.example.com",
  KHEREP_ATL_PROJECT_ID: "20202",
  KHEREP_ATL_PROJECT_KEY: "OP",
  KHEREP_ATL_ISSUE_TYPES: JSON.stringify({ Task: "31002" }),
  KHEREP_ATL_CRED_FILE_CODEX: "synthetic-credential-path",
};

const TOKEN: Route = ["POST", /oauth\/token$/, reply(200, { access_token: "synthetic-token" })];
const TENANT: Route = ["GET", /_edge\/tenant_info$/, reply(200, { cloudId: "synthetic-cloud" })];
// The session defaults come last, so a test can override the token or the tenant step.
const routed = (routes: Route[]) => route(routes, [TOKEN, TENANT]);

function deps(fetchImpl: FetchLike, env: Record<string, string | undefined> = JIRA_ENV): Partial<BrokerDeps> {
  return {
    env,
    readFile: async () => "Client ID: synthetic-client\nClient Secret: synthetic-secret-1234\n",
    readBytes: async () => Buffer.from("synthetic bytes"),
    stdoutIsTty: () => false,
    fetch: fetchImpl,
  };
}

test("a token request that throws is reported as network_error without any Jira call", async () => {
  const { calls, fetchImpl } = routed([["POST", /oauth\/token$/, throwing()]]);
  const result = await runCli(["get", "--key", "OP-1"], deps(fetchImpl));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.output, { status: 0, error: "network_error" });
  assert.equal(calls.length, 1);
});

test("a token answer that is not JSON falls back to the named token failure", async () => {
  const { fetchImpl } = routed([["POST", /oauth\/token$/, reply(502, "<html>bad gateway</html>")]]);
  const result = await runCli(["get", "--key", "OP-1"], deps(fetchImpl));
  assert.deepEqual(result.output, { status: 502, error: "Token-Request fehlgeschlagen." });
});

test("a tenant_info without cloudId stops before any Jira request", async () => {
  const { calls, fetchImpl } = routed([["GET", /_edge\/tenant_info$/, reply(404, { errorMessages: ["no tenant"] })]]);
  const result = await runCli(["get", "--key", "OP-1"], deps(fetchImpl));
  assert.deepEqual(result.output, { status: 404, errorMessages: ["no tenant"], error: "tenant_info fehlgeschlagen." });
  assert.equal(calls.some((call) => call.url.includes("/rest/api/3/")), false);
});

test("an unreadable credential file is refused without naming the path", async () => {
  const { calls, fetchImpl } = routed([]);
  const result = await runCli(["get", "--key", "OP-1"], {
    ...deps(fetchImpl),
    readFile: async () => { throw new Error("EACCES synthetic-credential-path"); },
  });
  assert.deepEqual(result.output, { status: 0, error: "Credentials-Datei ist nicht lesbar." });
  assert.equal(calls.length, 0);
});

test("selftest fails when tenant_info does not name a cloud", async () => {
  const { fetchImpl } = routed([
    ["POST", /oauth\/token$/, sequence(reply(200, { access_token: "synthetic-token" }), reply(401, { error: "access_denied" }))],
    ["GET", /_edge\/tenant_info$/, reply(200, {})],
  ]);
  const result = await runCli(["selftest"], deps(fetchImpl));
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.verdict, "FAIL");
  assert.deepEqual(result.output.tenantInfo, { status: 200 });
});

test("get reports a refused read with the filtered error fields only", async () => {
  const { fetchImpl } = routed([["GET", /\/issue\/OP-1\?fields=/, reply(400, {
    errorMessages: ["bad field", 7], errors: { customfield_1: 5 }, secret: "never echoed",
  })]]);
  const result = await runCli(["get", "--key", "OP-1"], deps(fetchImpl));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.output, {
    status: 400, issueKey: "OP-1", errorMessages: ["bad field", "7"], errors: { customfield_1: "5" }, error: "Get fehlgeschlagen.",
  });
});

test("update reports a refused write, a failed readback and an unconfirmed summary", async () => {
  const put = (status: number): Route => ["PUT", /\/issue\/OP-2$/, reply(status, status === 204 ? undefined : { errorMessages: ["no"] })];
  const read = (status: number, body: unknown): Route => ["GET", /\/issue\/OP-2\?fields=/, reply(status, body)];
  const argv = ["update", "--key", "OP-2", "--summary", "neu"];

  const refused = await runCli(argv, deps(routed([put(400)]).fetchImpl));
  assert.deepEqual(refused.output, { status: 400, issueKey: "OP-2", errorMessages: ["no"], error: "Update fehlgeschlagen." });

  const unread = await runCli(argv, deps(routed([put(204), read(500, { error: "boom" })]).fetchImpl));
  assert.deepEqual(unread.output, {
    status: 204, issueKey: "OP-2", readbackStatus: 500, error: "Readback nach dem Update fehlgeschlagen.",
  });

  const stale = await runCli(argv, deps(routed([put(204), read(200, { fields: { summary: "alt" } })]).fetchImpl));
  assert.deepEqual(stale.output, {
    status: 204, issueKey: "OP-2", readbackStatus: 200, error: "Readback bestätigt die neue Summary nicht.",
  });
  assert.equal(stale.exitCode, 1);
});

test("comment reports a write without an id as a failure", async () => {
  const { fetchImpl } = routed([["POST", /\/issue\/OP-3\/comment$/, reply(201, {})]]);
  const result = await runCli(["comment", "--key", "OP-3", "--body", "x"], deps(fetchImpl));
  assert.deepEqual(result.output, { status: 201, issueKey: "OP-3", error: "Comment fehlgeschlagen." });
});

test("attach reports a readback that does not load after an accepted upload", async () => {
  const { fetchImpl } = routed([
    ["POST", /\/issue\/OP-4\/attachments$/, reply(200, [{ id: "1", filename: "a.md" }])],
    ["GET", /\/issue\/OP-4\?fields=attachment$/, reply(503, { errorMessages: ["later"] })],
  ]);
  const result = await runCli(["attach", "--key", "OP-4", "--file", "/nowhere/a.md"], deps(fetchImpl));
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.error, "Readback nach dem Upload fehlgeschlagen.");
  assert.deepEqual(result.output.errorMessages, ["later"]);
  assert.equal(result.output.readbackStatus, 503);
});

test("search reports a refused query as a failure without hits", async () => {
  const { fetchImpl } = routed([["GET", /\/search\/jql\?/, reply(400, { errorMessages: ["jql invalid"] })]]);
  const result = await runCli(["search", "--jql", "project = OP"], deps(fetchImpl));
  assert.deepEqual(result.output, { status: 400, errorMessages: ["jql invalid"], error: "Suche fehlgeschlagen." });
});

test("a Jira call that throws mid-session is reported as network_error, not as an empty answer", async () => {
  const { fetchImpl } = routed([["GET", /\/issue\/OP-5\?fields=/, throwing()]]);
  const result = await runCli(["get", "--key", "OP-5"], deps(fetchImpl));
  assert.deepEqual(result.output, { status: 0, issueKey: "OP-5", error: "network_error" });
});
