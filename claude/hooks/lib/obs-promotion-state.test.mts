#!/usr/bin/env node
// Unit test for the promotion state of obs-handback-state.mts (issue #731
// PR-B): the session-keyed .brief and pending .promote files. Every case writes under
// its own temporary home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claimJoin, joinKey, pendingPromotion, prune, readBrief, recordBrief, recordPromotion, stateDir, validSession } from "./obs-handback-state.mts";
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
// A read-only directory refuses writes only for a non-root user on POSIX.
const NO_CHMOD = process.platform === "win32" || process.getuid?.() === 0;
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

// The pending files of the session, and the ids in each, in name order.
const PENDING = new RegExp(`^${SID}\\.promote\\.\\d+\\.[0-9a-f]{12}$`);
const pendingFiles = (h: string) => fs.readdirSync(stateDir(h)).filter((name) => PENDING.test(name)).sort((a, b) => a.localeCompare(b));
const pendingLines = (h: string) => pendingFiles(h).map((name) => fs.readFileSync(file(h, name), "utf8")).sort((a, b) => a.localeCompare(b));

test("each join with hits writes its own pending file, and an unreadable label warns", () => {
  const h = home();
  recordBrief(h, SID, BRIEF);
  assert.equal(recordPromotion(h, SID, ["11", "12"], claudePages(RESULT)), null);
  assert.deepEqual(pendingLines(h), ["11\n"]);
  const warning = recordPromotion(h, SID, ["9", "100"], claudePages("9 finding=1 evidence=assumed Nine"));
  assert.match(String(warning), /page\(s\) 100 could not be read/);
  recordPromotion(h, SID, ["10", "9"], claudePages("10 finding=3 evidence=assumed Ten\n9 finding=1 evidence=assumed Nine"));
  assert.deepEqual(pendingLines(h), ["11\n", "9,10\n", "9\n"].sort((a, b) => a.localeCompare(b)), "never a merge; ids in numeric order");
  assert.equal(pendingPromotion(h, SID), promotionReason(["9", "10", "11"]), "one reason, de-duplicated and sorted");
  assert.deepEqual(pendingFiles(h), []);
});

test("a temp file that cannot be written leaves no pending file", { skip: NO_CHMOD }, () => {
  const h = home();
  recordBrief(h, SID, BRIEF);
  fs.chmodSync(stateDir(h), 0o500); // the directory refuses the temp file
  try {
    assert.equal(recordPromotion(h, SID, ["11"], claudePages(RESULT)), null);
  } finally {
    fs.chmodSync(stateDir(h), 0o700);
  }
  assert.deepEqual(fs.readdirSync(stateDir(h)), [`${SID}.brief`]);
});

test("without a recorded brief the join warns about possible hits, and writes nothing", () => {
  const h = home();
  assert.match(String(recordPromotion(h, SID, ["11", "12"], claudePages(RESULT))),
    /page\(s\) 11 were filed evidence-assumed but could not be joined to the dispatch brief \(no dispatch brief recorded for this session\)/);
  assert.equal(recordPromotion(h, SID, ["12"], claudePages(RESULT)), null, "no page that could be a hit: silent");
  fs.mkdirSync(stateDir(h), { recursive: true });
  fs.writeFileSync(file(h, `${SID}.brief`), "measured=x\n");
  assert.match(String(recordPromotion(h, SID, ["11"], claudePages(RESULT))), /no dispatch brief recorded/, "an unreadable brief is no brief");
  assert.deepEqual(pendingFiles(h), []);
});

test("a recorded brief without a measured finding stays silent and writes nothing", () => {
  const h = home();
  recordBrief(h, SID, "relayed: a\nrelayed: b");
  assert.equal(recordPromotion(h, SID, ["11", "12"], claudePages(RESULT)), null);
  assert.deepEqual(pendingFiles(h), []);
});

test("recordBrief never throws, whatever it is handed", () => {
  const h = home();
  recordBrief(h, SID, undefined as unknown as string);
  recordBrief(() => { throw new Error("no home"); }, SID, BRIEF);
  assert.equal(fs.existsSync(path.join(h, ".cache")), false);
  recordBrief(() => h, SID, BRIEF);
  assert.deepEqual(readBrief(h, SID), { measured: [1, 3], findings: 3 }, "a home given as a function");
});

test("a write in the window between another Stop's claim and its read is delivered alone by the next Stop", () => {
  const h = home();
  recordBrief(h, SID, BRIEF);
  recordPromotion(h, SID, ["11"], claudePages(RESULT));
  const [first] = pendingFiles(h);
  const claimed = file(h, `${first}.4242.claim`);
  fs.renameSync(file(h, first!), claimed); // another Stop has claimed, not yet read
  recordPromotion(h, SID, ["9"], claudePages("9 finding=3 evidence=assumed Nine"));
  assert.equal(fs.readFileSync(claimed, "utf8"), "11\n", "the claimed copy is untouched");
  assert.equal(pendingPromotion(h, SID), promotionReason(["9"]), "the next Stop names only the new id");
  assert.equal(pendingPromotion(h, SID), null);
  assert.deepEqual(fs.readdirSync(stateDir(h)).filter((name) => name.includes(".promote")), [`${first}.4242.claim`], "no own claim or temp file left");
});

