import { isSessionRef, type DirectoryBody } from "../protocol-messages.mts";
import {
  intercomLabel, isTaskLabel, MAX_TASK_TEXT, taskSessionName, type PermissionMode, type SessionStartArgs, type TaskRuntime,
} from "../protocol-tasks.mts";
import { resumeArgs } from "./codex-process.mts";
import { adoptOffered, spawnRun } from "./codex-runner.mts";
import { retireCopies } from "./copy-retire.mts";
import { deliveryContext, frameRecords, sessionInbox } from "./deliver-core.mts";
import { attachDelivery } from "./delivery-identity.mts";
import { addLocalSession, readDirectory } from "./exchange.mts";
import { getMessage, markClosedAttempt, markOffered, markRetry, setMessageProgress, type InboxRecord } from "./inbox.mts";
import { RecordLockBusy } from "./inbox-record-lock.mts";
import { withServiceAdmission, type ServiceAdmission } from "./service-drain.mts";
import { taskCommand } from "./session-command.mts";
import { agentRows, BACKGROUNDED, mapIds, runClaude, startTask, type RunnerDeps } from "./session-runner.mts";
import { CLAUDE_RUNTIME } from "./sessions.mts";
import { handoverTaskMessages } from "./task-handover.mts";
import { queueReport, readTask, senderOf, writeTask, type TaskRecord } from "./task-records.mts";
import { wakeText } from "./wake-hook.mts";

// How closed-delivery.mts hands messages for a session that is no longer
// running (issues #102, #105) to an intercom session of their sender: resume
// the sender's ended intercom session in the background, or start a new one.
// Each function returns null on success and otherwise the reason; a Claude
// resume whose run is kept rethrows a later error instead (resumeClaude).
//
// Claude Code, from https://code.claude.com/docs/en/agent-view ("From your
// shell", fetched 2026-09-27): "To continue an existing conversation in the
// background, pass its full session ID with `--resume`"; "On Claude Code
// v2.1.257 or later, Claude Code either continues that session under the same
// ID, or starts a copy under a new ID and prints a `note:` line explaining why
// it couldn't continue in place." The node looks the resumed session up in
// `claude agents --json` at once and adopts a copy (issue #109): the task
// record takes its id and the messages waiting for the original id are
// readdressed to it; the session it held before is stopped once idle
// (copy-retire.mts, issue #111). A copy whose id is not listed is stopped and a new
// intercom session starts. /docs/en/sessions ("Permission mode on resume"): "Pass
// `--permission-mode` or `--dangerously-skip-permissions` to override the
// restored mode", so the resumed session runs in its recorded mode. The prompt
// is the fixed wake text; the delivery hook of that turn offers the messages
// as framed peer content, each with its reply command, as for a woken session
// (wake-hook.mts). Codex: `codex exec resume <thread>` as for a Codex task
// (codex-wake.mts), with the framed messages on stdin, since an exec run may
// fire no hook.

// The closed session the messages were addressed to.
export interface ClosedTarget { sessionId: string; runtime: TaskRuntime; cwd: string }

const reasonOf = (error: unknown): string => String((error as Error).message ?? error).slice(0, 256);

// The intercom record for the run: the working directory checked again, a new deadline.
function rerunRecord(deps: RunnerDeps, task: TaskRecord, cwd: string, now: number): TaskRecord {
  return { ...task, cwd, deadline: new Date(now + deps.policy.sessions!.maxRuntimeMinutes * 60_000).toISOString(), reason: undefined,
    stopAttempts: undefined };
}

// task: an ended intercom session with a known session id. The record is
// written before the run with mappingPendingSince (session-runner.mts
// background), and restored if the resume fails. Both resumes are admitted
// with the owner probe of the deps (issue #423). Issue #638: a failed resume
// (no short id printed, an unlisted copy stopped) returns its reason, also if
// its cleanup or release fails; once the run is kept, any later error (a
// write, the release) propagates, as a reason would start a second session.
export async function resumeClaude(deps: RunnerDeps, task: TaskRecord, cwd: string, count: number, now: number): Promise<string | null> {
  const kept = { run: false };
  try { return await withServiceAdmission(deps.paths, () => resumeClaudeAdmitted(deps, task, cwd, count, now, kept), deps.serviceOwner); }
  catch (error) { if (kept.run) throw error; return reasonOf(error); }
}

// A nonempty full id that is no session reference is never adopted (issue #638).
const malformedId = (id: unknown): boolean => typeof id === "string" && id !== "" && !isSessionRef(id);

