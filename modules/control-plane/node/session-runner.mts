import type { AdmissionAuthority } from "./session-authority.mts";
import { execFile } from "node:child_process";

import { isSessionRef } from "../protocol-messages.mts";
import type { SessionContinueArgs, SessionStartArgs, SessionStopArgs } from "../protocol-tasks.mts";
import { continueCodex, startCodex, stopCodex } from "./codex-runner.mts";
import { startTimeOf, type CodexDeps } from "./codex-process.mts";
import type { NodePaths } from "./config.mts";
import type { InboxRecord } from "./inbox.mts";
import type { NodePolicy } from "./policy.mts";
import { notReady, type Readiness } from "./runtime-readiness.mts";
import { taskCommand } from "./session-command.mts";
import { claudeCall, findClaude, LIST_TIMEOUT_MS, type Exec } from "./sessions.mts";
import { admitStart, overLimit, refuse, trim, type Admitted } from "./task-admission.mts";
import { withNodeOnPath, withoutSessionMarkers } from "./task-env.mts";
import { queueReport, readTask, writeTask, type TaskRecord } from "./task-records.mts";
import { frameFollowUp } from "./task-prompt.mts";
import { recordRefusal } from "./task-refusals.mts";
import { withServiceAdmission, type ServiceOwnerProbe } from "./service-drain.mts";

// Starts, continues and stops Claude Code background sessions for tasks
// (issue #31, item 5), from https://code.claude.com/docs/en/agent-view and
// /docs/en/cli-reference (fetched 2026-09-25):
// - `claude --bg` / `--background` "Start the session as a background agent
//   and return immediately"; the prompt is the positional argument.
// - `--name` sets "the session's display name in agent view"; `--permission-mode`
//   accepts default, acceptEdits, plan, auto, dontAsk, bypassPermissions.
// - "After backgrounding, Claude prints the session's short ID ...":
//   `backgrounded · 7c5dcf5d · flaky-test-fix`, possibly after `Starting
//   background service…`.
// - `claude --resume <full session id> --bg "<prompt>"` continues a session,
//   in place or as a copy under a new id; `claude stop <id>` takes the short id.
// - `claude agents --json --all` lists sessions with `id` (short), `sessionId`,
//   `name` and `state` (working, blocked, done, failed, stopped); `kind`
//   (interactive, background) always, and `pid` and `status` (busy, waiting,
//   idle) "While the process is alive" (agent-view, fetched 2026-10-17). A
//   launch records that pid and its start time (issue #437); status re-reads
//   both, since the supervisor may stop and restart a session's process.
// - `claude stop` returns before the session's process ended, and the listing
//   shows the session stopped without a pid at once; a running shell command
//   is not ended (issue #437, measured on macOS). The owner's confirmed stop,
//   which waits for every captured process, lives in task-control-claude-stop.mts.
// A task with runtime codex goes to codex-runner.mts instead (issue #63).
// --name stays task-<8> even for a labelled task (issue #74): findRow falls
// back to that name to map the session before its short id is known, and the
// Worker and the node recognise a task session by it (no chains). A label is
// not unique (every intercom session from one sender shares it), so it is
// only shown in the directory, never used as the name.

export const RUN_TIMEOUT_MS = 60_000;
export const BACKGROUNDED = /^backgrounded · ([A-Za-z0-9]+)/m;

export interface RunnerDeps {
  paths: NodePaths; policy: NodePolicy; livenessAuthority?: AdmissionAuthority;
  exec?: Exec; findClaude?: () => string | null; platform?: NodeJS.Platform; comSpec?: string;
  now?: () => number; realpath?: (p: string) => string; cli?: string;
  // The Codex runner's process hooks; tests replace them.
  codex?: CodexDeps;
  // Set for an intercom session the node starts on its own (issue #102):
  // the Worker does not know the task, so nothing is reported.
  local?: "intercom";
  // The daemon log, for what a run could not apply (codex-mcp.mts).
  log?: (line: string) => void;
  // Issue #197: whether each runtime can run a turn (runtime-readiness.mts).
  // The daemon always sets it; without it every runtime counts as ready.
  readiness?: Readiness;
  // Issue #423: the owner of a service admission; tests replace the default,
  // whose Windows identity lookup starts PowerShell.
  serviceOwner?: ServiceOwnerProbe;
  // Issue #408, PR 4: the Worker capabilities proven on the current
  // connection (client.mts workerCapabilities); null or absent: none proven.
  workerCapabilities?: () => readonly string[] | null;
  // Issue #487: the daemon's inbox records (inbox-index.mts, or one round's
  // snapshot of it); without it the readers list the inbox files.
  inbox?: () => InboxRecord[];
}

// Rejects with the CLI's own stderr (or stdout), never with the command line,
// which carries the task text.
const execClaude: Exec = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { ...options, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (!error) return resolve(String(stdout));
    const code = (error as { code?: unknown }).code;
    reject(new Error(String(stderr).trim() || String(stdout).trim() || `claude exited with ${String(code)}`));
  });
});

