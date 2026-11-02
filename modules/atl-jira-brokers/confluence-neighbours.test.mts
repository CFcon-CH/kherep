// Tests for the stitching run as a whole: what it links, and what it says about
// why. No network: the session answers from fixtures, and the run is a dry run.
import assert from "node:assert/strict";
import test from "node:test";

import { requestError, SCOPES, type ConfluenceSession } from "./confluence-contract.mts";
import { reportRelated, reportStitch, type NeighbourDeps } from "./confluence-neighbours.mts";

const ISSUE_TITLE = "Four files import the confluence-evidence modules (grep over modules, bootstrap, claude, codex)";

const PAGES = [
  { id: "900", title: "Acme", parentId: null },
  { id: "901", title: "Acme brand banner: visual identity and color palette", parentId: "900" },
  { id: "1", title: "macOS product-node daemon launchd agent configuration", parentId: "900" },
  { id: "2", title: "Acme architecture: governance layer, not agent harness", parentId: "900" },
  { id: "3", title: "Acme color palette tokens", parentId: "900" },
  { id: "4", title: "Acme installer backup rotation", parentId: "900" },
];

function deps(log: string[]): NeighbourDeps {
  const session: ConfluenceSession = {
    async request(spec) {
      if (spec.path.includes("/spaces/")) return { status: 200, json: { results: PAGES, _links: {} } };
      if (spec.path.includes("/search")) return { status: 200, json: { results: [] } };
      return { status: 200, json: { body: { storage: { value: "<p>body</p>" } } } };
    },
  };
  return {
    session,
    spaceId: "42",
    spaceKey: "KB",
    log: (line) => log.push(line),
    logError: (line) => log.push(`error: ${line}`),
    semantic: async () => ({ titles: PAGES.slice(1).map((p) => p.title) }),
    update: async () => { throw new Error("a dry run must not write"); },
  };
}

test("reportStitch links only on a distinctive word and logs the reason per link", async () => {
  const log: string[] = [];
  const code = await reportStitch(deps(log), { only: "901", perOrphan: 3, dryRun: true });
  assert.equal(code, 0);
  const links = log.filter((line) => line.startsWith("link\t"));
  assert.deepEqual(links, ["link\t3\t901\tterm=color,palette\tsibling"],
    "the sibling with no shared word and the page sharing only the product name are not linked");
  assert.ok(log.includes("pages that would be written: 1"));
});

// Issue #479. Two real runs against one in-memory page store. The store hands
// a written body back the way Confluence may re-serialize it (here: a list item
// wrapped in a paragraph), so the bytes read back are not the bytes written.
// "Already linked" has to survive that, for a sibling neighbour as for any.
const SIBLINGS = [
  { id: "900", title: "Acme", parentId: null },
  { id: "101", title: "Broker output differs between hosts", parentId: "900" },
  { id: "102", title: "Why the runtime label differs", parentId: "900" },
  { id: "103", title: "Release checklist", parentId: null },
];

function store(reserialize: (storage: string) => string) {
  const bodies = new Map([["101", "<p>o</p>"], ["102", "<p>n</p>"], ["103", "<p>m</p>"]]);
  const writes: string[] = [];
  const session: ConfluenceSession = {
    async request(spec) {
      if (spec.path.includes("/spaces/")) return { status: 200, json: { results: SIBLINGS, _links: {} } };
      if (spec.path.includes("/search")) return { status: 200, json: { results: [] } };
      const id = /\/pages\/([^/?]+)/.exec(spec.path)?.[1] ?? "";
      return { status: 200, json: { body: { storage: { value: bodies.get(id) ?? "" } } } };
    },
  };
  const log: string[] = [];
  const run: NeighbourDeps = {
    session, spaceId: "42", spaceKey: "KB",
    log: (line) => log.push(line),
    logError: (line) => log.push(`error: ${line}`),
    semantic: async () => ({ titles: SIBLINGS.map((p) => p.title) }),
    update: async (id, storage) => { writes.push(id); bodies.set(id, reserialize(storage)); },
  };
  return { run, writes, log, bodies };
}

