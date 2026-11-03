import { startTimeOf } from "./codex-process.mts";
import { isSessionRef } from "../protocol-messages.mts";
import type { TaskState } from "../protocol-tasks.mts";
import { MAX_RUNTIME_REASON } from "./codex-runner.mts";
import { watchCodexTasks } from "./codex-watch.mts";
import { retireCopies } from "./copy-retire.mts";
import { finalizeMessageTaskIdentity, resolveDelivery } from "./delivery-identity.mts";
import { RecordLockBusy } from "./inbox-record-lock.mts";
import { claudeProgressed, failStalledClaude, progressOverdue, refuseCarried, settleCarried } from "./run-progress.mts";
import { agentRows, findRow, mapIds, rowPid, markClaudeStopped, runClaude, stopTask, type RunnerDeps } from "./session-runner.mts";
import { measureClaude } from "./task-control-claude.mts";
import { handoverDeliveryMessages } from "./task-handover.mts";
import { isActive, listTasks, mappingPendingAt, queueReport, readTask, writeTask, type TaskRecord } from "./task-records.mts";

// The watch round for started task sessions (issue #31, item 5), run with the
// daemon's session snapshot. The `state` values of `claude agents --json`
// ("Read session state from a script", https://code.claude.com/docs/en/agent-view,
// fetched 2026-09-25) map to task states; each change is reported once. A
// task its session reported done stays under the deadline until it ends.
// Codex tasks have their own round (codex-runner.mts, issue #63).
export const AGENT_STATES: Readonly<Record<string, TaskState>> = {
  working: "running", blocked: "needs-input", done: "done", failed: "failed", stopped: "stopped",
};

// Issue #541: a max-runtime stop that `claude stop` cannot confirm.
export const MAX_STOP_ROUNDS = 10;
export const STOP_UNCONFIRMED_NO_RUN = "max runtime reached; claude stop not confirmed, fresh status shows no live run";
export const STOP_UNCONFIRMED_GAVE_UP = `max runtime reached; claude stop not confirmed after ${MAX_STOP_ROUNDS} rounds`;

// After a failed max-runtime stop the run is measured as owner status measures
// it. No live process measured (a session without one, no run version) settles
// the record at once. A live process, also behind an ended row, and a
// measurement that decides nothing (unknown) are stopped again next round, for
// at most MAX_STOP_ROUNDS rounds counted on the record, so a daemon restart
// neither resets nor prolongs them. The measurement may re-capture the process
// identity, so every write starts from the record on disk.
async function stopUnconfirmed(deps: RunnerDeps, mapped: TaskRecord, row: Record<string, unknown> | undefined, error: unknown,
  log: (line: string) => void, now: number): Promise<void> {
  const message = String((error as Error).message ?? error);
  const measured = await measureClaude(mapped, deps, now);
  const current = readTask(deps.paths, mapped.taskId);
  if (!current || !isActive(current)) return; // settled by another writer meanwhile
  const base = mapIds(current, row);
  const attempt = (current.stopAttempts ?? 0) + 1;
  if ((measured.processState === "closed" || measured.processState === "idle") && measured.runVersion === undefined) {
    const saved = markClaudeStopped(deps, base, STOP_UNCONFIRMED_NO_RUN);
    log(`kherep-node: task ${mapped.taskId}: max-runtime stop not confirmed (${message}); fresh status shows no live run (${measured.processState}), recorded ${saved.state}`);
  } else if (attempt >= MAX_STOP_ROUNDS) {
    const saved = markClaudeStopped(deps, base, STOP_UNCONFIRMED_GAVE_UP);
    log(`kherep-node: task ${mapped.taskId}: max-runtime stop not confirmed after ${MAX_STOP_ROUNDS} rounds (${message}); recorded ${saved.state}`);
  } else {
    writeTask(deps.paths, { ...base, stopAttempts: attempt }, now);
    log(`kherep-node: could not stop task ${mapped.taskId}: ${message} (attempt ${attempt} of ${MAX_STOP_ROUNDS})`);
  }
}

// Issue #634: a record lock another writer holds leaves the task, its mapping
// unsaved, to the next watch while later tasks still run; any other error ends
// the round as before.
function deferOnBusy(error: unknown, taskId: string, step: string, log: (line: string) => void): void {
  if (!(error instanceof RecordLockBusy)) throw error;
  log(`kherep-node: task ${taskId}: ${step} deferred: ${error.code}: ${error.message}`);
}

// Issue #638: a nonempty full id that is no session reference (isSessionRef)
// is never adopted; an empty or missing one keeps the missing-mapping path.
const malformedId = (id: unknown): boolean => typeof id === "string" && id !== "" && !isSessionRef(id);