async function resumeClaudeAdmitted(deps: RunnerDeps, task: TaskRecord, cwd: string, count: number, now: number,
  kept: { run: boolean }): Promise<string | null> {
  const sessionId = task.sessionId!;
  if (!isSessionRef(sessionId)) return "the intercom session id is not valid";
  // The session held so far is stopped once a copy is adopted and it is idle (issue #111).
  const retire = [...(task.retire ?? []), ...(task.shortId ? [{ shortId: task.shortId, sessionId }] : [])];
  const pending: TaskRecord = { ...rerunRecord(deps, task, cwd, now), state: "started", mappingPendingSince: new Date(now).toISOString(),
    awaitingProgressSince: new Date(now).toISOString(), ...(retire.length > 0 ? { retire } : {}) };
  writeTask(deps.paths, { ...pending, shortId: undefined }, now);
  const failed = (reason: string): string => {
    writeTask(deps.paths, task, now);
    return reason;
  };
  let output: string;
  try {
    output = await runClaude(deps, ["--resume", sessionId, "--bg", "--permission-mode", task.permissionMode, wakeText(count)], cwd);
  } catch (error) {
    return failed(reasonOf(error));
  }
  const shortId = BACKGROUNDED.exec(output)?.[1];
  if (!shortId) return failed("claude --resume printed no session id");
  let rows: Record<string, unknown>[] | undefined;
  try {
    rows = await agentRows(deps);
  } catch {
    // mapped later by the watch round
  }
  const row = rows?.find((r) => r.id === shortId);
  // A copy (a `note:` line) whose new id is not listed cannot be adopted.
  if (/^note:/im.test(output) && typeof row?.sessionId !== "string") {
    await runClaude(deps, ["stop", shortId]).catch(() => undefined);
    return failed("claude continued the session as a copy under a new id it did not list");
  }
  kept.run = true;
  // A malformed listed id keeps the old one, pending, for the watch round to map.
  const invalid = malformedId(row?.sessionId);
  if (invalid) deps.log?.(`kherep-node: task ${task.taskId}: listed session id is not valid; mapping deferred`);
  let saved = writeTask(deps.paths, mapIds({ ...pending, shortId }, invalid ? undefined : row), now);
  // A copy under a new id (issue #109) takes over the messages waiting for the original id.
  const adopted = saved.sessionId ?? sessionId;
  if (adopted !== sessionId) {
    try {
      handoverTaskMessages(deps.paths.inbox, sessionId, adopted,
        { taskId: saved.taskId, runtime: saved.runtime ?? "claude" });
    } catch (error) {
      // Issue #627: the resume ran and cannot fail any more, or a second
      // session would start. The record is written without the adopted id,
      // so the watch round (task-watch.mts) adopts the copy and readdresses.
      if (!(error instanceof RecordLockBusy)) throw error;
      skipBusy(deps)(error);
      saved = writeTask(deps.paths, { ...pending, shortId }, now);
    }
  }
  queueReport(deps.paths, { taskId: saved.taskId, state: "started", sessionId: saved.sessionId ?? sessionId });
  addLocalSession(deps.paths, { sessionId: adopted, name: task.name });
  if (rows && !invalid) await retireCopies(deps, saved, rows);
  return null;
}

export async function resumeCodex(deps: RunnerDeps, task: TaskRecord, cwd: string, count: number, now: number): Promise<string | null> {
  try { return await withServiceAdmission(deps.paths, (admission) => resumeCodexAdmitted(deps, task, cwd, count, now, admission), deps.serviceOwner); }
  catch (error) { return reasonOf(error); }
}

async function resumeCodexAdmitted(
  deps: RunnerDeps, task: TaskRecord, cwd: string, count: number, now: number, admission: ServiceAdmission,
): Promise<string | null> {
  const sessionId = task.sessionId!;
  const owner = { sessionId, runtime: "codex" };
  const refs = [sessionId, task.name];
  const context = deliveryContext("UserPromptSubmit", refs, { paths: deps.paths, owner, now: () => now, offeredBy: "intercom",
    ...(deps.cli ? { replyCommand: deps.cli } : {}) });
  const offeredAt = new Date(now).toISOString();
  const offered = sessionInbox(deps.paths, refs, owner).filter((r) => r.state === "offered" && r.offeredAt === offeredAt).map((r) => r.messageId);
  if (offered.length === 0) return "no message left to offer";
  // As codex-wake.mts: a run for peer messages keeps the task's state; the watch round settles its offers.
  const run: TaskRecord = { ...rerunRecord(deps, task, cwd, now), running: true, offered };
  try {
    await spawnRun(deps, run, (files, outbox) => resumeArgs(sessionId, task.permissionMode, files, outbox),
      `${wakeText(count)}\n\n${context}`, admission);
  } catch (error) {
    for (const id of offered) markRetry(deps.paths.inbox, id);
    return reasonOf(error);
  }
  return null;
}

