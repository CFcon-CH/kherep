import fs from "node:fs";
import path from "node:path";

import type { ServiceAction, ServiceBinding, WindowsServiceSummary } from "./service-types.mts";
import { supervisorArguments } from "./service-supervisor-data.mts";

const AFFECTING_ENV = new Set(["NODE_OPTIONS", "NODE_PATH"]);

export function managedArguments(binding: ServiceBinding): string[] {
  return [path.join(binding.source.root, "modules", "control-plane", "node", "service-runner.mts"),
    "--config-dir", binding.configRoot, "--service-name", binding.serviceName,
    ...(binding.taskPath ? ["--task-path", binding.taskPath] : []), "--workspace", binding.workspace];
}

export function legacyDaemonArguments(binding: ServiceBinding, sourceRoot = binding.source.root): string[] {
  return [path.join(sourceRoot, "modules", "control-plane", "node", "cli.mts"), "daemon"];
}

export function daemonArgumentsMatch(actual: string[], binding: ServiceBinding, sourceRoot = binding.source.root): boolean {
  return [managedArguments(binding), legacyDaemonArguments(binding, sourceRoot)]
    .some(expected => actual.length === expected.length && expected.every((value, index) => actual[index] === value));
}

// Issue #420: launchd.plist(5) ExitTimeOut is how long launchd waits "between
// sending the SIGTERM signal and before sending a SIGKILL signal"; its default
// is system-defined and zero means infinity. 60 s covers a stopping daemon's
// wait for its readiness probe (45 s timeout, 5 s kill grace) and a session
// listing (10 s).
export const MAC_EXIT_TIMEOUT_S = 60;

export function freshMacDefinition(binding: ServiceBinding): Record<string, unknown> {
  return {
    Label: binding.serviceName,
    ProgramArguments: [binding.nodeExecutable, ...managedArguments(binding)],
    WorkingDirectory: binding.workspace,
    RunAtLoad: true,
    KeepAlive: true,
    ExitTimeOut: MAC_EXIT_TIMEOUT_S,
  };
}

function affectingEnvironment(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).some((key) => AFFECTING_ENV.has(key.toUpperCase()));
}

export function validateMacExecutionFields(existing: Record<string, unknown>, binding: ServiceBinding): void {
  if (existing.Program !== undefined && existing.Program !== binding.nodeExecutable) {
    throw new Error("service Program overrides the verified Node executable");
  }
  if (existing.EnableGlobbing === true) throw new Error("service enables argument globbing");
}

export function adoptMacDefinition(
  existing: Record<string, unknown>, binding: ServiceBinding, _uid: number, priorSourceRoot = binding.source.root,
): Record<string, unknown> {
  if (existing.Label !== binding.serviceName) throw new Error("service label does not match the selected service");
  if (affectingEnvironment(existing.EnvironmentVariables)) throw new Error("service has execution-affecting environment variables");
  validateMacExecutionFields(existing, binding);
  const args = existing.ProgramArguments;
  const cli = path.join(priorSourceRoot, "modules", "control-plane", "node", "cli.mts");
  if (!Array.isArray(args) || args.length !== 3 || args[0] !== binding.nodeExecutable || args[1] !== cli || args[2] !== "daemon") {
    throw new Error("service has unsupported program arguments");
  }
  return { ...existing, ProgramArguments: [binding.nodeExecutable, ...managedArguments(binding)] };
}

export function retargetMacDefinition(existing: Record<string, unknown>, binding: ServiceBinding): Record<string, unknown> {
  if (existing.Label !== binding.serviceName) throw new Error("service label does not match the selected service");
  if (affectingEnvironment(existing.EnvironmentVariables)) throw new Error("service has execution-affecting environment variables");
  validateMacExecutionFields(existing, binding);
  // An ExitTimeOut the operator set stays (issue #420).
  return { ExitTimeOut: MAC_EXIT_TIMEOUT_S, ...existing, ProgramArguments: [binding.nodeExecutable, ...managedArguments(binding)] };
}

