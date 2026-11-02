import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type test from "node:test";

import type { SessionInfo } from "../protocol.mts";
import { audits, closedNode, PEER, SESSION } from "./closed-fixture.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { SESSIONS_INTERVAL_MS } from "./daemon.mts";
import { deliverForHook } from "./deliver-hook.mts";
import { recordingSessions } from "./exchange.mts";
import type { Diagnostics } from "./handover-diagnostics-fixture.mts";
import { getMessage, getReceipt, storeMessage, UNDELIVERABLE_AFTER_MS, writeJsonAtomic, type InboxRecord } from "./inbox.mts";
import { recordLockFile, RECORD_LOCK_WAIT_MS, setRecordLockWait } from "./inbox-record-lock.mts";
import { CLOSED_AFTER_MISSES, CLOSED_MIN_AGE_MS, closedSession, knownSessionsFile } from "./known-sessions.mts";
import { T0, taskId } from "./task-fixture.mts";
import { listTasks, readTask, writeTask } from "./task-records.mts";
import { watchTasks } from "./task-watch.mts";
import { fixtureEvidence, syntheticListing } from "./session-authority-fixture.mts";

export type Provenance = "D-known" | "F-known";
export type Scenario = "interrupted-successive" | "normal-successive" | "same-target-retry";
const T = taskId(10), B = taskId(11), M1 = taskId(20), M2 = taskId(21), U = taskId(22), P = taskId(23);
const S1 = taskId(101), S2 = taskId(102), S3 = taskId(103), SX = taskId(104);
const source = { binding: "external-run-receipt" };

