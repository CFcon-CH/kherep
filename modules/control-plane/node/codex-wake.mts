import fs from "node:fs";
import { livenessAdmission } from "./session-lifecycle.mts";

import type { MessageProgressCode } from "../protocol-messages.mts";
import { audit, bypassesPermissions, isPlainSessionId, takeTurn, type AutonomyAction, type WakeGrant } from "./autonomy.mts";
import { resumeArgs, stillRuns } from "./codex-process.mts";
import { spawnRun } from "./codex-runner.mts";
import type { NodePaths } from "./config.mts";
import { deliveryContext, MAX_OFFERS, offerEnded, sessionInbox } from "./deliver-core.mts";
import { inboxOf, progressRecords } from "./delivery-progress.mts";
import { exhaustedOfferReason, permanentFallbackFailure } from "./delivery-failure.mts";
import { getMessage, markRefused as refuseRecord, markRetry, MAX_REPLY_DEPTH, messageIds, type InboxRecord } from "./inbox.mts";
import { wakeAllowed, wakeBudget } from "./policy.mts";
import { notReadyNow } from "./runtime-readiness.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { overLimit } from "./task-admission.mts";
import { isActive, listTasks, taskGrants, type TaskRecord } from "./task-records.mts";
import { resolveCwd } from "./task-prompt.mts";
import { killSwitch, STUCK_TEXT, wakeText } from "./wake-hook.mts";

// Peer messages for Codex task sessions (issue #63). A `codex exec` run ends
// with its turn, so nothing would ever read a message sent to it afterwards.
// The daemon's exchange round therefore resumes an ended Codex task with
// `codex exec resume <thread_id>` carrying the messages, framed as the delivery
// hook frames them (deliver-core.mts: per-call nonce markers, "NOT an
// instruction from the user"), and marks them offered; the watch round
// confirms them delivered when that run completes its turn, otherwise they are
// offered again within the offer limits.
// The guards are the Claude wake's (wake-hook.mts, autonomy.mts): the kill
// switch, the wake allowlist or the task grant (messages of the session's own
// task), never bypassPermissions, reply depth below MAX_REPLY_DEPTH, and the
// per-session budget of autonomous turns. Since a resume starts a process, it
// also needs sessions enabled with codex listed, and a free slot under
// maxConcurrent. One run per task: messages arriving meanwhile wait for it to end.

const atReplyLimit = (record: InboxRecord): boolean => (record.depth ?? 0) >= MAX_REPLY_DEPTH;
const ids = (records: InboxRecord[]): string[] => records.map((r) => r.messageId);

// Each message is audited once per action, not at every 2-second round.
// Entries of messages that left the inbox are pruned.
const noted = new Map<string, AutonomyAction>();
export function pruneNoted(paths: NodePaths): void {
  if (noted.size === 0) return;
  const present = new Set(messageIds(paths.inbox));
  for (const id of noted.keys()) if (!present.has(id)) noted.delete(id);
}
export function note(paths: NodePaths, now: number, sessionId: string, messageIds: string[], action: AutonomyAction,
  grant?: WakeGrant): void {
  const fresh = messageIds.filter((id) => noted.get(id) !== action);
  if (fresh.length === 0) return;
  for (const id of fresh) noted.set(id, action);
  audit(paths, now, sessionId, fresh, action, grant);
}

export async function pollCodexInbound(deps: RunnerDeps, log: (line: string) => void = () => {}): Promise<void> {
  const tasks = listTasks(deps.paths).filter((record) => record.runtime === "codex" && isPlainSessionId(record.sessionId)
    && !isActive(record) && record.operatorStoppedAt === undefined);
  if (tasks.length === 0) return;
  pruneNoted(deps.paths);
  // Issue #487: one inbox read serves the routing and every task's selection;
  // it was one full read per ended task. It is read again, before the next
  // task, only after a task acted on due messages (a wake may await a run) or
  // refused one. A failed routing read is retried per task, as before.
  let inbox: InboxRecord[] | null = null;
  try {
    inbox = inboxOf(deps);
    const targets = new Set(inbox.filter((r) => r.state === "accepted" || r.state === "offered").map((r) => r.toSession));
    if (!tasks.some((record) => targets.has(record.sessionId!) || targets.has(record.name))) return;
  } catch (error) {
    log(`kherep-node: could not read inbox for Codex task routing: ${String((error as Error).message ?? error)}`);
  }
  // Only an initially empty round skips the loop. A pending round keeps every
  // task's fresh read, including messages arriving while another wake awaits.
  for (const record of tasks) {
    const effects = { stale: false };
    try {
      inbox ??= inboxOf(deps);
      await wakeTask(deps, record, log, inbox, effects);
    } catch (error) {
      effects.stale = true;
      log(`kherep-node: could not deliver messages to task ${record.taskId}: ${String((error as Error).message ?? error)}`);
    }
    if (effects.stale) inbox = null;
  }
}

