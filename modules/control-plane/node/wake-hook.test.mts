import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listenerScope } from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { getMessage, markOffered, MAX_REPLY_DEPTH, readJson, writeJsonAtomic } from "./inbox.mts";
import { writeTask } from "./task-records.mts";
import {
  killSwitch, listenerDir, REARM_TEXT, runWake, WAKE_GRACE_MS, WAKE_MAX_WAIT_MS, WAKE_POLL_MS, WAKE_SETTLE_MS, WAKE_TIMEOUT_S,
  wakeAudit, wakeText,
} from "./wake-hook.mts";
import { arrive, auditLines, listen, lockFile, SECRET, SELF, setup, T0 } from "./wake-fixture.mts";
import { wokeFile } from "./wake-pending.mts";

// The wake listener (issue #31): a fake clock and sleep drive it, so no test
// waits in real time except the one that runs the script as Claude Code would.
// wake-guards.test.mts covers the policy, budget and permission guards.

const HOOK = fileURLToPath(new URL("./wake-hook.mts", import.meta.url));
const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was "
  + "created\\)\\r?\\n", "gm");
const withoutTypeStrippingWarning = (stderr: string | Buffer): string => String(stderr).replace(TYPE_STRIPPING_WARNING, "");
// Preloaded into the spawned hook: the process listing fails, so the run mode
// (headless-mode.mts) comes from CLAUDE_CODE_ENTRYPOINT alone, whatever started
// the test (a claude -p or a --bg session included). The hook keeps its real
// parent, so the parent check runs as in a session.
const NO_LISTING = `data:text/javascript,${encodeURIComponent("import cp from 'node:child_process';"
  + "import { syncBuiltinESMExports } from 'node:module';"
  + "cp.execFile = (...args) => { setImmediate(() => args.at(-1)(new Error('no listing'))); return {}; };"
  + "syncBuiltinESMExports();")}`;
// Preloaded instead: the listing shows the hook's parent as claude -p, as when
// sh -c execs the hook in a Claude Code process (issue #245).
const PRINT_LISTING = `data:text/javascript,${encodeURIComponent("import cp from 'node:child_process';"
  + "import { syncBuiltinESMExports } from 'node:module';"
  + "const rows = [[process.ppid, 1, 'claude -p hi'], [1, 0, 'init']];"
  + "const out = process.platform === 'win32' ? JSON.stringify(rows.map(([ProcessId, ParentProcessId, CommandLine]) => "
  + "({ ProcessId, ParentProcessId, CommandLine }))) : rows.map((row) => row.join(' ')).join(String.fromCharCode(10));"
  + "cp.execFile = (...args) => { setImmediate(() => args.at(-1)(null, out)); return {}; };"
  + "syncBuiltinESMExports();")}`;

test("wakes with the fixed text for a message that arrives after the grace period, by name or id", async (t) => {
  const { paths } = setup(t);
  let byName = "";
  let byId = "";
  const result = await listen(paths, { token: "tok", tick: (clock) => {
    if (clock === T0 + 2 * WAKE_POLL_MS) {
      byName = arrive(paths, 1, clock);
      byId = arrive(paths, 2, clock, SELF);
    }
  } });
  assert.deepEqual(result, { code: 2, text: wakeText(2) });
  // Issue #417: the woken turn's UserPromptSubmit claims this marker.
  assert.deepEqual(readJson(wokeFile(paths, SELF)),
    { wokenAt: T0 + 2 * WAKE_POLL_MS + WAKE_SETTLE_MS, token: "tok", messageIds: [byName, byId] });
  assert.ok(!fs.readFileSync(wokeFile(paths, SELF), "utf8").includes(SECRET), "the marker never carries message text");
  assert.equal(wakeText(2), "Kherep: 2 new message(s) from other agent sessions arrived. They are delivered in this turn.");
  assert.deepEqual(auditLines(paths),
    [{ ts: new Date(T0 + 2 * WAKE_POLL_MS + WAKE_SETTLE_MS).toISOString(), sessionId: SELF, messageIds: [byName, byId], action: "wake" }]);
  assert.ok(!fs.readFileSync(wakeAudit(paths), "utf8").includes(SECRET), "the audit never carries message text");
  assert.equal(getMessage(paths.inbox, byName)?.state, "accepted", "the delivery hook of the woken turn offers it");
  assert.equal(fs.existsSync(lockFile(paths)), false);
});