export const fallbackDirective = (sessionId: string): string =>
  `Automatic delivery fallback approved by this node's policy (messaging.resumeClosed): the message was addressed to session `
  + `${sessionId}, which is no longer running on this node.`;

// The label of the intercom session: intercom: <sender runtime>@<sender node name>.
function senderLabel(deps: RunnerDeps, from: InboxRecord["from"]): string | undefined {
  let directory: DirectoryBody | null = null;
  try {
    directory = readDirectory(deps.paths);
  } catch {
    // no label then
  }
  const node = directory?.nodes.find((n) => n.nodeId === from.nodeId)?.name ?? from.nodeId.slice(0, 8);
  const runtime = directory?.sessions.find((s) => s.nodeId === from.nodeId && (s.sessionId === from.session || s.name === from.session))?.runtime;
  const label = intercomLabel(runtime === CLAUDE_RUNTIME ? "claude" : runtime ?? "session", node);
  return isTaskLabel(label) ? label : undefined;
}

// A new intercom session with the messages of one sender as its task text,
// framed as the delivery hook frames them (each with its --reply-to command),
// as far as they fit; the messages it carries are offered to it and delivered
// only once its turn completed (Claude: the watch round, run-progress.mts
// settleCarried, issue #308; Codex: codex-runner.mts adoptOffered, issue #119).
export async function startIntercom(deps: RunnerDeps, target: ClosedTarget, records: InboxRecord[],
  mode: PermissionMode, directive = fallbackDirective(target.sessionId), taskId: string = crypto.randomUUID()): Promise<string | null> {
  if (records.length === 0 || records.some(r => Object.hasOwn(r, "binding"))) return "loop-resolution-required";
  const from = records[0].from;
  const label = senderLabel(deps, from);
  let text: string;
  let carried: InboxRecord[];
  try {
    ({ text, carried } = frameRecords(deps.paths, records, deps.cli ?? taskCommand(deps.paths, { platform: deps.platform }), MAX_TASK_TEXT));
  } catch (error) {
    return reasonOf(error);
  }
  const args: SessionStartArgs = { taskId, runtime: target.runtime, name: taskSessionName(taskId), prompt: text, permissionMode: mode,
    cwd: target.cwd, requestedBy: senderOf(records[0]), directive,
    ...(label ? { label } : {}) };
  let result: Awaited<ReturnType<typeof startTask>>;
  try {
    result = await startTask(args, { ...deps, local: "intercom" });
  } catch (error) {
    return reasonOf(error);
  }
  const started = readTask(deps.paths, taskId);
  if (!started) return "the local delivery task record was not written";
  if (!["started", "running"].includes(result.state) || !["started", "running"].includes(started.state)) {
    return started.reason ?? "the local delivery task did not start";
  }
  const linked = attachDelivery(deps.paths, started, carried.map((record) => record.messageId), skipBusy(deps));
  for (const record of carried) setMessageProgress(deps.paths.inbox, record.messageId, "fallback", "fallback-running", deps.now?.());
  const offered = handOver(deps, args.name, carried);
  const tracked = target.runtime === "codex" ? linked : { ...linked, carried: offered };
  if (tracked !== started) writeTask(deps.paths, tracked, deps.now?.());
  if (target.runtime === "codex") adoptOffered(deps, taskId, offered);
  return null;
}

// Issues #119 and #308: the carried messages wait, offered, for the intercom
// session they were readdressed to, until its turn completed: a Codex run on
// Windows ends with the daemon (codex-runner.mts adoptOffered), and progress of
// a Claude session is no read receipt (run-progress.mts settleCarried). A run
// that ends without completing leaves them to the next offer (codex-wake.mts,
// task grant; the delivery hook). A message answered meanwhile stays
// delivered. Returns the ids it offered.
function handOver(deps: RunnerDeps, name: string, carried: InboxRecord[]): string[] {
  const now = deps.now?.() ?? Date.now();
  const ids: string[] = [];
  for (const { messageId } of carried) {
    const state = getMessage(deps.paths.inbox, messageId)?.state;
    if (state !== "accepted" && state !== "offered") continue;
    try {
      if (state === "accepted") markOffered(deps.paths.inbox, messageId, now, "intercom");
      markClosedAttempt(deps.paths.inbox, messageId, now, name);
    } catch (error) {
      if (!(error instanceof RecordLockBusy)) throw error;
      skipBusy(deps)(error);
      continue;
    }
    ids.push(messageId);
  }
  return ids;
}

// Issue #627: after the session started or resumed, a record whose lock stays
// held is logged and left as it is; failing the round would start it again.
export const skipBusy = (deps: RunnerDeps) => (error: RecordLockBusy): void => {
  deps.log?.(`kherep-node: ${error.message}; left out of the hand-over`);
};