const wrapItems = (storage: string) => storage.replace(/<li>(<a\b[^>]*>.*?<\/a>)<\/li>/g, "<li><p>$1</p></li>");

for (const [name, reserialize] of [["verbatim", (s: string) => s], ["re-serialized", wrapItems]] as const) {
  test(`a second stitch of the same orphan writes nothing (${name} store, sibling neighbour)`, async () => {
    const { run, writes, log } = store(reserialize);
    assert.equal(await reportStitch(run, { only: "101", perOrphan: 3 }), 0);
    assert.ok(log.includes("link\t102\t101\tterm=differs\tsibling"), "the neighbour is a sibling");
    assert.deepEqual(writes, ["102"]);

    log.length = 0;
    assert.equal(await reportStitch(run, { only: "101", perOrphan: 3 }), 0);
    assert.deepEqual(writes, ["102"], "the second run must not write the link again");
    assert.ok(log.includes("pages written: 0"));
    assert.ok(log.includes("unchanged: 1"));
  });
}

test("a block that already exists still takes a new orphan", async () => {
  const { run, writes, bodies } = store(wrapItems);
  bodies.set("102", '<p>n</p><h2>Related pages</h2><ul><li><p><a href="/wiki/spaces/KB/pages/103">Release checklist</a></p></li></ul>');
  await reportStitch(run, { only: "101", perOrphan: 3 });
  assert.deepEqual(writes, ["102"]);
  assert.match(bodies.get("102") ?? "", /pages\/103".*pages\/101"/, "the earlier link is kept and the orphan added");
});

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

const TWO_ORPHANS = [
  { id: "900", title: "Acme", parentId: null },
  { id: "10", title: "Alpha palette design", parentId: "900" },
  { id: "11", title: "Beta palette tokens", parentId: "900" },
  { id: "12", title: "Gamma rotation", parentId: "900" },
];

test("stitch: a refused text search skips that orphan, counts it, and finishes the run", async () => {
  const log: string[] = [];
  const code = await reportStitch(halves(log, {
    pages: TWO_ORPHANS,
    bodies: { "10": '<p><a href="/wiki/spaces/KB/pages/12">g</a></p>' },
    search: (cql) => (cql.endsWith('"alpha palette design"') ? 403 : null),
  }), { dryRun: true, perOrphan: 3 });
  assert.equal(code, 1);
  const err = errors(log);
  assert.match(err[0], /^unsearched\t10\texact-term search: HTTP 403\. /);
  assert.ok(err[0].endsWith('cql: space="KB" and type=page and text ~ "alpha palette design"'));
  assert.deepEqual(log.filter((line) => line.startsWith("link\t")), ["link\t10\t11\tterm=palette\tsibling"],
    "the second orphan is still searched; the first gets no link");
  assert.ok(log.includes("orphans: 2"));
  assert.ok(log.includes("pages that would be written: 1"));
  assert.ok(log.includes("isolated: 0"));
  assert.equal(err.at(-1), "1 orphan(s) were never searched. Their neighbours are UNKNOWN.");
});

test("stitch sends the sanitised CQL for the issue's title", async () => {
  const log: string[] = [];
  const cqls: string[] = [];
  const pages = [...PAGES, { id: "77", title: ISSUE_TITLE, parentId: "900" }];
  await reportStitch(halves(log, { pages, cqls }), { only: "77", dryRun: true });
  assert.deepEqual(cqls, ['space="KB" and type=page and text ~ "four files import confluence evidence modules grep bootstrap claude codex"']);
});

