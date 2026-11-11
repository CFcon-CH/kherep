import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { listenerScope, markListenerIdle, rememberMode, TURN_SPACING_MS, TURNS_PER_HOUR } from "./autonomy.mts";
import { REOFFER_AFTER_MS } from "./deliver-core.mts";
import type { RunMode } from "./headless-mode.mts";
import { getMessage, markDelivered, markOffered, readJson } from "./inbox.mts";
import { listenerDir, REARM_TEXT, STUCK_TEXT, WAKE_GRACE_MS, WAKE_POLL_MS, wakeMaxWaitMs, WAKE_MAX_WAIT_MS, wakeText } from "./wake-hook.mts";
import { arrive, auditLines, id, listen, lockFile, SECRET, SELF, setup, T0, type ListenOptions } from "./wake-fixture.mts";

// Guards of the wake listener (issue #31, operator decisions of 2026-09-25):
// opt-in policy, per-session allowlist, budget, permission mode, arming at
// UserPromptSubmit, stuck offers, parent death and the --timeout argument;
// headless runs (issue #235).

const LATER = T0 + 2 * WAKE_POLL_MS;
// Listens until a message arriving at the second poll wakes it, or 60 s pass.
const listenFor = (paths: Parameters<typeof listen>[0], n: number, options: ListenOptions = {}) => {
  const start = options.start ?? T0;
  return listen(paths, { ...options, tick: (clock) => {
    if (clock === start + 2 * WAKE_POLL_MS) arrive(paths, n, clock);
    options.tick?.(clock);
  } });
};

// An absent section is the default and wakes every session (issue #390); an
// explicit opt-out or a malformed section arms nothing.
test("no wake after an opt-out: disabled or malformed wake sections arm nothing, an absent one wakes", async (t) => {
  const malformed = [false, { enabled: false }, { enabled: false, sessions: ["*"] }, { enabled: "true", sessions: ["*"] }, { enabled: true },
    { enabled: true, sessions: [] }, { enabled: true, sessions: "*" }, { enabled: true, sessions: ["review", 7] }];
  for (const wake of malformed) {
    const { paths } = setup(t, { wake });
    arrive(paths, 1, T0 + 10_000);
    assert.deepEqual(await listen(paths, { tick: () => assert.fail(`no poll for ${JSON.stringify(wake)}`) }), { code: 0 });
    assert.equal(fs.existsSync(listenerDir(paths)), false);
    assert.deepEqual(auditLines(paths), []);
  }
  const absent = setup(t, { wake: undefined }).paths;
  assert.deepEqual(await listenFor(absent, 1), { code: 2, text: wakeText(1) });
  // A policy file that does not parse fails closed as a whole.
  const broken = setup(t).paths;
  fs.writeFileSync(broken.policy, "{not json");
  assert.deepEqual(await listen(broken, { tick: () => assert.fail("no poll") }), { code: 0 });
});

test("only allowlisted sessions are woken: by id, by name or by an explicit \"*\"", async (t) => {
  const other = setup(t, { wake: { enabled: true, sessions: ["someone-else"] } }).paths;
  assert.deepEqual(await listen(other, { tick: () => assert.fail("no poll") }), { code: 0 });
  assert.deepEqual(auditLines(other).map((l) => [l.action, l.sessionId]), [["not-allowlisted", SELF]]);
  for (const sessions of [[SELF], ["review"], ["*"]]) {
    const { paths } = setup(t, { wake: { enabled: true, sessions } });
    assert.deepEqual(await listenFor(paths, 1), { code: 2, text: wakeText(1) }, JSON.stringify(sessions));
  }
});

