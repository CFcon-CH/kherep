import {requireMessageEffect} from './message-admission.mts';
import { verifyPreparedLaunch } from "./target-delivery-launch.mts";
import { finishRouteEffect } from "./target-delivery-outcome.mts";
import { windowControl } from "./target-delivery-window.mts";
import type { ExecutionContext } from "./target-delivery-operation.mts";
import { checkExecution, beginRouteEffect } from "./target-delivery-route.mts";
import { commandProducer } from "./target-delivery-producer.mts";
import { canonical } from "./target-delivery-state.mts";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { PermissionMode } from "../protocol-tasks.mts";
import type { KillReport } from "./codex-app-server-client.mts";
import { codexCommand, type CodexCommand } from "./codex-binary.mts";
import type { LoadedThreads } from "./codex-daemon.mts";
import type { McpList } from "./codex-mcp.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { isCodexSessionId } from "./codex-sessions.mts";
import { writeJsonAtomic } from "./inbox.mts";
import { KHEREP_SESSION_ENV, SESSION_ENV } from "./msg-resolve.mts";
import type { ProcessIdentity } from "./codex-stop.mts";
import type { ProcessRelation } from "./process-relations.mts";
import { held, startTimeOf } from "./process-start.mts";
import { withNodeOnPath } from "./task-env.mts";
import type { ServiceAdmission } from "./service-drain.mts";
import { timedSync } from "./sync-timing.mts";

// The Codex processes of tasks (issue #63), from `codex exec --help` and
// `codex exec resume --help` of Codex CLI 0.153.4 and the measurements in the
// issue: `codex exec --json` prints JSON Lines events, `thread.started` with
// `thread_id` first and `turn.completed` at the end; `-o` writes the last agent
// message; without closed stdin it waits for more input. The prompt goes in on
// stdin (`-`: "instructions are read from stdin"), never as an argument that
// `ps` would show for the whole run; stdin is closed right after it. `codex exec resume`
// has no `-C`, `--sandbox` or `--add-dir`: it takes the sandbox as `-c
// sandbox_mode=...`, the extra writable root as `-c
// sandbox_workspace_write.writable_roots=[...]`, and runs in the process's
// working directory.
// Besides the working directory, the only writable root is the node's outbox,
// so `kherep-node msg send` works from inside the sandbox; the rest of the
// node directory (its key, policy and task records) stays read-only.

// exec is non-interactive and cannot ask, so the permission mode maps to a
// sandbox: auto and acceptEdits may edit the workspace, default reads only.
export const CODEX_SANDBOX: Readonly<Record<PermissionMode, string>> = {
  auto: "workspace-write", acceptEdits: "workspace-write", default: "read-only",
};
// Flags that lift the sandbox or approvals; the runner never passes them.
export const FORBIDDEN_CODEX_FLAGS = ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--approve-for-me"];

export type SignalScope = "group" | "process";

// Issue #473: the identity and tree reads may answer asynchronously; a
// synchronous fake stays valid.
type MaybePromise<T> = T | Promise<T>;

// Moved to process-start.mts (issue #473); importers keep this module.
export { holdsChild, processStart, sameProcess, startTimeOf, stillRuns } from "./process-start.mts";