test("stitch: a semantic error names the orphan it left unsearched", async () => {
  const log: string[] = [];
  const code = await reportStitch(halves(log, { semantic: { titles: [], error: "semantic search failed" } }),
    { only: "901", dryRun: true });
  assert.equal(code, 1);
  assert.deepEqual(errors(log), ["unsearched\t901\tsemantic search failed",
    "1 orphan(s) were never searched. Their neighbours are UNKNOWN."]);
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

// stitch --only with a real update callback: the eligible exact title beside
// an unreadable row must not be written; the same title fully readable must.
async function stitchOnly10(results: unknown[]) {
  const log: string[] = [];
  const writes: string[] = [];
  const run = { ...halves(log, { pages: TWO_ORPHANS, semantic: { titles: [] }, results: () => results }),
    update: async (id: string) => { writes.push(id); } };
  const code = await reportStitch(run, { only: "10", perOrphan: 3 });
  return { code, log, writes };
}

test("stitch --only: an incompletely read exact half writes nothing and counts the orphan unsearched", async () => {
  const { code, log, writes } = await stitchOnly10([{ title: "Beta palette tokens" }, {}]);
  assert.equal(code, 1);
  assert.deepEqual(writes, []);
  assert.ok(!log.some((line) => line.startsWith("link\t")));
  assert.ok(log.includes("isolated: 0"));
  assert.ok(log.includes("pages written: 0"));
  const err = errors(log);
  assert.match(err[0],
    /^unsearched\t10\texact-term search: 1 of 2 result row\(s\) had no readable title\. Hits from this half are incomplete and UNKNOWN\. cql: /);
  assert.ok(err[0].endsWith('text ~ "alpha palette design"'));
  assert.equal(err.at(-1), "1 orphan(s) were never searched. Their neighbours are UNKNOWN.");
});

test("stitch --only control: the same exact title fully readable links and writes", async () => {
  const { code, log, writes } = await stitchOnly10([{ title: "Beta palette tokens" }]);
  assert.equal(code, 0);
  assert.ok(log.includes("link\t11\t10\tterm=palette\tsibling"));
  assert.deepEqual(writes, ["11"]);
  assert.ok(!errors(log).some((line) => line.startsWith("unsearched")));
});

test("stitch sweep: an unreadable orphan is unsearched, not isolated; the other is still linked", async () => {
  const log: string[] = [];
  const code = await reportStitch(halves(log, {
    pages: TWO_ORPHANS,
    bodies: { "10": '<p><a href="/wiki/spaces/KB/pages/12">g</a></p>' },
    results: (cql) => (cql.endsWith('"alpha palette design"') ? [{}] : []),
  }), { dryRun: true, perOrphan: 3 });
  assert.equal(code, 1);
  const err = errors(log);
  assert.match(err[0], /^unsearched\t10\texact-term search: 1 of 1 result row\(s\)/);
  assert.deepEqual(log.filter((line) => line.startsWith("link\t")), ["link\t10\t11\tterm=palette\tsibling"]);
  assert.ok(log.includes("orphans: 2"));
  assert.ok(log.includes("pages that would be written: 1"));
  assert.ok(log.includes("isolated: 0"));
  assert.equal(err.at(-1), "1 orphan(s) were never searched. Their neighbours are UNKNOWN.");
});

test("stitch --only: a non-string title row is unsearched, not isolated", async () => {
  const log: string[] = [];
  const code = await reportStitch(halves(log, { results: () => [{ title: 7 }] }), { only: "901", dryRun: true });
  assert.equal(code, 1);
  assert.ok(log.includes("isolated: 0"));
  assert.ok(!log.some((line) => line.startsWith("link\t")));
  const err = errors(log);
  assert.equal(err.length, 2);
  assert.ok(err[0].startsWith("unsearched\t901\t"));
  assert.match(err[0].slice("unsearched\t901\t".length), ROWS_LINE);
  assert.equal(err[1], "1 orphan(s) were never searched. Their neighbours are UNKNOWN.");
});

// Issue #710. A supplied id selects the targeted mode, even an empty one: the
// falsy "" used to fall through to the sweep and write across the space.
for (const only of ["", "   ", "abc"]) {
  test(`stitch only=${JSON.stringify(only)} refuses before any request instead of sweeping`, async () => {
    const log: string[] = [];
    const run: NeighbourDeps = {
      ...deps(log),
      session: { async request() { throw new Error("no request may run"); } },
      semantic: async () => { throw new Error("no search may run"); },
    };
    assert.equal(await reportStitch(run, { only }), 1);
    assert.deepEqual(log, ["error: --id must be a numeric Confluence page id. Nothing was searched or written."]);
  });
}
