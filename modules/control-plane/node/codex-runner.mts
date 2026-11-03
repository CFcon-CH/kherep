import { deliverInboxMessage, refuseInboxMessage, retryInboxMessage } from "./target-delivery-inbox.mts";
import { finalizeMessageTaskIdentity } from "./delivery-identity.mts";
import { verifyPreparedLaunch } from "./target-delivery-launch.mts";
import type { ExecutionContext } from "./target-delivery-operation.mts";
import { checkExecution } from "./target-delivery-route.mts";
import { bindRouteExecutionSession, transitionRouteMessages, finishRouteEffect } from "./target-delivery-outcome.mts";
import type { SessionContinueArgs, SessionStopArgs } from "../protocol-tasks.mts";
import {
  codexEnv, codexFiles, detachCodex, resumeArgs, spawnCodex, startArgs, stillRuns, type CodexFiles,
} from "./codex-process.mts";
import { readEvents, readExit } from "./codex-output.mts";
import { findCodex } from "./codex-binary.mts";
import { intercomMcpOverrides } from "./codex-mcp.mts";
import { reapDescendants } from "./codex-reap.mts";
import { terminate } from "./codex-stop.mts";
import { ensureDir } from "./config.mts";
import { permanentFallbackFailure } from "./delivery-failure.mts";
import { getMessage, markDelivered, markRefused, markRetry } from "./inbox.mts";
import { notReady } from "./runtime-readiness.mts";
import { continueServiceAdmission, retainServiceAdmission, type ServiceAdmission } from "./service-drain.mts";
import { taskCommand } from "./session-command.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { overLimit, refuse, trim } from "./task-admission.mts";
import { isActive, queueReport, readTask, writeTask, type TaskRecord } from "./task-records.mts";
import { frameFollowUp, resolveCwd } from "./task-prompt.mts";

// Starts, continues and stops Codex tasks (issue #63; the watch round is
// codex-watch.mts) with the same admission, limits and framing as Claude tasks
// (session-runner.mts). The
// task's session id is the Codex thread_id; its process is known by pid and
// start time. States: started once the process runs, done when it ended after
// turn.completed (exit 0 when this daemon saw the exit), failed otherwise,
// stopped by the operator or at the max runtime. A run started for peer
// messages (codex-wake.mts) keeps the task's state and settles its offers.

export const MAX_RUNTIME_REASON = "max runtime reached";
export const IDENTITY_UNKNOWN = "process identity unknown";
const POLL_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
export const sessionOf = (record: TaskRecord) => (record.sessionId ? { sessionId: record.sessionId } : {});

export type RunArgs = (files: CodexFiles, outbox: string) => string[];

// Spawns codex for the record, with the outbox as its one extra writable root,
// the session named in its environment and the prompt on stdin, and records
// pid and start time. Rejects when it cannot start.
export async function spawnRun(
  deps: RunnerDeps, record: TaskRecord, args: RunArgs, prompt: string, admission?: ServiceAdmission, context?:ExecutionContext,
): Promise<TaskRecord> {
  return continueServiceAdmission(deps.paths, admission, (active) => spawnAdmitted(deps, record, args, prompt, active, context), deps.serviceOwner);
}

async function spawnAdmitted(
  deps: RunnerDeps, record: TaskRecord, args: RunArgs, prompt: string, admission: ServiceAdmission, context?:ExecutionContext,
): Promise<TaskRecord> {
  context??=record.targetAttempt?{kind:"message",handle:record.targetAttempt}:undefined;
  checkExecution(deps.paths,context,["exec-resume","task-start"],undefined,{runtime:"codex",taskId:record.taskId,sessionId:record.sessionId??null,phase:"ready"});
  const codex = {...deps.codex,onUnconfirmedShutdown:()=>{retainServiceAdmission(admission);deps.codex?.onUnconfirmedShutdown?.();}};
  const files = codexFiles(deps.paths, record.taskId);
  const file = context?.kind==="message"?context.launch?.binding.executable:(codex.findCodex ?? findCodex)();
  if (!file) throw new Error("codex is not installed on this node");
  ensureDir(deps.paths.outbox);
  const intercom = record.local === "intercom";
  const detached = detachCodex(codex.platform ?? process.platform, intercom);
  const runArgs=context?.kind==="message"?context.launch!.rawArgs:[...(intercom?await mcpOff(deps,record,admission):[]),...args(files,deps.paths.outbox)];
  if(context?.kind==="message")writeTask(deps.paths,record,deps.now?.());
  const env=codexEnv(deps.paths,record.sessionId??record.name);
  if(context?.kind==='message') {
    const home=context.launch?.binding.home;
    if(!home)throw Error('message home unknown');
    env.CODEX_HOME=home;
  }
  const { pid, pidStart } = await spawnCodex(codex,file,runArgs,record.cwd,files,
    env,prompt,detached,context,deps.paths,{taskId:record.taskId,sessionId:record.sessionId??null});
  finishRouteEffect(deps.paths,context!,{kind:"exec",pid,pidStart:pidStart??null,threadId:null});
  const now = deps.now?.() ?? Date.now();
  return writeTask(deps.paths, { ...record, pid, pidStart, descendants: undefined, awaitingProgressSince: new Date(now).toISOString() }, now);
}

