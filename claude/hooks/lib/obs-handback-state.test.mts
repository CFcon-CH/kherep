#!/usr/bin/env node
// Unit test for obs-handback-state.mts (issue #555): the per-agent state the
// PostToolUse recorder writes and the SubagentStop hook reads. Every case
// writes under its own temporary home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearDelivered, hasMeasuredBrief, homeOf, markRefused, OBS_RESULT_FORMAT, PAGE_LINE_FORMAT, pageLinesReason, pageLinesUnreadable, prune,
  readDelivered, recordDelivered, refusedReason, stateDir, validId, writeStopTrace,
} from "./obs-handback-state.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "obs-handback-state-test-")));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
function home(): string {
  const dir = path.join(TMP, `home-${++seq}`);
  fs.mkdirSync(dir);
  return dir;
}

const file = (h: string, name: string) => path.join(stateDir(h), name);

test("validId accepts only a bounded opaque id", () => {
  assert.equal(validId("agent-1_A"), "agent-1_A");
  assert.equal(validId("a".repeat(64)), "a".repeat(64));
  for (const bad of ["", "../x", "a/b", "a\\b", "a.b", "a b", "a".repeat(65), 42, null, undefined, {}]) {
    assert.equal(validId(bad), null, String(bad));
  }
});

test("homeOf is the parent of the invoked hooks directory", () => {
  assert.equal(homeOf(path.join(TMP, "root", "hooks", "obs-result-check.mts")), path.join(TMP, "root"));
  assert.equal(stateDir(path.join(TMP, "root")), path.join(TMP, "root", ".cache", "obs-result-check"));
});

test("recordDelivered stores the verdict and the tool_use_id, last write wins", () => {
  const h = home();
  recordDelivered(h, "a1", "wrote", "toolu_01ABC");
  assert.equal(fs.readFileSync(file(h, "a1.delivered"), "utf8"), "wrote\ttoolu_01ABC\n");
  assert.deepEqual(readDelivered(h, "a1"), { verdict: "wrote", toolUseId: "toolu_01ABC" });
  recordDelivered(h, "a1", "malformed more than one OBS-RESULT line", 42);
  assert.deepEqual(readDelivered(h, "a1"), { verdict: "malformed more than one OBS-RESULT line", toolUseId: "-" });
  recordDelivered(h, "a1", "empty", "not an id");
  assert.deepEqual(readDelivered(h, "a1"), { verdict: "empty", toolUseId: "-" });
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file(h, "a1.delivered")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(stateDir(h)).mode & 0o777, 0o700);
  }
});

test("readDelivered tells an absent state from an unreadable one", () => {
  const h = home();
  assert.equal(readDelivered(h, "none"), null);
  fs.mkdirSync(file(h, "dir.delivered"), { recursive: true });
  assert.equal(readDelivered(h, "dir"), "unreadable");
  fs.writeFileSync(file(h, "notab.delivered"), "wrote\n");
  assert.equal(readDelivered(h, "notab"), "unreadable");
});

test("clearDelivered removes the state, and a missing one is no error", () => {
  const h = home();
  recordDelivered(h, "a1", "wrote", "t1");
  clearDelivered(h, "a1");
  assert.equal(readDelivered(h, "a1"), null);
  clearDelivered(h, "a1");
});

test("reads, clears and prunes create no state directory", () => {
  const h = home();
  readDelivered(h, "a1");
  clearDelivered(h, "a1");
  prune(h);
  assert.equal(fs.existsSync(path.join(h, ".cache")), false);
});