test("ignores what arrived up to the grace period after arming, then re-arms itself before the timeout", async (t) => {
  const { paths } = setup(t);
  const before = arrive(paths, 1, T0 - 1_000);
  let during = "";
  const result = await listen(paths, { maxWaitMs: 10_000, tick: (clock) => {
    if (clock === T0 + WAKE_POLL_MS) during = arrive(paths, 2, T0 + WAKE_GRACE_MS);
  } });
  // Claude Code kills a listener at its timeout without waking the session, so
  // the listener wakes it first; that turn starts the next listener.
  assert.deepEqual(result, { code: 2, text: REARM_TEXT });
  assert.equal(REARM_TEXT, "Kherep: message listener re-armed.");
  assert.equal(WAKE_MAX_WAIT_MS, (WAKE_TIMEOUT_S - 60) * 1000);
  assert.deepEqual([getMessage(paths.inbox, before)?.state, getMessage(paths.inbox, during)?.state], ["accepted", "accepted"]);
  assert.deepEqual(auditLines(paths).map((l) => [l.action, l.messageIds]), [["rearm", []]]);
  assert.equal(fs.existsSync(lockFile(paths)), false, "the re-arming listener releases its lock");
  assert.equal(fs.existsSync(wokeFile(paths, SELF)), false, "a re-arm leaves no wake marker");
});

test("re-reads the state before waking: a message a delivery hook offered meanwhile wakes nobody", async (t) => {
  const { paths } = setup(t);
  let messageId = "";
  const result = await listen(paths, { maxWaitMs: 10_000, tick: (clock) => {
    if (clock === T0 + 2 * WAKE_POLL_MS) messageId = arrive(paths, 1, clock);
    if (clock === T0 + 2 * WAKE_POLL_MS + WAKE_SETTLE_MS) markOffered(paths.inbox, messageId, clock);
  } });
  assert.equal(getMessage(paths.inbox, messageId)?.state, "offered");
  assert.deepEqual(result, { code: 2, text: REARM_TEXT });
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["rearm"]);
});

test("a listener replaced by a newer one exits quietly and leaves the new lock; identity is the token", async (t) => {
  const { paths } = setup(t);
  // Same pid and start time, other token: still another listener.
  const newer = { token: "newer", pid: 4242, startedAt: T0, event: "Stop" };
  const result = await listen(paths, { token: "older", tick: () => writeJsonAtomic(lockFile(paths), newer) });
  assert.deepEqual(result, { code: 0 });
  assert.deepEqual(auditLines(paths).map((l) => [l.action, l.messageIds]), [["superseded", []]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile(paths), "utf8")), newer);
  // A lost lock and scope end the listener without a line (a lock alone is put back: listener-sweep.test.mts).
  const lost = setup(t).paths;
  const lose = (): void => { for (const file of [lockFile(lost), listenerScope(lost, SELF)]) fs.rmSync(file); };
  assert.deepEqual(await listen(lost, { tick: lose }), { code: 0 });
  assert.deepEqual(auditLines(lost), []);
});

test("the kill switch and an unenrolled machine keep the listener from starting", async (t) => {
  const { paths } = setup(t);
  fs.writeFileSync(killSwitch(paths), "");
  arrive(paths, 1, T0 + 10_000);
  assert.deepEqual(await listen(paths, { tick: () => assert.fail("no poll with the kill switch set") }), { code: 0 });
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["disabled"]);
  assert.equal(fs.existsSync(listenerDir(paths)), false);

  const none = setup(t, { enrolled: false }).paths;
  assert.deepEqual(await listen(none, { tick: () => assert.fail("no poll without a node") }), { code: 0 });
  assert.equal(fs.existsSync(none.dir), false, "an unenrolled machine gets no files");
  for (const bad of [undefined, "", "../x", "a/b"]) {
    assert.deepEqual(await runWake({ session_id: bad, hook_event_name: "Stop" }, { paths, sleep: async () => assert.fail("no poll") }),
      { code: 0 });
  }
  assert.deepEqual(await runWake({ session_id: SELF, hook_event_name: "PreToolUse" }, { paths, sleep: async () => assert.fail("no poll") }),
    { code: 0 });
});

