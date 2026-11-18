// Issue #965: transition, unlink, download and project-discovery refusals of the Codex Jira broker,
// plus the CLI boundary run as a real process. Fetch is a route table; credentials are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli, type BrokerDeps, type FetchLike } from "./atl-jira.mts";
import { reply, routed as route, throwing, type Route } from "./broker-route.fixture.mts";

const BROKER = path.join(import.meta.dirname, "atl-jira.mts");
const SEED_ENV = {
  KHEREP_ATL_SITE: "https://jira.example.com",
  KHEREP_ATL_PROJECT_KEY: "OP",
  KHEREP_ATL_CRED_FILE_CODEX: "synthetic-credential-path",
};
const JIRA_ENV = { ...SEED_ENV, KHEREP_ATL_PROJECT_ID: "20202", KHEREP_ATL_ISSUE_TYPES: JSON.stringify({ Task: "31002" }) };

const routed = (routes: Route[]) => route(routes, [
  ["POST", /oauth\/token$/, reply(200, { access_token: "synthetic-token" })],
  ["GET", /_edge\/tenant_info$/, reply(200, { cloudId: "synthetic-cloud" })],
]);

function deps(fetchImpl: FetchLike, env: Record<string, string | undefined> = JIRA_ENV): Partial<BrokerDeps> {
  return {
    env,
    readFile: async () => "Client ID: synthetic-client\nClient Secret: synthetic-secret-1234\n",
    stdoutIsTty: () => false,
    fetch: fetchImpl,
  };
}

const TRANSITIONS = "/issue/OP-7/transitions";
const toProgress = ["transition", "--key", "OP-7", "--to", "indeterminate"];

test("transition reports an unreadable transition list without writing", async () => {
  const { calls, fetchImpl } = routed([["GET", /\/issue\/OP-7\/transitions$/, reply(403, { errorMessages: ["no browse"] })]]);
  const result = await runCli(toProgress, deps(fetchImpl));
  assert.deepEqual(result.output, {
    status: 403, issueKey: "OP-7", errorMessages: ["no browse"], error: "Transitions konnten nicht gelesen werden.",
  });
  assert.equal(calls.some((call) => call.method === "POST" && call.url.endsWith(TRANSITIONS)), false);
});

test("transition refuses a target whose status id cannot be verified afterwards", async () => {
  const { calls, fetchImpl } = routed([["GET", /\/issue\/OP-7\/transitions$/, reply(200, {
    transitions: [{ id: "21", name: "Start", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } }],
  })]]);
  const result = await runCli(toProgress, deps(fetchImpl));
  assert.deepEqual(result.output, {
    status: 200, issueKey: "OP-7", error: "Zielstatus mit verifizierbarer Status-ID ist nicht verfügbar.",
  });
  assert.equal(calls.some((call) => call.method === "POST" && call.url.endsWith(TRANSITIONS)), false);
});

test("transition reports a refused write and reads nothing back", async () => {
  const { calls, fetchImpl } = routed([
    ["GET", /\/issue\/OP-7\/transitions$/, reply(200, {
      transitions: [{ id: "21", name: "Start", to: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } } }],
    })],
    ["POST", /\/issue\/OP-7\/transitions$/, reply(409, { errorMessages: ["conflict"] })],
  ]);
  const result = await runCli(toProgress, deps(fetchImpl));
  assert.deepEqual(result.output, { status: 409, issueKey: "OP-7", errorMessages: ["conflict"], error: "Transition fehlgeschlagen." });
  assert.equal(calls.some((call) => call.url.includes("?fields=status")), false);
});

const LINK_TYPES = { issueLinkTypes: [{ id: "1000", name: "Duplicate", inward: "is duplicated by", outward: "duplicates" }] };
const LINKED = {
  fields: { issuelinks: [{
    id: "10501", type: { id: "1000", name: "Duplicate", inward: "is duplicated by", outward: "duplicates" },
    inwardIssue: { key: "OP-827" },
  }] },
};
const unlink = ["unlink", "--type", "Duplicate", "--outward", "OP-1093", "--inward", "OP-827"];
const catalog: Route = ["GET", /\/issueLinkType$/, reply(200, LINK_TYPES)];

test("unlink reports an issue whose links cannot be read and deletes nothing", async () => {
  const { calls, fetchImpl } = routed([catalog, ["GET", /\/issue\/OP-1093\?fields=issuelinks$/, reply(500, {})]]);
  const result = await runCli(unlink, deps(fetchImpl));
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.status, 500);
  assert.equal(result.output.error, "Verknüpfungen des Vorgangs sind nicht lesbar.");
  assert.equal(calls.some((call) => call.method === "DELETE"), false);
});