export function quoteWindowsArg(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let result = '"';
  let slashes = 0;
  for (const char of value) {
    if (char === "\\") { slashes++; continue; }
    if (char === '"') result += "\\".repeat(slashes * 2 + 1) + '"';
    else result += "\\".repeat(slashes) + char;
    slashes = 0;
  }
  return result + "\\".repeat(slashes * 2) + '"';
}

export function windowsManagedAction(binding: ServiceBinding): ServiceAction {
  const root = process.env.SystemRoot ?? (process.platform === "win32" ? "" : String.raw`C:\Windows`);
  if (!path.win32.isAbsolute(root)) throw new Error("Windows system root is unavailable");
  const executable = path.win32.join(root, "System32", "conhost.exe");
  const args = ["--headless", binding.nodeExecutable, ...supervisorArguments(binding)].map(quoteWindowsArg).join(" ");
  return { executable, arguments: args,
    workingDirectory: binding.workspace };
}

export function windowsLegacyLogFile(action: ServiceAction): string {
  if (!/^conhost(?:\.exe)?$/i.test(path.win32.basename(action.executable))) {
    throw new Error("service legacy supervisor log path is unavailable");
  }
  const tokens = windowsArgs(action.arguments);
  const index = tokens.findIndex(token => token.toLowerCase() === "-logfile");
  const file = index >= 0 ? tokens[index + 1] : undefined;
  if (!file || (!path.win32.isAbsolute(file) && !path.isAbsolute(file))) {
    throw new Error("service legacy supervisor log path is unavailable");
  }
  return file;
}

export interface WindowsSupervisorProcess { executable: string; argv: string[]; kind: "managed" | "legacy" }

export function windowsSupervisorProcess(action: ServiceAction, binding: ServiceBinding): WindowsSupervisorProcess {
  const tokens = windowsArgs(action.arguments);
  if (/^conhost(?:\.exe)?$/i.test(path.win32.basename(action.executable)) && tokens[0] === "--headless" && tokens[1]) {
    let managed = false;
    if (binding.logFile && binding.supervisorGeneration) {
      const expected = windowsManagedAction(binding);
      managed = action.executable.toLowerCase() === expected.executable.toLowerCase()
        && action.arguments === expected.arguments;
    }
    return { executable: tokens[1], argv: tokens.slice(1), kind: managed ? "managed" : "legacy" };
  }
  if (/^(?:powershell|pwsh)(?:\.exe)?$/i.test(path.win32.basename(action.executable))) {
    return { executable: action.executable, argv: [action.executable, ...tokens], kind: "legacy" };
  }
  throw new Error("service has an unsupported supervisor action");
}

export function windowsArgs(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;
  let slashes = 0;
  for (const char of value) {
    if (char === "\\") { slashes++; continue; }
    if (char === '"') {
      current += "\\".repeat(Math.floor(slashes / 2));
      if (slashes % 2) current += '"'; else quoted = !quoted;
      slashes = 0;
      continue;
    }
    current += "\\".repeat(slashes);
    slashes = 0;
    if (/\s/u.test(char) && !quoted) { if (current) { result.push(current); current = ""; } }
    else current += char;
  }
  current += "\\".repeat(slashes);
  if (quoted) throw new Error("service has malformed quoted arguments");
  if (current) result.push(current);
  return result;
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}