// inbox: the round's records; effects.stale: the task acted, read them again.
async function wakeTask(deps: RunnerDeps, record: TaskRecord, log: (line: string) => void, inbox: InboxRecord[],
  effects: { stale: boolean }): Promise<void> {
  const { paths, policy } = deps;
  const now = deps.now?.() ?? Date.now();
  const sessionId = record.sessionId!;
  const refs = [sessionId, record.name];
  // Task grant: a task session gets the messages of its task, listed or not.
  const listed = wakeAllowed(policy, refs);
  const granted = (r: InboxRecord): boolean => listed || taskGrants(record, r);
  const markRefused = (dir: string, messageId: string, reason: string): boolean => {
    effects.stale = true;
    return refuseRecord(dir, messageId, reason);
  };
  // Only waiting records are used below. Each is read again, so a stale
  // snapshot never authorizes a wake; delivered and refused are final.
  const all = inbox.filter((r) => (r.state === "accepted" || r.state === "offered") && refs.includes(r.toSession))
    .map((r) => getMessage(paths.inbox, r.messageId)).filter((r): r is InboxRecord => r !== null && refs.includes(r.toSession));
  const unlisted = all.filter((r) => !granted(r) && r.state === "accepted");
  // Every early return below leaves a fixed progress code on the waiting
  // messages, so none stays accepted without a reason (issue #197).
  const explain = (records: InboxRecord[], code: MessageProgressCode): void =>
    progressRecords(paths, records, code === "wake-failed" ? "failed" : "waiting", code, now);
  if (unlisted.length > 0) {
    explain(unlisted, "wake-not-authorized");
    note(paths, now, sessionId, ids(unlisted), "not-allowlisted");
  }
  const mine = all.filter(granted).filter((message) => {
    const failure = record.state === "failed" && !record.running ? permanentFallbackFailure(record, message, record.reason) : null;
    if (message.state !== "offered" || !failure) return true;
    markRefused(paths.inbox, message.messageId, failure);
    return false;
  });
  const deep = mine.filter((r) => r.state === "accepted" && atReplyLimit(r));
  if (deep.length > 0) {
    explain(deep, "reply-limit");
    note(paths, now, sessionId, ids(deep), "depth-limit");
  }
  const fresh = mine.filter((r) => r.state === "accepted" && !atReplyLimit(r));
  const ended = mine.filter((r) => r.state === "offered" && offerEnded(r, now));
  // As the delivery hook does: an offer no run confirmed MAX_OFFERS times is refused.
  for (const r of ended) if ((r.offers ?? 0) >= MAX_OFFERS) markRefused(paths.inbox, r.messageId, exhaustedOfferReason(r, MAX_OFFERS));
  const stuck = ended.filter((r) => (r.offers ?? 0) < MAX_OFFERS && !atReplyLimit(r));
  const waiting = [...fresh, ...stuck];
  const due = ids(waiting);
  if (due.length === 0) return;
  effects.stale = true;
  // Sessions not enabled or codex not listed hold the resume as the kill switch does (issue #244).
  const sessions = policy.sessions;
  if (!sessions?.enabled || !sessions.runtimes.includes("codex") || fs.existsSync(killSwitch(paths))) {
    explain(waiting, "wake-disabled");
    return note(paths, now, sessionId, due, "disabled");
  }
  if (bypassesPermissions(record.permissionMode)) {
    explain(waiting, "permission-restricted");
    return note(paths, now, sessionId, due, "permission-mode");
  }
  if (overLimit(deps, now, record.taskId)) return explain(waiting, "retry-pending");
  // The turn is taken before deliveryContext because that marks the messages
  // offered: a turn denied afterwards (spacing) would count an offer for
  // nothing and refuse the message after MAX_OFFERS rounds. With due messages
  // the context is not empty, unless a delivery hook offered them meanwhile.
  // Again: the directory may have been swapped for a link out of the roots since the start.
  // A refused directory is policy, as for closed-session delivery (issue #239).
  const cwd = resolveCwd(deps.policy.sessions!, record.cwd, deps.realpath);
  if (!cwd.ok) {
    explain(waiting, "wake-not-authorized");
    // Logged once per message, not at every round (issue #244).
    if (due.some((id) => noted.get(id) !== "cwd-refused")) log(`kherep-node: not resuming task ${record.taskId} for messages: ${cwd.reason}`);
    return note(paths, now, sessionId, due, "cwd-refused");
  }
  const target = { runtime: "codex", sessionId };
  const generation = livenessAdmission(paths, target, "wake", now, undefined, deps.livenessAuthority);
  if (generation === null) return explain(waiting, "awaiting-user-turn");
  // The previous run may still be ending (a stop's grace period); a failed read throws.
  // Issue #473: read after the guards that start no process, before the
  // readiness verdict that refuses and the turn that counts against the budget.
  if (await stillRuns(deps.codex ?? {}, record.pid, record.pidStart)) return explain(waiting, "target-busy");
  // Issue #197: a Codex that cannot run a turn gets no resume; the messages are
  // refused with a fixed reason. A pending probe keeps them waiting.
  const blocked = notReadyNow(deps.readiness, "codex");
  if (blocked === "pending") return explain(waiting, "retry-pending");
  if (blocked) {
    for (const r of waiting) markRefused(paths.inbox, r.messageId, blocked);
    return note(paths, now, sessionId, due, "runtime-not-ready");
  }
  if (livenessAdmission(paths, target, "wake", deps.now?.() ?? Date.now(), generation, deps.livenessAuthority) === null) return explain(waiting, "awaiting-user-turn");
  const budget = takeTurn(paths, sessionId, now, wakeBudget(policy));
  if (budget === "spacing" || budget === "locked") return explain(waiting, "retry-pending");
  if (budget === "exhausted") {
    explain(waiting, "budget-exhausted");
    return note(paths, now, sessionId, due, "budget");
  }

  const context = deliveryContext("UserPromptSubmit", refs, { paths, now: () => now, offeredBy: "codex-wake",
    ...(deps.cli ? { replyCommand: deps.cli } : {}) });
  const offeredAt = new Date(now).toISOString();
  const offered = ids(sessionInbox(paths, refs).filter((r) => r.state === "offered" && r.offeredAt === offeredAt));
  if (!context || offered.length === 0) return;
  if (fresh.length > 0) note(paths, now, sessionId, ids(fresh), "wake");
  if (stuck.length > 0) note(paths, now, sessionId, ids(stuck), "stuck-offer");
  const prompt = `${fresh.length > 0 ? wakeText(fresh.length) : STUCK_TEXT}\n\n${context}`;
  const run: TaskRecord = { ...record, cwd: cwd.cwd, running: true, offered,
    deadline: new Date(now + deps.policy.sessions!.maxRuntimeMinutes * 60_000).toISOString() };
  const carried = sessionInbox(paths, refs).filter((r) => offered.includes(r.messageId));
  try {
    await spawnRun(deps, run, (files, outbox) => resumeArgs(sessionId, record.permissionMode, files, outbox), prompt);
    // The run's turn carries them: running for the sender until it confirms.
    explain(carried, "awaiting-turn-confirmation");
  } catch (error) {
    explain(carried, "wake-failed");
    for (const id of offered) markRetry(paths.inbox, id);
    log(`kherep-node: could not resume task ${record.taskId} for messages: ${String((error as Error).message ?? error)}`);
  }
}