test("a session in bypassPermissions is never woken; the other permission modes are", async (t) => {
  const bypass = setup(t).paths;
  assert.deepEqual(await listen(bypass, { mode: "bypassPermissions", tick: () => assert.fail("no poll") }), { code: 0 });
  assert.deepEqual(auditLines(bypass).map((l) => l.action), ["permission-mode"]);
  assert.equal(fs.existsSync(lockFile(bypass)), false);
  for (const mode of ["default", "acceptEdits", "plan", "auto", "dontAsk"]) {
    const { paths } = setup(t);
    assert.deepEqual(await listenFor(paths, 1, { mode }), { code: 2, text: wakeText(1) }, mode);
  }
});

// Armed first, decided after (issue #235): the arming order stays the order
// the hooks armed in (#225), and a headless verdict ends the listener before
// its first poll.
test("a headless run (claude -p) ends its listener before it polls, audited headless, and leaves no files", async (t) => {
  for (const event of ["Stop", "UserPromptSubmit", "SessionStart"]) {
    const { paths } = setup(t);
    const starting = event === "SessionStart";
    if (starting) rememberMode(paths, SELF, "default");
    arrive(paths, 1, T0 + 10_000);
    const runMode = async (): Promise<RunMode> => {
      assert.equal(readJson<{ token: string }>(lockFile(paths))?.token, "h", `armed before the check at ${event}`);
      return "headless";
    };
    assert.deepEqual(await listen(paths, { event, token: "h", ...(starting ? { mode: null } : {}), runMode,
      tick: () => assert.fail(`no poll at ${event}`) }), { code: 0 });
    assert.deepEqual(auditLines(paths).map((l) => [l.action, l.messageIds]), [["headless", []]], event);
    // No lock, mode or scope: only the mode a SessionStart found stored is left.
    assert.deepEqual(fs.readdirSync(listenerDir(paths)), starting ? [`${SELF}.mode.json`] : [], event);
  }
  // A check that fails decides nothing: the listener stays.
  const { paths } = setup(t);
  assert.deepEqual(await listenFor(paths, 1, { runMode: async () => { throw new Error("no listing"); } }), { code: 2, text: wakeText(1) });
});

test("a headless release never touches a newer listener's lock, scope or the mode it relies on", async (t) => {
  const { paths } = setup(t);
  let decide = (): void => {};
  const verdict = new Promise<RunMode>((resolve) => { decide = () => resolve("headless"); });
  const stop = listen(paths, { token: "stop", runMode: () => verdict });
  let seen: unknown[] = [];
  const prompt = listen(paths, { event: "UserPromptSubmit", token: "prompt", start: T0 + 1_000, maxWaitMs: 10_000, tick: (clock) => {
    if (clock === T0 + 1_000 + WAKE_POLL_MS) decide();
    if (clock === T0 + 1_000 + 2 * WAKE_POLL_MS) {
      seen = [readJson<{ token: string }>(lockFile(paths))?.token, readJson<{ token: string }>(listenerScope(paths, SELF))?.token,
        fs.readdirSync(listenerDir(paths)).includes(`${SELF}.mode.json`)];
    }
  } });
  assert.deepEqual(await stop, { code: 0 });
  assert.deepEqual(seen, ["prompt", "prompt", true]);
  assert.deepEqual(await prompt, { code: 2, text: REARM_TEXT });
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["headless", "rearm"]);
});