// A task session (cwd given) gets the node directory first on PATH and none of
// the daemon's own Claude Code session markers (task-env.mts).
export async function runClaude(deps: RunnerDeps, args: string[], cwd?: string): Promise<string> {
  const claude = (deps.findClaude ?? findClaude)();
  if (!claude) throw new Error("claude is not installed on this node");
  const run = claudeCall(claude, args, args[0] === "agents" ? LIST_TIMEOUT_MS : RUN_TIMEOUT_MS, deps.platform, deps.comSpec);
  return (deps.exec ?? execClaude)(run.file, run.args, { ...run.options, ...(cwd ? { cwd, env: withoutSessionMarkers(withNodeOnPath(process.env)) } : {}) });
}

// The rows of `claude agents --json --all`; rejects when the listing fails.
export async function agentRows(deps: RunnerDeps): Promise<Record<string, unknown>[]> {
  const parsed: unknown = JSON.parse(await runClaude(deps, ["agents", "--json", "--all"]));
  if (!Array.isArray(parsed)) throw new Error("claude agents printed no session list");
  return parsed.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
}

// The row of a task session: by the short id `--bg` printed, else by its name.
export function findRow(rows: Record<string, unknown>[], record: Pick<TaskRecord, "shortId" | "name">): Record<string, unknown> | undefined {
  return rows.find((r) => record.shortId !== undefined && r.id === record.shortId) ?? rows.find((r) => r.name === record.name);
}

// A row with a session id confirms the mapping (mappingPendingSince, issue #109).
export function mapIds(record: TaskRecord, row: Record<string, unknown> | undefined): TaskRecord {
  const confirmed = typeof row?.sessionId === "string" ? row.sessionId : undefined;
  const sessionId = confirmed ?? record.sessionId;
  const shortId = typeof row?.id === "string" ? row.id : record.shortId;
  const { mappingPendingSince, ...rest } = record;
  return { ...(confirmed ? rest : record), ...(sessionId ? { sessionId } : {}), ...(shortId ? { shortId } : {}) };
}

// The pid a listing row shows while the session's process is alive (issue #437).
export const rowPid = (row: Record<string, unknown> | undefined): number | undefined =>
  typeof row?.pid === "number" && Number.isSafeInteger(row.pid) && row.pid > 0 ? row.pid : undefined;

// The listed process and its start time, best effort: a start time that
// cannot be read leaves the identity to the next status (task-control-claude.mts).
async function withProcess(deps: RunnerDeps, record: TaskRecord, row: Record<string, unknown> | undefined): Promise<TaskRecord> {
  const pid = rowPid(row);
  if (pid === undefined) return record;
  try {
    const pidStart = await startTimeOf(deps.codex ?? {}, pid);
    return pidStart === null ? record : { ...record, pid, pidStart };
  } catch {
    return record;
  }
}

// Runs `claude ... --bg ...` and records the task with the short id it
// printed; the full session id follows from `claude agents --json --all`.
// The record is written before the run with mappingPendingSince and no short
// id (a launch in flight, task-watch.mts), so a wake listener the session arms
// before its id is known waits for it (issue #109).
async function background(deps: RunnerDeps, launched: TaskRecord, args: string[]): Promise<TaskRecord> {
  const now = deps.now?.() ?? Date.now();
  const record = writeTask(deps.paths, { ...launched, shortId: undefined, mappingPendingSince: new Date(now).toISOString(),
    awaitingProgressSince: new Date(now).toISOString() }, now);
  let output: string;
  try {
    output = await runClaude(deps, args, record.cwd);
  } catch (error) {
    const message = String((error as Error).message);
    writeTask(deps.paths, { ...launched, state: "failed", reason: trim(message) });
    return refuse(deps, record.taskId, message);
  }
  const shortId = BACKGROUNDED.exec(output)?.[1];
  if (!shortId) {
    writeTask(deps.paths, { ...launched, state: "failed", reason: "no session id printed" });
    return refuse(deps, record.taskId, `claude --bg printed no session id: ${trim(output)}`);
  }
  // Every launch is a new run: a continue drops the previous run's process identity and failed stops.
  const { pid, pidStart, descendants, stopAttempts, ...launch } = record;
  let mapped: TaskRecord = { ...launch, shortId, state: "started" };
  try {
    const row = findRow(await agentRows(deps), mapped);
    // Issue #639: a malformed nonempty full id maps as a row without one; its short id and pid stay.
    const malformed = typeof row?.sessionId === "string" && row.sessionId !== "" && !isSessionRef(row.sessionId);
    mapped = await withProcess(deps, mapIds(mapped, malformed ? { ...row, sessionId: undefined } : row), row);
  } catch {
    // mapped later by the watch round
  }
  const saved = writeTask(deps.paths, mapped, deps.now?.());
  queueReport(deps.paths, { taskId: saved.taskId, state: "started", ...(saved.sessionId ? { sessionId: saved.sessionId } : {}) });
  return saved;
}

