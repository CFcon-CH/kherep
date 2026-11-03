import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { listenerScope, TURN_SPACING_MS, TURNS_PER_HOUR } from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { MAX_REPLY_DEPTH, readJson, getMessage } from "./inbox.mts";
import { runHook } from "./deliver-hook.mts";
import { budgetFile } from "./budget-store.mts";
import type { RouteReservation } from "./target-delivery-operation.mts";
import { WAKE_BACKLOG_AFTER_MS, WAKE_POLL_MS, wakeText } from "./wake-hook.mts";
import { completeWakeCycle,arrive, arriveReply, auditLines, listen, lockFile, SELF, sentOriginal, setup, T0 } from "./wake-fixture.mts";
import { REPLY_GRANT_MAX_AGE_MS } from "./wake-reply.mts";

// The wake listener with wake.replies (issue #253): a session the allowlist
// does not name stays armed and wakes for replies to its own messages only.
// Every other guard applies as before.

const OTHER = "00000000-0000-4000-8000-0000000000dd";
const REPLIES = { enabled: true, replies: true };
const writeWake = (paths: NodePaths, wake?: unknown): void =>
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], ...(wake === undefined ? {} : { wake }) }));

// A listener on a 20 s wait; the reply arrives at its second poll.
function replyAt(paths: NodePaths, options: Parameters<typeof arriveReply>[3] & { start?: number; mode?: string } = {}) {
  const start = options.start ?? T0;
  return listen(paths, { start, mode: options.mode, maxWaitMs: 20_000, tick: (clock) => {
    if (clock === start + 2 * WAKE_POLL_MS) arriveReply(paths, Math.floor(clock / 1000) % 0x10000, clock, options);
  } });
}
const actions = (paths: NodePaths) => auditLines(paths).map((l) => [l.action, l.grant]);

test("with wake.replies a reply to the session's own message wakes it unlisted; the audit names the grant", async (t) => {
  for (const wake of [REPLIES, { enabled: true, sessions: ["someone-else"], replies: true }]) {
    const { paths } = setup(t, { wake });
    sentOriginal(paths);
    let scope: unknown;
    let message = "";
    const result = await listen(paths, { token: "listener-1", maxWaitMs: 20_000, tick: (clock) => {
      if (clock === T0 + 2 * WAKE_POLL_MS) message = arriveReply(paths, 1, clock);
      scope ??= readJson(listenerScope(paths, SELF));
    } });
    assert.deepEqual(result, { code: 2, text: wakeText(1) }, JSON.stringify(wake));
    assert.deepEqual(auditLines(paths).map((l) => [l.action, l.messageIds, l.grant]), [["wake", [message], "reply"]]);
    assert.deepEqual(scope, { token: "listener-1", listed: false, replies: true, order: T0 });
    const ownerFile=path.join(paths.dir,'codex-native-pending',SELF+'.json');
    const reservation=():RouteReservation=>JSON.parse(fs.readFileSync(ownerFile,'utf8'));
    const initial=reservation(),budget=fs.readFileSync(budgetFile(paths,SELF));
    assert.deepEqual(getMessage(paths.inbox,message)!.targetAttempt,initial.handle);
    assert.equal(initial.transitions.length,1);
    const hook=(event:string)=>{
      const writes:string[]=[],warnings:string[]=[];
      runHook(JSON.stringify({session_id:SELF,hook_event_name:event,permission_mode:'default'}),
        {paths,now:()=>T0+2*WAKE_POLL_MS+250,replyCommand:'synthetic'},text=>writes.push(text),line=>warnings.push(line));
      assert.deepEqual(warnings,[]);return writes;
    };
    assert.equal(hook('UserPromptSubmit').length,1);
    assert.equal(getMessage(paths.inbox,message)!.state,'offered');
    assert.equal(reservation().transitions.length,2);
    assert.deepEqual(hook('Stop'),[]);
    assert.equal(getMessage(paths.inbox,message)!.state,'delivered');
    assert.equal(reservation().transitions.length,3);
    assert.deepEqual(reservation().group,initial.group);
    assert.deepEqual(reservation().handle,initial.handle);
    assert.deepEqual(reservation().budget,initial.budget);
    assert.deepEqual(fs.readFileSync(budgetFile(paths,SELF)),budget);

  }
});

test("a listed session's reply wakes as before, without a grant", async (t) => {
  const { paths } = setup(t, { wake: { enabled: true, sessions: ["review"], replies: true } });
  sentOriginal(paths);
  assert.deepEqual(await replyAt(paths), { code: 2, text: wakeText(1) });
  assert.deepEqual(actions(paths), [["wake", undefined]]);
});

test("without the switch an unlisted session gets no listener", async (t) => {
  for (const wake of [{ enabled: true, sessions: ["someone-else"] }, { enabled: true, sessions: ["someone-else"], replies: false }]) {
    const { paths } = setup(t, { wake });
    sentOriginal(paths);
    assert.deepEqual(await listen(paths, { tick: () => assert.fail("no poll") }), { code: 0 });
    assert.deepEqual(actions(paths), [["not-allowlisted", undefined]]);
  }
});