test("a message at the reply limit does not wake the session; the audit says so once", async (t) => {
  const { paths } = setup(t);
  const deep = arrive(paths, 1, T0 + 5_000, "review", MAX_REPLY_DEPTH);
  assert.deepEqual(await listen(paths, { maxWaitMs: 20_000 }), { code: 2, text: REARM_TEXT });
  assert.deepEqual(auditLines(paths).map((l) => [l.action, l.messageIds]), [["depth-limit", [deep]], ["rearm", []]]);
  assert.equal(getMessage(paths.inbox, deep)?.state, "accepted");

  const mixed = setup(t).paths;
  arrive(mixed, 1, T0 + 5_000, "review", MAX_REPLY_DEPTH);
  let shallow="";
  assert.deepEqual(await listen(mixed,{tick:clock=>{if(clock===T0+2*WAKE_POLL_MS)shallow=arrive(mixed,2,clock,"review",MAX_REPLY_DEPTH-1);}}),{code:2,text:wakeText(1)});
  assert.deepEqual(auditLines(mixed).map((l) => l.action), ["depth-limit", "wake"]);
  assert.deepEqual(auditLines(mixed)[1].messageIds, [shallow]);
});

// Issue #213: the listener reads the policy at every poll, so an allowlist
// change reaches a listener that is already armed. The live case: a task
// session the allowlist does not name listens on its task grant alone.
const TASK = "3f2a1b0c-0000-4000-8000-000000000001";
const writePolicy = (paths: NodePaths, wake?: unknown): void => fs.writeFileSync(paths.policy, JSON.stringify({ version: 1,
  allowedCommands: [], ...(wake === undefined ? {} : { wake }), sessions: { enabled: true, workspaceRoots: [paths.dir] } }));
function grantOnly(t: test.TestContext): NodePaths {
  const { paths } = setup(t);
  writePolicy(paths, { enabled: true, sessions: ["someone-else"] });
  writeTask(paths, { taskId: TASK, name: "task-3f2a1b0c", cwd: paths.dir, permissionMode: "auto", state: "running", sessionId: SELF,
    startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 7_200_000).toISOString(), updatedAt: new Date(T0).toISOString() });
  return paths;
}

test("a listener armed while the session was not allowlisted wakes for its messages once the policy says \"*\"", async (t) => {
  const paths = grantOnly(t);
  let message = "";
  const result = await listen(paths, { tick: (clock) => {
    if (clock === T0 + 2 * WAKE_POLL_MS) writePolicy(paths, { enabled: true, sessions: ["*"] });
    if (clock === T0 + 4 * WAKE_POLL_MS) message = arrive(paths, 1, clock);
  } });
  assert.deepEqual(result, { code: 2, text: wakeText(1) });
  assert.deepEqual(auditLines(paths).map((l) => [l.action, l.messageIds]), [["wake", [message]]]);
});

test("a listener on its task grant alone does not wake for another message until the policy allows the session", async (t) => {
  const paths = grantOnly(t);
  const allowAt = T0 + 10 * WAKE_POLL_MS;
  let message = "";
  let scope: unknown;
  const result = await listen(paths, { token: "listener-1", tick: (clock) => {
    if (clock === T0 + 2 * WAKE_POLL_MS) message = arrive(paths, 1, clock);
    if (clock !== allowAt) return;
    assert.equal(getMessage(paths.inbox, message)?.state, "accepted");
    scope = readJson(listenerScope(paths, SELF));
    writePolicy(paths, { enabled: true, sessions: ["review"] });
  } });
  assert.deepEqual(result, { code: 2, text: wakeText(1) });
  // What the daemon reads to report progress (delivery-progress.mts): the grant only, not the allowlist.
  assert.deepEqual(scope, { token: "listener-1", listed: false, taskId: TASK, order: T0 });
  assert.deepEqual(auditLines(paths).map((l) => [l.ts, l.action, l.messageIds]),
    [[new Date(allowAt + WAKE_SETTLE_MS).toISOString(), "wake", [message]]]);
});

test("a disabled wake section or a withdrawn allowlist entry ends the listener: lock released, audit not-allowlisted", async (t) => {
  for (const wake of [{ enabled: false }, { enabled: true, sessions: ["someone-else"] }]) {
    const { paths } = setup(t);
    const result = await listen(paths, { tick: (clock) => {
      if (clock === T0 + 2 * WAKE_POLL_MS) writePolicy(paths, wake);
      if (clock === T0 + 3 * WAKE_POLL_MS) arrive(paths, 1, clock);
    } });
    assert.deepEqual(result, { code: 0 }, JSON.stringify({ wake }));
    assert.equal(fs.existsSync(lockFile(paths)), false);
    assert.deepEqual(auditLines(paths).map((l) => [l.ts, l.action]), [[new Date(T0 + 2 * WAKE_POLL_MS).toISOString(), "not-allowlisted"]]);
  }
});

