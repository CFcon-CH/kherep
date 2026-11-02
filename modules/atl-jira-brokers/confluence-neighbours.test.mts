// Tests for the related report: what it lists and how it reports a half that did
// not run. No network: the session answers from fixtures. The stitch modes are
// tested in confluence-stitch.test.mts (issue #736).
import assert from "node:assert/strict";
import test from "node:test";

import { requestError, SCOPES, type ConfluenceSession } from "./confluence-contract.mts";
import { reportRelated, type NeighbourDeps } from "./confluence-neighbours.mts";

const PAGES = [
  { id: "900", title: "Acme", parentId: null },
  { id: "901", title: "Acme brand banner: visual identity and color palette", parentId: "900" },
  { id: "1", title: "macOS product-node daemon launchd agent configuration", parentId: "900" },
  { id: "2", title: "Acme architecture: governance layer, not agent harness", parentId: "900" },
  { id: "3", title: "Acme color palette tokens", parentId: "900" },
  { id: "4", title: "Acme installer backup rotation", parentId: "900" },
];

// Issue #651. A refused text search is an UNKNOWN half, not "no neighbours",
// and it neither aborts the run nor reads as a missing scope.
function halves(log: string[], opts: {
  pages?: { id: string; title: string; parentId: string | null }[];
  bodies?: Record<string, string>;
  search?: (cql: string) => number | null;
  // The rows a /search that is not refused answers with (issue #656). Default: none.
  results?: (cql: string) => unknown[];
  semantic?: { titles: string[]; error?: string };
  cqls?: string[];
}): NeighbourDeps {
  const pages = opts.pages ?? PAGES;
  const session: ConfluenceSession = {
    async request(spec) {
      if (spec.path.includes("/spaces/")) return { status: 200, json: { results: pages, _links: {} } };
      if (spec.path.includes("/search")) {
        const cql = decodeURIComponent(spec.path.split("cql=")[1].split("&")[0]);
        opts.cqls?.push(cql);
        const refused = opts.search?.(cql);
        if (refused) throw requestError({ method: "GET", path: spec.path, scope: SCOPES.get }, refused, {});
        return { status: 200, json: { results: opts.results?.(cql) ?? [] } };
      }
      const id = /\/pages\/([^/?]+)/.exec(spec.path)?.[1] ?? "";
      return { status: 200, json: { body: { storage: { value: opts.bodies?.[id] ?? "<p>body</p>" } } } };
    },
  };
  return {
    session, spaceId: "42", spaceKey: "KB",
    log: (line) => log.push(line),
    logError: (line) => log.push(`error: ${line}`),
    semantic: async () => opts.semantic ?? { titles: pages.slice(1).map((p) => p.title) },
    update: async () => { throw new Error("a dry run must not write"); },
  };
}

const errors = (log: string[]) => log.filter((line) => line.startsWith("error: ")).map((line) => line.slice(7));
const FAILURE_403 = /^exact-term search: HTTP 403\. Hits from this half are UNKNOWN\. cql: space="KB" and type=page and text ~ "/;

test("related: an exact half refused with 403 and no semantic hit is UNKNOWN, exit 1", async () => {
  const log: string[] = [];
  const code = await reportRelated(halves(log, { search: () => 403, semantic: { titles: [] } }),
    { title: "Unrelated widget notes" });
  assert.equal(code, 1);
  assert.ok(log.includes("count: 0"));
  const err = errors(log);
  assert.match(err[0], FAILURE_403);
  assert.ok(err[0].endsWith('text ~ "unrelated widget notes"'));
  assert.equal(err[1], "Only one half of the search ran and it found nothing. This result is UNKNOWN, not zero.");
});

test("related: an exact half refused with 500 keeps the semantic hits, exit 0", async () => {
  const log: string[] = [];
  const code = await reportRelated(halves(log, { search: () => 500 }), { title: PAGES[1].title, id: "901" });
  assert.equal(code, 0);
  assert.ok(log.some((line) => line.startsWith("related\t3\t")));
  const err = errors(log);
  assert.match(err[0], /^exact-term search: HTTP 500\. Hits from this half are UNKNOWN\. cql: /);
  assert.equal(err[1], "These hits come from the semantic half only. The list may be incomplete.");
});

test("related: a semantic error with no hit keeps its pre-existing report", async () => {
  const log: string[] = [];
  const code = await reportRelated(halves(log, { semantic: { titles: [], error: "semantic search failed" } }),
    { title: "Unrelated widget notes" });
  assert.equal(code, 1);
  assert.deepEqual(errors(log), ["semantic search failed",
    "Nothing was searched, so nothing was found. This result is UNKNOWN, not zero."]);
});

test("related: both halves failed names both and reports UNKNOWN", async () => {
  const log: string[] = [];
  const code = await reportRelated(halves(log, {
    search: () => 403, semantic: { titles: [], error: "semantic search failed" },
  }), { title: "Unrelated widget notes" });
  assert.equal(code, 1);
  const err = errors(log);
  assert.equal(err.length, 3);
  assert.equal(err[0], "semantic search failed");
  assert.match(err[1], FAILURE_403);
  assert.equal(err[2], "Nothing was searched, so nothing was found. This result is UNKNOWN, not zero.");
});