async function admit(args: SessionStartArgs, deps: RunnerDeps): Promise<Admitted> {
  const admitted = admitStart(args, deps);
  // Issue #197: a runtime that cannot run a turn starts nothing (no record, no start counted).
  const blocked = await notReady(deps.readiness, args.runtime);
  if (blocked) refuse(deps, args.taskId, blocked);
  return admitted;
}

// Issue #240: a refusal record, so owner task control can answer with the
// reason. Failing to write it never replaces the refusal itself.
function keepRefusal(args: SessionStartArgs, deps: RunnerDeps, error: unknown): void {
  if (deps.local) return;
  try {
    recordRefusal(deps.paths, args, trim(String((error as Error).message)), deps.now?.() ?? Date.now());
  } catch (failed) {
    deps.log?.(`kherep-node: task ${args.taskId}: refusal record not written: ${String((failed as Error).message)}`);
  }
}

export async function startTask(args: SessionStartArgs, deps: RunnerDeps): Promise<{ taskId: string; state: string; sessionId?: string }> {
  const existing = readTask(deps.paths, args.taskId);
  if (existing) return { taskId: existing.taskId, state: existing.state }; // a resent command
  return withServiceAdmission(deps.paths, async (admission) => {
    const { record, prompt } = await admit(args, deps).catch((error: unknown) => {
      keepRefusal(args, deps, error);
      throw error;
    });
    if (args.runtime === "codex") return startCodex(deps, record, prompt, admission);
    const saved = await background(deps, record, ["--bg", "--name", args.name, "--permission-mode", record.permissionMode, prompt]);
    return { taskId: saved.taskId, state: saved.state, ...(saved.sessionId ? { sessionId: saved.sessionId } : {}) };
  }, deps.serviceOwner);
}

// Only a task this node started, whose session is known and not running.
export async function continueTask(args: SessionContinueArgs, deps: RunnerDeps): Promise<{ taskId: string; state: string }> {
  return withServiceAdmission(deps.paths, async (admission) => {
    const record = readTask(deps.paths, args.taskId);
    if (!record) throw new Error("this node did not start that task");
    if (record.runtime === "codex") return continueCodex(args, deps, admission);
    if (!deps.policy.sessions?.enabled) throw new Error("sessions are not enabled on this node");
    if (!record.sessionId) throw new Error("the task's session id is not known yet");
    if (record.state === "started" || record.state === "running" || record.running) throw new Error("the task's session is still running");
    const now = deps.now?.() ?? Date.now();
    const limit = overLimit(deps, now, args.taskId);
    if (limit) throw new Error(limit);
    const blocked = await notReady(deps.readiness, "claude");
    if (blocked) throw new Error(blocked);
    const restarted: TaskRecord = { ...record, state: "started", reason: undefined,
      deadline: new Date(now + deps.policy.sessions.maxRuntimeMinutes * 60_000).toISOString() };
    const saved = await background(deps, restarted, ["--resume", record.sessionId, "--bg", "--permission-mode", record.permissionMode,
      frameFollowUp(args.taskId, args.prompt, deps.cli ?? taskCommand(deps.paths, { platform: deps.platform }))]);
    return { taskId: saved.taskId, state: saved.state };
  }, deps.serviceOwner);
}

// `claude stop <short id>` for a task this node started. A task whose session
// already reported done keeps that state for the Worker; only the process ends.
export async function stopTask(args: SessionStopArgs, deps: RunnerDeps, reason = "stopped by the operator"): Promise<{ taskId: string; state: string }> {
  const record = readTask(deps.paths, args.taskId);
  if (!record) throw new Error("this node did not start that task");
  if (record.runtime === "codex") return stopCodex(args, deps, reason);
  if (!record.shortId) throw new Error("the task's session id is not known yet");
  await runClaude(deps, ["stop", record.shortId]);
  const saved = markClaudeStopped(deps, record, reason);
  return { taskId: saved.taskId, state: saved.state };
}

// The state write and report after a Claude stop (stopTask and the confirmed
// owner stop): a task whose session already reported done stays done.
export function markClaudeStopped(deps: RunnerDeps, record: TaskRecord, reason: string): TaskRecord {
  const reportedDone = record.state === "done";
  const saved = writeTask(deps.paths, { ...record, state: reportedDone ? "done" : "stopped", reason, running: undefined, stopAttempts: undefined }, deps.now?.());
  if (!reportedDone) {
    queueReport(deps.paths, { taskId: saved.taskId, state: "stopped", reason, ...(saved.sessionId ? { sessionId: saved.sessionId } : {}) });
  }
  return saved;
}