// The run-mode check may take a process listing of seconds. It runs after
// arming, so the hook that armed later keeps the session, whichever check ends first.
test("a Stop whose run-mode check ends after the next prompt armed stands down; the prompt's listener stays", async (t) => {
  const { paths } = setup(t);
  let release = (): void => {};
  const gate = new Promise<RunMode>((resolve) => { release = () => resolve("interactive"); });
  const stop = listen(paths, { token: "stop", runMode: () => gate });
  const prompt = listen(paths, { event: "UserPromptSubmit", token: "prompt", start: T0 + 1_000, maxWaitMs: 10_000, tick: (clock) => {
    if (clock !== T0 + 1_000 + WAKE_POLL_MS) return;
    arrive(paths, 1, clock);
    release();
  } });
  assert.deepEqual(await stop, { code: 0 }, "no idle listener that could wake the running turn");
  assert.deepEqual(await prompt, { code: 2, text: REARM_TEXT });
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["superseded", "rearm"]);

  // The other way round, the prompt's listener replaces the Stop's as before.
  const other = setup(t).paths;
  let armed = (): void => {};
  const late = new Promise<RunMode>((resolve) => { armed = () => resolve("interactive"); });
  const first = listen(other, { token: "stop", maxWaitMs: 10_000, tick: () => armed() });
  const second = listen(other, { event: "UserPromptSubmit", token: "prompt", start: T0 + 1_000, maxWaitMs: 10_000, runMode: () => late });
  assert.deepEqual([await first, await second], [{ code: 0 }, { code: 2, text: REARM_TEXT }]);
  assert.deepEqual(auditLines(other).map((l) => l.action), ["superseded", "rearm"]);
});

test("a run whose mode is undecided arms as before (fail open)", async (t) => {
  const { paths } = setup(t);
  assert.deepEqual(await listenFor(paths, 1, { runMode: async () => "unknown" }), { code: 2, text: wakeText(1) });
});

test(`wakes at most ${TURNS_PER_HOUR} times per rolling hour and waits out the spacing`, async (t) => {
  const { paths } = setup(t, {wake:{enabled:true,sessions:[SELF]}});
  // Each woken turn delivers its message; one left accepted would be the next Stop listener's backlog (issue #706).
  for (let n = 1; n <= TURNS_PER_HOUR; n++) {
    assert.equal((await listenFor(paths, n, { start: T0 + n * 60_000 })).code, 2, `wake ${n}`);
    markDelivered(paths.inbox, id(n));
  }
  const over = TURNS_PER_HOUR + 1;
  const late = T0 + over * 60_000;
  assert.deepEqual(await listenFor(paths, over, { start: late }), { code: 0 });
  assert.equal(getMessage(paths.inbox, id(over))?.state, "accepted", "it waits for the next user prompt");
  assert.deepEqual(auditLines(paths).findLast(line => line.action === "budget"), { ts: new Date(late + 2 * WAKE_POLL_MS + 250).toISOString(),
    sessionId: SELF, messageIds: [id(over)], action: "budget" });
  // The first wake leaves the rolling hour one hour after it was taken.
  const firstWake = Date.parse(auditLines(paths)[0].ts);
  assert.equal((await listenFor(paths, over + 1, { start: firstWake + 60 * 60_000 })).code, 2);

  // Spacing: a message 10 s after a wake wakes once 30 s have passed.
  const spaced = setup(t, {wake:{enabled:true,sessions:[SELF]}}).paths;
  assert.equal((await listenFor(spaced, 1)).code, 2);
  markDelivered(spaced.inbox, id(1));
  const start = T0 + 10_000;
  assert.deepEqual(await listenFor(spaced, 2, { start }), { code: 2, text: wakeText(1) });
  const [first, second] = auditLines(spaced).map((l) => Date.parse(l.ts));
  assert.ok(second - first >= TURN_SPACING_MS && second - first < TURN_SPACING_MS + 2 * WAKE_POLL_MS + 250, `${second - first}`);
});

test("armed at UserPromptSubmit it stays silent while the turn may run, and wakes once StopFailure ended it", async (t) => {
  const { paths } = setup(t, {wake:{enabled:true,sessions:[SELF]}});
  let messageId = "";
  const result = await listen(paths, { event: "UserPromptSubmit", maxWaitMs: 60 * 60_000, tick: (clock) => {
    if (clock === LATER) messageId = arrive(paths, 1, clock);
    // The turn's Stop would offer it; StopFailure instead marks the listener idle.
    if (clock === T0 + 60_000) markListenerIdle(paths, SELF, clock);
  } });
  assert.deepEqual(result, { code: 2, text: wakeText(1) });
  assert.equal(Date.parse(auditLines(paths)[0].ts), T0 + 60_000 + 250);
  assert.deepEqual(auditLines(paths)[0].messageIds, [messageId]);

  // After a user interrupt nothing marks it: idle once the turn cannot still run.
  const interrupted = setup(t, {wake:{enabled:true,sessions:[SELF]}}).paths;
  assert.deepEqual(await listenFor(interrupted, 1, { event: "UserPromptSubmit", maxWaitMs: 60 * 60_000 }), { code: 2, text: wakeText(1) });
  assert.equal(Date.parse(auditLines(interrupted)[0].ts), T0 + REOFFER_AFTER_MS + 250);
});