test("joinKey is the tool_use_id when valid, else a digest of the trimmed status line", () => {
  assert.equal(joinKey("toolu_01", "anything"), "toolu_01");
  const key = joinKey(undefined, "\n  OBS-RESULT: wrote 1 11  \n11 finding=1 evidence=assumed T");
  assert.match(key, /^s[0-9a-f]{16}$/);
  assert.equal(joinKey(null, "OBS-RESULT: wrote 1 11\nother page lines"), key, "the same status line, the same key");
  assert.equal(joinKey("../x", "OBS-RESULT: wrote 1 11"), key, "an invalid tool_use_id falls back to the status line");
  assert.notEqual(joinKey(undefined, "OBS-RESULT: wrote 1 12"), key);
  assert.match(joinKey(undefined, ""), /^s[0-9a-f]{16}$/);
});

test("claimJoin lets one hook join a result, once", () => {
  const h = home();
  assert.equal(claimJoin(h, "agent-1", "toolu_01"), true);
  assert.equal(claimJoin(h, "agent-1", "toolu_01"), false, "the same handback again");
  assert.equal(claimJoin(h, "agent-1", "toolu_02"), true, "a later handback of the same agent");
  assert.equal(claimJoin(h, null, "toolu_03"), true, "without an agent id the join is unguarded");
  assert.equal(claimJoin(h, null, "toolu_03"), true);
  const blocked = home();
  fs.mkdirSync(path.join(blocked, ".cache"));
  fs.writeFileSync(path.join(blocked, ".cache", "obs-result-check"), "a file, not the state directory");
  assert.equal(claimJoin(blocked, "agent-1", "toolu_01"), true, "an unwritable marker never blocks the join");
});

test("without a session id the join warns about possible hits only, and keeps no state", () => {
  const h = home();
  assert.match(String(recordPromotion(h, undefined, ["11", "12"], claudePages(RESULT))), /page\(s\) 11 were filed evidence-assumed but could not be joined/);
  assert.equal(recordPromotion(h, "Not An Id", ["12"], claudePages(RESULT)), null);
  assert.equal(fs.existsSync(path.join(h, ".cache")), false);
});

test("pendingPromotion consumes once: the reason, then nothing", () => {
  const h = home();
  assert.equal(pendingPromotion(h, SID), null, "no state directory");
  recordBrief(h, SID, BRIEF);
  recordPromotion(h, SID, ["11", "12"], claudePages(RESULT));
  fs.writeFileSync(file(h, "other-session.promote.1.abcdef012345"), "77\n");
  assert.equal(pendingPromotion(h, SID), promotionReason(["11"]));
  assert.deepEqual(pendingFiles(h), []);
  assert.equal(pendingPromotion(h, SID), null);
  assert.equal(pendingPromotion(h, undefined), null);
  assert.ok(fs.existsSync(file(h, "other-session.promote.1.abcdef012345")), "another session's file is not claimed");
});

test("pendingPromotion removes a corrupt file without a reason, and skips what it cannot claim or remove", { skip: NO_CHMOD }, () => {
  const h = home();
  fs.mkdirSync(stateDir(h), { recursive: true });
  fs.writeFileSync(file(h, `${SID}.promote`), "x\n");
  assert.equal(pendingPromotion(h, SID), null);
  assert.equal(fs.existsSync(file(h, `${SID}.promote`)), false);
  fs.mkdirSync(file(h, `${SID}.promote`));
  assert.equal(pendingPromotion(h, SID), null, "a directory is neither read nor emitted");
  fs.writeFileSync(file(h, `${SID}.promote.1.abcdef012345`), "5\n");
  fs.chmodSync(stateDir(h), 0o500); // the rename that claims is refused
  try {
    assert.equal(pendingPromotion(h, SID), null);
  } finally {
    fs.chmodSync(stateDir(h), 0o700);
  }
  assert.equal(pendingPromotion(h, SID), promotionReason(["5"]), "delivered once the claim succeeds");
});

test("prune removes old .brief, pending, .joined, claim and temp files like every other state file", () => {
  const h = home();
  recordBrief(h, SID, BRIEF);
  recordPromotion(h, SID, ["11"], claudePages(RESULT));
  claimJoin(h, "agent-1", "toolu_01");
  const leftovers = [`${SID}.promote.77.abcdef012345.12.claim`, `${SID}.promote.78.abcdef012345.tmp`];
  for (const name of leftovers) fs.writeFileSync(file(h, name), "11\n");
  const old = new Date(Date.now() - 2 * 86_400_000);
  for (const name of [`${SID}.brief`, ...pendingFiles(h), "agent-1.toolu_01.joined", ...leftovers]) fs.utimesSync(file(h, name), old, old);
  prune(h);
  assert.deepEqual(fs.readdirSync(stateDir(h)), []);
});