export interface CodexDeps {
  findCodex?: () => string | null;
  platform?: NodeJS.Platform;
  // The start time of a running process, null when there is none; throws
  // when it cannot tell.
  processStart?: (pid: number) => MaybePromise<string | null>;
  // Signals the process group of pid, or with scope "process" only pid.
  signal?: (pid: number, signal: NodeJS.Signals, scope?: SignalScope) => void;
  // Issue #408: the fork reply's group kill with its report (codex-fork-process.mts); signalGroupReport by default.
  killGroup?: (pid: number, signal: NodeJS.Signals) => KillReport;
  processTree?: (root: number) => MaybePromise<ProcessIdentity[]>;
  processRelations?: () => MaybePromise<ProcessRelation[]>;
  graceMs?: number;
  // How long a start waits for thread.started.
  startWaitMs?: number;
  // How long a `codex queue` run may take (codex-queue.mts).
  queueTimeoutMs?: number;
  // Await exact owned-pointer reconciliation; the default uses public Queue RPC.
  reconcileQueue?: (owner: string, admission?: ServiceAdmission) => Promise<void>;
  // The Codex home whose rollouts wake.codexApp reads (codex-app.mts);
  // CODEX_HOME or ~/.codex when absent.
  home?: string;
  // The thread ids loaded on the shared app-server daemon, null when unknown
  // (codex-daemon.mts); the control socket under home when absent.
  loadedThreads?: LoadedThreads;
  // Starts the process; tests record the options.
  spawn?: typeof spawn;
  // Runs `codex <args>` for the MCP server list of intercom runs (codex-mcp.mts).
  mcpList?: McpList;
  mcpListTimeoutMs?: number;
  // Issue #408: runs `codex features list` for the fork reply's feature filter
  // (codex-fork-reply.mts), with the McpList runner by default.
  featuresList?: McpList;
  // Issue #408: whether the Codex PostToolUse hook is installed (codex-fork-admission.mts).
  postToolHook?: () => boolean;
  // A started helper that cannot prove both exit and close must keep its
  // service admission fail-closed even when callers reduce the failure to a reason.
  onUnconfirmedShutdown?: () => void;
  // Tests only (issue #408, PR 4): runs after the relay's outbox step, before its final re-check of the inbox record.
  beforeOutbox?: () => void;
}

export interface CodexFiles { dir: string; events: string; lastMessage: string; stderr: string; exit: string }

export function codexFiles(paths: NodePaths, taskId: string): CodexFiles {
  const dir = path.join(paths.dir, "codex-tasks", taskId);
  return { dir, events: path.join(dir, "events.jsonl"), lastMessage: path.join(dir, "last-message.txt"),
    stderr: path.join(dir, "stderr.log"), exit: path.join(dir, "exit.json") };
}

// The config reference documents writable_roots as "Additional writable roots
// when sandbox_mode = workspace-write", so in read-only the outbox is most
// likely not writable either; the flag is passed anyway and changes nothing there.
// --skip-git-repo-check ("Allow running Codex outside a Git repository", in
// the help of both commands) skips only Codex's check that the working
// directory is a trusted Git repository, not the sandbox: the node already
// confines the working directory to its policy's workspace roots, which need
// not be repositories. Without it such a task fails at once (measured live:
// "Not inside a trusted directory and --skip-git-repo-check was not specified.").
export function startArgs(cwd: string, mode: PermissionMode, files: CodexFiles, outbox: string): string[] {
  return guard(["exec", "--json", "--skip-git-repo-check", "-C", cwd, "--sandbox", CODEX_SANDBOX[mode], "--add-dir", outbox, "-o", files.lastMessage, "-"]);
}

// TOML basic strings accept JSON string escapes.
// The thread id comes from codex's own output: only a plain id (never one that
// starts with "-" and could read as an option) goes on the command line.
export function resumeArgs(threadId: string, mode: PermissionMode, files: CodexFiles, outbox: string): string[] {
  if (!isCodexSessionId(threadId)) throw new Error("the task's thread id is not a plain id");
  return guard(["exec", "resume", "--json", "--skip-git-repo-check", "-c", `sandbox_mode="${CODEX_SANDBOX[mode]}"`,
    "-c", `sandbox_workspace_write.writable_roots=[${JSON.stringify(outbox)}]`, "-o", files.lastMessage, threadId, "-"]);
}