test("prune removes files older than 24 h and keeps young ones", () => {
  const h = home();
  recordDelivered(h, "old", "wrote", "t1");
  recordDelivered(h, "young", "wrote", "t2");
  writeStopTrace(h, "old", { mode: "auto", state: "absent", waited: 0, after: "-", transcript: "none", branch: "auto" });
  const then = new Date(Date.now() - 25 * 3_600_000);
  fs.utimesSync(file(h, "old.delivered"), then, then);
  fs.utimesSync(file(h, "old.stop"), then, then);
  assert.equal(markRefused(h, "old", "t1"), "created");
  assert.equal(markRefused(h, "young", "t2"), "created");
  fs.utimesSync(file(h, "old.refused"), then, then);
  prune(h);
  assert.equal(fs.existsSync(file(h, "old.delivered")), false);
  assert.equal(fs.existsSync(file(h, "old.stop")), false);
  assert.equal(fs.existsSync(file(h, "young.delivered")), true);
  // Issue #571, D1: the gate's once-only marker is retained, old or young.
  assert.equal(fs.readFileSync(file(h, "old.refused"), "utf8"), "refused\tt1\n");
  assert.equal(fs.existsSync(file(h, "young.refused")), true);
});

test("prune does not follow a state directory that is a link", () => {
  const h = home();
  const target = path.join(TMP, `link-target-${seq}`);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "old.delivered"), "wrote\tt1\n");
  const then = new Date(Date.now() - 25 * 3_600_000);
  fs.utimesSync(path.join(target, "old.delivered"), then, then);
  fs.mkdirSync(path.join(h, ".cache"));
  fs.symlinkSync(target, stateDir(h), process.platform === "win32" ? "junction" : "dir");
  prune(h);
  assert.equal(fs.existsSync(path.join(target, "old.delivered")), true);
});

test("writeStopTrace writes the fixed keys and never a payload value", () => {
  const h = home();
  writeStopTrace(h, "a1", { mode: "auto", state: "absent", waited: 300, after: "present", transcript: "none", branch: "state" });
  assert.equal(fs.readFileSync(file(h, "a1.stop"), "utf8"),
    "mode=auto state=absent waited=300 after=present transcript=none branch=state\n");
  writeStopTrace(h, "a1", { mode: "Example Corp host.example.com", state: "present", waited: 0, after: "-", transcript: "delivered", branch: "state" });
  assert.match(fs.readFileSync(file(h, "a1.stop"), "utf8"), /^mode=other state=present /);
  writeStopTrace(h, "a1", { mode: undefined, state: "present", waited: 0, after: "-", transcript: "delivered", branch: "state" });
  assert.match(fs.readFileSync(file(h, "a1.stop"), "utf8"), /^mode=- /);
});

// Issue #571: the once-only marker of the PreToolUse gate obs-handback-gate.mts.
test("markRefused creates the marker once, then reports that it exists", () => {
  const h = home();
  assert.equal(markRefused(h, "a1", "toolu_01ABC"), "created");
  assert.equal(fs.readFileSync(file(h, "a1.refused"), "utf8"), "refused\ttoolu_01ABC\n");
  assert.equal(markRefused(h, "a1", "toolu_02DEF"), "exists");
  assert.equal(fs.readFileSync(file(h, "a1.refused"), "utf8"), "refused\ttoolu_01ABC\n");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file(h, "a1.refused")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(stateDir(h)).mode & 0o777, 0o700);
  }
  assert.equal(markRefused(h, "a2", 42), "created");
  assert.equal(fs.readFileSync(file(h, "a2.refused"), "utf8"), "refused\t-\n");
  assert.equal(markRefused(h, "a3", "not an id"), "created");
  assert.equal(fs.readFileSync(file(h, "a3.refused"), "utf8"), "refused\t-\n");
});

test("markRefused reports a directory in the marker's place as exists", () => {
  const h = home();
  fs.mkdirSync(file(h, "d1.refused"), { recursive: true });
  assert.equal(markRefused(h, "d1", "t1"), "exists");
});

const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
test("markRefused reports an unwritable state directory as failed", { skip: process.platform === "win32" || asRoot }, () => {
  const h = home();
  fs.mkdirSync(stateDir(h), { recursive: true });
  fs.chmodSync(stateDir(h), 0o500);
  try {
    assert.equal(markRefused(h, "a1", "t1"), "failed");
    assert.equal(fs.existsSync(file(h, "a1.refused")), false);
  } finally {
    fs.chmodSync(stateDir(h), 0o700);
  }
});