function validateWrapper(action: ServiceAction, binding: ServiceBinding, sourceRoot: string): void {
  const tokens = windowsArgs(action.arguments);
  const direct = /^(?:powershell|pwsh)(?:\.exe)?$/i.test(path.win32.basename(action.executable));
  let wrapper: string | undefined;
  if (direct) {
    const file = tokens.findIndex(token => token.toLowerCase() === "-file");
    if (file < 0 || file !== tokens.length - 2) throw new Error("service has an unsupported PowerShell wrapper");
    wrapper = tokens[file + 1];
  } else if (/^conhost(?:\.exe)?$/i.test(path.win32.basename(action.executable))) {
    const expectedFlags = ["--headless"];
    if (tokens.length !== 12 || tokens[0] !== expectedFlags[0]
      || !/^(?:powershell|pwsh)(?:\.exe)?$/i.test(path.win32.basename(tokens[1]))
      || tokens[2].toLowerCase() !== "-noprofile" || tokens[3].toLowerCase() !== "-noninteractive"
      || tokens[4].toLowerCase() !== "-file" || tokens[6].toLowerCase() !== "-workspace"
      || tokens[8].toLowerCase() !== "-nodeexe" || tokens[10].toLowerCase() !== "-logfile") {
      throw new Error("service has an unsupported dedicated supervisor action");
    }
    wrapper = tokens[5];
    if (!sameWindowsPath(tokens[7], sourceRoot)) throw new Error("service supervisor workspace does not match the running source");
    if (!sameWindowsPath(tokens[9], binding.nodeExecutable)) throw new Error("service supervisor Node executable does not match");
    if (!path.win32.isAbsolute(tokens[11]) && !path.isAbsolute(tokens[11])) throw new Error("service supervisor log path is not absolute");
  }
  if (!wrapper || (!path.win32.isAbsolute(wrapper) && !path.isAbsolute(wrapper))) throw new Error("service has an unsupported PowerShell wrapper");
  const real = fs.realpathSync.native(wrapper);
  if (direct) {
    const root = fs.realpathSync.native(sourceRoot);
    if (!real.startsWith(`${root}${path.sep}`)) throw new Error("service wrapper is outside the verified source");
  }
  const text = fs.readFileSync(real, "utf8");
  if (/NODE_(?:OPTIONS|PATH)|--(?:loader|import)\b|Invoke-Expression|\biex\b/i.test(text)) {
    throw new Error("service wrapper changes execution-affecting Node settings");
  }
  if (/\b(?:Import-Module|using\s+module|Add-Type)\b/i.test(text)
    || /^[^\S\n\r\u2028\u2029]*[&.]\s+["']?(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.?[\\/])/im.test(text)) {
    throw new Error("service wrapper has an unsupported external wrapper chain");
  }
}

export function validateWindowsAdoption(
  summary: WindowsServiceSummary, binding: ServiceBinding, currentUser: string, priorSourceRoot = binding.source.root,
): void {
  validateWindowsEnvelope(summary, currentUser);
  validateWrapper(summary.actions[0], binding, priorSourceRoot);
}

function validateWindowsEnvelope(summary: WindowsServiceSummary, currentUser: string): void {
  if (summary.owner.toLowerCase() !== currentUser.toLowerCase()) throw new Error("service belongs to another user");
  if (summary.logonType?.toLowerCase() !== "interactivetoken") throw new Error("service is not an interactive current-user task");
  if (summary.runLevel && summary.runLevel.toLowerCase() !== "leastprivilege") throw new Error("service does not use least privilege");
  if (summary.enabled === false) throw new Error("service is disabled");
  if (summary.logonTriggers !== 1 || summary.triggerTypes.length !== 1
    || summary.triggerTypes[0].toLowerCase() !== "logontrigger") {
    throw new Error("service must have exactly one logon trigger and no other triggers");
  }
  if (summary.logonTriggerEnabled !== null && summary.logonTriggerEnabled !== true) {
    throw new Error("service logon trigger is disabled");
  }
  if (summary.logonTriggerUser !== null
    && (typeof summary.logonTriggerUser !== "string"
      || summary.logonTriggerUser.toLowerCase() !== currentUser.toLowerCase())) {
    throw new Error("service logon trigger belongs to another user");
  }
  if (summary.actionTypes.length !== 1 || summary.actionTypes[0].toLowerCase() !== "exec" || summary.actions.length !== 1) {
    throw new Error("service must have exactly one Exec action");
  }
  if (affectingEnvironment(summary.executionEnvironment)) throw new Error("service has execution-affecting environment variables");
}

export function validateWindowsManaged(summary: WindowsServiceSummary, binding: ServiceBinding, currentUser: string): void {
  validateWindowsEnvelope(summary, currentUser);
  const expected = windowsManagedAction(binding);
  const actual = summary.actions[0];
  if (!sameWindowsPath(actual.executable, expected.executable)
    || actual.arguments !== expected.arguments
    || !actual.workingDirectory || !expected.workingDirectory
    || !sameWindowsPath(actual.workingDirectory, expected.workingDirectory)) {
    throw new Error("Scheduled Task binding does not match the managed source");
  }
}
