import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { configRoot, nodePaths, readConfig } from "./config.mts";
import { captureSourceIdentity, runtimeSourceRoot } from "./daemon-source.mts";
import { ensureLauncher, type LauncherStatus } from "./launcher.mts";
import type { LifecycleDependencies } from "./service-lifecycle.mts";
import { servicePlatform, serviceSelector, supportedServicePlatform } from "./service-platform.mts";
import { readServiceReceipt, serviceRoot, type ServiceReceipt } from "./service-records.mts";
import { activateManagedService, rollbackManagedService } from "./service-transaction.mts";
import { reportServiceStatus, reportUnmanagedStatus, type StatusDependencies } from "./service-status.mts";
import { SERVICE_STAGES, type ServiceStage } from "./service-transaction-support.mts";
import { isStopCode, type ServiceBinding, type StopCode } from "./service-types.mts";
import { lastFailureOf, removeServiceLastFailure, writeServiceLastFailure, type ServiceLastFailure } from "./service-last-failure.mts";
import { nativeFailure, type NativeFailure } from "./service-windows-invoke.mts";

export const SERVICE_USAGE = `  kherep-node service install --workspace <absolute> [--source <clean checkout>] [--service-name <name>] [--task-path <path>] [--adopt]
  kherep-node service upgrade [--source <clean checkout>]
  kherep-node service status
  kherep-node service rollback
  kherep-node service rollback --recover --backup <backup-id> --source <candidate-clean-checkout>
  macOS --adopt uses the configured on-disk plist, not a complete snapshot of the loaded launchd cache.`;

export type ServiceCommand = { action: "install"; workspace: string; source?: string; serviceName?: string; taskPath?: string;
  adopt: boolean; explicitServiceName: boolean } | { action: "upgrade"; source?: string }
  | { action: "status" } | { action: "rollback"; recover?: true; backup?: string; source?: string };

export function defaultServiceName(platform: ServiceBinding["platform"]): string {
  return platform === "win32" ? "KherepNode" : "org.kherep.node";
}

interface ServiceCliDependencies extends StatusDependencies {
  root?: string;
  readReceipt?: (paths: ReturnType<typeof nodePaths>) => ServiceReceipt | null;
  lifecycle?: Omit<LifecycleDependencies, "paths" | "adapter">;
}

const SERVICE_FAILURE_CODES = new Set(["SERVICE_ACTIVATION_FAILED", "SERVICE_ROLLBACK_FAILED"]);
const SERVICE_STAGE_SET = new Set<string>(SERVICE_STAGES);
interface SafeServiceFailure { ok: false; code: string; recovery: "restored" | "unknown"; stage?: ServiceStage; blocker?: string; stopCode?: StopCode;
  native?: NativeFailure }
// #838 A4: the failed native call, validated field by field (service-windows-invoke.mts); anything else is dropped.
const native = (error: unknown): { native?: NativeFailure } => {
  const detail = nativeFailure(error);
  return detail ? { native: detail } : {};
};
// Only fixed fields leave the process; the error message may carry native output and is never printed.
export function safeServiceFailure(error: unknown): SafeServiceFailure | null {
  if (!error || typeof error !== "object") return null;
  const value = error as { code?: unknown; recovery?: unknown; stage?: unknown; blocker?: unknown; stopCode?: unknown };
  if (typeof value.code !== "string" || !SERVICE_FAILURE_CODES.has(value.code)
    || (value.recovery !== "restored" && value.recovery !== "unknown")) return null;
  return { ok: false, code: value.code, recovery: value.recovery,
    ...(typeof value.stage === "string" && SERVICE_STAGE_SET.has(value.stage) ? { stage: value.stage as ServiceStage } : {}),
    ...(typeof value.blocker === "string" && /^RECOVERY_[A-Z_]{1,40}$/.test(value.blocker) ? { blocker: value.blocker } : {}),
    ...(isStopCode(value.stopCode) ? { stopCode: value.stopCode } : {}), ...native(error) };
}