test("an unreadable policy file keeps the listener on its last good policy and is audited once", async (t) => {
  const { paths } = setup(t);
  let message = "";
  const result = await listen(paths, { tick: (clock) => {
    if (clock === T0 + 2 * WAKE_POLL_MS) fs.writeFileSync(paths.policy, "{ half written");
    if (clock === T0 + 5 * WAKE_POLL_MS) message = arrive(paths, 1, clock);
  } });
  assert.deepEqual(result, { code: 2, text: wakeText(1) });
  assert.deepEqual(auditLines(paths).map((l) => [l.action, l.messageIds]), [["policy-unreadable", []], ["wake", [message]]]);
});

test("runs as Claude Code starts it: exit 2 with the wake text on stderr, exit 0 without a node or with a bad --timeout", (t) => {
  const { root, paths } = setup(t);
  // Arrived well after the grace period, so the first poll wakes.
  arrive(paths, 1, Date.now() + 60_000, SELF);
  const input = JSON.stringify({ session_id: SELF, hook_event_name: "Stop", stop_hook_active: false, permission_mode: "default" });
  const run = (args: string[], dir: string, stdin = input, entrypoint = "cli") => spawnSync(process.execPath,
    ["--import", NO_LISTING, HOOK, ...args],
    { input: stdin, env: { ...process.env, KHEREP_CONFIG_DIR: dir, CLAUDE_CODE_ENTRYPOINT: entrypoint }, encoding: "utf8", timeout: 30_000 });
  // A --timeout too short for the re-arm margin ends it before it listens.
  const short = run(["--timeout", "90"], root);
  assert.deepEqual([short.status, short.stdout, withoutTypeStrippingWarning(short.stderr)], [0, "", ""]);
  // A headless run (claude -p, issue #235) gets no listener: exit 0 at once, the message still waits.
  const headless = run(["--timeout", String(WAKE_TIMEOUT_S)], root, input, "sdk-cli");
  assert.deepEqual([headless.status, headless.stdout, withoutTypeStrippingWarning(headless.stderr)], [0, "", ""]);
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["headless"]);
  const woken = run(["--timeout", String(WAKE_TIMEOUT_S)], root);
  assert.deepEqual([woken.status,woken.stdout,withoutTypeStrippingWarning(woken.stderr)],[0,"",""],"CLI without native producer facts cannot grant message wake");

  const empty = setup(t, { enrolled: false }).root;
  for (const stdin of [input, "{not json", ""]) {
    const quiet = run([], empty, stdin);
    assert.deepEqual([quiet.status, quiet.stdout, withoutTypeStrippingWarning(quiet.stderr)], [0, "", ""], stdin);
  }
});

test("a second hook of the same Claude Code process takes the kept run mode and lists no processes (issues #245, #248)", (t) => {
  // Kept under CLAUDE_PID (issue #248), else under the hook's parent pid, this test's process.
  for (const [claudePid, key] of [["4242", "4242"], [undefined, String(process.pid)]] as const) {
    const { root, paths } = setup(t);
    arrive(paths, 1, Date.now() + 60_000, SELF);
    const input = JSON.stringify({ session_id: SELF, hook_event_name: "Stop", stop_hook_active: false, permission_mode: "default" });
    for (const listing of [PRINT_LISTING, NO_LISTING]) {
      const run = spawnSync(process.execPath, ["--import", listing, HOOK, "--timeout", String(WAKE_TIMEOUT_S)], { input, encoding: "utf8",
        env: { ...process.env, KHEREP_CONFIG_DIR: root, CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PID: claudePid }, timeout: 30_000 });
      assert.deepEqual([run.status, run.stdout, withoutTypeStrippingWarning(run.stderr)], [0, "", ""]);
    }
    // Without the kept mode the second hook, whose listing fails, would listen and wake for the waiting message.
    assert.deepEqual(auditLines(paths).map((l) => l.action), ["headless", "headless"], key);
    assert.deepEqual(fs.readdirSync(path.join(paths.dir, "run-modes")), [`${SELF}.${key}.json`]);
  }
});