// The environment of a Codex task process: the daemon's own, plus where the
// node directory is and which session this is, for the msg CLI (msg-resolve.mts).
// A Claude Code session id the daemon inherited is dropped: the msg CLI would
// prefer it and speak for that Claude session. The node directory goes first
// on PATH (task-env.mts).
export function codexEnv(paths: NodePaths, session: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...withNodeOnPath(base), [KHEREP_SESSION_ENV]: session, KHEREP_CONFIG_DIR: path.dirname(paths.dir) };
  delete result[SESSION_ENV];
  return result;
}

function guard(args: string[]): string[] {
  if (args.some((arg) => FORBIDDEN_CODEX_FLAGS.includes(arg))) throw new Error("refusing a codex flag that lifts the sandbox");
  return args;
}

// Issue #119: on Windows a detached codex has no console, so each console
// child it starts (shell commands, MCP servers behind cmd.exe) opens a new
// visible window. An intercom run the daemon starts on its own is therefore
// not detached there: it shares the daemon's hidden console and, as measured
// in the issue, ends when the daemon exits. Its messages then count as not
// delivered and are offered again (codex-runner.mts). Operator tasks, and
// every run on other platforms, keep their own process group.
export const detachCodex = (platform: NodeJS.Platform, intercom: boolean): boolean => !(intercom && platform === "win32");

// Issue #124: a detached run on Windows (an operator task) starts through the
// wrapper codex-windowless.mts, run with this Node: the wrapper is detached
// and survives a daemon restart, codex runs attached to it in a console
// without a window. The pid, start time and exit code the daemon records are
// the wrapper's; it ends when codex ends, exits with codex's code, and
// `taskkill /T` on it reaches codex and its children.
export const WINDOWLESS = path.join(import.meta.dirname, "codex-windowless.mts");
export function launchCommand(command: CodexCommand, platform: NodeJS.Platform, detached: boolean, node: string = process.execPath): CodexCommand {
  return platform === "win32" && detached ? { file: node, args: [WINDOWLESS, command.file, ...command.args] } : command;
}

// Starts codex (detached in its own process group unless told otherwise),
// writes the prompt to its stdin and closes it, and sends stdout (the events)
// and stderr into the task's files; exit.json records how it ended while this
// daemon runs. Resolves with the pid once it runs, and its start time, read
// before codex gets the end of its prompt (issue #473). A codex failing at
// startup can still exit during the read, so the start counts only while this
// child is still held; undefined when it ended or the read failed: the watch
// reads it again while this daemon holds the child.
export async function spawnCodex(deps: CodexDeps, file: string, args: string[], cwd: string, files: CodexFiles,
  env: NodeJS.ProcessEnv, prompt: string, detached = true, context?:ExecutionContext, paths?:NodePaths, execution?:{taskId:string|null;sessionId:string|null}): Promise<{ pid: number; pidStart: string | undefined }> {
  if(!context)throw Error("execution context missing");
  if(context.kind==="read-only")throw Error("read-only context cannot launch");
  if(context.kind==="message"&&!paths)throw Error("message execution paths missing");
  const prepared=context.kind==="message"?context.launch:undefined;
  if(context.kind==="message") {
    if(!prepared||!execution||file!==prepared.binding.executable||canonical(args)!==canonical(prepared.rawArgs)||cwd!==prepared.binding.cwd||detached!==prepared.binding.detached)throw Error("prepared command/task context differs");
    verifyPreparedLaunch(paths!,context,prepared,["exec-resume","task-start"],{runtime:"codex",...execution,phase:"ready"});
    if(!prepared.binding.home||!path.isAbsolute(prepared.binding.home)||env.CODEX_HOME!==prepared.binding.home)throw Error('message home differs');
  }
  const platform = deps.platform ?? process.platform;
  const command = prepared?.outer??launchCommand(codexCommand(file, args, platform), platform, detached);
  ensureDir(files.dir);
  for (const f of [files.lastMessage, files.exit]) fs.rmSync(f, { force: true });
  const out = fs.openSync(files.events, "w", 0o600);
  const err = fs.openSync(files.stderr, "w", 0o600);
  try {
    if(context.kind==='message'){beginRouteEffect(paths!,context,['exec-resume','task-start']);requireMessageEffect({paths:paths!},context,'outer-spawn');}
    const child = (deps.spawn ?? spawn)(command.file, command.args, { cwd, env, detached, stdio: ["pipe", out, err], windowsHide: true });
    child.stdin?.on("error", () => {}); // a codex that exits before reading
    child.on("exit", (code, signal) => {
      if (held.get(child.pid!) === child) held.delete(child.pid!);
      try {
        writeJsonAtomic(files.exit, { code, signal });
      } catch {
        // the watch then decides from the events alone
      }
    });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => resolve(child.pid!));
    });
    held.set(pid, child);
    let pidStart: string | undefined;
    try {
      pidStart = await startTimeOf(deps, pid) ?? undefined;
    } catch {
      // read again by the watch
    }
    if (held.get(pid) !== child) pidStart = undefined; // ended or replaced during the read
    const inner=codexCommand(file,args,platform);
    let payload=prompt;
    try {
      payload=(platform==='win32'&&detached?windowControl(context,paths,inner.file,inner.args,WINDOWLESS):'')+prompt;
      if(context.kind==="message"){
      verifyPreparedLaunch(paths!,context,prepared!,["exec-resume","task-start"],{runtime:"codex",...execution!,phase:"executing"});
      if(env.CODEX_HOME!==prepared!.binding.home)throw Error('message home changed before stdin');
      requireMessageEffect({paths:paths!},context,'prompt-release');
      }
    }
    catch {
      try{deps.onUnconfirmedShutdown?.();}catch{/* containment cannot erase measured identity */}child.stdin?.destroy();
      try{if(paths&&context.kind==="message")finishRouteEffect(paths,context,{kind:"exec",pid,pidStart:pidStart??null,threadId:null});if(paths&&context.kind==="message")finishRouteEffect(paths,context,{kind:"uncertain"});}catch{/* the existing fence remains */}
      const error=Object.assign(Error("message context changed before stdin"),{pid,pidStart});throw error;
    }
    child.stdin?.end(payload);
    child.unref();
    return { pid, pidStart };
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
}

