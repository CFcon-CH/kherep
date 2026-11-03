import { MAX_SUMMARY } from "../protocol-tasks.mts";
import { lastStderrLine, readEvents, readExit, readLastMessage, type CodexExit } from "./codex-output.mts";
import { codexFiles, holdsChild, startTimeOf, stillRuns, type CodexFiles } from "./codex-process.mts";
import { reapDescendants, refreshDescendants } from "./codex-reap.mts";
import { IDENTITY_UNKNOWN, MAX_RUNTIME_REASON, sessionOf, settleOffered, stopCodex } from "./codex-runner.mts";
import { finalizeMessageTaskIdentity, resolveDelivery } from "./delivery-identity.mts";
import { held } from "./process-start.mts";
import { failStalledCodex, NO_PROGRESS_REASON, progressOverdue } from "./run-progress.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { trim } from "./task-admission.mts";
import { isActive, listTasks, queueReport, writeTask, type TaskRecord } from "./task-records.mts";

// The Codex part of the watch round (issue #63), split from codex-runner.mts:
// how an ended run finished, the deadline, process identity and, since issue
// #197, the first progress of a run's turn.

// How an ended run finished: done after turn.completed and exit 0 (or an exit
// this daemon did not see), failed otherwise.
function outcome(files: CodexFiles): { state: "done"; summary?: string } | { state: "failed"; reason: string } {
  const events = readEvents(files);
  const exit = readExit(files);
  if (events.completed && (exit === null || exit.code === 0)) {
    const summary = readLastMessage(files).slice(0, MAX_SUMMARY);
    return { state: "done", ...(summary ? { summary } : {}) };
  }
  return { state: "failed", reason: trim(events.error ?? exitReason(exit, lastStderrLine(files))) };
}

// With codex's own last stderr line, for example its refusal to run outside a
// trusted directory.
function exitReason(exit: CodexExit | null, detail: string): string {
  const reason = exit?.signal ? `codex ended by ${exit.signal}` : exit ? `codex exited with ${String(exit.code)}`
    : "codex ended without completing the turn";
  return detail ? `${reason}: ${detail}` : reason;
}