test("unlink reports a refused delete with the chosen link id", async () => {
  const { fetchImpl } = routed([
    catalog,
    ["GET", /\/issue\/OP-1093\?fields=issuelinks$/, reply(200, LINKED)],
    ["DELETE", /\/issueLink\/10501$/, reply(403, { errorMessages: ["not allowed"] })],
  ]);
  const result = await runCli(unlink, deps(fetchImpl));
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.linkId, "10501");
  assert.equal(result.output.status, 403);
  assert.equal(result.output.error, "Unlink fehlgeschlagen.");
});

test("download reports a content request that throws as network_error", async () => {
  const meta = { id: "10224", filename: "note.md", mimeType: "text/markdown", size: 4 };
  const { fetchImpl } = routed([
    ["GET", /\/issue\/OP-9\?fields=attachment$/, reply(200, { key: "OP-9", fields: { attachment: [meta] } })],
    ["GET", /\/attachment\/content\/10224/, throwing()],
  ]);
  const result = await runCli(["download", "--key", "OP-9", "--id", "10224"], deps(fetchImpl));
  assert.deepEqual(result.output, { status: 0, attachmentId: "10224", error: "network_error" });
  assert.equal(result.stdoutBytes, undefined);
});

test("a host with only site and project key discovers the binding before the verb runs", async () => {
  const { calls, fetchImpl } = routed([
    ["GET", /\/project\/search\?keys=OP$/, reply(200, { values: [{ key: "OP", id: "10111" }] })],
    ["GET", /\/issue\/createmeta\/OP\/issuetypes$/, reply(200, { issueTypes: [{ id: "10002", name: "Task" }] })],
    ["GET", /\/issue\/OP-1\?fields=/, reply(200, { key: "OP-1", fields: { summary: "s" } })],
  ]);
  const result = await runCli(["get", "--key", "OP-1"], deps(fetchImpl, SEED_ENV));
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.summary, "s");
  assert.equal(calls.filter((call) => call.url.includes("oauth/token")).length, 2);
});

test("a refused project discovery stops before the verb runs", async () => {
  const { calls, fetchImpl } = routed([["GET", /\/project\/search\?keys=OP$/, reply(403, { errorMessages: ["forbidden"] })]]);
  const result = await runCli(["get", "--key", "OP-1"], deps(fetchImpl, SEED_ENV));
  assert.deepEqual(result.output, { status: 403, errorMessages: ["forbidden"], error: "Projektauflösung fehlgeschlagen." });
  assert.equal(calls.some((call) => call.url.includes("/issue/OP-1")), false);
});

function runBroker(args: string[], extra: { env?: Record<string, string>; preload?: string } = {}) {
  const flags = extra.preload ? ["--import", extra.preload] : [];
  return spawnSync(process.execPath, [...flags, BROKER, ...args], {
    encoding: "buffer", timeout: 20_000, env: { PATH: process.env.PATH ?? "", ...extra.env },
  });
}

test("the broker run as a process prints help as one JSON line on stdout", () => {
  const run = runBroker(["help"]);
  assert.equal(run.status, 0);
  const lines = run.stdout.toString("utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(String(JSON.parse(lines[0]).usage), /download/);
});

test("imported without a script path the module stays a library and prints nothing", () => {
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(BROKER)});`], {
    encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "");
});

test("a download run as a process writes the bytes to stdout and the envelope to stderr", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "atl-jira-main-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const credential = path.join(home, "credential.txt");
  fs.writeFileSync(credential, "Client ID: synthetic-client\nClient Secret: synthetic-secret-1234\n");
  const preload = path.join(home, "fake-fetch.mjs");
  fs.writeFileSync(preload, `
const json = (body) => new Response(JSON.stringify(body), { status: 200 });
const meta = { id: "10224", filename: "note.md", mimeType: "text/markdown", size: 6 };
globalThis.fetch = async (url) => {
  if (url.endsWith("/oauth/token")) return json({ access_token: "synthetic-token" });
  if (url.endsWith("/_edge/tenant_info")) return json({ cloudId: "synthetic-cloud" });
  if (url.includes("/attachment/content/10224")) return new Response("# Note", { status: 200 });
  return json({ key: "OP-9", fields: { attachment: [meta] } });
};
`);
  const run = runBroker(["download", "--key", "OP-9", "--id", "10224"], {
    preload: path.join(home, "fake-fetch.mjs"),
    env: { ...JIRA_ENV, KHEREP_ATL_CRED_FILE_CODEX: credential },
  });
  assert.equal(run.status, 0, run.stderr.toString("utf8"));
  assert.equal(run.stdout.toString("utf8"), "# Note");
  assert.deepEqual(JSON.parse(run.stderr.toString("utf8")), {
    status: 200, attachmentId: "10224", filename: "note.md", mimeType: "text/markdown", bytes: 6,
  });
});