// Issue #119: an intercom run keeps the user's Codex config but not its MCP
// servers (codex-mcp.mts). Without a list it starts as before, logged.
async function mcpOff(deps: RunnerDeps, record: TaskRecord, admission: ServiceAdmission): Promise<string[]> {
  const codex = deps.codex ?? {};
  const found = await intercomMcpOverrides({ ...codex, onUnconfirmedShutdown: () => {
    retainServiceAdmission(admission);
    codex.onUnconfirmedShutdown?.();
  } }, deps.now?.());
  if ("reason" in found) {
    deps.log?.(`kherep-node: task ${record.taskId}: MCP servers left as configured: ${found.reason}`);
    return [];
  }
  if (found.unnamed > 0) deps.log?.(`kherep-node: task ${record.taskId}: ${found.unnamed} MCP server(s) without a bare name stay enabled`);
  return found.args;
}

// spawnRun, then up to startWaitMs for thread.started (or the process's end)
// when the thread is not known yet. A start error fails the task.
async function launch(
  deps: RunnerDeps, record: TaskRecord, args: RunArgs, prompt: string, admission?: ServiceAdmission,
): Promise<TaskRecord> {
  const codex = deps.codex ?? {};
  const files = codexFiles(deps.paths, record.taskId);
  let saved: TaskRecord;
  try {
    saved = await spawnRun(deps, record, args, prompt, admission, deps.executionContext);
  } catch (error) {
    const message = record.targetAttempt?"message launch outcome uncertain":String((error as Error).message);
    const measured=error as {pid?:unknown;pidStart?:unknown};
    const evidence=record.targetAttempt&&Number.isSafeInteger(measured.pid)&&(measured.pid as number)>0?{pid:measured.pid as number,...(typeof measured.pidStart==='string'?{pidStart:measured.pidStart}:{})}:{};
    writeTask(deps.paths, { ...record,...evidence, state: "failed", reason: trim(message) });
    return refuse(deps, record.taskId, message);
  }
  const until = Date.now() + (codex.startWaitMs ?? 15_000);
  let events = readEvents(files);
  while (!saved.sessionId && !events.threadId && Date.now() < until && readExit(files) === null) {
    await sleep(POLL_MS);
    events = readEvents(files);
  }
  if (!saved.sessionId && events.threadId) {
    saved = writeTask(deps.paths, saved.targetAttempt
      ?finalizeMessageTaskIdentity(deps.paths,{...saved,observedSessionId:events.threadId})
      :{...saved,sessionId:events.threadId},deps.now?.());
  }
  queueReport(deps.paths, { taskId: saved.taskId, state: "started", ...sessionOf(saved) });
  return saved;
}

export async function startCodex(
  deps: RunnerDeps, record: TaskRecord, prompt: string, admission?: ServiceAdmission,
): Promise<{ taskId: string; state: string; sessionId?: string }> {
  const saved = await launch(deps, record, (files, outbox) => startArgs(record.cwd, record.permissionMode, files, outbox), prompt, admission);
  return { taskId: saved.taskId, state: saved.state, ...sessionOf(saved) };
}

// Only a task whose thread is known and whose process has ended.
export async function continueCodex(
  args: SessionContinueArgs, deps: RunnerDeps, admission?: ServiceAdmission,
): Promise<{ taskId: string; state: string }> {
  const record = readTask(deps.paths, args.taskId)!;
  if (!deps.policy.sessions?.enabled) throw new Error("sessions are not enabled on this node");
  if (!deps.policy.sessions.runtimes.includes("codex")) throw new Error("runtime codex is not supported on this node yet");
  if (!record.sessionId) throw new Error("the task's session id is not known yet");
  if (record.state === "started" || record.state === "running" || record.running || await stillRuns(deps.codex ?? {}, record.pid, record.pidStart)) {
    throw new Error("the task's session is still running");
  }
  const now = deps.now?.() ?? Date.now();
  const limit = overLimit(deps, now, args.taskId);
  if (limit) throw new Error(limit);
  const threadId = record.sessionId;
  // Again: the directory may have been swapped for a link out of the roots since the start.
  const cwd = resolveCwd(deps.policy.sessions, record.cwd, deps.realpath);
  if (!cwd.ok) throw new Error(cwd.reason);
  const blocked = await notReady(deps.readiness, "codex");
  if (blocked) throw new Error(blocked);
  const prompt = frameFollowUp(args.taskId, args.prompt, deps.cli ?? taskCommand(deps.paths, { platform: deps.platform }), "codex");
  const { targetAttempt:_targetAttempt, offered:_offered, operatorStoppedAt: _operatorStoppedAt, taskControlRecoveryRunVersion: _taskControlRecoveryRunVersion, ...resumable } = record;
  const restarted: TaskRecord = { ...resumable, cwd: cwd.cwd, state: "started", reason: undefined, pid: undefined, pidStart: undefined,
    deadline: new Date(now + deps.policy.sessions.maxRuntimeMinutes * 60_000).toISOString() };
  const saved = await launch(deps, restarted, (files, outbox) => resumeArgs(threadId, record.permissionMode, files, outbox), prompt, admission);
  return { taskId: saved.taskId, state: saved.state };
}

