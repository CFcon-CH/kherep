import { refuseInboxMessage } from "./target-delivery-inbox.mts";
import { transitionRouteMessages } from "./target-delivery-outcome.mts";
import { withRoute } from "./target-delivery-route.mts";
import { settleOffered } from "./codex-runner.mts";
import { listInbox, markRefused, setMessageProgress } from "./inbox.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { queueReport, writeTask, type TaskRecord } from "./task-records.mts";

// Issue #197, inactivity: a run the node started (task, continue, intercom
// start or resume, message resume) records awaitingProgressSince. The watch
// round clears it at the first observed progress of the run's turn; a run
// without any NO_PROGRESS_MS after its start is stopped and reported failed.
// Live finding 2026-10-04: a background Claude session whose login had expired
// went idle without a turn while its sender saw `delivered`.
// - Claude: `claude agents --json --all` (https://code.claude.com/docs/en/agent-view,
//   fetched 2026-10-04) documents `state` working, blocked, done, failed and
//   stopped; `blocked` includes "an error only you can clear such as an
//   expired login", and `waitingFor` names an open prompt. Progress is a done
//   session, one still working WORKING_SETTLE_MS after the start, or one
//   blocked on a prompt its turn raised. Any other state (for example idle) is none.
// - Codex: an `item.*` event or `turn.completed` in the run's events
//   (codex-output.mts progressed); `thread.started` and `turn.started` precede
//   the model's first answer and do not count.

export const NO_PROGRESS_MS = 10 * 60_000;
export const NO_PROGRESS_REASON = "no progress after start";
// The fixed reason a message the run carried gets at its sender.
export const NO_PROGRESS_MESSAGE = "target run made no progress after start";

// A turn that fails at once (an expired login stops "before it reaches the
// API") may still read working in the first seconds, so working counts only
// this long after the start.
export const WORKING_SETTLE_MS = 30_000;
const TURN_PROMPTS: readonly unknown[] = ["permission prompt", "input needed", "sandbox request"];

export function claudeProgressed(record: TaskRecord, row: Record<string, unknown> | undefined, now: number): boolean {
  if (!row || record.awaitingProgressSince === undefined) return false;
  const settled = now - Date.parse(record.awaitingProgressSince) >= WORKING_SETTLE_MS;
  return (row.state === "working" && settled) || row.state === "done" || (row.state === "blocked" && TURN_PROMPTS.includes(row.waitingFor));
}

export const progressOverdue = (record: TaskRecord, now: number): boolean =>
  record.awaitingProgressSince !== undefined && now - Date.parse(record.awaitingProgressSince) >= NO_PROGRESS_MS;

// Issue #308: the messages a Claude intercom start carried in its task text
// (closed-resume.mts startIntercom) are offered to it and settled when its
// turn ends, as a Codex run settles its offers (codex-runner.mts
// settleOffered): delivered once the session is done, offered again when it
// failed or was stopped. Progress (working, a prompt the turn raised) is no
// read receipt. The session's own Stop hook may confirm them earlier.
export function settleCarried(deps: RunnerDeps, record: TaskRecord, row: Record<string, unknown>): TaskRecord {
  const completed = row.state === "done";
  if (!completed && row.state !== "failed" && row.state !== "stopped") return record;
  settleOffered(deps, { ...record, offered: record.carried }, completed);
  return { ...record, carried: undefined };
}

// The waiting messages this run delivers (delivery identity) are refused with
// the fixed reason: their one closed-session attempt went to this run.
export function refuseCarried(deps: RunnerDeps, record: TaskRecord): void {
  if(record.targetAttempt){
    withRoute(deps.paths,record.targetAttempt,s=>{const op=s.consumer??s.group.operation;if(op.execution.taskId!==record.taskId)throw Error("refusal task group differs");});
    transitionRouteMessages(deps.paths,{kind:"message",handle:record.targetAttempt},r=>r.state==='accepted'||r.state==='offered'?{...r,state:"refused",reason:NO_PROGRESS_MESSAGE}:r);return;
  }
  for (const message of listInbox(deps.paths.inbox)) {
    if (message.delivery?.taskId === record.taskId) refuseInboxMessage(deps.paths, message.messageId, NO_PROGRESS_MESSAGE,
      r=>(r.state==='accepted'||r.state==='offered')&&r.delivery?.taskId===record.taskId&&r.delivery.runtime===(record.runtime??'claude'));
  }
}

// Stops a run without progress; a failed stop is logged, not thrown.
async function stopStalled(record: TaskRecord, stop: () => Promise<unknown>, log: (line: string) => void): Promise<void> {
  try {
    await stop();
  } catch (error) {
    log(`kherep-node: could not stop task ${record.taskId} without progress: ${String((error as Error).message ?? error)}`);
  }
}

// A Claude run that made no progress: its session is stopped (best effort, the
// short id may be unknown), the task reported failed and its messages refused.
// The runtime's readiness verdict ages out, so the next caller starts a probe.
export async function failStalledClaude(deps: RunnerDeps, record: TaskRecord, stop: (shortId: string) => Promise<unknown>,
  log: (line: string) => void, now: number): Promise<void> {
  deps.readiness?.invalidate("claude");
  const { shortId } = record;
  if (shortId) await stopStalled(record, () => stop(shortId), log);
  refuseCarried(deps, record);
  const saved = writeTask(deps.paths, { ...record, state: "failed", reason: NO_PROGRESS_REASON, awaitingProgressSince: undefined,
    carried: undefined, running: undefined }, now);
  queueReport(deps.paths, { taskId: saved.taskId, state: "failed", reason: NO_PROGRESS_REASON,
    ...(saved.sessionId ? { sessionId: saved.sessionId } : {}) });
  log(`kherep-node: task ${record.taskId} made no progress after start; reported failed`);
}

// A Codex run that made no progress: stop reports it failed (codex-runner.mts
// stopCodex); the messages it carried get wake-failed and are offered again
// within the offer limit, after the runtime is probed again.
export async function failStalledCodex(deps: RunnerDeps, record: TaskRecord, stop: () => Promise<unknown>,
  log: (line: string) => void, now: number): Promise<void> {
  deps.readiness?.invalidate("codex");
  for (const id of record.offered ?? []) setMessageProgress(deps.paths.inbox, id, "failed", "wake-failed", now);
  await stopStalled(record, stop, log);
}
