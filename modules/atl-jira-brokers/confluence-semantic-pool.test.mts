// Tests for stage 1 of the model backend (issue #1020): the candidate pool is
// deterministic, holds inventory leaves only, and a failed CQL request fails
// the whole call instead of yielding a pool that looks complete.
import assert from "node:assert/strict";
import test from "node:test";

import { bodyCql, buildPool, POOL_CAP, poolTerms, titleCandidates } from "./confluence-semantic-pool.mts";
import { indexOf, PAGES, recordingSession as session, refusingSession as refusing } from "./semantic-model.fixture.mts";

test("poolTerms keeps content words and numbers and splits dotted tokens", () => {
  assert.deepEqual(poolTerms("node.js 22 upgrade (vite-plugin) the"), ["node", "js", "upgrade", "vite", "plugin", "22"]);
});

test("titleCandidates ranks deterministically, skips shelves and non-matches", () => {
  const first = titleCandidates(PAGES, poolTerms("service account credential"));
  assert.deepEqual(first.map((e) => e.id), ["2", "3"]);
  assert.deepEqual(titleCandidates(PAGES, poolTerms("service account credential")), first, "same input, same order");
  assert.equal(titleCandidates(PAGES, poolTerms("development")).length, 0, "the shelf never enters");
});

test("bodyCql joins at most 12 words with OR inside the space", () => {
  const words = Array.from({ length: 15 }, (_, i) => `w${i}`);
  const cql = bodyCql("KB", words)!;
  assert.equal(cql.match(/text ~/g)?.length, 12);
  assert.match(cql, /^space="KB" and type=page and \(text ~ "w0" or text ~ "w1" or /);
  assert.equal(bodyCql("KB", []), null);
});

test("buildPool: titles first, body hits after, excerpts attached, unknown ids dropped", async () => {
  const { session: s, specs } = session({ results: [
    { content: { id: "3", title: "Credential file expired in the nightly job" }, excerpt: "the  credential\nexpired" },
    { content: { id: "4", title: "Printer setup" }, excerpt: "tray" },
    { content: { id: "999", title: "Other space" }, excerpt: "x" },
    { content: { id: "1", title: "Development" }, excerpt: "shelf" },
  ] });
  const built = await buildPool("credential rotation", { session: s, spaceKey: "KB", pages: PAGES });
  assert.ok("entries" in built);
  assert.deepEqual(built.entries.map((e) => e.id), ["2", "3", "4"]);
  assert.equal(built.entries[1].excerpt, "the credential expired");
  assert.equal(specs.length, 1);
  assert.match(specs[0].path, /\/wiki\/rest\/api\/search\?cql=.*&limit=25&excerpt=indexed$/);
});

test("buildPool caps the pool at 65 rows", async () => {
  const many = indexOf(Array.from({ length: 120 }, (_, i): [string, string] => [String(i + 10), `credential note ${i}`]));
  const body = { results: Array.from({ length: 25 }, (_, i) => ({ content: { id: String(i + 100), title: "x" }, excerpt: "" })) };
  const built = await buildPool("credential", { session: session(body).session, spaceKey: "KB", pages: many });
  assert.ok("entries" in built);
  assert.equal(built.entries.length, POOL_CAP);
});

test("buildPool: a refused or unreadable CQL request fails the call", async () => {
  for (const status of [403, 500]) {
    const built = await buildPool("credential", { session: refusing(status), spaceKey: "KB", pages: PAGES });
    assert.deepEqual(built, { error: `the candidate text search failed with HTTP ${status}` });
  }
  const odd = await buildPool("credential", { session: session({ nothing: true }).session, spaceKey: "KB", pages: PAGES });
  assert.deepEqual(odd, { error: "the candidate text search returned an unreadable result" });
});

test("buildPool: a query without a searchable word sends no request", async () => {
  const { session: s, specs } = session();
  assert.deepEqual(await buildPool("the and of", { session: s, spaceKey: "KB", pages: PAGES }), { error: "the query has no searchable word" });
  assert.equal(specs.length, 0);
});