// Ends the process after the identity check (terminate). A task that already
// reported done, or whose run was one for peer messages (running), keeps its
// reported state and sends no report; only the process ends.
// ended: the reported state, failed for a run without progress (issue #197).
export async function stopCodex(args: SessionStopArgs, deps: RunnerDeps, reason: string,
  operatorStop = reason === "stopped by the operator", ended: "stopped" | "failed" = "stopped"): Promise<{ taskId: string; state: string }> {
  let record = readTask(deps.paths, args.taskId)!;
  const now = deps.now?.() ?? Date.now();
  if (operatorStop && record.operatorStoppedAt === undefined) {
    record = writeTask(deps.paths, { ...record, operatorStoppedAt: new Date(now).toISOString() }, now);
  }
  const captured = { taskId: record.taskId, pid: record.pid, pidStart: record.pidStart };
  const exited = readExit(codexFiles(deps.paths, record.taskId)) !== null;
  let fresh = record;
  if (!exited) {
    if (record.pid === undefined) throw new Error("the task's process is not known");
    await terminate(deps.codex ?? {}, record.pid, record.pidStart);
    // Termination yields to another daemon lane. Reread before touching task,
    // inbox or report state, and bind every mutation to the captured process.
    const current = readTask(deps.paths, captured.taskId);
    if (!current || captured.pidStart === undefined
      || current.pid !== captured.pid || current.pidStart !== captured.pidStart) {
      throw new Error("task run changed while stop was in progress");
    }
    fresh = current;
  } else {
    // Issue #233: the root ended on its own; its recorded descendants may not.
    reapDescendants(deps.codex ?? {}, record, deps.log ?? (() => {}));
  }
  settleOffered(deps, fresh, false);
  const keep = fresh.state === "done" || fresh.running === true;
  const marker = operatorStop && fresh.operatorStoppedAt === undefined ? { operatorStoppedAt: record.operatorStoppedAt } : {};
  const saved = writeTask(deps.paths, { ...fresh, ...marker, ...(keep ? {} : { state: ended, reason }),
    running: undefined, offered: undefined, awaitingProgressSince: undefined, descendants: undefined }, now);
  if (!keep) queueReport(deps.paths, { taskId: saved.taskId, state: ended, reason, ...sessionOf(saved) });
  return { taskId: saved.taskId, state: saved.state };
}

// The messages a run carried: delivered when it completed its turn, otherwise
// offered again later within the offer limits (deliver-core.mts).
export function settleOffered(deps: RunnerDeps, record: TaskRecord, completed: boolean, reason?: string): void {
  if(record.targetAttempt) {
    const ctx={kind:"message" as const,handle:record.targetAttempt};
    const saved=checkExecution(deps.paths,ctx,["exec-resume","task-start"]);
    if(!saved||(saved.consumer??saved.group.operation).execution.taskId!==record.taskId)throw Error("task result context differs");
    const expected=saved.group.binding.members.map(m=>m.messageId).sort();
    if(JSON.stringify([...(record.offered??[])].sort())!==JSON.stringify(expected))throw Error("task result membership differs");
    transitionRouteMessages(deps.paths,ctx,r=>{
      if(r.state!=='offered')return r;
      const failure=permanentFallbackFailure(record,r,reason);
      return {...r,...(completed?{state:'delivered' as const}:failure?{state:'refused' as const,reason:failure}:{retry:true})};
    });
    return;
  }
  for (const id of record.offered ?? []) {
    const message = getMessage(deps.paths.inbox, id);
    if (message?.state !== "offered") continue;
    const failure = permanentFallbackFailure(record, message, reason);
    if (completed) deliverInboxMessage(deps.paths, id);
    else if (failure) refuseInboxMessage(deps.paths, id, failure);
    else retryInboxMessage(deps.paths, id);
  }
}

// Issue #119: the messages a new intercom run carries (closed-resume.mts
// startIntercom) settle like those of a message run, when the watch round sees
// it end. A run that ended before they were adopted settles them at once.
export function adoptOffered(deps: RunnerDeps, taskId: string, ids: string[]): void {
  const record = readTask(deps.paths, taskId);
  if (!record || ids.length === 0) return;
  if (isActive(record)) writeTask(deps.paths, { ...record, offered: [...(record.offered ?? []), ...ids] }, deps.now?.());
  else settleOffered(deps, { ...record, offered: ids }, record.state === "done", record.reason);
}
