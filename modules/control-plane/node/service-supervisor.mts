#!/usr/bin/env node
import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { captureSourceIdentity, compareSourceIdentity, runtimeSourceRoot, type SourceIdentity } from "./daemon-source.mts";
import { nodePaths } from "./config.mts";
import { managedArguments } from "./service-definitions.mts";
import { SERVICE_DRAIN_BLOCKED, serviceDrainFile } from "./service-drain.mts";
import { claimServiceLaunchPermit } from "./service-launch-permit.mts";
import { decodeSupervisorBinding } from "./service-supervisor-data.mts";
import type { ServiceBinding } from "./service-types.mts";

export const RESTART_DELAY_MS = 30_000;
const DRAIN_POLL_MS = 100;

interface SupervisorChild {
  once(event: "error" | "close", listener: (...args: unknown[]) => void): this;
  removeAllListeners(): this;
  kill(): boolean;
}
interface RuntimeEvidence {
  nodeExecutable: string;
  sourceRoot: string;
  env: NodeJS.ProcessEnv;
  captureSource(): SourceIdentity;
  realpath?: (value: string) => string;
}
interface SupervisorDependencies {
  spawnChild(executable: string, args: string[], options: SpawnOptions): SupervisorChild;
  sleep(milliseconds: number): Promise<void>;
  drainActive(): boolean;
  claimPermit(): boolean;
  verifySource(): void;
  openLog(): number;
  closeLog(fd: number): void;
  reportStartFailure?(): void;
  reportDrainBlocked?(): void;
}

const canonical = (value: string, realpath: (path: string) => string): string => realpath(value).toLowerCase();

export function validateSupervisorRuntime(binding: ServiceBinding, evidence: RuntimeEvidence = {
  nodeExecutable: process.execPath, sourceRoot: runtimeSourceRoot(), env: process.env,
  captureSource: () => captureSourceIdentity(binding.source.root), realpath: fs.realpathSync.native,
}): void {
  if (Object.keys(evidence.env).some(key => /^(?:NODE_OPTIONS|NODE_PATH)$/i.test(key))) {
    throw new Error("service supervisor has execution-affecting Node environment variables");
  }
  const realpath = evidence.realpath ?? ((value: string) => path.resolve(value));
  if (canonical(evidence.nodeExecutable, realpath) !== canonical(binding.nodeExecutable, realpath)) {
    throw new Error("service supervisor Node executable differs from its binding");
  }
  if (canonical(evidence.sourceRoot, realpath) !== canonical(binding.source.root, realpath)) {
    throw new Error("service supervisor source root differs from its binding");
  }
  if (compareSourceIdentity(binding.source, evidence.captureSource()).status !== "match") {
    throw new Error("service supervisor source identity differs from its binding");
  }
}

export function openSupervisorLog(file: string): number {
  const before = fs.lstatSync(file, { throwIfNoEntry: false });
  if (before && (before.isSymbolicLink() || !before.isFile())) throw new Error("service supervisor log is not a regular file");
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | (before ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
  const fd = fs.openSync(file, flags, 0o600);
  try {
    const opened = fs.fstatSync(fd);
    const after = fs.lstatSync(file);
    if (!opened.isFile() || after.isSymbolicLink() || !after.isFile() || opened.dev !== after.dev || opened.ino !== after.ino) {
      throw new Error("service supervisor log is not a regular file");
    }
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}

export function startWindowsServiceSupervisor(binding: ServiceBinding, overrides: Partial<SupervisorDependencies> = {}) {
  const deps: SupervisorDependencies = {
    spawnChild: (file, args, options) => spawn(file, args, options),
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    drainActive: () => fs.existsSync(serviceDrainFile(nodePaths(binding.configRoot))),
    claimPermit: () => claimServiceLaunchPermit(nodePaths(binding.configRoot), binding),
    verifySource: () => validateSupervisorRuntime(binding),
    openLog: () => openSupervisorLog(binding.logFile!), closeLog: fd => fs.closeSync(fd),
    reportStartFailure: () => console.error("kherep-node service supervisor: daemon start failed"),
    ...overrides,
  };
  const log = deps.openLog();
  // Headless task console output does not reach the operator's service log.
  const reportDrainBlocked = deps.reportDrainBlocked ?? (() => {
    fs.writeSync(log, `kherep-node service supervisor: ${SERVICE_DRAIN_BLOCKED} daemon start waits for the service drain; see kherep-node service status\n`);
  });
  let child: SupervisorChild | undefined;
  let stopped = false;
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });

  const fail = (error: unknown) => {
    if (stopped) return;
    stopped = true;
    deps.closeLog(log);
    rejectDone(error);
  };
  const restart = async () => {
    await deps.sleep(RESTART_DELAY_MS);
    if (!stopped) await launch();
  };
  const launch = async () => {
    let reported = false;
    while (!stopped && deps.drainActive() && !deps.claimPermit()) {
      if (!reported) {
        reported = true;
        try { reportDrainBlocked(); } catch { /* Diagnostics cannot change the drain wait. */ }
      }
      await deps.sleep(DRAIN_POLL_MS);
    }
    if (stopped) return;
    deps.verifySource();
    let next: SupervisorChild;
    try {
      next = deps.spawnChild(binding.nodeExecutable, managedArguments(binding), {
        cwd: binding.workspace, shell: false, detached: false, windowsHide: false,
        stdio: ["ignore", log, log], env: process.env,
      });
    } catch {
      deps.reportStartFailure?.();
      await restart();
      return;
    }
    child = next;
    let settled = false;
    const finish = () => {
      if (settled || stopped) return;
      settled = true;
      if (child === next) child = undefined;
      void restart().catch(fail);
    };
    next.once("error", () => { deps.reportStartFailure?.(); finish(); });
    next.once("close", finish);
  };
  void launch().catch(fail);

  return { done, stop: async () => {
    if (stopped) return done;
    stopped = true;
    if (child) { child.removeAllListeners(); child.kill(); child = undefined; }
    deps.closeLog(log);
    resolveDone();
    return done;
  } };
}

async function run(encoded: string): Promise<void> {
  const binding = decodeSupervisorBinding(encoded);
  validateSupervisorRuntime(binding);
  const supervisor = startWindowsServiceSupervisor(binding);
  const stop = () => { void supervisor.stop(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await supervisor.done;
}

function isMainModule(): boolean {
  const entry = process.argv[1] ?? "";
  try { return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href; } catch { return false; }
}

if (isMainModule()) run(process.argv[2] ?? "").catch((error: unknown) => {
  console.error(`kherep-node service supervisor: ${(error as Error).message ?? String(error)}`);
  process.exitCode = 1;
});