type Run = (file: string, args: string[]) => unknown;
// Still synchronous (issue #473): a slow taskkill is logged by name.
const runHidden: Run = (file, args) => timedSync(file, () => execFileSync(file, args, { windowsHide: true, timeout: 10_000 }));

// SIGTERM or SIGKILL to the process group (the negative pid) or, on Windows,
// taskkill for the process tree (/T; /F for SIGKILL). Either way it reaches
// codex behind the npm launcher too. A process that is gone is no error.
export const signalGroup = (pid: number, signal: NodeJS.Signals, platform?: NodeJS.Platform, run?: Run): boolean =>
  signalGroupReport(pid, signal, platform, run) === "sent";

// The same signal with its report (codex-app-server-client.mts): "absent" only
// when POSIX kill(-pgid) answers ESRCH, the kernel's statement that no process
// of the group exists. Windows taskkill /T cannot tell an exited root with
// living descendants from an empty tree (issue #231), so a failure there is
// "unconfirmed", never "absent".
export function signalGroupReport(pid: number, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform,
  run: Run = runHidden): KillReport {
  try {
    if (platform === "win32") run("taskkill", ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])]);
    else process.kill(-pid, signal);
    return "sent";
  } catch (error) {
    return platform !== "win32" && (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unconfirmed";
  }
}

// The same signal to the single process pid; throws when it fails. Issue #231:
// a descendant in its own process group misses the group signal, and on Windows
// taskkill /T walks the tree from a root that must still run, so a descendant
// whose root ended is reached only by its own pid.
export function signalProcess(pid: number, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform,
  run: Run = runHidden): void {
  if (platform === "win32") run("taskkill", ["/PID", String(pid), ...(signal === "SIGKILL" ? ["/F"] : [])]);
  else process.kill(pid, signal);
}