// Issue #656. A /search row without a readable title is an incompletely read
// exact half: UNKNOWN, never an ordinary "count: 0" with exit 0 and never
// "isolated". It travels in the same failure field as a refused request.
const ROWS_LINE = /^exact-term search: 1 of 1 result row\(s\) had no readable title\. Hits from this half are incomplete and UNKNOWN\. cql: space="KB" and type=page and text ~ "/;
const PARTIAL_HITS = "The exact-term half was not fully read. The list may be incomplete.";
const PARTIAL_NONE = "The exact-term half was not fully read and nothing was found. This result is UNKNOWN, not zero.";

for (const [name, row] of [["an empty row", {}], ["a non-string title", { title: 7 }]] as const) {
  test(`related: ${name} with no semantic hit is UNKNOWN, exit 1`, async () => {
    const log: string[] = [];
    const code = await reportRelated(halves(log, { results: () => [row], semantic: { titles: [] } }),
      { title: "Unrelated widget notes" });
    assert.equal(code, 1);
    assert.ok(log.includes("count: 0"));
    const err = errors(log);
    assert.match(err[0], ROWS_LINE);
    assert.ok(err[0].endsWith('text ~ "unrelated widget notes"'));
    assert.equal(err[1], PARTIAL_NONE);
    assert.equal(err.length, 2);
    assert.ok(err.every((line) => !/HTTP/.test(line)));
  });
}

test("related: a mixed exact half keeps its hit and does not call it semantic-only", async () => {
  const log: string[] = [];
  const code = await reportRelated(halves(log, {
    semantic: { titles: [] }, results: () => [{ content: { title: "Acme color palette tokens" } }, {}],
  }), { title: PAGES[1].title, id: "901" });
  assert.equal(code, 0);
  assert.ok(log.some((line) => line.startsWith("related\t3\t")));
  assert.ok(log.includes("count: 1"));
  const err = errors(log);
  assert.match(err[0], /^exact-term search: 1 of 2 result row\(s\) had no readable title\./);
  assert.equal(err[1], PARTIAL_HITS);
  assert.equal(err.length, 2);
  assert.ok(err.every((line) => !/semantic half only|Only one half|Nothing was searched/.test(line)));
});

test("related: a mixed exact half keeps its hit while the semantic half failed", async () => {
  const log: string[] = [];
  const code = await reportRelated(halves(log, {
    semantic: { titles: [], error: "semantic search failed" },
    results: () => [{ content: { title: "Acme color palette tokens" } }, {}],
  }), { title: PAGES[1].title, id: "901" });
  assert.equal(code, 0);
  assert.ok(log.some((line) => line.startsWith("related\t3\t")));
  const err = errors(log);
  assert.equal(err.length, 3);
  assert.equal(err[0], "semantic search failed");
  assert.match(err[1], /^exact-term search: 1 of 2 result row\(s\) had no readable title\./);
  assert.equal(err[2], PARTIAL_HITS);
  assert.ok(err.every((line) => !/Nothing was searched|semantic half only/.test(line)));
});

test("related: a semantic hit with every exact row unreadable names no half", async () => {
  const log: string[] = [];
  const code = await reportRelated(halves(log, { results: () => [{}] }), { title: PAGES[1].title, id: "901" });
  assert.equal(code, 0);
  assert.ok(log.some((line) => line.startsWith("related\t3\t")));
  const err = errors(log);
  assert.match(err[0], ROWS_LINE);
  assert.equal(err[1], PARTIAL_HITS);
});

test("related: readable rows that match nothing beside an unreadable one stay UNKNOWN, exit 1", async () => {
  const log: string[] = [];
  const code = await reportRelated(halves(log, {
    semantic: { titles: [] }, results: () => [{ title: "Not in this space" }, {}],
  }), { title: "Unrelated widget notes" });
  assert.equal(code, 1);
  assert.ok(log.includes("count: 0"));
  const err = errors(log);
  assert.match(err[0], /1 of 2 result row\(s\)/);
  assert.equal(err[1], PARTIAL_NONE);
});

// Issue #736: related asks with title plus topic in the space, and every row
// carries area, a terms hint and a snippet. Shared words no longer drop a row:
// the page with no shared word is listed, and the reader decides.
test("related rows carry area, terms and snippet, and the term rule drops nothing", async () => {
  const log: string[] = [];
  const asked: { query: string; spaceKey?: string }[] = [];
  const run: NeighbourDeps = { ...halves(log, {}), semantic: async (query, _limit, options) => {
    asked.push({ query, spaceKey: options?.spaceKey });
    return { titles: [], items: [
      { id: "1", title: PAGES[2].title, snippet: "<p>launchd\tagent</p>" },
      { id: "3", title: PAGES[4].title, snippet: "Palette tokens." },
    ] };
  } };
  const code = await reportRelated(run, { title: PAGES[1].title, topic: "Which colours the banner uses.", id: "901" });
  assert.equal(code, 0);
  assert.deepEqual(asked, [{ query: `${PAGES[1].title}. Which colours the banner uses.`, spaceKey: "KB" }]);
  assert.deepEqual(log.filter((line) => line.startsWith("related\t")), [
    `related\t1\t${PAGES[2].title}\tAcme\t\tlaunchd agent`,
    `related\t3\t${PAGES[4].title}\tAcme\tcolor,palette\tPalette tokens.`,
  ]);
  assert.ok(log.includes("count: 2"));
});
