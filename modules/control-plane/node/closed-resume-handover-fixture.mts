import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type test from "node:test";
import type { SessionInfo } from "../protocol.mts";
import { TURN_SPACING_MS } from "./autonomy.mts";
import { audits, closedNode, PEER, SESSION } from "./closed-fixture.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { SESSIONS_INTERVAL_MS } from "./daemon.mts";
import { deliverForHook } from "./deliver-hook.mts";
import { recordingSessions } from "./exchange.mts";
import type { Diagnostics } from "./handover-diagnostics-fixture.mts";
import { getMessage, getReceipt, storeMessage, markClosedAttempt, setDeliveryTask, type InboxRecord } from "./inbox.mts";
import { recordLockFile, RECORD_LOCK_WAIT_MS, setRecordLockWait } from "./inbox-record-lock.mts";
import { T0, taskId } from "./task-fixture.mts";
import { listTasks, readTask, writeTask } from "./task-records.mts";
import { watchTasks } from "./task-watch.mts";
import { fixtureEvidence, syntheticListing } from "./session-authority-fixture.mts";

// Synthetic only: closedNode injects fake exec, findClaude and service owner.
// No runtime launch or private runtime/session read; the real fallback/hooks execute.
export const T = taskId(10), M1 = taskId(20), M2 = taskId(21), Q = taskId(23);
export const S1 = taskId(101), S2 = taskId(102), S3 = taskId(103);
export async function resumedHandover(t: test.TestContext, d: Diagnostics, contention?: "address" | "identity", strict=false) {
  const node = closedNode(t), logs: string[] = [], receiving: { event: string; ids: string[]; output: string }[] = [];
  let now = T0, seen: SessionInfo[] = [];
  const get = (id: string) => getMessage(node.paths.inbox, id)!;
  const messages = () => [get(M1), get(M2)];
  const advance = (ms: number) => { now += ms; node.tick(ms); };
  const log = (line: string) => logs.push(line);
  const observe = (stage: string) => d.observe(stage, { case: `immediate-resume/${contention ?? "normal"}`,
    source: { binding: "external-run-receipt" }, task: readTask(node.paths, T), records: [...messages(), get(Q)],
    audits: audits(node), logs, receiving, counts: { launches: node.calls.filter((c) => c.args[0] !== "agents").length,
      hooks: receiving.length, receipts: [M1, M2, Q].filter((id) => getReceipt(node.paths.inbox, id)).length } });
  // This scenario models a complete, authoritative generated app/holder read.
  const discover = recordingSessions(node.paths, async () => syntheticListing(node.livenessAuthority, [...seen],
    [SESSION, S1, S2, S3].map(sessionId => fixtureEvidence({ runtime: "claude-code", sessionId },
      seen.some(row => row.sessionId === sessionId) ? "running" : "closed", now)).map(e=>({...e,lifecycle:{status:'value' as const,value:{state:'restored' as const,generation:7},source:'native-lifecycle' as const,observedAt:now,complete:true,reasonCode:'observed' as const}})), now), log, () => now,
    undefined, undefined, node.livenessAuthority);
  function view(sessionId: string, shortId = sessionId.slice(0, 8)) {
    node.rows.splice(0, node.rows.length, { id: shortId, sessionId, name: "synthetic-task-a", state: "working", kind: "background",pid:53530 });
    seen = [{ sessionId, name: "synthetic-task-a", runtime: "claude-code", state: "busy", cwd: node.workspace }];
  }
  function store(id: string) {
    storeMessage(node.paths.inbox, { messageId: id, from: PEER, toSession: SESSION,
      text: `synthetic ${id}`, createdAt: new Date(now - 1).toISOString(),senderOrigin:{nodeId:PEER.nodeId,sentAt:new Date(now-1).toISOString()} }, now - 1);
  }
  const lock = recordLockFile(node.paths.inbox, M2), open = fs.openSync;
  function hold() {
    const fd = open(lock, "wx"); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); fs.closeSync(fd);
  }
  setRecordLockWait(0);
  t.after(() => { setRecordLockWait(RECORD_LOCK_WAIT_MS); if (fs.existsSync(lock)) fs.unlinkSync(lock); });
  writeTask(node.paths, { taskId: T, name: "synthetic-task-a", cwd: node.workspace,
    permissionMode: "auto", runtime: "claude", state: "running", local: "intercom", shortId: S1.slice(0, 8), sessionId: S1,
    requestedBy: `${PEER.nodeId}/${PEER.session}`, startedAt: new Date(now).toISOString(),
    deadline: new Date(now + 2 * 60 * 60_000).toISOString(), updatedAt: "" }, now);
  store(M1); store(M2);
  if(strict)await deliverToClosed(node.deps(), log);
  else for(const id of [M1,M2]) {
    // Persisted pre-#706 handover rows exercise the retained legacy copy lane.
    // Fresh source-owned delivery is tested separately with strict=true.
    markClosedAttempt(node.paths.inbox,id,now,S1);setDeliveryTask(node.paths.inbox,id,{taskId:T,runtime:'claude',sessionId:S1});
  }
  const entry = messages();
  for (const r of entry) {
    assert.equal(r.toSession, S1); assert.equal(r.closedTo, SESSION); assert.ok(r.closedAttempt);
    assert.deepEqual(r.delivery, { taskId: T, runtime: "claude", sessionId: S1 });
  }
  view(S1); await discover(); advance(SESSIONS_INTERVAL_MS); view(S2); await discover(); hold();
  await watchTasks(node.deps(), log);
  assert.equal(readTask(node.paths, T)?.sessionId, S1);
  assert.deepEqual(messages(), [{ ...entry[0], toSession: S2 }, entry[1]]);
  assert.equal(get(M1).delivery?.sessionId, S1, "address phase stopped before identity correction");
  fs.unlinkSync(lock); observe("partial-watch");
  writeTask(node.paths, { ...readTask(node.paths, T)!, state: "done", running: undefined }, now);
  advance(TURN_SPACING_MS * 2); node.rows.splice(0); seen = []; store(Q); await discover();
  const base = node.deps();
  let resumeAcquisitions = 0;
  let resuming=false;
  if (contention === "identity") t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (resuming && file === lock && flags === "wx" && ++resumeAcquisitions === 2) hold();
    return open(file, flags, mode);
  });
  const deps = { ...base, log, exec: async (file: string, args: string[], options: Parameters<NonNullable<typeof base.exec>>[2]) => {
    if (args[0] !== "--resume") return base.exec!(file, args, options);
    resuming=true;
    node.calls.push({ file, args, options });
    assert.equal(args[1], strict?S2:S1);
    view(S3, "c0ffee03");
    if (contention === "address") hold();
    return "note: continuing as a copy\nbackgrounded · c0ffee03\n";
  } };
  await deliverToClosed(deps, log); observe("immediate-after-resume");
  const afterResume = { task: readTask(node.paths, T)!, records: messages(), q: get(Q), logs: [...logs], audits: audits(node) };
  async function finish() {
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
    await discover(); await watchTasks(deps, log); observe("stable-watch");
    for (const r of messages()) {
      if(!strict)assert.deepEqual(r, { ...entry.find((m) => m.messageId === r.messageId)!,
        toSession: S3, delivery: { taskId: T, runtime: "claude", sessionId: S3 } });
      else {assert.equal(r.toSession,S3);assert.deepEqual(r.delivery,{taskId:T,runtime:'claude',sessionId:S3});assert.deepEqual(r.targetAttempt,entry[0].targetAttempt);}
    }
    function hook(event: "UserPromptSubmit" | "Stop") {
      const output = deliverForHook({ hook_event_name: event, session_id: S3, permission_mode: "auto", stop_hook_active: false },
        { paths: node.paths, now: () => now, nonce: () => "synthetic-nonce", replyCommand: "synthetic-node msg send" });
      const context = output ? String(JSON.parse(output).hookSpecificOutput?.additionalContext ?? "") : "";
      const ids = [...context.matchAll(/^=== Kherep peer message ([\w-]+) \[/gm)].map((m) => m[1]!);
      receiving.push({ event, ids, output }); return ids;
    }
    const carried=strict?[M1,M2]:[M1,M2,Q];
    // The resumed command already carries its exact selected group. The hook
    // offers only the legacy intermediates not already framed by that command.
    const prompt=node.calls.find(c=>c.args[0]==='--resume')!.args.at(-1)!;
    for(const id of strict?[M1,M2]:[Q])assert.ok(prompt.includes(id));
    if(strict)assert.equal(prompt.includes(Q),false);
    assert.deepEqual(hook("UserPromptSubmit"),strict?[]:[M1,M2]);
    for (const id of carried) assert.equal(get(id).state, "offered");
    hook("Stop");
    for (const id of carried) assert.equal(get(id).state, "delivered");
    if(strict){assert.equal(get(Q).state,'accepted');assert.equal(get(Q).targetAttempt,undefined);assert.equal(get(Q).delivery,undefined);}
    assert.deepEqual([...hook("UserPromptSubmit"), ...hook("Stop")], []);
    assert.equal(node.calls.filter((c) => c.args[0] === "--resume").length, 1);
    assert.deepEqual(node.calls.filter((c) => c.args[0] !== "agents").map((c) => c.args[0]), ["--resume"]);
    assert.equal(listTasks(node.paths).length, 1); observe("summary");
  }
  return { afterResume, entry, finish, paths: node.paths };
}
