#!/usr/bin/env node
// Unit test for the promotion state of obs-handback-state.mts (issue #731
// PR-B): the session-keyed .brief and .promote files. Every case writes under
// its own temporary home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pendingPromotion, prune, readBrief, recordBrief, recordPromotion, stateDir, validSession } from "./obs-handback-state.mts";
import { claudePages, promotionReason } from "./obs-promotion-policy.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "obs-promotion-state-test-")));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
function home(): string {
  const dir = path.join(TMP, `home-${++seq}`);
  fs.mkdirSync(dir);
  return dir;
}
const SID = "0f3c2a9e-1b7d-4c55-9e21-5a0d6b8c4f17";
const file = (h: string, name: string) => path.join(stateDir(h), name);
const BRIEF = `Session id: ${SID}\n- measured: code kherep \`npm test\` -> 42 pass\n- relayed: the operator\n- measured: live \`curl -sI x\` -> 200`;
const RESULT = "OBS-RESULT: wrote 2 11,12\n11 finding=1 evidence=assumed Build passes\n12 finding=3 evidence=confirmed Endpoint answers";

test("validSession accepts only the session id shape the dispatch guard checks", () => {
  assert.equal(validSession(SID), SID);
  for (const bad of ["", "Upper", "-lead", "a/b", "a.b", "a".repeat(81), 7, null, undefined]) assert.equal(validSession(bad), null, String(bad));
});

test("recordBrief writes the integer line for a valid session only, and readBrief reads it back", () => {
  const h = home();
  recordBrief(h, SID, BRIEF);
  assert.equal(fs.readFileSync(file(h, `${SID}.brief`), "utf8"), "measured=1,3 findings=3\n");
  assert.deepEqual(readBrief(h, SID), { measured: [1, 3], findings: 3 });
  const bare = home();
  recordBrief(bare, "../x", BRIEF);
  recordBrief(bare, undefined, BRIEF);
  assert.equal(fs.existsSync(path.join(bare, ".cache")), false, "no session id, no state");
});

test("readBrief is null for an absent, unreadable or malformed brief", () => {
  const h = home();
  assert.equal(readBrief(h, SID), null);
  fs.mkdirSync(stateDir(h), { recursive: true });
  fs.writeFileSync(file(h, `${SID}.brief`), "measured=1 findings=0\n");
  assert.equal(readBrief(h, SID), null);
  fs.rmSync(file(h, `${SID}.brief`));
  fs.mkdirSync(file(h, `${SID}.brief`));
  assert.equal(readBrief(h, SID), null, "a directory is unreadable");
});

test("a hit is written to .promote, idempotently, and an unreadable label warns", () => {
  const h = home();
  recordBrief(h, SID, BRIEF);
  assert.equal(recordPromotion(h, SID, ["11", "12"], claudePages(RESULT)), null);
  assert.equal(fs.readFileSync(file(h, `${SID}.promote`), "utf8"), "11\n");
  assert.equal(recordPromotion(h, SID, ["11", "12"], claudePages(RESULT)), null, "the second join changes nothing");
  assert.equal(fs.readFileSync(file(h, `${SID}.promote`), "utf8"), "11\n");
  const warning = recordPromotion(h, SID, ["9", "100"], claudePages("9 finding=1 evidence=assumed Nine"));
  assert.match(String(warning), /page\(s\) 100 could not be read/);
  assert.equal(fs.readFileSync(file(h, `${SID}.promote`), "utf8"), "9,11\n", "pending ids are kept, ordered numerically");
  recordPromotion(h, SID, ["10"], claudePages("10 finding=3 evidence=assumed Ten"));
  assert.equal(fs.readFileSync(file(h, `${SID}.promote`), "utf8"), "9,10,11\n", "ids of one length in numeric order");
});

test("a corrupt pending file is replaced by the new hits", () => {
  const h = home();
  recordBrief(h, SID, BRIEF);
  fs.writeFileSync(file(h, `${SID}.promote`), "not ids\n");
  recordPromotion(h, SID, ["11"], claudePages(RESULT));
  assert.equal(fs.readFileSync(file(h, `${SID}.promote`), "utf8"), "11\n");
});

test("without a brief or without a measured finding the join is silent and writes nothing", () => {
  const h = home();
  assert.equal(recordPromotion(h, SID, ["11", "12"], new Map()), null);
  recordBrief(h, SID, "relayed: a\nrelayed: b");
  assert.equal(recordPromotion(h, SID, ["11", "12"], new Map()), null);
  assert.equal(fs.existsSync(file(h, `${SID}.promote`)), false);
});

test("without a session id the join warns about possible hits only, and keeps no state", () => {
  const h = home();
  assert.match(String(recordPromotion(h, undefined, ["11", "12"], claudePages(RESULT))), /page\(s\) 11 were filed evidence-assumed but could not be joined/);
  assert.equal(recordPromotion(h, "Not An Id", ["12"], claudePages(RESULT)), null);
  assert.equal(fs.existsSync(path.join(h, ".cache")), false);
});

test("pendingPromotion consumes once: the reason, then nothing", () => {
  const h = home();
  recordBrief(h, SID, BRIEF);
  recordPromotion(h, SID, ["11", "12"], claudePages(RESULT));
  assert.equal(pendingPromotion(h, SID), promotionReason(["11"]));
  assert.equal(fs.existsSync(file(h, `${SID}.promote`)), false);
  assert.equal(pendingPromotion(h, SID), null);
  assert.equal(pendingPromotion(h, undefined), null);
});

test("pendingPromotion removes a corrupt file without a reason, and emits nothing it could not remove", () => {
  const h = home();
  fs.mkdirSync(stateDir(h), { recursive: true });
  fs.writeFileSync(file(h, `${SID}.promote`), "x\n");
  assert.equal(pendingPromotion(h, SID), null);
  assert.equal(fs.existsSync(file(h, `${SID}.promote`)), false);
  fs.mkdirSync(file(h, `${SID}.promote`));
  assert.equal(pendingPromotion(h, SID), null, "a directory is neither read nor emitted");
});

test("prune removes old .brief and .promote files like every other state file", () => {
  const h = home();
  recordBrief(h, SID, BRIEF);
  recordPromotion(h, SID, ["11"], claudePages(RESULT));
  const old = new Date(Date.now() - 2 * 86_400_000);
  for (const name of [`${SID}.brief`, `${SID}.promote`]) fs.utimesSync(file(h, name), old, old);
  prune(h);
  assert.deepEqual(fs.readdirSync(stateDir(h)), []);
});