// Claude Code on Windows starts each hook through bash -c, so each hook has a
// fresh shell as its parent (issue #248). "$@"; exit keeps bash as the parent
// instead of letting it exec node; MSYS2_ARG_CONV_EXCL keeps Git Bash from
// rewriting the arguments. The preload records each hook's parent pid. Git
// Bash parses its Windows command line itself and drops quote characters, so
// the characters encodeURIComponent leaves alone are percent-encoded too.
const bashSafe = (arg: string): string => arg.startsWith("data:")
  ? arg.replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`) : arg;
// On Windows a plain "bash" may resolve to the WSL launcher, which cannot run
// this node.exe, so the test names Git Bash, as Claude Code uses it there.
// Elsewhere (a per-user install) the test skips.
const GIT_BASH = ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"];
const BASH = process.platform === "win32" ? GIT_BASH.find((file) => fs.existsSync(file)) ?? null : "bash";
const viaBash = (args: string[], options: Parameters<typeof spawnSync>[2] = {}) =>
  spawnSync(BASH ?? "bash", ["-c", "\"$@\"; exit $?", "bash", ...args.map(bashSafe)], { encoding: "utf8", timeout: 30_000, ...options });
const RECORD_PPID = `data:text/javascript,${encodeURIComponent("import fs from 'node:fs';"
  + "fs.appendFileSync(process.env.KHEREP_TEST_PPID_LOG, process.ppid + String.fromCharCode(10));")}`;
// Only a bash that really ran this node counts: the probe must print its result.
const bashProbe = BASH === null ? null : viaBash([process.execPath, "-p", "1+1"], { env: { ...process.env, MSYS2_ARG_CONV_EXCL: "*" } });
const bashRunsNode = bashProbe?.status === 0 && String(bashProbe.stdout).trim() === "2";

test("hooks behind a fresh bash each take the run mode kept under CLAUDE_PID (issue #248)",
  { skip: bashRunsNode ? false : "no bash that runs this node" }, (t) => {
    const { root, paths } = setup(t);
    arrive(paths, 1, Date.now() + 60_000, SELF);
    const log = path.join(root, "parent-pids");
    const input = JSON.stringify({ session_id: SELF, hook_event_name: "Stop", stop_hook_active: false, permission_mode: "default" });
    for (const listing of [PRINT_LISTING, NO_LISTING]) {
      const run = viaBash([process.execPath, "--import", RECORD_PPID, "--import", listing, HOOK, "--timeout", String(WAKE_TIMEOUT_S)],
        { input, env: { ...process.env, KHEREP_CONFIG_DIR: root, CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PID: "4242",
          KHEREP_TEST_PPID_LOG: log, MSYS2_ARG_CONV_EXCL: "*" } });
      assert.deepEqual([run.status, run.stdout, withoutTypeStrippingWarning(run.stderr)], [0, "", ""]);
    }
    const parents = fs.readFileSync(log, "utf8").trim().split(/\r?\n/);
    // Windows may reuse a pid for the second shell, so only check that a shell, not this process, was the parent.
    assert.equal(parents.length, 2, "both hooks recorded their parent");
    assert.ok(!parents.includes(String(process.pid)), "each hook has a shell as parent");
    // The second hook's listing fails: only the kept mode makes it headless instead of waking.
    assert.deepEqual(auditLines(paths).map((l) => l.action), ["headless", "headless"]);
    assert.deepEqual(fs.readdirSync(path.join(paths.dir, "run-modes")), [`${SELF}.4242.json`]);
  });

test("guarded20 wakes through pending/listener while malformed admission stays blocked", async (t) => {
  for (const valid of [true, false]) {
    const { paths } = setup(t);
    const id = arrive(paths, 1, T0 + 5_000, "review", 20);
    const record = getMessage(paths.inbox, id)!;
    writeJsonAtomic(path.join(paths.inbox, `${id}.json`), { ...record,
      loop: { version: valid ? 1 : 2, threadId: id, depth: 20, generation: 0, ordinal: 21 } });
    const outcome = await listen(paths, { maxWaitMs: 20_000 });
    assert.deepEqual(outcome, { code: 2, text: valid ? wakeText(1) : REARM_TEXT });
    assert.equal(auditLines(paths).some((r) => r.action === "wake"), valid);
  }
});