test("no wake for a reply from another node, after the age bound, to another session, or for another message", async (t) => {
  const other = setup(t, { wake: REPLIES }).paths;
  sentOriginal(other);
  await replyAt(other, { from: OTHER });
  assert.deepEqual(actions(other), [["rearm", undefined]], "another node");

  const old = setup(t, { wake: REPLIES }).paths;
  sentOriginal(old, { createdAt: new Date(T0 - REPLY_GRANT_MAX_AGE_MS).toISOString() });
  await replyAt(old);
  assert.deepEqual(actions(old), [["rearm", undefined]], "older than 24 h when the reply is polled");

  const foreign = setup(t, { wake: REPLIES }).paths;
  sentOriginal(foreign, { fromSessionId: "s-other" });
  await replyAt(foreign);
  assert.deepEqual(actions(foreign), [["rearm", undefined]], "another session's message under the same name");

  const unrelated = setup(t, { wake: REPLIES }).paths;
  sentOriginal(unrelated);
  await listen(unrelated, { maxWaitMs: 20_000, tick: (clock) => { if (clock === T0 + 2 * WAKE_POLL_MS) arrive(unrelated, 1, clock); } });
  assert.deepEqual(actions(unrelated), [["rearm", undefined]], "a message that is no reply");
});

test("a granted reply at the depth limit does not wake", async (t) => {
  const { paths } = setup(t, { wake: REPLIES });
  sentOriginal(paths, { depth: MAX_REPLY_DEPTH - 1 });
  await replyAt(paths, { depth: MAX_REPLY_DEPTH });
  assert.deepEqual(actions(paths), [["depth-limit", undefined], ["rearm", undefined]]);
});

test("withdrawing the switch ends an unlisted listener: lock released, audit not-allowlisted (issue #213)", async (t) => {
  for (const wake of [{ enabled: true, sessions: ["someone-else"] }, { enabled: true, replies: false }, { enabled: false }]) {
    const { paths } = setup(t, { wake: REPLIES });
    sentOriginal(paths);
    const result = await listen(paths, { tick: (clock) => {
      if (clock === T0 + 2 * WAKE_POLL_MS) writeWake(paths, wake);
      if (clock === T0 + 3 * WAKE_POLL_MS) arriveReply(paths, 1, clock);
    } });
    assert.deepEqual(result, { code: 0 }, JSON.stringify(wake));
    assert.equal(fs.existsSync(lockFile(paths)), false);
    assert.deepEqual(auditLines(paths).map((l) => [l.ts, l.action]), [[new Date(T0 + 2 * WAKE_POLL_MS).toISOString(), "not-allowlisted"]]);
  }
});

test("a SessionStart listener with a permission mode wakes once for a granted backlog reply, audited with the grant", async (t) => {
  const { paths } = setup(t, { wake: REPLIES });
  sentOriginal(paths);
  const waiting = arriveReply(paths, 1, T0 - 60_000);
  const result = await listen(paths, { event: "SessionStart", source: "resume", maxWaitMs: 20_000 });
  assert.deepEqual(result, { code: 2, text: wakeText(1) });
  assert.deepEqual(auditLines(paths).map((l) => [l.ts, l.action, l.messageIds, l.grant]),
    [[new Date(T0 + WAKE_BACKLOG_AFTER_MS + 250).toISOString(), "backlog", [waiting], "reply"]]);
});

// A SessionStart input without permission_mode needs an explicit listing for
// the launch check, so a session only the reply grant covers does not arm then
// (fails closed); it arms at its next Stop or prompt.
test("a SessionStart without permission_mode does not arm a replies-only session", async (t) => {
  const { paths } = setup(t, { wake: REPLIES });
  sentOriginal(paths);
  arriveReply(paths, 1, T0 - 60_000);
  const result = await listen(paths, { event: "SessionStart", source: "resume", mode: null, maxWaitMs: 20_000 });
  assert.deepEqual(result, { code: 0 });
  assert.deepEqual(actions(paths), [["permission-mode-unknown", undefined]]);
});

test("the budget and the bypassPermissions exclusion still apply", async (t) => {
  const bypass = setup(t, { wake: REPLIES }).paths;
  sentOriginal(bypass);
  assert.deepEqual(await replyAt(bypass, { mode: "bypassPermissions" }), { code: 0 });
  assert.deepEqual(actions(bypass), [["permission-mode", undefined]]);

  const { paths } = setup(t, { wake: REPLIES });
  sentOriginal(paths);
  let start = T0;
  for (let n = 1; n <= TURNS_PER_HOUR; n++) {
    const result=await replyAt(paths, { start });
    assert.equal(result.code, 2, `wake ${n}`);
    const budget=fs.readFileSync(budgetFile(paths,SELF));
    assert.equal(completeWakeCycle(result).status,'retired',`completion ${n}`);
    assert.deepEqual(fs.readFileSync(budgetFile(paths,SELF)),budget,'retirement never refunds/recharges');
    start += TURN_SPACING_MS + 10 * WAKE_POLL_MS;
  }
  assert.deepEqual(await replyAt(paths, { start }), { code: 0 });
  assert.equal(auditLines(paths).at(-1)?.action, "budget");
});
