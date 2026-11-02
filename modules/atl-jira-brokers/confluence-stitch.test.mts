// Issue #736 replayed. A new page W about a Windows logon scheduled-task
// workaround got backlinks from an owner-probe page (A) and a Codex idle-state
// page (B), on the shared title words "account" and "state". The fake search
// below answers in the measured ranking: the bare title puts A and B at ranks 4
// and 6 among the on-topic pages, the topic sentence puts C1-C4 at ranks 1-4.
// No network: the session answers from an in-memory page store.
import assert from "node:assert/strict";
import test from "node:test";

import { RECEIPT_KIND, type Receipt } from "./confluence-candidates.mts";
import { requestError, SCOPES, type ConfluenceSession } from "./confluence-contract.mts";
import type { Proposals } from "./confluence-semantic.mts";
import { stitchCandidates, stitchDecisions, stitchSweep, type StitchDeps } from "./confluence-stitch.mts";

const PAGES = [
  { id: "1", title: "Kherep", parentId: null },
  { id: "2", title: "Operations", parentId: "1" },
  { id: "3", title: "Agents", parentId: "1" },
  { id: "500", title: "Windows logon task workaround for the agent account state", parentId: "2" },
  { id: "601", title: "Owner probe retry when the account lookup fails", parentId: "3" },
  { id: "602", title: "Codex session idle state after a switch", parentId: "3" },
  { id: "701", title: "Scheduled task does not start at Windows logon", parentId: "2" },
  { id: "702", title: "Task Scheduler trigger delay after logon", parentId: "2" },
  { id: "703", title: "Run a hook as the interactive user at logon", parentId: "2" },
  { id: "704", title: "Windows session 0 isolation blocks the tray app", parentId: "2" },
  // Perfect title-term overlap with W, and still no decision names it.
  { id: "705", title: "Agent account state workaround logon", parentId: "3" },
];
const W = "500";
const TOPIC = "A scheduled task registered for the logon trigger never starts under the service account; running it as the interactive user fixes it.";
const title = (id: string) => PAGES.find((page) => page.id === id)!.title;
const hit = (id: string) => ({ id, title: title(id), snippet: `<p>Body of ${title(id)}.</p>` });
// The measured rankings, top first.
const BY_TITLE = ["701", "705", "702", "601", "703", "602", "704"].map(hit);
const BY_TOPIC = ["701", "702", "703", "704", "705", "601"].map(hit);

interface Fixture {
  deps: StitchDeps;
  log: string[];
  errors: string[];
  puts: { id: string; storage: string; message: string }[];
  queries: { query: string; spaceKey?: string }[];
  files: Map<string, string>;
  bodies: Map<string, string>;
  now: { value: number };
}

