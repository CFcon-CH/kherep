#!/usr/bin/env node
// Unit test for obs-promotion-policy.mts (issue #731 PR-B): the brief record,
// the result labels and their join. Pure: no file is touched.
import assert from "node:assert/strict";
import test from "node:test";

import {
  briefRecord, claudeIds, claudePages, formatBrief, joinPromotion, parseBrief, PROMOTION_PREFIX, promotionReason, unjoinable,
  unjoinedWarning, unreadableWarning, type PageEvidence,
} from "./obs-promotion-policy.mts";

const SHA = "2733b35e2c102ac54295568509c68b18b6d92cab";
const BRIEF = [
  "Session id: 0f3c2a9e-1b7d-4c55-9e21-5a0d6b8c4f17",
  "Scope: Kherep",
  "- measured: code kherep `npm test` -> 42 pass",
  "- relayed: the operator",
  `2. measured: code kherep@${SHA} -- a.mts \`node a.mts\` -> ok`,
  "measured: live `curl -sI https://example.com` -> 200",
].join("\n");

test("the brief record holds the 1-based measured: positions and the finding count only", () => {
  assert.deepEqual(briefRecord(BRIEF), { measured: [1, 3, 4], findings: 4 });
  assert.deepEqual(briefRecord("relayed: a\nrelayed: b"), { measured: [], findings: 2 });
  assert.deepEqual(briefRecord("no marker at all"), { measured: [], findings: 0 });
});

test("formatBrief and parseBrief round-trip one integer line", () => {
  assert.equal(formatBrief({ measured: [1, 3, 4], findings: 4 }), "measured=1,3,4 findings=4\n");
  assert.equal(formatBrief({ measured: [], findings: 2 }), "measured=- findings=2\n");
  for (const record of [{ measured: [1, 3, 4], findings: 4 }, { measured: [], findings: 0 }, { measured: [2], findings: 9999 }]) {
    assert.deepEqual(parseBrief(formatBrief(record)), record);
  }
  assert.deepEqual(parseBrief("measured=2 findings=3"), { measured: [2], findings: 3 }, "the newline is optional");
});

test("parseBrief refuses anything but one valid line", () => {
  for (const bad of ["", "measured= findings=1\n", "measured=0 findings=1\n", "measured=1 findings=01\n", "measured=1,x findings=2\n",
    "measured=1 findings=2\nmeasured=1 findings=2\n", "measured=5 findings=4\n", "measured=10000 findings=10000\n", "findings=1 measured=1\n"]) {
    assert.equal(parseBrief(bad), null, JSON.stringify(bad));
  }
});

test("claudeIds reads the ids of a wrote status line, and nothing else", () => {
  assert.deepEqual(claudeIds("\nOBS-RESULT: wrote 2 11,12\n11 finding=1 evidence=assumed T"), ["11", "12"]);
  assert.deepEqual(claudeIds("OBS-RESULT:\twrote  3 1 2, 3"), ["1", "2", "3"]);
  assert.deepEqual(claudeIds("OBS-RESULT: empty nothing new"), []);
  assert.deepEqual(claudeIds("OBS-RESULT: failed broker down"), []);
  assert.deepEqual(claudeIds("Report.\nOBS-RESULT: wrote 1 5"), [], "only the first non-empty line counts");
  assert.deepEqual(claudeIds(""), []);
  assert.deepEqual(claudeIds("OBS-RESULT: wrote 2 7 ../8"), ["7"], "a non-numeric id is never returned");
});

test("claudePages reads exactly the documented page line, an optional bullet allowed", () => {
  const pages = claudePages([
    "OBS-RESULT: wrote 5 1,2,3,4,5",
    "1 finding=2 evidence=assumed A finding about the build",
    "- 2 finding=- evidence=confirmed Page without a finding",
    "*\t3 finding=4 evidence=refuted Third",
    "4 finding=1 evidence=assumed",
    "5 finding=1 evidence=guessed Bad label",
    "1 finding=3 evidence=confirmed The first line of an id wins",
    "6 (id, title) old format",
  ].join("\r\n"));
  assert.deepEqual([...pages.entries()], [
    ["1", { finding: 2, evidence: "assumed" }],
    ["2", { finding: null, evidence: "confirmed" }],
    ["3", { finding: 4, evidence: "refuted" }],
  ]);
  assert.equal(claudePages("7 finding=0 evidence=assumed Zero is no position").size, 0);
});

const pages = (rows: [string, number | null, string][]) => new Map<string, PageEvidence>(rows.map(([id, finding, evidence]) => [id, { finding, evidence }]));

test("a hit is a page filed assumed for a measured finding", () => {
  const brief = { measured: [1, 3], findings: 4 };
  const result = joinPromotion(brief, ["10", "11", "12", "13", "14"], pages([
    ["10", 1, "assumed"], ["11", 3, "confirmed"], ["12", 2, "assumed"], ["13", null, "assumed"], ["14", 3, "assumed"],
  ]));
  assert.deepEqual(result, { hits: ["10", "14"], unreadable: [] });
});

test("an id without a label or naming a finding the brief lacks is unreadable, never a hit", () => {
  const brief = { measured: [1], findings: 2 };
  assert.deepEqual(joinPromotion(brief, ["1", "2", "3"], pages([["1", 1, "assumed"], ["2", 3, "assumed"]])), { hits: ["1"], unreadable: ["2", "3"] });
  assert.deepEqual(joinPromotion(brief, ["1", "2"], new Map()), { hits: [], unreadable: ["1", "2"] }, "no parsable label at all");
});

test("without a measured finding or without a brief there is nothing to join", () => {
  const filed = pages([["1", 1, "assumed"]]);
  assert.deepEqual(joinPromotion({ measured: [], findings: 3 }, ["1", "2"], filed), { hits: [], unreadable: [] });
  assert.deepEqual(joinPromotion(null, ["1", "2"], filed), { hits: [], unreadable: [] });
});

test("unjoinable names the pages that could be a hit without a brief", () => {
  assert.deepEqual(unjoinable(["1", "2", "3", "4"], pages([["1", 1, "assumed"], ["2", null, "assumed"], ["3", 2, "confirmed"]])), ["1"]);
});

test("the delivered texts are fixed and name only the page ids", () => {
  assert.equal(promotionReason(["123", "456"]),
    "Kherep obs-promotion: page(s) 123, 456 were filed evidence-assumed for finding(s) the brief marked measured:. "
    + "In this turn, for each page run the Confluence broker evidence verb (--mode prepare, then decide, then verify) with this turn's measurement, "
    + "or state in your final message why it cannot be promoted (for example no exact code binding). A marker alone never promotes a page.");
  assert.match(unreadableWarning(["7"]), /^Kherep obs-promotion: the evidence labels of page\(s\) 7 could not be read/);
  assert.match(unjoinedWarning(["8", "9"]), /^Kherep obs-promotion: page\(s\) 8, 9 were filed evidence-assumed but could not be joined .*no session id/);
  for (const text of [promotionReason(["1"]), unreadableWarning(["1"]), unjoinedWarning(["1"])]) assert.ok(text.startsWith(PROMOTION_PREFIX));
});