// The Codex part of the watch round: maps a late thread_id, stops a task past
// its deadline and reports how an ended process finished, once.
export async function watchCodexTasks(deps: RunnerDeps, log: (line: string) => void = () => {}): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const codex = deps.codex ?? {};
  for (let record of listTasks(deps.paths).filter((t) => t.runtime === "codex" && isActive(t))) {
    const files = codexFiles(deps.paths, record.taskId);
    // A start time the spawn could not read is read again while this daemon
    // holds the child; its pid cannot be reused before that, and the holder is
    // compared again after every awaited read. Issue #473: a read after that
    // child ended or was replaced meanwhile is foreign, not recorded.
    const child = record.pid === undefined ? undefined : held.get(record.pid);
    if (record.pidStart === undefined && child) {
      try {
        const pidStart = await startTimeOf(codex, record.pid!);
        if (pidStart && held.get(record.pid!) === child) record = writeTask(deps.paths, { ...record, pidStart }, now);
      } catch {
        // the next round tries again; the held child can be stopped meanwhile
      }
    }
    // Without start time, held child or seen exit (a daemon restart), the
    // process can be neither identified nor stopped: the run counts as failed
    // instead of holding a slot for ever. A run for peer messages keeps the
    // task's reported state.
    if (record.pidStart === undefined && !holdsChild(record.pid) && readExit(files) === null) {
      log(`kherep-node: task ${record.taskId}: ${IDENTITY_UNKNOWN}; its process, if any, was not stopped`);
      settleOffered(deps, record, false);
      if (record.running) {
        writeTask(deps.paths, { ...record, running: undefined, offered: undefined }, now);
        continue;
      }
      const saved = writeTask(deps.paths, { ...record, state: "failed", reason: IDENTITY_UNKNOWN, offered: undefined }, now);
      queueReport(deps.paths, { taskId: saved.taskId, state: "failed", reason: IDENTITY_UNKNOWN, ...sessionOf(saved) });
      continue;
    }
    const threadId = readEvents(files).threadId ?? record.observedSessionId ?? record.sessionId;
    let mapped: TaskRecord = resolveDelivery(deps.paths, { ...record, ...(threadId ? { observedSessionId:record.targetAttempt?threadId:undefined,sessionId:threadId } : {}) });
    if(mapped.targetAttempt&&(mapped.observedSessionId||mapped.mappingConflict)) {
      writeTask(deps.paths,mapped,now);continue; // no public guessed/native ID or second effect
    }
    // Issue #121: exit.json exists only for a run this daemon started and saw
    // end (spawnCodex removes it before each run), so such a run has ended,
    // even past its deadline or when its start time cannot be read.
    const ended = readExit(files) !== null;
    if (!ended && record.operatorStoppedAt !== undefined) {
      if (record.taskControlRecoveryRunVersion !== undefined) continue;
      try {
        await stopCodex({ taskId: record.taskId }, deps, "stopped by the operator");
      } catch (error) {
        log(`kherep-node: could not confirm stop of task ${record.taskId}: ${String((error as Error).message ?? error)}`);
      }
      continue;
    }
    // Issue #544: the run is measured before the deadline stop. A root that is no
    // longer the recorded process (ended, or its pid reused after a reboot or
    // downtime past the deadline) settles below from the run's own outcome, and
    // only its recorded descendants are ended (issue #233); the process that
    // holds the pid now is read once, for its start time, and never signalled.
    let running: boolean;
    try {
      running = !ended && await stillRuns(codex, record.pid, record.pidStart);
    } catch (error) {
      log(`kherep-node: task ${record.taskId}: ${String((error as Error).message ?? error)}`);
      continue; // a failed read decides nothing
    }
    if (running && now >= Date.parse(record.deadline)) {
      if (mapped.sessionId !== record.sessionId) writeTask(deps.paths, mapped, now);
      try {
        await stopCodex({ taskId: record.taskId }, deps, MAX_RUNTIME_REASON);
      } catch (error) {
        log(`kherep-node: could not stop task ${record.taskId}: ${String((error as Error).message ?? error)}`);
      }
      continue;
    }
    // Issue #197: a live run whose turn shows no progress (run-progress.mts) is
    // stopped and failed; its messages are offered again, the runtime probed again.
    if (running && record.awaitingProgressSince !== undefined) {
      if (readEvents(files).progressed) {
        record = writeTask(deps.paths, { ...record, awaitingProgressSince: undefined }, now);
        mapped = { ...mapped, awaitingProgressSince: undefined };
      } else if (progressOverdue(record, now)) {
        await failStalledCodex(deps, record, () => stopCodex({ taskId: record.taskId }, deps, NO_PROGRESS_REASON, false, "failed"), log, now);
        continue;
      }
    }
    if (running) {
      // Issue #233: the run's descendants, for a settle after its root crashed.
      try {
        const found = await refreshDescendants(codex, record);
        if (found) {
          const descendants = found.length > 0 ? found : undefined;
          record = writeTask(deps.paths, { ...record, descendants }, now);
          mapped = { ...mapped, descendants };
        }
      } catch (error) {
        log(`kherep-node: task ${record.taskId}: could not record its processes: ${String((error as Error).message ?? error)}`);
      }
      if (mapped.sessionId !== record.sessionId) {
        const saved = writeTask(deps.paths, mapped, now);
        if (!record.running) queueReport(deps.paths, { taskId: saved.taskId, state: saved.state, ...sessionOf(saved) });
      }
      continue;
    }
    // Issue #544: why a run without exit.json settles here, for the operator.
    if (!ended) {
      log(`kherep-node: task ${record.taskId}: its root (pid ${record.pid ?? "unknown"}) is no longer the recorded process; settled from its outcome`);
    }
    // Reported done by the session (task done), or a run for peer messages:
    // released without a new report.
    const result = outcome(files);
    settleOffered(deps, record, result.state === "done", result.state === "failed" ? result.reason : undefined);
    // Issue #233: a failed run's root may have crashed and left its children.
    if (result.state === "failed") reapDescendants(codex, record, log);
    if (record.running) {
      writeTask(deps.paths, { ...mapped, running: undefined, offered: undefined, descendants: undefined }, now);
      continue;
    }
    const saved = writeTask(deps.paths, { ...mapped, state: result.state, ...(result.state === "failed" ? { reason: result.reason } : {}),
      offered: undefined, descendants: undefined }, now);
    queueReport(deps.paths, { taskId: saved.taskId, ...result, ...sessionOf(saved) });
  }
}