function fixture(options: {
  pages?: typeof PAGES;
  search?: () => number | null;
  results?: () => unknown[];
  semantic?: Proposals;
  reserialize?: (storage: string) => string;
} = {}): Fixture {
  const pages = options.pages ?? PAGES;
  const bodies = new Map(pages.map((page) => [page.id, `<p>${page.title}</p>`]));
  bodies.set("701", '<p>c1</p><p><a href="/wiki/spaces/KB/pages/702">x</a></p>');
  const log: string[] = [];
  const errors: string[] = [];
  const puts: Fixture["puts"] = [];
  const queries: Fixture["queries"] = [];
  const files = new Map<string, string>();
  const now = { value: Date.parse("2026-11-02T10:00:00Z") };
  const session: ConfluenceSession = {
    async request(spec) {
      if (spec.path.includes("/spaces/")) return { status: 200, json: { results: pages, _links: {} } };
      if (spec.path.includes("/search")) {
        const refused = options.search?.();
        if (refused) throw requestError({ method: "GET", path: spec.path, scope: SCOPES.get }, refused, {});
        return { status: 200, json: { results: options.results?.() ?? [] } };
      }
      const id = /\/pages\/([^/?]+)/.exec(spec.path)?.[1] ?? "";
      return { status: 200, json: { body: { storage: { value: bodies.get(id) ?? "" } } } };
    },
  };
  const deps: StitchDeps = {
    session, spaceId: "42", spaceKey: "KB",
    log: (line) => log.push(line),
    logError: (line) => errors.push(line),
    semantic: async (query, _limit, opts) => {
      queries.push({ query, spaceKey: opts?.spaceKey });
      if (options.semantic) return options.semantic;
      const items = query.includes("interactive user") ? BY_TOPIC : BY_TITLE;
      return { titles: items.map((item) => item.title), items };
    },
    update: async (id, storage, message) => {
      puts.push({ id, storage, message });
      bodies.set(id, options.reserialize ? options.reserialize(storage) : storage);
    },
    now: () => now.value,
    readText: async (path) => {
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files.get(path)!;
    },
    writeNew: async (path, text) => {
      if (files.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      files.set(path, text);
    },
  };
  return { deps, log, errors, puts, queries, files, bodies, now };
}

const REASON_C1 = "Same logon-trigger task that never starts; this page has the root cause.";
const REASON_C2 = "Documents the trigger delay the workaround has to tolerate at logon.";

async function candidates(f: Fixture, out = "/r/receipt.json", perPage = 4): Promise<number> {
  return await stitchCandidates(f.deps, { id: W, topic: TOPIC, out, perPage });
}

async function decide(f: Fixture, lines: string, receipt = "/r/receipt.json"): Promise<number> {
  f.files.set("/r/decisions.txt", lines);
  return await stitchDecisions(f.deps, { id: W, candidates: receipt, decisions: "/r/decisions.txt" });
}

test("candidate mode searches by topic in the space, writes the receipt and nothing else", async () => {
  const f = fixture();
  assert.equal(await candidates(f), 0);
  assert.deepEqual(f.puts, [], "candidate mode never writes a page");
  assert.equal(f.queries.length, 1);
  assert.equal(f.queries[0].spaceKey, "KB");
  assert.ok(f.queries[0].query.startsWith(`${title(W)}. A scheduled task`), f.queries[0].query);
  const rows = f.log.filter((line) => line.startsWith("candidate\t"));
  assert.deepEqual(rows.map((line) => line.split("\t")[1]), ["701", "702", "703", "704"], "the on-topic pages, in rank order");
  // "logon" is in five of eleven titles here, so it is not a rare term.
  assert.deepEqual(rows[0].split("\t"), ["candidate", "701", title("701"), "Kherep > Operations", "task,windows",
    `Body of ${title("701")}.`]);
  assert.ok(f.log.includes("receipt\t/r/receipt.json"));
  assert.ok(f.log.includes("count: 4"));
  const receipt = JSON.parse(f.files.get("/r/receipt.json")!) as Receipt;
  assert.equal(receipt.kind, RECEIPT_KIND);
  assert.equal(receipt.source, W);
  assert.equal(receipt.spaceKey, "KB");
  assert.equal(receipt.searchedAt, "2026-11-02T10:00:00.000Z");
  assert.deepEqual(receipt.candidates.map((c) => c.id), ["701", "702", "703", "704"]);
});

test("decisions {C1, C2} write exactly C1 and C2, each with its reason", async () => {
  const f = fixture();
  await candidates(f);
  assert.equal(await decide(f, `701\t${REASON_C1}\n702\t${REASON_C2}\n`), 0);
  assert.deepEqual(f.puts.map((put) => put.id), ["701", "702"]);
  assert.match(f.puts[0].message, /link 500\. Same logon-trigger task/);
  assert.match(f.bodies.get("701")!, /<h2>Related pages<\/h2>.*pages\/500"/);
  assert.match(f.bodies.get("701")!, /pages\/702">x<\/a>/, "the body before the block is kept");
  assert.ok(f.log.includes(`link\t701\t500\treason=${REASON_C1}\tarea=Kherep > Operations`));
  assert.ok(f.log.includes(`link\t702\t500\treason=${REASON_C2}\tarea=Kherep > Operations`));
  assert.ok(f.log.includes("pages written: 2"));
  assert.ok(!f.puts.some((put) => ["601", "602", "705"].includes(put.id)), "no off-topic page is touched");
});

test("a decision naming a page outside the receipt is refused with zero PUTs", async () => {
  const f = fixture();
  await candidates(f);
  assert.equal(await decide(f, `701\t${REASON_C1}\n601\tShares the word account with the new page.\n`), 1);
  assert.deepEqual(f.puts, []);
  assert.deepEqual(f.log.filter((line) => line.startsWith("refused\t")), ["refused\t601\tnot a candidate in the receipt"]);
  assert.deepEqual(f.errors, ["Nothing was written."]);
});

test("a receipt for another source page is refused", async () => {
  const f = fixture();
  await candidates(f);
  const receipt = JSON.parse(f.files.get("/r/receipt.json")!) as Receipt;
  f.files.set("/r/other.json", JSON.stringify({ ...receipt, source: "703" }));
  assert.equal(await decide(f, `701\t${REASON_C1}\n`, "/r/other.json"), 1);
  assert.deepEqual(f.puts, []);
  assert.ok(f.log.includes("refused\t500\tthe receipt is for another page"));
});

test("a receipt older than 2 h, or unreadable files, are refused before anything is read from the space", async () => {
  const f = fixture();
  await candidates(f);
  f.now.value += 2 * 60 * 60 * 1000 + 1;
  assert.equal(await decide(f, `701\t${REASON_C1}\n`), 1);
  assert.ok(f.log.includes("refused\t500\tthe receipt is older than 2 h"));
  assert.equal(await stitchDecisions(f.deps, { id: W, candidates: "/r/none.json", decisions: "/r/decisions.txt" }), 1);
  assert.ok(f.log.includes("refused\t500\t--candidates is not readable"));
  assert.deepEqual(f.puts, []);
});

test("an empty decisions file ends in nolink and writes nothing", async () => {
  const f = fixture();
  await candidates(f);
  assert.equal(await decide(f, ""), 0);
  assert.deepEqual(f.puts, []);
  assert.deepEqual(f.log.at(-1), "nolink\t500\tno candidate on topic");
});

test("perfect title-term overlap without a decision writes nothing", async () => {
  const f = fixture();
  assert.equal(await stitchCandidates(f.deps, { id: W, topic: TOPIC, out: "/r/receipt.json", perPage: 5 }), 0);
  const row = f.log.find((line) => line.startsWith("candidate\t705\t"))!;
  assert.match(row, /\tagent,account,state,workaround\t/, "every rare content word of the title is shared");
  assert.equal(await decide(f, ""), 0);
  assert.deepEqual(f.puts, [], "shared words are a hint, never a link");
});

test("the sweep lists candidates per orphan and writes nothing", async () => {
  const f = fixture();
  f.deps.update = async () => { throw new Error("the sweep must not write"); };
  assert.equal(await stitchSweep(f.deps, { perPage: 3 }), 0);
  assert.ok(f.log.includes(`orphan\t${W}\t${title(W)}`));
  assert.ok(f.log.some((line) => line.startsWith("candidate\t")));
  assert.ok(f.log.includes("pages written: 0 (the sweep is read-only; link with stitch --id and decisions)"));
  assert.ok(f.queries.every((q) => q.spaceKey === "KB"));
  assert.ok(f.queries.some((q) => q.query.startsWith("Windows logon task workaround for the agent account state. Windows logon")),
    "an orphan's topic is the opening of its own body");
  assert.deepEqual(f.errors, []);
});

// Issue #479 against write mode: a block Confluence hands back re-serialized
// still counts as linked, so the same decision a second time writes nothing.
const wrapItems = (storage: string) => storage.replace(/<li>(<a\b[^>]*>.*?<\/a>)<\/li>/g, "<li><p>$1</p></li>");
for (const [name, reserialize] of [["verbatim", (s: string) => s], ["re-serialized", wrapItems]] as const) {
  test(`the same decision twice writes once (${name} store)`, async () => {
    const f = fixture({ reserialize });
    await candidates(f);
    assert.equal(await decide(f, `702\t${REASON_C2}\n`), 0);
    assert.equal(await decide(f, `702\t${REASON_C2}\n`), 0);
    assert.deepEqual(f.puts.map((put) => put.id), ["702"]);
    assert.ok(f.log.includes("unchanged: 1"));
  });
}

test("a block that already exists keeps its links and takes the new page", async () => {
  const f = fixture();
  f.bodies.set("703", '<p>n</p><h2>Related pages</h2><ul><li><p><a href="/wiki/spaces/KB/pages/704">t</a></p></li></ul>');
  await candidates(f);
  await decide(f, "703\tRuns the same hook as the interactive user at logon.\n");
  assert.match(f.bodies.get("703")!, /pages\/704".*pages\/500"/);
});

// Issues #651 and #656: a refused or half-read exact half leaves the candidate
// set UNKNOWN; no receipt exists, so no write can follow from it.
const HALF_FAILURES: [string, Parameters<typeof fixture>[0]][] = [
  ["a refused exact half", { search: () => 403 }],
  ["an unreadable exact row", { results: () => [{}] }],
  ["a failed semantic half", { semantic: { titles: [], error: "semantic search did not run: twg not found" } }],
];
for (const [name, opts] of HALF_FAILURES) {
  test(`${name} is unsearched, exit 1, and writes no receipt`, async () => {
    const f = fixture(opts);
    assert.equal(await candidates(f), 1);
    assert.equal(f.files.size, 0);
    assert.ok(!f.log.some((line) => line.startsWith("candidate\t")));
    assert.match(f.errors[0], /^unsearched\t500\t/);
    assert.match(f.errors[1], /UNKNOWN; no receipt was written/);
  });
}

test("a sweep with an unsearched orphan exits 1 and names it", async () => {
  const f = fixture({ search: () => 500 });
  assert.equal(await stitchSweep(f.deps, { limit: 2 }), 1);
  assert.equal(f.errors.filter((line) => line.startsWith("unsearched\t")).length, 2);
  assert.equal(f.errors.at(-1), "2 orphan(s) were never searched. Their candidates are UNKNOWN.");
});

test("an existing --out is refused and nothing is printed as a candidate", async () => {
  const f = fixture();
  f.files.set("/r/receipt.json", "{}");
  assert.equal(await candidates(f), 1);
  assert.equal(f.files.get("/r/receipt.json"), "{}");
  assert.ok(!f.log.some((line) => line.startsWith("candidate\t")));
  assert.match(f.errors[0], /--out was not written: it already exists/);
});

test("an empty topic and an id outside the space are refused before any search", async () => {
  const f = fixture();
  assert.equal(await stitchCandidates(f.deps, { id: W, topic: "  ", out: "/r/a.json" }), 1);
  assert.equal(await stitchCandidates(f.deps, { id: "999", topic: TOPIC, out: "/r/b.json" }), 1);
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.errors, ["--topic is empty. A title alone is not a topic; nothing was searched.",
    "That id is not a page in this space."]);
});
