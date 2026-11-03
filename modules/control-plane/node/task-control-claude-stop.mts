import type { TaskControlErrorCode, TaskControlProcessState, TaskControlTaskState } from "../protocol-task-control.mts";
import { startTimeOf, type CodexDeps } from "./codex-process.mts";
import { processTree, signalPhase, waitStopped, type ProcessIdentity } from "./codex-stop.mts";
import { markClaudeStopped, runClaude, type RunnerDeps } from "./session-runner.mts";
import { measureClaude } from "./task-control-claude.mts";
import { runVersionOf } from "./task-control-run.mts";
import { readTask, type TaskRecord } from "./task-records.mts";

// The confirmed owner stop of a Claude background task (issue #437, PR 2),
// after the shared checks in task-control-local.mts. Measured on macOS
// (Claude Code 2.1.300): the listed pid is the session process, MCP servers
// are its children, and a Bash tool command is a descendant in its own process
// group. `claude stop` returns at once and the row shows no pid while the
// process still lives; the session process ends, a running shell command does
// not. A session process killed without `claude stop` is restarted by the
// supervisor. So the stop captures the whole tree first, runs `claude stop`,
// waits for every captured identity, re-captures the tree from its live
// members after `claude stop` and before each signal, signals only survivors
// by pid while each keeps its captured start, and never the session process:
// alive after the grace it is `stop_failed`, unsignalled. Windows stays
// refused (issue #460, measured): a Git Bash tool command's parent is an
// intermediate process that already exited, so the command is not in the tree
// of the listed session process, and it and its shell outlive `claude stop`.

export type ClaudeStopOutcome = { taskState: TaskControlTaskState }
  | { errorCode: TaskControlErrorCode; state: "failed" | "unknown"; processState: TaskControlProcessState };

const refused = (errorCode: TaskControlErrorCode, state: "failed" | "unknown" = "failed",
  processState: TaskControlProcessState = "unknown"): ClaudeStopOutcome => ({ errorCode, state, processState });

const messageOf = (error: unknown): string => String((error as Error).message ?? error);

const MAX_TREE = 256;

// The captured tree, grown by what its live members started since the last
// capture (review P2-1). Each identity whose pid an earlier walk of this pass
// did not reach is walked once more; the walk stands only while its root still
// has the captured start. An entry is new when no captured identity has that
// pid with that start; starts already captured are kept (processTree's known
// list, issue #233), so a pid reused by a new descendant inside the stop is
// the same residual as there. A process whose ancestors all ended before a
// capture is never reached. Past MAX_TREE entries growth stops and the stop
// is not confirmed.
async function grownTree(deps: CodexDeps, tree: ProcessIdentity[]): Promise<{ tree: ProcessIdentity[]; capped: boolean }> {
  const grown = [...tree];
  const seen = new Set(grown.map(({ pid, start }) => `${pid} ${start}`));
  const covered = new Set<number>();
  let capped = grown.length > MAX_TREE;
  for (const { pid, start } of tree) {
    if (covered.has(pid)) continue;
    const walked = await processTree(deps, pid, grown);
    if (walked.find((entry) => entry.pid === pid)?.start !== start) continue; // ended or reused: nothing to grow from
    for (const entry of walked) {
      covered.add(entry.pid);
      const key = `${entry.pid} ${entry.start}`;
      if (seen.has(key)) continue;
      if (grown.length >= MAX_TREE) {
        capped = true;
        break;
      }
      seen.add(key);
      grown.push(entry);
    }
  }
  return { tree: grown, capped };
}

// Survivors by their own pid, SIGTERM then SIGKILL, each phase on the tree
// grown just before it. Rejects as stopIdentities does when one outlives SIGKILL.
async function endSurvivors(deps: CodexDeps, tree: ProcessIdentity[], grace: number): Promise<{ capped: boolean }> {
  let capped = false;
  let notes: string[] = [];
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const grown = await grownTree(deps, tree);
    tree = grown.tree;
    capped ||= grown.capped;
    notes = await signalPhase(deps, null, tree, signal);
    if (await waitStopped(deps, tree, grace)) return { capped };
  }
  throw new Error(["process tree did not stop after SIGKILL", ...notes].join("; "));
}