// The CLI's stderr line: a service failure as its fixed JSON; any other error as its message, plus the validated
// native call when a pre-mutation step failed in one (#838 A4).
export function serviceErrorLine(error: unknown): string {
  const failure = safeServiceFailure(error);
  if (failure) return JSON.stringify(failure);
  const detail = native(error);
  return `kherep-node: ${(error as Error)?.message ?? String(error)}${detail.native ? ` ${JSON.stringify(detail)}` : ""}`;
}

// #838 A4: display-only record; a failure to write or remove it never changes the command's result.
async function recorded<T>(paths: ReturnType<typeof nodePaths>, command: ServiceLastFailure["command"], commit: () => string | undefined,
  run: () => Promise<T>): Promise<T> {
  let result: T;
  try { result = await run(); } catch (error) {
    try { writeServiceLastFailure(paths, lastFailureOf(command, error, new Date(), commit())); } catch { /* display only */ }
    throw error;
  }
  try { removeServiceLastFailure(paths); } catch { /* display only */ }
  return result;
}

export function parseServiceCommand(argv: string[]): ServiceCommand {
  const rawAction = argv[0];
  if (!(rawAction === "install" || rawAction === "upgrade" || rawAction === "status" || rawAction === "rollback")) {
    throw new Error(`usage:\n${SERVICE_USAGE}`);
  }
  const action = rawAction;
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: argv.slice(1), strict: true, options: { workspace: { type: "string" }, source: { type: "string" },
      "service-name": { type: "string" }, "task-path": { type: "string" }, adopt: { type: "boolean" },
      recover: { type: "boolean" }, backup: { type: "string" } } });
  } catch { throw new Error(`usage:\n${SERVICE_USAGE}`); }
  const stringOption = (value: unknown): string | undefined => {
    if (value === undefined || typeof value === "string") return value;
    throw new Error(`usage:\n${SERVICE_USAGE}`);
  };
  const workspace = stringOption(parsed.values.workspace);
  const source = stringOption(parsed.values.source);
  const serviceName = stringOption(parsed.values["service-name"]);
  const taskPath = stringOption(parsed.values["task-path"]);
  const rawAdopt = parsed.values.adopt;
  if (rawAdopt !== undefined && typeof rawAdopt !== "boolean") throw new Error(`usage:\n${SERVICE_USAGE}`);
  const adopt = rawAdopt === true;
  const recover = parsed.values.recover, backup = stringOption(parsed.values.backup);
  if (recover !== undefined || backup !== undefined) {
    if (action !== "rollback" || recover !== true || !backup || !source || !path.isAbsolute(source)
      || workspace !== undefined || serviceName !== undefined || taskPath !== undefined || rawAdopt !== undefined
      || argv.filter(x => x === "--recover").length !== 1
      || argv.filter(x => x === "--backup" || x.startsWith("--backup=")).length !== 1
      || argv.filter(x => x === "--source" || x.startsWith("--source=")).length !== 1) throw new Error(`usage:\n${SERVICE_USAGE}`);
    return { action, recover: true, backup, source: path.resolve(source) };
  }
  if (action === "install") {
    if (typeof workspace !== "string" || !path.isAbsolute(workspace)) throw new Error("service install requires an absolute --workspace");
    if (source && !path.isAbsolute(source)) throw new Error("--source must be absolute");
    return { action, workspace: path.resolve(workspace), ...(source ? { source: path.resolve(source) } : {}),
      ...(serviceName ? { serviceName } : {}), ...(taskPath ? { taskPath } : {}), adopt,
      explicitServiceName: serviceName !== undefined };
  }
  if (action === "upgrade") {
    if (workspace || serviceName || taskPath || adopt) throw new Error(`usage:\n${SERVICE_USAGE}`);
    if (source && !path.isAbsolute(source)) throw new Error("--source must be absolute");
    return { action, ...(source ? { source: path.resolve(source) } : {}) };
  }
  if (workspace || source || serviceName || taskPath || adopt) throw new Error(`usage:\n${SERVICE_USAGE}`);
  return { action };
}

