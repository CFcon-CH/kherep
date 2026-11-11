import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { markListenerIdle, takeTurn, TURN_SPACING_MS, TURNS_PER_HOUR } from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { deliverForHook } from "./deliver-hook.mts";
import { getMessage, markOffered } from "./inbox.mts";
import { REARM_TEXT, WAKE_GRACE_MS, WAKE_POLL_MS, WAKE_SETTLE_MS, wakeText } from "./wake-hook.mts";
import { arrive, arriveReply, auditLines, id, listen, lockFile, SELF, sentOriginal, setup, T0 } from "./wake-fixture.mts";

// Issue #706: a listener armed at Stop wakes its session once for what that
// Stop's delivery hook left accepted, when its grace period is over:
// A a message received inside the grace period, after the hook read the inbox;
// B a message received before the listener armed that the hook did not offer;
// C a message the hook saw but could not offer, because the budget refused the
//   continuation.

// The first poll after the grace period, then the settle pause.
const BACKLOG_WAKE = 2 * WAKE_POLL_MS + WAKE_SETTLE_MS;
const hook = (paths: NodePaths, event: string, at: number): string =>
  deliverForHook({ session_id: SELF, hook_event_name: event, permission_mode: "default" },
    { paths, nonce: () => "t0k3n", replyCommand: "kherep-node", now: () => at });
const lines = (paths: NodePaths) => auditLines(paths).map((l) => [l.action, l.messageIds, Date.parse(l.ts) - T0]);
const turns = (paths: NodePaths): number[] => JSON.parse(fs.readFileSync(lockFile(paths).replace(/\.json$/, ".turns.json"), "utf8")).turns;

test("A: a Stop listener wakes for a message received inside its grace period once that period is over", async (t) => {
  const { paths } = setup(t);
  // Measured 2026-11-11: received 1.68 s after the listener armed.
  const result = await listen(paths, { maxWaitMs: 20_000, tick: (clock) => {
    if (clock === T0 + WAKE_POLL_MS) arrive(paths, 8, T0 + 1_680);
  } });
  assert.ok(1_680 < WAKE_GRACE_MS);
  assert.deepEqual(result, { code: 2, text: wakeText(1) });
  assert.deepEqual(lines(paths), [["backlog", [id(8)], BACKLOG_WAKE]]);
  assert.equal(getMessage(paths.inbox, id(8))?.state, "accepted", "the woken turn's delivery hook offers it");
});

test("B: a Stop listener wakes for a message received before it armed that the Stop delivery hook did not offer", async (t) => {
  const { paths } = setup(t);
  // The Stop delivery hook read the inbox before the message was stored.
  assert.equal(hook(paths, "Stop", T0 - 1_500), "");
  arrive(paths, 1, T0 - 1_000);
  assert.deepEqual(await listen(paths, { maxWaitMs: 20_000 }), { code: 2, text: wakeText(1) });
  assert.deepEqual(lines(paths), [["backlog", [id(1)], BACKLOG_WAKE]]);
});

test("C: a Stop continuation the turn spacing refused is made up by one wake once the spacing allows it", async (t) => {
  const { paths } = setup(t);
  // The wake that opened the ending turn, 20 s before its Stop.
  const opened = T0 - 20_000;
  assert.equal(takeTurn(paths, SELF, opened), "ok");
  arrive(paths, 1, T0 - 1_000);
  assert.equal(hook(paths, "Stop", T0), "", "the Stop offers nothing");
  assert.deepEqual(lines(paths), [["continue-budget", [id(1)], 0]]);
  assert.equal(getMessage(paths.inbox, id(1))?.state, "accepted");

  assert.deepEqual(await listen(paths, { maxWaitMs: 120_000 }), { code: 2, text: wakeText(1) });
  const [, woke] = auditLines(paths);
  assert.deepEqual([woke.action, woke.messageIds], ["backlog", [id(1)]]);
  const waited = Date.parse(woke.ts) - opened;
  assert.ok(waited >= TURN_SPACING_MS && waited < TURN_SPACING_MS + WAKE_POLL_MS + WAKE_SETTLE_MS, String(waited));
  assert.deepEqual(turns(paths), [opened, Date.parse(woke.ts)], "one turn for the wake");

  // The woken turn: its UserPromptSubmit offers the message once, its Stop
  // confirms it, and the next listener finds nothing to wake for.
  const prompt = Date.parse(woke.ts) + 500;
  assert.ok(hook(paths, "UserPromptSubmit", prompt).includes(id(1)));
  assert.deepEqual([getMessage(paths.inbox, id(1))?.offers, getMessage(paths.inbox, id(1))?.offeredBy], [1, "wake"]);
  assert.equal(hook(paths, "Stop", prompt + 5_000), "");
  assert.equal(getMessage(paths.inbox, id(1))?.state, "delivered");
  assert.deepEqual(await listen(paths, { start: prompt + 5_000, maxWaitMs: 20_000 }), { code: 2, text: REARM_TEXT });
});