// record carries the owner's marker; runVersion is the run the owner measured.
// A throw (a read that fails) is mapped by the caller like a Codex stop error.
export async function stopClaude(record: TaskRecord, runVersion: string, runner: RunnerDeps,
  now: () => number): Promise<ClaudeStopOutcome> {
  if ((runner.platform ?? process.platform) === "win32") return refused("unsupported_runtime");
  const log = (line: string): void => runner.log?.(`kherep-node: task ${record.taskId}: ${line}`);
  const deps = runner.codex ?? {};
  // A fresh measurement: the run must still be the one the owner measured.
  const fresh = await measureClaude(record, runner, now());
  if (fresh.errorCode) return refused(fresh.errorCode);
  if (fresh.processState !== "running") return refused("stale_run", "unknown", fresh.processState);
  if (fresh.runVersion !== runVersion) return refused("stale_run", "unknown", "running");
  const current = readTask(runner.paths, record.taskId);
  if (!current?.shortId || current.pid === undefined || runVersionOf(current) !== runVersion) return refused("stale_run", "unknown");
  // Capture before `claude stop`, by parent and regardless of process group;
  // a failed capture signals nothing, unlike terminate()'s timeout fallback.
  let identities: ProcessIdentity[];
  try {
    identities = await processTree(deps, current.pid);
  } catch {
    return refused("identity_unknown");
  }
  const root = identities.find((entry) => entry.pid === current.pid);
  if (!root || root.start !== current.pidStart) return refused("stale_run", "unknown");
  // The supported stop. If it fails, nothing is signalled: the supervisor
  // would restart a session process that ended without it.
  try {
    await runClaude(runner, ["stop", current.shortId], undefined, {kind:"operator"});
  } catch (error) {
    log(`claude stop failed: ${messageOf(error)}`);
    return refused("stop_failed");
  }
  // The captured identities are the evidence, never the row. The session
  // process is never signalled: the supervisor's reaction to a signalled
  // session is not measured, and ending its commands while it lives is no stop.
  const grace = deps.graceMs ?? 5_000;
  let capped: boolean;
  try {
    const grown = await grownTree(deps, identities);
    capped = grown.capped;
    if (!await waitStopped(deps, grown.tree, grace)) {
      if (await startTimeOf(deps, root.pid) === root.start) {
        log("the session process still runs after claude stop; nothing signalled");
        return refused("stop_failed", "failed", "running");
      }
      log("processes outlived claude stop; signalling each by its pid");
      if ((await endSurvivors(deps, grown.tree, grace)).capped) capped = true;
    }
  } catch (error) {
    const message = messageOf(error);
    log(message);
    return refused("stop_failed", "failed", message.startsWith("process tree did not stop") ? "running" : "unknown");
  }
  if (capped) {
    log(`the process tree passed ${MAX_TREE} processes; the stop is not confirmed`);
    return refused("stop_failed", "failed", "unknown");
  }
  // A live pid listed again is a supervisor restart: a new run, recorded by
  // measureClaude for the next status. A failed listing does not undo the
  // evidence that every captured identity ended.
  const after = await measureClaude(current, runner, now());
  if (after.processState === "running") {
    log("the session is running again after the stop");
    return refused("stale_run", "unknown", "running");
  }
  if (after.errorCode) log("the measurement after the stop failed; every captured process ended");
  const latest = readTask(runner.paths, record.taskId);
  if (!latest || latest.pid !== current.pid || latest.pidStart !== current.pidStart) return refused("stale_run", "unknown");
  return { taskState: markClaudeStopped(runner, latest, "stopped by task owner").state };
}