test("the gate reason carries the shared format on one line", () => {
  assert.ok(refusedReason("x").includes(OBS_RESULT_FORMAT));
  assert.doesNotMatch(refusedReason("x"), /\n/);
});

// Issue #950. The page line check of the gate: fixed texts, and a predicate
// that reads only a measured brief of a valid session.
const ONCE = "This refusal happens once; the next handback is delivered as sent and checked by the recorder.";
test("the gate reasons are fixed one-line texts, and without page lines the #571 text is unchanged", () => {
  assert.equal(refusedReason("x"), "Kherep obs-handback-gate: OBS-RESULT check (ROUTING.md, Session observations): the first non-empty line of your "
    + "SubagentHandback message is not exactly one valid status line (x). Send the handback again with exactly one OBS-RESULT line as its first line, "
    + "restated from what you actually did: `OBS-RESULT: wrote <n> <page ids>` with n equal to the number of numeric ids, or `OBS-RESULT: empty <reason>` "
    + `or \`OBS-RESULT: failed <reason>\`, the reason not starting with wrote, empty or failed. Create no further pages. ${ONCE}`);
  assert.equal(refusedReason("x", true), refusedReason("x").replace(ONCE, `A \`measured:\` brief is recorded for this session: ${PAGE_LINE_FORMAT} ${ONCE}`));
  assert.equal(pageLinesReason(), "Kherep obs-handback-gate: page line check (claude-obs, Result): a `measured:` brief is recorded for this session and "
    + "not every page id of your `OBS-RESULT: wrote` line has a page line in the required form. Send the handback again with the same status line and the "
    + "same page list: after the status line one line per written page, exactly `<id> finding=<n|-> evidence=<confirmed|assumed|refuted|superseded> <title>`, "
    + "`<n>` the 1-based position of the brief finding the page files, never above the number of findings in the brief, `-` when it files none, and the "
    + `label the page actually carries. Create no further pages. ${ONCE}`);
  assert.doesNotMatch(refusedReason("x", true) + pageLinesReason(), /\n/);
});

test("hasMeasuredBrief and pageLinesUnreadable read only a measured brief of a valid session", () => {
  const h = home();
  const sid = "950c0000-0000-4000-8000-000000000001";
  const old = "OBS-RESULT: wrote 1 11\n11 A";
  const both = (session: unknown, message = old) => [hasMeasuredBrief(h, session), pageLinesUnreadable(h, session, message)];
  assert.deepEqual(both(sid), [false, false], "no brief");
  assert.equal(fs.existsSync(path.join(h, ".cache")), false, "a read creates no state");
  fs.mkdirSync(stateDir(h), { recursive: true });
  fs.writeFileSync(file(h, `${sid}.brief`), "measured=1 findings=1\n");
  assert.deepEqual(both(sid), [true, true]);
  assert.deepEqual(both(sid, "OBS-RESULT: wrote 1 11\n11 finding=1 evidence=assumed A"), [true, false], "readable");
  assert.deepEqual(both(sid, "OBS-RESULT: wrote 1 11\n11 finding=2 evidence=assumed A"), [true, true], "above the finding count");
  assert.deepEqual(both(sid, "OBS-RESULT: empty nothing new"), [true, false], "no page id");
  for (const bad of [sid.toUpperCase(), undefined, 42, "../x"]) assert.deepEqual(both(bad), [false, false], String(bad));
  fs.writeFileSync(file(h, `${sid}.brief`), "measured=- findings=1\n");
  assert.deepEqual(both(sid), [false, false], "nothing measured");
  fs.rmSync(file(h, `${sid}.brief`));
  fs.mkdirSync(file(h, `${sid}.brief`));
  assert.deepEqual(both(sid), [false, false], "an unreadable brief");
});