test("UserPromptSubmit and Stop arming never leave two listeners for one session", async (t) => {
  const { paths } = setup(t);
  const early = listen(paths, { event: "UserPromptSubmit", token: "ups" });
  // The turn ends with Stop: its listener takes the lock over.
  const late = listenFor(paths, 1, { token: "stop" });
  assert.deepEqual(await early, { code: 0 });
  assert.deepEqual(await late, { code: 2, text: wakeText(1) });
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["superseded", "wake"]);
  // StopFailure marks only a listener armed at UserPromptSubmit.
  const stopLock = { token: "t", pid: 1, startedAt: T0, event: "Stop" };
  fs.mkdirSync(listenerDir(paths), { recursive: true });
  fs.writeFileSync(lockFile(paths), JSON.stringify(stopLock));
  markListenerIdle(paths, SELF, T0);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile(paths), "utf8")), stopLock);
});

test("an offer left by a turn that ended without Stop wakes the idle session once", async (t) => {
  const { paths } = setup(t);
  const stuck = arrive(paths, 1, T0 - REOFFER_AFTER_MS - 5_000);
  markOffered(paths.inbox, stuck, T0 - REOFFER_AFTER_MS);
  assert.deepEqual(await listen(paths), { code: 2, text: STUCK_TEXT });
  assert.deepEqual(auditLines(paths).map((l) => [l.action, l.messageIds]), [["stuck-offer", [stuck]]]);
  assert.equal(Date.parse(auditLines(paths)[0].ts) >= T0 + WAKE_GRACE_MS, true, "not before the parallel Stop could confirm it");
  // Never twice for one record: the next listener re-arms instead.
  assert.deepEqual(await listen(paths, { start: T0 + 60_000, maxWaitMs: 30_000 }), { code: 2, text: REARM_TEXT });
  assert.equal(getMessage(paths.inbox, stuck)?.state, "offered", "the next prompt offers it again");
  assert.ok(!fs.readFileSync(`${paths.dir}/wake.jsonl`, "utf8").includes(SECRET));
});

test("the listener exits when the process that started it is gone", async (t) => {
  const { paths } = setup(t);
  let polls = 0;
  assert.deepEqual(await listen(paths, { parentAlive: () => ++polls < 2 }), { code: 0 });
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["parent-gone"]);
  assert.equal(fs.existsSync(lockFile(paths)), false);
});

test("--timeout drives the re-arm deadline: 60 s before the timeout", async (t) => {
  assert.equal(wakeMaxWaitMs([]), WAKE_MAX_WAIT_MS);
  assert.equal(wakeMaxWaitMs(["--timeout", "3600"]), 3_540_000);
  for (const bad of [["--timeout"], ["--timeout", "x"], ["--timeout", "120"], ["--timeout", "1.5"]]) assert.equal(wakeMaxWaitMs(bad), null);
  const { paths } = setup(t, {wake:{enabled:true,sessions:[SELF]}});
  assert.deepEqual(await listen(paths, { maxWaitMs: wakeMaxWaitMs(["--timeout", "3600"]) as number }), { code: 2, text: REARM_TEXT });
  assert.equal(Date.parse(auditLines(paths)[0].ts), T0 + 3_540_000);
});
