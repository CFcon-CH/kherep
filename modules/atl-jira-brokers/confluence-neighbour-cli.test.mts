// Issue #965: the neighbour verbs through the broker CLI - related, context, orphans, space and the
// stitch argument gates - against a route-table fetch. Synthetic values only, no network, no process.
import assert from "node:assert/strict";
import test from "node:test";

import { runCli, type Injected } from "./atl-confluence-ccoder.mts";
import {
  cmdChildren, cmdContext, cmdGetBody, cmdMove, cmdOrphans, cmdRelated, cmdSearch, cmdSpace, cmdStitch, type NeighbourCliContext,
} from "./confluence-neighbour-cli.mts";
import { reply, routed, type Route } from "./broker-route.fixture.mts";

const CRED_PATH = "synthetic-credential-path";
const SPACE: Route = ["GET", /\/spaces\?keys=KB$/, reply(200, { results: [{ id: "9001", key: "KB", name: "Knowledge" }] })];
const NO_SPACE: Route = ["GET", /\/spaces\?keys=/, reply(200, { results: [] })];
const INDEX = (rows: unknown[]): Route => ["GET", /\/spaces\/9001\/pages\?limit=250&status=current$/, reply(200, { results: rows })];
const CQL: Route = ["GET", /\/rest\/api\/search\?cql=/, reply(200, { results: [] })];
const STORAGE = (id: string, value: string): Route => ["GET", new RegExp(`/pages/${id}\\?body-format=storage$`), reply(200, { body: { storage: { value } } })];

function harness(routes: Route[], titles: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const { calls, fetchImpl } = routed(routes, [
    ["POST", /auth\.atlassian\.com/, reply(200, { access_token: "synthetic-token", expires_in: 3600 })],
    ["GET", /_edge\/tenant_info$/, reply(200, { cloudId: "synthetic-cloud" })],
  ]);
  const injected: Injected = {
    env: { KHEREP_ATL_SITE: "https://wiki.example.com", KHEREP_ATL_CRED_FILE_CLAUDE: CRED_PATH },
    readFile: async (file: string) => {
      if (file !== CRED_PATH) throw new Error("ENOENT synthetic");
      return "Client ID: synthetic-client\nSecret: synthetic-secret-1234\n";
    },
    fetch: fetchImpl,
    log: (line) => { out.push(line); },
    logError: (line) => { err.push(line); },
    now: () => 1_000_000,
    semantic: async (query) => { asked.push(query); return { titles }; },
    writeOut: () => { throw new Error("no payload expected"); },
  };
  // The context the broker would build, for calling the exported verbs directly.
  const context = (): NeighbourCliContext => ({ ...injected, credEnv: "KHEREP_ATL_CRED_FILE_CLAUDE", session: {} } as NeighbourCliContext);
  return { out, err, calls, asked, injected, context, run: (argv: string[]) => runCli(argv, injected) };
}

const PAGES = [
  { id: "100", title: "Shelf", spaceId: "9001", parentId: null },
  { id: "101", title: "Token cache rules", spaceId: "9001", parentId: "100" },
  { id: "102", title: "Token expiry gotcha", spaceId: "9001", parentId: "100" },
];

test("context prints the page, its parent and its neighbours", async () => {
  const h = harness([SPACE, INDEX(PAGES), STORAGE("101", '<ac:link><ri:page ri:content-title="Token expiry gotcha" /></ac:link>')]);
  assert.equal(await h.run(["context", "--space", "KB", "--id", "101"]), 0, h.err.join("\n"));
  assert.equal(h.out[0], "page\t101\tToken cache rules");
  assert.equal(h.out[1], "parent\t100\tShelf");
  assert.ok(h.out.some((line) => line.startsWith("siblings: ")));
});

test("context refuses an id that is not a page of the space", async () => {
  const h = harness([SPACE, INDEX(PAGES)]);
  assert.equal(await h.run(["context", "--space", "KB", "--id", "999"]), 1);
  assert.deepEqual(h.err, ["That id is not a page in this space."]);
});

test("context refuses a blank --id before any request", async () => {
  const h = harness([]);
  assert.equal(await h.run(["context", "--space", "KB", "--id", "  "]), 1);
  assert.deepEqual(h.err, ["--id is missing."]);
  assert.equal(h.calls.length, 0);
});

test("orphans reads every body and lists the pages nothing links to", async () => {
  const h = harness([SPACE, INDEX(PAGES), STORAGE("100", ""), STORAGE("101", ""), STORAGE("102", "")]);
  assert.equal(await h.run(["orphans", "--space", "KB"]), 0, h.err.join("\n"));
  assert.deepEqual(h.out.slice(-2), ["pages: 3", "count: 2"]);
});

test("a neighbour verb on a space the account cannot see is refused", async () => {
  const h = harness([NO_SPACE]);
  assert.equal(await h.run(["orphans", "--space", "ZZ"]), 1);
  assert.deepEqual(h.err, ["No space with that key is visible to the service account."]);
});

test("related refuses a blank title and a blank topic before any request", async () => {
  const blankTitle = harness([]);
  assert.equal(await blankTitle.run(["related", "--space", "KB", "--title", "  "]), 1);
  assert.deepEqual(blankTitle.err, ["--title is missing."]);

  const blankTopic = harness([]);
  assert.equal(await blankTopic.run(["related", "--space", "KB", "--title", "Token", "--topic", "  "]), 1);
  assert.deepEqual(blankTopic.err, ["--topic is empty."]);
  assert.equal(blankTitle.calls.length + blankTopic.calls.length, 0);
});

