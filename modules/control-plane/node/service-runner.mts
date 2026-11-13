#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { codexLivenessSource } from "./codex-liveness-source.mts";
import { nodePaths, readConfig } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { serviceSelector, supportedServicePlatform } from "./service-platform.mts";

export interface ServiceRunnerArgs { configDir: string; serviceName: string; taskPath?: string; workspace: string }

export function parseServiceRunnerArgs(argv: string[], platform: NodeJS.Platform = process.platform): ServiceRunnerArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: argv, strict: true, options: {
      "config-dir": { type: "string" }, "service-name": { type: "string" }, "task-path": { type: "string" }, workspace: { type: "string" },
    } });
  } catch { throw new Error("usage: service-runner --config-dir <absolute> --service-name <name> [--task-path <path>] --workspace <absolute>"); }
  const configDir = parsed.values["config-dir"];
  const serviceName = parsed.values["service-name"];
  const taskPath = parsed.values["task-path"];
  const workspace = parsed.values.workspace;
  if (typeof configDir !== "string" || typeof serviceName !== "string" || typeof workspace !== "string"
    || (taskPath !== undefined && typeof taskPath !== "string") || !path.isAbsolute(configDir) || !path.isAbsolute(workspace)) {
    throw new Error("service runner paths must be absolute");
  }
  const service = serviceSelector(supportedServicePlatform(platform), serviceName, taskPath);
  return { configDir: path.resolve(configDir), ...service, workspace: path.resolve(workspace) };
}

// Issue #420: an ISO time in front of every daemon log line, in the service log
// and for the foreground `kherep-node daemon`; without it no incident timeline
// can be built. startDaemon's own default (tests) stays plain.
export const timestamped = (write: (line: string) => void = (line) => console.error(line)) =>
  (line: string): void => write(`${new Date().toISOString()} ${line}`);

// Ends the daemon on SIGINT, SIGTERM and SIGHUP. On Windows SIGHUP is the
// console closing, after which Windows ends Node about 10 s later (Node
// process.md); TerminateProcess (taskkill /F, Stop-Process) delivers nothing.
export function stopOnSignals(daemon: { stop(): void }): void {
  const stop = () => daemon.stop();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, stop);
}

async function run(argv: string[]): Promise<void> {
  const args = parseServiceRunnerArgs(argv);
  const paths = nodePaths(args.configDir);
  const config = readConfig(paths.config);
  if (!config) throw new Error("managed daemon service is not enrolled");
  process.chdir(args.workspace);
  const platform = supportedServicePlatform();
  // Issue #706: the Codex liveness source; it probes only with wake.nativeQueue.
  const log = timestamped();
  const daemon = startDaemon(config, paths, log, undefined, undefined,
    { name: args.serviceName, platform, ...(args.taskPath ? { taskPath: args.taskPath } : {}) }, undefined, undefined, codexLivenessSource({ paths, log }));
  stopOnSignals(daemon);
  await daemon.done;
}

function isMainModule(): boolean {
  const entry = process.argv[1] ?? "";
  try { return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href; } catch { return false; }
}

if (isMainModule()) run(process.argv.slice(2)).catch((error: unknown) => {
  timestamped()(`kherep-node service: ${(error as Error).message ?? String(error)}`);
  process.exitCode = 1;
});