export async function diagnostic(t: test.TestContext, d: Diagnostics, provenance: Provenance, scenario: Scenario, offered = false) {
  const node = closedNode(t), caseName = `${provenance}/${scenario}${offered ? "/offered-retry" : ""}`;
  let now = T0, target = S1, seen: SessionInfo[] = [];
  const logs: string[] = [], receiving: { event: string; session: string; ids: string[]; output: string }[] = [];
  const ids = [M1, M2, U, P];
  const record = (id: string) => getMessage(node.paths.inbox, id);
  const bytes = (id: string) => fs.readFileSync(path.join(node.paths.inbox, `${id}.json`), "utf8");
  const fields = (r: InboxRecord | null) => r && ({ messageId: r.messageId, toSession: r.toSession, state: r.state,
    closedTo: r.closedTo, closedAttempt: r.closedAttempt, delivery: r.delivery, offers: r.offers,
    retry: r.retry, receivedAt: r.receivedAt, reason: r.reason });
  const runs = () => node.calls.filter((c) => c.args[0] !== "agents");
  const advance = (ms: number) => { now += ms; node.tick(ms); };
  const readKnown = (): Record<string, unknown>[] => JSON.parse(fs.readFileSync(knownSessionsFile(node.paths), "utf8")).sessions;
  function observe(stage: string, extra: Record<string, unknown> = {}) {
    d.observe(stage, { case: caseName, source, now, task: readTask(node.paths, T), discovery: seen.map((s) => s.sessionId),
      knownS2: readKnown().find((s) => s.sessionId === S2) ?? null, closedS2: closedSession(node.paths, S2, now),
      records: ids.map((id) => fields(record(id))), receiving, audits: audits(node), localTaskCount: listTasks(node.paths).length,
      logs, counts: { launches: runs().length, hooks: receiving.length,
        receipts: ids.filter((id) => getReceipt(node.paths.inbox, id)).length }, ...extra });
  }
  function view(sessionId: string) {
    target = sessionId;
    node.rows.splice(0, node.rows.length,
      { id: sessionId.slice(0, 8), sessionId, name: "synthetic-task-a", state: "working" },
      { id: "bbbbbbbb", sessionId: SX, name: "synthetic-task-b", state: "working" });
    seen = [{ sessionId, name: "synthetic-task-a", runtime: "claude-code", state: "busy", cwd: node.workspace },
      { sessionId: SX, name: "synthetic-task-b", runtime: "claude-code", state: "busy", cwd: node.workspace }];
  }
  // Positive handover cases explicitly model complete generated native facts.
  const discover = recordingSessions(node.paths, async () => syntheticListing(node.livenessAuthority, [...seen],
    [SESSION, S1, S2, S3, SX].map(sessionId => fixtureEvidence({ runtime: "claude-code", sessionId },
      seen.some(row => row.sessionId === sessionId) ? "running" : "closed", now)), now), (line) => logs.push(line), () => now,
    undefined, undefined, node.livenessAuthority);
  const watch = () => watchTasks(node.deps(), (line) => logs.push(line));
  const fallback = () => deliverToClosed(node.deps(), (line) => logs.push(line));
  async function round(label: string) {
    await discover(); observe(`${label}:discovery`);
    await watch(); observe(`${label}:watch`);
    await fallback(); observe(`${label}:fallback`);
  }
  function store(id: string, toSession: string, receivedAt: number) {
    return storeMessage(node.paths.inbox, { messageId: id, from: PEER, toSession,
      text: `synthetic ${id}`, createdAt: new Date(receivedAt).toISOString() }, receivedAt);
  }
  function hook(event: "UserPromptSubmit" | "Stop" | "StopFailure") {
    const output = deliverForHook({ hook_event_name: event, session_id: target,
      permission_mode: "auto", stop_hook_active: false }, { paths: node.paths, now: () => now,
      nonce: () => "synthetic-nonce", replyCommand: "synthetic-node msg send" });
    const context = output ? String(JSON.parse(output).hookSpecificOutput?.additionalContext ?? "") : "";
    const received = [...context.matchAll(/^=== Kherep peer message ([\w-]+) \[/gm)].map((m) => m[1]!);
    receiving.push({ event, session: target, ids: received, output });
    observe(`hook:${event}`);
    return received;
  }
  const lock = recordLockFile(node.paths.inbox, M2);
  setRecordLockWait(0);
  t.after(() => { setRecordLockWait(RECORD_LOCK_WAIT_MS); if (fs.existsSync(lock)) fs.unlinkSync(lock); });
  try {
    const task = writeTask(node.paths, { taskId: T, name: "synthetic-task-a", cwd: node.workspace,
      permissionMode: "auto", runtime: "claude", state: "running", local: "intercom", shortId: S1.slice(0, 8),
      sessionId: S1, requestedBy: `${PEER.nodeId}/${PEER.session}`,
      startedAt: new Date(now).toISOString(), deadline: new Date(now + 2 * 60 * 60_000).toISOString(), updatedAt: "" }, now);
    writeTask(node.paths, { ...task, taskId: B, name: "synthetic-task-b", local: undefined,
      requestedBy: undefined, shortId: "bbbbbbbb", sessionId: SX }, now);
    const unrelated = store(U, SX, now - 4_000);
    writeJsonAtomic(path.join(node.paths.inbox, `${U}.json`), { ...unrelated, closedTo: S1,
      delivery: { taskId: B, runtime: "claude", sessionId: SX } });
    const unrelatedBytes = bytes(U);
    for (const [i, id] of [M1, M2].entries()) store(id, provenance === "F-known" ? SESSION : S1, now - 5_000 + i);
    if (provenance === "F-known") {
      await fallback();
      for (const id of [M1, M2]) {
        const r = record(id)!;
        assert.deepEqual([r.toSession, r.closedTo, r.state, r.delivery],
          [S1, SESSION, "accepted", { taskId: T, runtime: "claude", sessionId: S1 }]);
        assert.ok(r.closedAttempt);
      }
    } else for (const id of [M1, M2]) {
      assert.equal(record(id)?.closedAttempt, undefined);
      assert.equal(record(id)?.delivery, undefined);
    }
    view(S1); await discover(); observe("initial");
    if (offered) {
      assert.deepEqual(hook("UserPromptSubmit"), [M1, M2], "initial failed turn really received both blocks");
      hook("StopFailure");
      for (const id of [M1, M2]) {
        const r = record(id)!;
        assert.deepEqual([r.state, r.offers, r.retry], ["offered", 1, true]);
        assert.equal(getReceipt(node.paths.inbox, id), null, "StopFailure invents no delivered receipt");
      }
      observe("failed-turn-offer-retry");
    }
    const entry = [record(M1)!, record(M2)!];
    advance(SESSIONS_INTERVAL_MS); view(S2); await discover();
    if (scenario !== "normal-successive") {
      const fd = fs.openSync(lock, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); fs.closeSync(fd);
    }
    await watch(); observe("first-handover:watch");
    if (scenario !== "normal-successive") {
      assert.ok(fs.existsSync(lock));
      assert.equal(readTask(node.paths, T)?.sessionId, S1);
      assert.equal(record(M1)?.toSession, S2);
      assert.equal(record(M2)?.toSession, S1);
      assert.deepEqual(record(M1), { ...entry[0], toSession: S2, closedTo: entry[0]!.closedTo ?? S1 });
      assert.deepEqual(record(M2), entry[1], "held message has no invented offer or receipt");
      assert.equal(logs.filter((line) => line.includes(T) && line.includes(M2) && line.includes("RECORD_LOCK_BUSY")).length, 1);
    } else assert.equal(readTask(node.paths, T)?.sessionId, S2);
    await fallback(); observe("first-handover:fallback");
    if (scenario !== "normal-successive") fs.unlinkSync(lock);
    advance(SESSIONS_INTERVAL_MS); view(scenario === "same-target-retry" ? S2 : S3);
    await round("retry");
    if (scenario === "same-target-retry") for (const id of [M1, M2]) assert.equal(record(id)?.toSession, S2);
    if (scenario !== "same-target-retry") {
      for (let i = 1; i < CLOSED_AFTER_MISSES - 1; i++) { advance(SESSIONS_INTERVAL_MS); await round(`miss-${i + 1}`); }
      advance(SESSIONS_INTERVAL_MS); store(P, S2, now - 1); await round("eligible-rescue");
      const known = readKnown().find((s) => s.sessionId === S2)!;
      assert.ok(Number(known.misses) >= CLOSED_AFTER_MISSES);
      assert.ok(Date.parse(String(known.missedAt)) - Date.parse(String(known.missedSince)) >= CLOSED_MIN_AGE_MS);
      assert.ok(closedSession(node.paths, S2, now));
    } else {
      store(P, SESSION, now - 1); await round("eligible-rescue");
    }
    const rescue = record(P)!;
    assert.deepEqual([rescue.toSession, rescue.delivery], [target, { taskId: T, runtime: "claude", sessionId: target }]);
    assert.ok(rescue.closedAttempt);
    assert.ok(audits(node).some((a) => a.outcome === "reused" && a.reason === "intercom session running"
      && (a.messageIds as string[]).includes(P)));
    if (offered) for (const before of entry) {
      assert.deepEqual(record(before.messageId), { ...before, toSession: target,
        delivery: { ...before.delivery!, sessionId: target } }, "handover preserves real offer/retry evidence");
    }
    const beforeHook = new Map([M1, M2, P].map((id) => [id, bytes(id)]));
    const firstIds = hook("UserPromptSubmit");
    for (const id of [M1, M2, P]) {
      if (firstIds.includes(id)) assert.equal(record(id)?.state, "offered");
      else assert.equal(bytes(id), beforeHook.get(id), "unseen message was not offered");
    }
    hook("Stop");
    for (const id of firstIds) assert.equal(record(id)?.state, "delivered");
    const repeatIds = [...hook("UserPromptSubmit"), ...hook("Stop")];
    for (let i = 0; i < 2; i++) { advance(SESSIONS_INTERVAL_MS); await round(`stable-${i}`); }
    repeatIds.push(...hook("UserPromptSubmit"), ...hook("Stop"));
    const waitingBeforeHorizon = [M1, M2].map((id) => fields(record(id)));
    const refusalOrigin = Math.max(...[M1, M2].map((id) => {
      const r = record(id)!; return Date.parse((r.closedTo && r.closedAttempt) || r.receivedAt);
    }));
    advance(Math.max(1, refusalOrigin + UNDELIVERABLE_AFTER_MS + 1 - now));
    await round("refusal-horizon");
    repeatIds.push(...hook("UserPromptSubmit"), ...hook("Stop"));
    const verdicts = Object.fromEntries([M1, M2].map((id) => {
      const r = record(id)!;
      const verdict = repeatIds.includes(id) || firstIds.filter((x) => x === id).length > 1 ? "Duplicate"
        : firstIds.includes(id) && r.state === "delivered" ? "Delivered"
        : !firstIds.includes(id) && r.toSession === S2 && r.state === "refused" && r.reason === "target session not running"
          ? "Stranded in tested lifecycle" : "UNKNOWN";
      return [id, verdict];
    }));
    assert.equal(bytes(U), unrelatedBytes, "unrelated live-task record remains byte-identical");
    assert.equal(runs().length, 0, "no background/resume runtime calls");
    assert.equal(listTasks(node.paths).length, 2, "no additional task created");
    assert.ok(!logs.some((line) => line.includes("could not write") || line.includes("could not check")));
    if (scenario !== "interrupted-successive") for (const id of [M1, M2]) assert.equal(verdicts[id], "Delivered");
    observe("summary", { verdicts, firstIds, repeatIds, waitingBeforeHorizon, positiveRescue: true, unrelatedStable: true });
    return { case: caseName, verdicts, firstIds, repeatIds, target,
      entryRecords: entry, finalRecords: [record(M1)!, record(M2)!], receiving: [...receiving] };
  } finally { if (fs.existsSync(lock)) fs.unlinkSync(lock); }
}