export async function watchTasks(deps: RunnerDeps, log: (line: string) => void = () => {}): Promise<void> {
  await watchCodexTasks(deps, log);
  const claude = listTasks(deps.paths).filter((t) => t.runtime !== "codex");
  const active = claude.filter(isActive);
  if (active.length === 0 && !claude.some((t) => t.retire?.length)) return;
  const now = deps.now?.() ?? Date.now();
  let rows: Record<string, unknown>[] | null = null;
  try {
    rows = await agentRows(deps);
  } catch (error) {
    // A failed listing decides nothing; the deadline still applies.
    log(`kherep-node: task watch could not list sessions: ${String((error as Error).message ?? error)}`);
  }
  const deferred = new Set<string>();
  for (const record of active) {
    // A launch in flight (session-runner.mts background, closed-resume.mts): its run maps it.
    if (!record.shortId && mappingPendingAt(record, now)) continue;
    const found = rows ? findRow(rows, record) : undefined;
    // A malformed listed id, or a malformed stored one a handover would leave,
    // defers this task alone: only the row's short id serves its deadline stop.
    const invalid = malformedId(found?.sessionId) || (record.local === "intercom" && malformedId(record.sessionId)
      && typeof found?.sessionId === "string" && found.sessionId !== "" && found.sessionId !== record.sessionId);
    if (invalid) deferred.add(record.taskId);
    const row = invalid ? { id: found!.id } : found;
    let mapped = mapIds(record, row);
    if(mapped.targetAttempt) {
      const pid=rowPid(row);
      if(pid!==undefined) {
        const pidStart=await startTimeOf(deps.codex??{},pid);
        if(pidStart)mapped={...mapped,pid,pidStart};
      }
      try {mapped=finalizeMessageTaskIdentity(deps.paths,mapped,record.local==='intercom'&&record.sessionId!==row?.sessionId?record.sessionId:undefined);}
      catch(error){deferOnBusy(error,record.taskId,'copy mapping',log);continue;}
    }
    if(mapped.targetAttempt&&(mapped.observedSessionId||mapped.mappingConflict)){
      writeTask(deps.paths,mapped,now);
      if(now<Date.parse(record.deadline))continue;
    }
    if (now >= Date.parse(record.deadline)) {
      if (!mapped.shortId) {
        log(`kherep-node: task ${record.taskId} passed its max runtime, but its session id is not known`);
        continue;
      }
      if (mapped.shortId !== record.shortId) writeTask(deps.paths, mapped, now);
      try {
        await stopTask({ taskId: record.taskId }, deps, MAX_RUNTIME_REASON);
      } catch (error) {
        // A failed read, measurement or write here decides nothing and never aborts the round.
        await stopUnconfirmed(deps, mapped, row, error, log, now).catch((failed: unknown) => log(
          `kherep-node: could not stop task ${record.taskId}: ${String((error as Error).message ?? error)} (${String((failed as Error).message ?? failed)})`));
      }
      continue;
    }
    if (invalid) {
      // No evidence the session ended: clocks, carried messages and copies wait for a valid listing.
      log(`kherep-node: task ${record.taskId}: session id is not valid; mapping deferred`);
      continue;
    }
    // Issue #197: no progress of the run's turn within NO_PROGRESS_MS fails it
    // (run-progress.mts). A failed listing decides nothing; a state outside
    // AGENT_STATES (idle) is no progress.
    if (rows && mapped.awaitingProgressSince !== undefined && !record.running) {
      if (claudeProgressed(mapped, row, now)) mapped = { ...mapped, awaitingProgressSince: undefined };
      else if (row && (row.state === "failed" || row.state === "stopped")) {
        refuseCarried(deps, mapped);
        mapped = { ...mapped, awaitingProgressSince: undefined, carried: undefined };
      } else if (progressOverdue(mapped, now)) {
        await failStalledClaude(deps, mapped, (shortId) => runClaude(deps, ["stop", shortId], undefined, {kind:"operator"}), log, now);
        continue;
      }
    }
    // Issue #308: what an intercom start carried is delivered only once its turn completed.
    if (row && mapped.carried) mapped = settleCarried(deps, mapped, row);
    const agentState = row ? AGENT_STATES[String(row.state)] : undefined;
    if (record.running) {
      // Reported done by the session: released once its process has ended.
      if (rows && (!row || agentState === "done" || agentState === "stopped" || agentState === "failed")) {
        writeTask(deps.paths, { ...mapped, running: undefined }, now);
      }
      continue;
    }
    const next = agentState ?? record.state;
    const reported = next !== record.state || mapped.sessionId !== record.sessionId;
    if (!reported && mapped.shortId === record.shortId && mapped.mappingPendingSince === record.mappingPendingSince
      && mapped.awaitingProgressSince === record.awaitingProgressSince && mapped.carried === record.carried) continue;
    // An intercom session resumed as a copy under a new id (issue #109) takes over its waiting messages.
    if (record.local === "intercom" && record.sessionId && mapped.sessionId && mapped.sessionId !== record.sessionId) {
      try {
        handoverDeliveryMessages(deps.paths, record.sessionId, mapped.sessionId,
          { taskId: record.taskId, runtime: record.runtime ?? "claude" });
      } catch (error) {
        deferOnBusy(error, record.taskId, "readdress", log);
        continue;
      }
    }
    let resolved: TaskRecord;
    try {
      resolved = resolveDelivery(deps.paths, { ...mapped, state: next });
    } catch (error) {
      deferOnBusy(error, record.taskId, "delivery identity", log);
      continue;
    }
    const saved = writeTask(deps.paths, resolved, now);
    if (reported) queueReport(deps.paths, { taskId: saved.taskId, state: next, ...(saved.sessionId ? { sessionId: saved.sessionId } : {}) });
  }
  // Adopted copies (issue #111): the sessions their records held before are stopped once idle.
  if (!rows) return;
  for (const record of listTasks(deps.paths).filter((t) => t.retire?.length && !deferred.has(t.taskId))) {
    try {
      await retireCopies(deps, record, rows);
    } catch (error) {
      log(`kherep-node: could not stop a previous copy of task ${record.taskId}: ${String((error as Error).message ?? error)}`);
    }
  }
}
