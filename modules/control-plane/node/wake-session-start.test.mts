import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { markListenerIdle, rememberMode, TURNS_PER_HOUR } from "./autonomy.mts";
import { MAX_REPLY_DEPTH } from "./inbox.mts";
import { killSwitch, REARM_TEXT, WAKE_POLL_MS, WAKE_SETTLE_MS, wakeText } from "./wake-hook.mts";
import { arrive, auditLines, listen, lockFile, SELF, setup, T0, type ListenOptions } from "./wake-fixture.mts";

// Issue #97: the listener armed at SessionStart, so an idle session stays
// wakeable after its process restarts. A SessionStart input carries source but
// no permission_mode (measured on Claude Code 2.1.258), so these listeners
// leave the field out unless a test says otherwise. The settings and launch
// flags check is injected; launch-mode.test.mts covers it.

const LATER = T0 + 2 * WAKE_POLL_MS;
const atStart = (source: string, options: ListenOptions = {}): ListenOptions =>
  ({ event: "SessionStart", source, mode: null, ...options });
// A node that wakes "review", whose last prompt or Stop reported the given mode.
const seen = (t: test.TestContext, mode = "default", wake?: unknown) => {
  const { paths } = wake === undefined ? setup(t) : setup(t, { wake });
  rememberMode(paths, SELF, mode);
  return paths;
};
// Listens until a message arriving at the second poll wakes it, or 60 s pass.
const listenFor = (paths: Parameters<typeof listen>[0], n: number, options: ListenOptions = {}) => {
  const start = options.start ?? T0;
  return listen(paths, { ...options, tick: (clock) => {
    if (clock === start + 2 * WAKE_POLL_MS) arrive(paths, n, clock);
    options.tick?.(clock);
  } });
};
const noPoll = (options: ListenOptions = {}): ListenOptions => ({ ...options, tick: () => assert.fail("no poll") });

test("armed at SessionStart, an idle session wakes on a message after startup, resume, clear and fork", async (t) => {
  for (const source of ["startup", "resume", "clear", "fork"]) {
    const paths = seen(t);
    let armed: unknown;
    const result = await listenFor(paths, 1, atStart(source, { tick: (clock) => {
      if (clock === T0 + WAKE_POLL_MS) armed = JSON.parse(fs.readFileSync(lockFile(paths), "utf8"));
    } }));
    assert.deepEqual(result, { code: 2, text: wakeText(1) }, source);
    assert.deepEqual(armed, { token: (armed as { token: string }).token, pid: 4242, startedAt: T0, order: T0, event: "SessionStart", source });
    assert.deepEqual(auditLines(paths).map((l) => [l.action, Date.parse(l.ts)]), [["wake", LATER + WAKE_SETTLE_MS]], source);
    assert.equal(fs.existsSync(lockFile(paths)), false, source);
  }
});

test("after compaction, which can run inside a turn, it stays silent until the turn has ended", async (t) => {
  const paths = seen(t);
  const result = await listenFor(paths, 1, atStart("compact", { maxWaitMs: 60 * 60_000, tick: (clock) => {
    if (clock === T0 + 60_000) markListenerIdle(paths, SELF, clock);
  } }));
  assert.deepEqual(result, { code: 2, text: wakeText(1) });
  assert.equal(Date.parse(auditLines(paths)[0].ts), T0 + 60_000 + WAKE_SETTLE_MS);
  // StopFailure marks no listener armed while the session was idle.
  const lock = { token: "t", pid: 1, startedAt: T0, event: "SessionStart", source: "resume" };
  fs.writeFileSync(lockFile(paths), JSON.stringify(lock));
  markListenerIdle(paths, SELF, T0);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile(paths), "utf8")), lock);
});

test("a UserPromptSubmit after SessionStart supersedes its listener; one listener remains", async (t) => {
  const paths = seen(t);
  const early = listen(paths, atStart("resume", { token: "start" }));
  let held: unknown;
  const late = listen(paths, { event: "UserPromptSubmit", token: "prompt", maxWaitMs: 10_000, tick: (clock) => {
    if (clock === T0 + WAKE_POLL_MS) held = JSON.parse(fs.readFileSync(lockFile(paths), "utf8")).token;
  } });
  assert.deepEqual(await early, { code: 0 });
  assert.deepEqual(await late, { code: 2, text: REARM_TEXT });
  assert.equal(held, "prompt");
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["superseded", "rearm"]);
  assert.equal(fs.existsSync(lockFile(paths)), false, "the re-arming listener released the only lock");

  // A prompt that arms while the launch check still runs keeps its lock.
  const racing = seen(t);
  const newer = { token: "prompt", pid: 7, startedAt: T0, event: "UserPromptSubmit" };
  const launch = async () => {
    fs.writeFileSync(lockFile(racing), JSON.stringify(newer));
    return "ok" as const;
  };
  assert.deepEqual(await listen(racing, noPoll(atStart("resume", { launch }))), { code: 0 });
  assert.deepEqual(auditLines(racing).map((l) => l.action), ["superseded"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile(racing), "utf8")), newer);
});