test("related runs through the CLI with the injected semantic search", async () => {
  const h = harness([SPACE, INDEX(PAGES), CQL], ["Token expiry gotcha"]);
  assert.equal(await h.run(["related", "--space", "KB", "--title", "Token cache rules"]), 0, h.err.join("\n"));
  assert.deepEqual(h.out, ["related\t102\tToken expiry gotcha\tShelf\ttoken\t", "count: 1"]);
  assert.deepEqual(h.err, []);
  assert.deepEqual(h.asked.length, 1);
});

test("space reports a key the account cannot see as a refusal", async () => {
  const h = harness([NO_SPACE]);
  assert.equal(await h.run(["space", "--space", "ZZ"]), 1);
  assert.deepEqual(h.err, ["No space with that key is visible to the service account."]);
  assert.deepEqual(h.out, []);
});

test("stitch candidates refuse a whitespace topic before the space is looked up", async () => {
  const h = harness([]);
  assert.equal(await h.run(["stitch", "--space", "KB", "--id", "101", "--topic", "  ", "--out", "synthetic.receipt"]), 1);
  assert.match(h.err.join("\n"), /^--topic is empty\./);
  assert.equal(h.calls.length, 0);
});

test("a read-only stitch sweep over the space writes nothing", async () => {
  const h = harness([SPACE, INDEX(PAGES.slice(0, 2)), STORAGE("100", ""), STORAGE("101", ""), CQL]);
  assert.equal(await h.run(["stitch", "--space", "KB", "--limit", "1"]), 0, h.err.join("\n"));
  assert.ok(h.out.includes("orphans: 1"));
  assert.ok(h.out.includes("pages written: 0 (the sweep is read-only; link with stitch --id and decisions)"));
  assert.equal(h.calls.some((call) => call.method === "PUT"), false);
});

test("search refuses a blank query and maps an unexpected failure to unavailable, exit 2", async () => {
  const blank = harness([]);
  assert.equal(await blank.run(["search", "--space", "KB", "--query", "  "]), 2);
  assert.deepEqual([blank.err, blank.out], [["--query is missing."], ["status: unavailable"]]);

  const broken = harness([SPACE, INDEX(PAGES)]);
  const run = (argv: string[]) => runCli(argv, { ...broken.injected, semantic: async () => { throw new Error("synthetic"); } });
  assert.equal(await run(["search", "--space", "KB", "--query", "token"]), 2);
  assert.deepEqual([broken.err, broken.out], [["Internal error."], ["status: unavailable"]]);
});

test("children lists each child and the count", async () => {
  const h = harness([["GET", /\/pages\/100\/children\?limit=250$/, reply(200, { results: [{ id: "101", title: "Token cache rules" }] })]]);
  assert.equal(await h.run(["children", "--id", "100"]), 0);
  assert.deepEqual(h.out, ["101\tToken cache rules", "count: 1"]);
});

test("move falls back to the requested id when the write answer carries none", async () => {
  const h = harness([
    ["GET", /\/pages\/101\?body-format=storage$/, reply(200, { id: "101", title: "T", version: { number: 2 }, parentId: "100", body: { storage: { value: "" } } })],
    ["PUT", /\/pages\/101$/, reply(200, { version: { number: 3 } })],
    ["GET", /\/pages\/200\/children\?limit=250$/, reply(200, { results: [{ id: "101", title: "T" }] })],
  ]);
  assert.equal(await h.run(["move", "--id", "101", "--parent", "200"]), 0, h.err.join("\n"));
  assert.equal(h.out.at(-1), "readback parent: 200");
});

test("the exported verbs refuse absent arguments before any request", async () => {
  const h = harness([]);
  const ctx = h.context();
  const refusals: [() => Promise<number>, RegExp][] = [
    [() => cmdContext(ctx, {}), /^--id is missing\.$/],
    [() => cmdRelated(ctx, {}), /^--title is missing\.$/],
    [() => cmdRelated(ctx, { title: "T", topic: undefined }), /^--topic is empty\.$/],
    [() => cmdStitch(ctx, { id: undefined }), /^--id must be a numeric Confluence page id\./],
    [() => cmdStitch(ctx, { id: "101", topic: undefined, out: "x" }), /^--topic is empty\./],
    [() => cmdOrphans(ctx, {}), /--space must be a Confluence space key\./],
    [() => cmdSpace(ctx, {}), /--space must be a Confluence space key\./],
    [() => cmdChildren(ctx, {}), /--id must be a numeric Confluence id\./],
    [() => cmdMove(ctx, {}), /--id must be a numeric Confluence id\./],
    [() => cmdGetBody(ctx, { "body-only": "" }), /--id must be a numeric Confluence id\./],
    [() => cmdGetBody(ctx, { "body-only": "", format: undefined }), /--format "" is not readable/],
  ];
  for (const [call, message] of refusals) {
    await assert.rejects(call, (error: Error & { cliMessage?: string }) => message.test(error.cliMessage ?? error.message));
  }
  assert.equal(await cmdSearch(ctx, {}), 2);
  assert.deepEqual(h.err, ["--query is missing."]);
  assert.equal(h.calls.length, 0);
});
