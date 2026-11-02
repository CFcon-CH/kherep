import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type test from "node:test";

import type { SessionStartArgs } from "../protocol-tasks.mts";
import { nodePaths, writeConfig } from "./config.mts";
import { loadPolicy } from "./policy.mts";
import type { ServiceOwnerProbe } from "./service-drain.mts";
import type { RunnerDeps } from "./session-runner.mts";
import type { ExecOptions } from "./sessions.mts";
import { readReport, removeReport, reportIds } from "./task-records.mts";
import { createAdmissionAuthority } from "./session-authority.mts";

// Shared fixture of the task tests (item 5): a throwaway node directory with a
// workspace root, a policy with a sessions section, and a fake claude that
// never runs anything. It answers `--bg` (and `--resume <id> --bg`, in place)
// with the documented `backgrounded · <id> · <name>` line and `agents --json --all` with its rows.
// After livePids(first), each new row also carries the `pid` and `status` the
// listing shows "While the process is alive" (issue #437); by default it has neither.
// `stop <id>` does what `claude stop` was measured to do to the listing (issue
// #437): the row loses `pid` and `status` and shows `state: "stopped"` at once,
// whether or not its processes ended. onStop(handler) runs after that, so a
// test decides which processes end; failStop(message) rejects `stop` alone.

export const T0 = Date.UTC(2026, 8, 25, 12);
export const TASK = "3f2a1b0c-0000-4000-8000-000000000001";
export const taskId = (n: number): string => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000001`;

export interface Call { file: string; args: string[]; options: ExecOptions }

// Issue #423: the owner of the fixture's service admissions, this process,
// known without the PowerShell identity lookup of the default probe, which
// can time out on a loaded Windows runner. Pass it to serviceAdmissionsIdle
// to check the fixture's leases.
export const testServiceOwner: ServiceOwnerProbe = {
  current: () => ({ version: 1, pid: process.pid, startedAt: new Date(T0).toISOString(), owner: "kherep-test-owner" }),
  active: (owner) => owner.pid === process.pid,
};

export function taskNode(t: test.TestContext, sessions: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-task-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "repo"), { recursive: true });
  const paths = nodePaths(root);
  const livenessAuthority = createAdmissionAuthority(paths);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.invalid", nodeId: "00000000-0000-4000-8000-0000000000aa",
    name: "n", publicKey: "", privateKeyFile: "", policyFile: paths.policy, enrolledAt: new Date(T0).toISOString() });
  // Waking is off unless extra sets a wake section: an absent one wakes every session (issue #390).
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: false },
    sessions: { enabled: true, workspaceRoots: [workspace], ...sessions }, ...extra }));
  const calls: Call[] = [];
  const rows: Record<string, unknown>[] = [];
  let clock = T0;
  let next = 0;
  let failWith: string | null = null;
  let livePid: number | null = null;
  let stopFailure: string | null = null;
  let onStop: ((id: string) => void) | null = null;
  const exec = async (file: string, args: string[], options: ExecOptions): Promise<string> => {
    calls.push({ file, args, options });
    if (failWith) throw new Error(failWith);
    if (args[0] === "agents") return JSON.stringify(rows);
    if (args[0] === "stop") {
      if (stopFailure) throw new Error(stopFailure);
      const stopped = rows.find((row) => row.id === args[1]);
      if (stopped) {
        delete stopped.pid;
        delete stopped.status;
        stopped.state = "stopped";
      }
      onStop?.(args[1]);
      return "";
    }
    const short = `b${(next++).toString(16).padStart(7, "0")}`;
    const name = args[args.indexOf("--name") + 1];
    // A resume continues the session under its own id (a copy is set up by the test).
    const resumed = args[0] === "--resume" ? args[1] : undefined;
    rows.push({ id: short, sessionId: resumed ?? `5e55${short}-0000-4000-8000-000000000000`, ...(args.includes("--name") ? { name } : {}),
      state: "working", kind: "background", cwd: options.cwd, startedAt: clock,
      ...(livePid === null ? {} : { pid: livePid++, status: "busy" }) });
    return `Starting background service…\nbackgrounded · ${short}${args.includes("--name") ? ` · ${name}` : ""}\n  claude agents   list sessions\n`;
  };
  const deps = (): RunnerDeps => ({
    paths, policy: loadPolicy(paths.policy), exec, findClaude: () => "/opt/bin/claude", platform: "linux", now: () => clock, cli: "kherep-node",
    serviceOwner: testServiceOwner, livenessAuthority,
  });
  // Reports queued since the last call, oldest file order not guaranteed.
  const reports = (): Record<string, unknown>[] => reportIds(paths).map((id) => {
    const body = readReport(paths, id) as Record<string, unknown>;
    removeReport(paths, id);
    return body;
  });
  return {
    root, workspace, paths, calls, rows, deps, reports, livenessAuthority,
    tick: (ms: number) => { clock += ms; },
    failNext: (message: string | null) => { failWith = message; },
    livePids: (first: number | null) => { livePid = first; },
    failStop: (message: string | null) => { stopFailure = message; },
    onStop: (handler: ((id: string) => void) | null) => { onStop = handler; },
  };
}

export function startArgs(id: string = TASK, extra: Partial<SessionStartArgs> = {}): SessionStartArgs {
  return { taskId: id, runtime: "claude", name: `task-${id.slice(0, 8)}`, prompt: "fix the flaky test", permissionMode: "auto", ...extra };
}
