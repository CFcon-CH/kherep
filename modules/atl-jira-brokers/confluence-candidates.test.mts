// Issue #736: what a stitch may link and how a decision is bound to the
// candidate set the broker produced. Pure functions, no fixtures beyond a
// hand-built space index.
import assert from "node:assert/strict";
import test from "node:test";

import {
  areaOf,
  candidateRow,
  checkDecisions,
  parseDecisions,
  parseReceipt,
  RECEIPT_KIND,
  selectCandidates,
  type Receipt,
} from "./confluence-candidates.mts";
import type { IndexedPage, SpaceIndex } from "./confluence-related.mts";

function indexOf(pages: IndexedPage[]): SpaceIndex {
  const index: SpaceIndex = { byId: new Map(), byTitle: new Map(), parents: new Set() };
  for (const page of pages) {
    index.byId.set(page.id, page);
    index.byTitle.set(page.title.toLowerCase(), page);
    if (page.parentId) index.parents.add(page.parentId);
  }
  return index;
}

const INDEX = indexOf([
  { id: "1", title: "Kherep", parentId: null },
  { id: "2", title: "Operations", parentId: "1" },
  { id: "10", title: "Logon task workaround", parentId: "2" },
  { id: "11", title: "Scheduled task account at logon", parentId: "2" },
  { id: "12", title: "Owner probe retry state", parentId: "1" },
  { id: "13", title: "Logon task trigger delay", parentId: "2" },
]);

const item = (id: string, title: string, snippet = "") => ({ id, title, snippet });

test("a hit is matched by id before title", () => {
  // The id names page 13 although the title names page 11: the id wins.
  const out = selectCandidates(INDEX, { id: "10", title: "Logon task workaround" },
    [item("13", "Scheduled task account at logon", "delay")], [], 5);
  assert.deepEqual(out.map((c) => c.id), ["13"]);
  assert.equal(out[0].title, "Logon task trigger delay", "the title is the space's, not the hit's");
});

test("a hit without a usable id falls back to its exact title", () => {
  const out = selectCandidates(INDEX, { id: "10", title: "Logon task workaround" },
    [item("", "scheduled task account at logon"), item("999", "Owner probe retry state")], [], 5);
  assert.deepEqual(out.map((c) => c.id), ["11", "12"], "an id outside the space still matches by title");
});

test("self, shelf, foreign and duplicate hits are dropped; order and limit are kept", () => {
  const out = selectCandidates(INDEX, { id: "10", title: "Logon task workaround" }, [
    item("10", "Logon task workaround"),
    item("2", "Operations"),
    item("", "A page in another space"),
    item("12", "Owner probe retry state", "Retries."),
    item("", "Owner probe retry state"),
  ], ["Logon task trigger delay", "Scheduled task account at logon"], 2);
  assert.deepEqual(out.map((c) => c.id), ["12", "13"]);
});

test("area is the ancestor chain and terms are a hint that never filters", () => {
  const out = selectCandidates(INDEX, { id: "10", title: "Logon task workaround" },
    [item("12", "Owner probe retry state", "<p>Retries\tthe probe.</p>"), item("13", "")], ["Logon task trigger delay"], 5);
  assert.deepEqual(out[0], { id: "12", title: "Owner probe retry state", area: "Kherep", terms: [], snippet: "Retries the probe." });
  assert.equal(out[1].area, "Kherep > Operations");
  assert.deepEqual(out[1].terms, ["logon", "task"]);
  assert.equal(areaOf(INDEX, INDEX.byId.get("1")!), "");
});

test("a candidate row is five tab-separated single-line fields", () => {
  assert.equal(candidateRow({ id: "13", title: "A\tB", area: "Kherep > Operations", terms: ["logon", "task"], snippet: "s" }),
    "13\tA B\tKherep > Operations\tlogon,task\ts");
});