function installedBinding(command: Extract<ServiceCommand, { action: "install" }>, root: string): ServiceBinding {
  const platform = supportedServicePlatform();
  const sourceRoot = command.source ?? runtimeSourceRoot();
  const source = captureSourceIdentity(sourceRoot);
  const base = { platform, workspace: command.workspace, configRoot: root, nodeExecutable: process.execPath, source,
    ...(platform === "win32" ? { logFile: path.join(root, "control-plane", "service", "daemon.log") } : {}) };
  const service = serviceSelector(platform, command.serviceName ?? defaultServiceName(platform), command.taskPath);
  return { ...base, ...service };
}

function safeResult(value: Awaited<ReturnType<typeof activateManagedService>>, action: string): Record<string, unknown> {
  return { ok: true, action, serviceName: value.serviceName, platform: value.platform,
    ...(value.taskPath ? { taskPath: value.taskPath } : {}), source: { commit: value.source.commit, digest: value.source.digest, kind: value.source.kind },
    ...(value.backupId ? { backupId: value.backupId } : {}) };
}

// Issue #436. The stable launcher is derived from the receipt the transaction
// just wrote, outside the transaction: a failed write is reported and leaves the
// activation in place. Without a receipt (a rollback to a legacy service) the
// launcher still exists and fails closed.
function refreshLauncher(root: string, readReceipt: () => ServiceReceipt | null): LauncherStatus | "failed" {
  try {
    const binding = readReceipt()?.binding;
    return ensureLauncher(root, { platform: binding?.platform ?? supportedServicePlatform(),
      nodeExecutable: binding?.nodeExecutable ?? process.execPath }).status;
  } catch { return "failed"; }
}

export async function runService(argv: string[], dependencies: ServiceCliDependencies = {}): Promise<number> {
  const command = parseServiceCommand(argv);
  const root = dependencies.root ?? configRoot();
  const paths = nodePaths(root);
  const readReceipt = () => (dependencies.readReceipt ?? readServiceReceipt)(paths);
  const receipt = readReceipt();
  const report = (value: Awaited<ReturnType<typeof activateManagedService>>, action: string): number => {
    console.log(JSON.stringify({ ...safeResult(value, action), launcher: refreshLauncher(root, readReceipt) }, null, 2));
    return 0;
  };
  if (command.action === "status") {
    return receipt ? reportServiceStatus(paths, receipt, dependencies) : reportUnmanagedStatus(paths, dependencies);
  }
  if (!readConfig(paths.config)) throw new Error("managed daemon service requires an enrolled node");
  if (command.action === "install") {
    if (!fs.statSync(command.workspace, { throwIfNoEntry: false })?.isDirectory()) throw new Error("service workspace is not a directory");
    const binding = installedBinding(command, root);
    const adapter = (dependencies.adapterFor ?? servicePlatform)(serviceRoot(paths), binding.platform);
    const result = await activateManagedService({ mode: "install", binding, sourceRoot: command.source ?? runtimeSourceRoot(),
      adopt: command.adopt, explicitServiceName: command.explicitServiceName }, { ...dependencies.lifecycle, paths, adapter });
    return report(result, "install");
  }
  if (!receipt) throw new Error("managed service receipt is missing; install or adopt first");
  const adapter = (dependencies.adapterFor ?? servicePlatform)(serviceRoot(paths), receipt.binding.platform);
  if (command.action === "upgrade") {
    let commit: string | undefined;
    const result = await recorded(paths, "upgrade", () => commit, async () => {
      const sourceRoot = command.source ?? runtimeSourceRoot();
      const checkout = captureSourceIdentity(sourceRoot);
      commit = checkout.commit;
      const binding = { ...receipt.binding, source: checkout };
      return activateManagedService({ mode: "upgrade", binding, sourceRoot }, { ...dependencies.lifecycle, paths, adapter });
    });
    return report(result, "upgrade");
  }
  const result = await recorded(paths, "rollback", () => receipt.binding.source.commit, () => rollbackManagedService({ binding: receipt.binding,
    ...(command.recover ? { recover: { backup: command.backup!, source: command.source! } } : {}) }, { ...dependencies.lifecycle, paths, adapter }));
  return report(result, "rollback");
}