test("without permission_mode it arms only with a stored mode, an explicit listing and no bypass in settings or launch flags", async (t) => {
  const refused = async (paths: ReturnType<typeof seen>, action: string, options: ListenOptions = {}) => {
    let checked = false;
    const launch = options.launch ?? (async () => { checked = true; return "ok" as const; });
    assert.deepEqual(await listen(paths, noPoll(atStart("resume", { ...options, launch }))), { code: 0 }, action);
    assert.deepEqual(auditLines(paths).map((l) => l.action), [action]);
    assert.equal(fs.existsSync(lockFile(paths)), false);
    return checked;
  };
  // 1. Stored bypassPermissions, or no stored mode at all.
  assert.equal(await refused(seen(t, "bypassPermissions"), "permission-mode"), false);
  assert.equal(await refused(setup(t).paths, "permission-mode-unknown"), false);
  // 2. Listed only through "*".
  assert.equal(await refused(seen(t, "default", { enabled: true, sessions: ["*"] }), "permission-mode-unknown"), false);
  // 3 and 4. Settings or launch flags point to bypass, or cannot be read.
  await refused(seen(t), "permission-mode", { launch: async () => "bypass" });
  await refused(seen(t), "permission-mode-unknown", { launch: async () => "unknown" });
  // The arming path: all four hold, and the check sees the session's cwd.
  const paths = seen(t, "acceptEdits");
  let checkedCwd: unknown;
  const launch = async (cwd: unknown) => { checkedCwd = cwd; return "ok" as const; };
  assert.deepEqual(await listenFor(paths, 1, atStart("resume", { launch })), { code: 2, text: wakeText(1) });
  assert.equal(checkedCwd, paths.dir, "the fixture's input cwd");
  // An input that states the mode is judged by it, as at UserPromptSubmit and Stop.
  const stated = setup(t, { wake: { enabled: true, sessions: ["*"] } }).paths;
  assert.equal(await refused(stated, "permission-mode", { mode: "bypassPermissions" }), false);
  const plain = setup(t, { wake: { enabled: true, sessions: ["*"] } }).paths;
  assert.deepEqual(await listenFor(plain, 1, atStart("startup", { mode: "default", launch: async () => assert.fail("not checked") })),
    { code: 2, text: wakeText(1) });
});

test("the other guards hold at SessionStart: kill switch, opt-in, allowlist, reply depth and budget", async (t) => {
  const off = seen(t);
  fs.writeFileSync(killSwitch(off), "");
  assert.deepEqual(await listen(off, noPoll(atStart("resume"))), { code: 0 });
  assert.deepEqual(auditLines(off).map((l) => l.action), ["disabled"]);

  const none = seen(t, "default", null);
  assert.deepEqual(await listen(none, noPoll(atStart("resume"))), { code: 0 });
  assert.deepEqual(auditLines(none), []);

  const other = seen(t, "default", { enabled: true, sessions: ["someone-else"] });
  assert.deepEqual(await listen(other, noPoll(atStart("resume"))), { code: 0 });
  assert.deepEqual(auditLines(other).map((l) => l.action), ["not-allowlisted"]);

  const deep = seen(t);
  arrive(deep, 1, T0 + 5_000, "review", MAX_REPLY_DEPTH);
  assert.deepEqual(await listen(deep, atStart("resume", { maxWaitMs: 20_000 })), { code: 2, text: REARM_TEXT });
  assert.deepEqual(auditLines(deep).map((l) => l.action), ["depth-limit", "rearm"]);

  const paths = seen(t, "default", {enabled:true,sessions:[SELF]});
  for (let n = 1; n <= TURNS_PER_HOUR; n++) {
    assert.equal((await listenFor(paths, n, atStart("resume", { start: T0 + n * 60_000 }))).code, 2, `wake ${n}`);
  }
  assert.deepEqual(await listenFor(paths, 20, atStart("resume", { start: T0 + 7 * 60_000 })), { code: 0 });
  assert.equal(auditLines(paths).findLast(line => line.action === "budget")?.action, "budget");
});