const NOW = Date.parse("2026-11-02T10:00:00Z");
const RECEIPT: Receipt = {
  kind: RECEIPT_KIND, source: "10", spaceKey: "KB", query: "Logon task workaround. A topic.",
  searchedAt: "2026-11-02T09:30:00Z",
  candidates: [
    { id: "11", title: "Scheduled task account at logon", area: "Kherep > Operations", terms: [], snippet: "" },
    { id: "13", title: "Logon task trigger delay", area: "Kherep > Operations", terms: ["logon"], snippet: "" },
  ],
};
const EXPECTED = { source: "10", spaceKey: "KB", now: NOW };
const REASON = "Same logon task, documents its trigger delay.";

test("a receipt survives a JSON round trip and a malformed one is no receipt", () => {
  assert.deepEqual(parseReceipt(JSON.stringify(RECEIPT)), RECEIPT);
  assert.equal(parseReceipt("not json"), null);
  assert.equal(parseReceipt(JSON.stringify({ ...RECEIPT, candidates: [{ id: "x", title: "t" }] })), null);
  assert.equal(parseReceipt(JSON.stringify({ ...RECEIPT, source: 10 })), null);
});

test("decisions are one id and reason per line; blank lines and an empty file are allowed", () => {
  assert.deepEqual(parseDecisions(""), []);
  assert.deepEqual(parseDecisions(`11\t${REASON}\r\n\n13\tfirst\tsecond  part\n14\n`), [
    { id: "11", reason: REASON }, { id: "13", reason: "first second part" }, { id: "14", reason: "" },
  ]);
});

test("valid decisions against a fresh matching receipt raise no problem", () => {
  assert.deepEqual(checkDecisions(RECEIPT, [{ id: "11", reason: REASON }], EXPECTED), []);
  assert.deepEqual(checkDecisions(RECEIPT, [], EXPECTED), []);
});

test("every receipt-level refusal is named against the source page", () => {
  const cases: [Receipt | null, string][] = [
    [null, "the candidates file is not a stitch receipt"],
    [{ ...RECEIPT, kind: "other" as typeof RECEIPT_KIND }, "the candidates file is not a stitch receipt"],
    [{ ...RECEIPT, spaceKey: "OTHER" }, "the receipt is for another space"],
    [{ ...RECEIPT, source: "99" }, "the receipt is for another page"],
    [{ ...RECEIPT, searchedAt: "2026-11-02T07:59:00Z" }, "the receipt is older than 2 h"],
    [{ ...RECEIPT, searchedAt: "2026-11-02T11:00:00Z" }, "the receipt is dated in the future"],
    [{ ...RECEIPT, searchedAt: "yesterday" }, "the receipt has no readable search time"],
  ];
  for (const [receipt, why] of cases) {
    assert.deepEqual(checkDecisions(receipt, [], EXPECTED), [{ id: "10", why }], why);
  }
  assert.deepEqual(checkDecisions({ ...RECEIPT, spaceKey: "kb" }, [], EXPECTED), [], "space keys compare case-blind");
});

test("every decision-level refusal is named per id, all at once", () => {
  const problems = checkDecisions(RECEIPT, [
    { id: "12", reason: REASON },
    { id: "11", reason: REASON },
    { id: "11", reason: REASON },
    { id: "13", reason: "" },
    { id: "abc", reason: REASON },
    { id: "13", reason: "too short" },
    { id: "11", reason: "x".repeat(301) },
  ], EXPECTED);
  assert.deepEqual(problems, [
    { id: "12", why: "not a candidate in the receipt" },
    { id: "11", why: "decided more than once" },
    { id: "13", why: "no reason given" },
    { id: "abc", why: "not a numeric page id" },
    { id: "13", why: "decided more than once" },
    { id: "13", why: "reason shorter than 10 characters" },
    { id: "11", why: "decided more than once" },
    { id: "11", why: "reason longer than 300 characters" },
  ]);
});
