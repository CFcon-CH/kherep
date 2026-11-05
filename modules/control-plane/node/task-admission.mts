import { DELEGATED_PERMISSION_MODES, type SessionStartArgs } from "../protocol-tasks.mts";
import { taskCommand } from "./session-command.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { isActive, listTasks, queueReport, type TaskRecord } from "./task-records.mts";
import { framePrompt, resolveCwd } from "./task-prompt.mts";

// The checks every task start passes, whatever its runtime (issue #31, item 5;
// Codex since issue #63): the node's sessions policy, the runtime, the
// permission mode, delegation, the limits and the working directory. Both
// runtimes share the limits, so a Codex task counts against the same caps.

const DAY_MS = 24 * 60 * 60_000;

export const trim = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 256) || "no reason given";

// Logs the refusal (issue #240), queues task.report failed and rejects, so the
// command result fails too. The reason is a fixed text or the CLI's own error,
// never the prompt.
export function refuse(deps: RunnerDeps, taskId: string, reason: string): never {
  deps.log?.(`kherep-node: task ${taskId} refused: ${trim(reason)}`);
  if (!deps.local) queueReport(deps.paths, { taskId, state: "failed", reason: trim(reason) });
  throw new Error(reason);
}

// The reason a start (or, with except, a continue) exceeds a limit, or null.
export function taskLimit(deps: RunnerDeps, now: number, except?: string): { reason: string; code: "task-concurrency" | "task-starts-daily" } | null {
  const policy = deps.policy.sessions!;
  const tasks = listTasks(deps.paths).filter((t) => t.taskId !== except);
  if (tasks.filter(isActive).length >= policy.maxConcurrent) return { reason: `this node runs at most ${policy.maxConcurrent} task sessions at a time`, code: "task-concurrency" };
  if (except === undefined && tasks.filter((t) => now - Date.parse(t.startedAt) < DAY_MS).length >= policy.maxStartsPerDay) {
    return { reason: `this node starts at most ${policy.maxStartsPerDay} task sessions per day`, code: "task-starts-daily" };
  }
  return null;
}

export const overLimit = (deps: RunnerDeps, now: number, except?: string): string | null => taskLimit(deps, now, except)?.reason ?? null;

export interface Admitted { record: TaskRecord; prompt: string }

// The record and framed prompt of a start the policy allows; otherwise reports
// failed and rejects.
export function admitStart(args: SessionStartArgs, deps: RunnerDeps): Admitted {
  const policy = deps.policy.sessions;
  if (!policy?.enabled) refuse(deps, args.taskId, "sessions are not enabled on this node");
  if (!policy.runtimes.includes(args.runtime)) refuse(deps, args.taskId, `runtime ${args.runtime} is not supported on this node yet`);
  const mode = args.permissionMode;
  if (!policy.permissionModes.includes(mode)) refuse(deps, args.taskId, `permission mode ${mode} is not allowed on this node`);
  if (args.requestedBy !== undefined) {
    if (!policy.delegate.accept) refuse(deps, args.taskId, "this node does not accept delegated tasks");
    if (!DELEGATED_PERMISSION_MODES.includes(mode)) refuse(deps, args.taskId, "a delegated task runs in permission mode auto or default");
  }
  const now = deps.now?.() ?? Date.now();
  const limit = overLimit(deps, now);
  if (limit) refuse(deps, args.taskId, limit);
  const cwd = resolveCwd(policy, args.cwd, deps.realpath);
  if (!cwd.ok) return refuse(deps, args.taskId, cwd.reason);
  const delegation = args.requestedBy !== undefined
    ? { requestedBy: args.requestedBy, directive: args.directive ?? "", ...(args.label ? { label: args.label } : {}),
      ...(deps.local === "intercom" ? { framed: true } : {}) } : undefined;
  const record: TaskRecord = {
    taskId: args.taskId, runtime: args.runtime, name: args.name, cwd: cwd.cwd, permissionMode: mode, state: "started",
    startedAt: new Date(now).toISOString(), deadline: new Date(now + policy.maxRuntimeMinutes * 60_000).toISOString(),
    updatedAt: new Date(now).toISOString(), ...(args.requestedBy !== undefined ? { requestedBy: args.requestedBy } : {}),
    ...(args.sourceRequestId ? { sourceRequestId: args.sourceRequestId } : {}),
    ...(args.label ? { label: args.label } : {}), ...(deps.local ? { local: deps.local } : {}),
  };
  let cli: string;
  try {
    cli = deps.cli ?? taskCommand(deps.paths, { platform: deps.platform });
  } catch (error) {
    return refuse(deps, args.taskId, String((error as Error).message));
  }
  return { record, prompt: framePrompt(args.taskId, args.prompt, cli, delegation, args.runtime) };
}