test("a message the Stop delivery hook offered wakes nobody, also when the offer lands in the settle pause", async (t) => {
  const { paths } = setup(t);
  // Offered as a Stop continuation, before the listener's first eligible poll.
  arrive(paths, 1, T0 - 1_000);
  assert.ok(hook(paths, "Stop", T0).includes(id(1)));
  let settling = "";
  const result = await listen(paths, { maxWaitMs: 20_000, tick: (clock) => {
    if (clock === T0 + WAKE_POLL_MS) settling = arrive(paths, 2, T0 + 1_680);
    if (clock === T0 + BACKLOG_WAKE) markOffered(paths.inbox, settling, clock, "stop");
  } });
  assert.deepEqual(result, { code: 2, text: REARM_TEXT });
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["continue", "rearm"]);
  assert.equal(getMessage(paths.inbox, id(1))?.offers, 1, "offered once");
});

test("the Stop backlog wakes once per record; a later Stop listener re-arms instead", async (t) => {
  const { paths } = setup(t);
  arrive(paths, 1, T0 - 1_000);
  assert.deepEqual(await listen(paths, { maxWaitMs: 20_000 }), { code: 2, text: wakeText(1) });
  // The woken turn never ran, so the record still waits.
  assert.deepEqual(await listen(paths, { start: T0 + 60_000, maxWaitMs: 20_000 }), { code: 2, text: REARM_TEXT });
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["backlog", "rearm"]);
  assert.equal(getMessage(paths.inbox, id(1))?.state, "accepted", "left for the next prompt");
});

test("the Stop backlog draws on the hourly budget and never wakes past it", async (t) => {
  const { paths } = setup(t);
  for (let n = 0; n < TURNS_PER_HOUR; n++) assert.equal(takeTurn(paths, SELF, T0 - 50 * 60_000 + n * 2 * TURN_SPACING_MS), "ok");
  const spent = turns(paths);
  arrive(paths, 1, T0 - 1_000);
  assert.deepEqual(await listen(paths), { code: 0 });
  assert.deepEqual(lines(paths)[0], ["budget", [id(1)], BACKLOG_WAKE]);
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["budget", "listener-timeout"]);
  assert.deepEqual(turns(paths), spent, "no turn taken");
  assert.equal(getMessage(paths.inbox, id(1))?.state, "accepted");
});

test("a Stop continuation that just took a turn delays the backlog wake by the turn spacing", async (t) => {
  const { paths } = setup(t);
  assert.equal(takeTurn(paths, SELF, T0), "ok");
  const result = await listen(paths, { tick: (clock) => {
    if (clock === T0 + WAKE_POLL_MS) arrive(paths, 8, T0 + 1_680);
  } });
  assert.deepEqual(result, { code: 2, text: wakeText(1) });
  const waited = Date.parse(auditLines(paths)[0].ts) - T0;
  assert.ok(waited >= TURN_SPACING_MS && waited < TURN_SPACING_MS + WAKE_POLL_MS + WAKE_SETTLE_MS, String(waited));
});

test("a listener armed at UserPromptSubmit has no backlog, also once StopFailure marked it idle", async (t) => {
  const { paths } = setup(t);
  arrive(paths, 1, T0 - 1_000);
  const result = await listen(paths, { event: "UserPromptSubmit", maxWaitMs: 20_000, tick: (clock) => {
    if (clock === T0 + WAKE_POLL_MS) arrive(paths, 2, T0 + 1_680);
    if (clock === T0 + 2 * WAKE_POLL_MS) markListenerIdle(paths, SELF, clock);
  } });
  assert.deepEqual(result, { code: 2, text: REARM_TEXT });
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["rearm"]);
});

test("an unlisted session with wake.replies is woken for a granted reply inside the grace period, not for other backlog", async (t) => {
  const { paths } = setup(t, { wake: { enabled: true, replies: true } });
  sentOriginal(paths);
  arrive(paths, 1, T0 - 1_000);
  const result = await listen(paths, { maxWaitMs: 20_000, tick: (clock) => {
    if (clock === T0 + WAKE_POLL_MS) arriveReply(paths, 8, T0 + 1_680);
  } });
  assert.deepEqual(result, { code: 2, text: wakeText(1) });
  assert.deepEqual(auditLines(paths).map((l) => [l.action, l.messageIds, l.grant]), [["backlog", [id(8)], "reply"]]);
});
