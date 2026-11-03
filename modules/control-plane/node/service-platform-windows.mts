import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  legacyDaemonArguments, managedArguments, validateWindowsAdoption, validateWindowsManaged, windowsArgs,
  windowsLegacyLogFile, windowsManagedAction, windowsSupervisorProcess,
} from "./service-definitions.mts";
import { WINDOWS_PROCESS_PROVENANCE_SCRIPT, WINDOWS_STOP_SCRIPT } from "./service-platform-windows-process.mts";
import {
  waitForWindowsQuiescence, windowsProcessObservation, windowsProvenanceState, windowsStopObservation,
  type WindowsProvenance, type WindowsQuiescenceObservation,
} from "./service-windows-quiescence.mts";
import {
  FAILED_WRITE_SNAPSHOT, type FailedServiceWrite, type NativeServiceSnapshot, type ServiceAction, type ServiceAdapter, type ServiceBinding,
  type ServiceStopContext, type ServiceStopProof, type WindowsServiceSummary,
} from "./service-types.mts";

const PRELUDE = "$ErrorActionPreference='Stop';$payload=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:KHEREP_SERVICE_PAYLOAD))|ConvertFrom-Json;";
const STDIN_BOOTSTRAP = "$script=[Console]::In.ReadToEnd();&([ScriptBlock]::Create($script))";

export function powerShellInvocation(script: string, payload: unknown): {
  executable: string; args: string[]; env: NodeJS.ProcessEnv; input: string;
} {
  return { executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", STDIN_BOOTSTRAP], input: PRELUDE + script,
    env: { ...process.env, KHEREP_SERVICE_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString("base64") } };
}

export const decodePowerShellScript = (encoded: string): string => Buffer.from(encoded, "base64").toString("utf16le");
const xml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function normalizeTaskPath(value = "\\"): string {
  const normalized = value.replace(/\//g, "\\");
  if (!normalized.startsWith("\\") || /(?:^|\\)\.\.(?:\\|$)/.test(normalized)) throw new Error("invalid Scheduled Task path");
  return normalized === "\\" ? normalized : `${normalized.replace(/\\+$/, "")}\\`;
}

export function splitWindowsService(value: string, taskPath?: string): { serviceName: string; taskPath: string } {
  const normalized = value.replace(/\//g, "\\");
  if (taskPath && normalized.includes("\\")) throw new Error("Scheduled Task path was supplied twice");
  const parts = normalized.split("\\").filter(Boolean);
  const serviceName = parts.pop() ?? "";
  if (!/^[^\\/:*?"<>|]{1,200}$/.test(serviceName)) throw new Error("invalid Scheduled Task name");
  const embedded = parts.length ? `\\${parts.join("\\")}\\` : "\\";
  return { serviceName, taskPath: normalizeTaskPath(taskPath ?? embedded) };
}

const selector = (binding: ServiceBinding) => ({ serviceName: binding.serviceName, taskPath: normalizeTaskPath(binding.taskPath) });

export function windowsFreshXml(binding: ServiceBinding, user: string): Buffer {
  const action = windowsManagedAction(binding);
  return Buffer.from(`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>${xml(action.executable)}</Command><Arguments>${xml(action.arguments)}</Arguments><WorkingDirectory>${xml(action.workingDirectory ?? binding.workspace)}</WorkingDirectory></Exec></Actions>
</Task>`, "utf16le");
}

function invoke(script: string, payload: unknown, timeout = 30_000): string {
  const call = powerShellInvocation(script, payload);
  const result = spawnSync(call.executable, call.args, { input: call.input, encoding: "utf8", env: call.env, windowsHide: true, timeout,
    stdio: ["pipe", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error("Scheduled Task operation failed for the selected task");
  return result.stdout.trim();
}

export function windowsPrincipalSid(identity: string): string {
  const output = invoke(`try{$id=[string]$payload.identity;if($id-match'^S-\\d+(?:-\\d+)+$'){$sid=New-Object Security.Principal.SecurityIdentifier($id)}else{$sid=(New-Object Security.Principal.NTAccount($id)).Translate([Security.Principal.SecurityIdentifier])};[void]$sid.Translate([Security.Principal.NTAccount]);@{ok=$true;sid=$sid.Value}|ConvertTo-Json -Compress}catch{@{ok=$false}|ConvertTo-Json -Compress}`, { identity });
  const value = JSON.parse(output) as { ok?: boolean; sid?: string };
  if (value.ok !== true || !value.sid || !/^S-\d+(?:-\d+)+$/.test(value.sid)) {
    throw new Error("Scheduled Task principal identity is unresolved");
  }
  return value.sid;
}

export type WindowsTaskProvenance = WindowsProvenance;

export function windowsTaskProvenanceValid(value: WindowsTaskProvenance): boolean {
  return windowsProvenanceState(value) === "clear";
}

async function actionEvidence(adapter: WindowsServiceAdapter, binding: ServiceBinding, sourceRoot: string,
  allowLegacy: boolean): Promise<{ snapshot: NativeServiceSnapshot; action: ServiceAction;
    wrapper: ReturnType<typeof windowsSupervisorProcess> }> {
  const snapshot = await adapter.read(binding);
  const action = snapshot?.windows?.actions[0];
  if (!snapshot || !action) throw new Error("Scheduled Task action is unavailable");
  const wrapper = windowsSupervisorProcess(action, binding);
  if (wrapper.kind === "managed") await adapter.validateManaged(snapshot, binding);
  else {
    if (!allowLegacy) throw new Error("an unowned legacy supervisor cannot be stopped without daemon context");
    validateWindowsAdoption(snapshot.windows!, binding, await adapter.currentUser(), sourceRoot);
  }
  return { snapshot, action, wrapper };
}

async function processEvidence(adapter: WindowsServiceAdapter, binding: ServiceBinding, pid: number,
  startedAt: string, sourceRoot: string): Promise<WindowsQuiescenceObservation | null> {
  const evidence = await actionEvidence(adapter, binding, sourceRoot, true);
  const output = invoke(WINDOWS_PROCESS_PROVENANCE_SCRIPT,
    { pid, ...selector(binding), action: evidence.action, wrapper: evidence.wrapper });
  let process: Parameters<typeof windowsProcessObservation>[1];
  try { process = JSON.parse(output) as typeof process; }
  catch { throw new Error("Scheduled Task process provenance is incomplete"); }
  return windowsProcessObservation(evidence.snapshot, process, binding, pid, startedAt, sourceRoot);
}

async function stopEvidence(adapter: WindowsServiceAdapter, binding: ServiceBinding, expected: ServiceStopContext,
): Promise<WindowsQuiescenceObservation> {
  const sourceRoot = expected.sourceRoot ?? binding.source.root;
  const evidence = await actionEvidence(adapter, binding, sourceRoot, true);
  const daemon = { executable: binding.nodeExecutable, argv: [binding.nodeExecutable,
    ...(evidence.wrapper.kind === "managed" ? managedArguments(binding) : legacyDaemonArguments(binding, sourceRoot))] };
  const output = invoke(WINDOWS_STOP_SCRIPT, { ...selector(binding), action: evidence.action, wrapper: evidence.wrapper,
    checkOnly: true, daemon,
    expected: { pid: expected.pid, startedAt: expected.startedAt } });
  return windowsStopObservation(evidence.snapshot, output);
}

export const WINDOWS_READ_SCRIPT = `Import-Module ScheduledTasks;$matches=@(Get-ScheduledTask -TaskPath $payload.taskPath -ErrorAction Stop|Where-Object{$_.TaskName -ceq $payload.serviceName});if($matches.Count -eq 0){'{"missing":true}';exit};if($matches.Count -ne 1){throw'expected one selected task'};$t=$matches[0];$raw=Export-ScheduledTask -TaskName $payload.serviceName -TaskPath $payload.taskPath;[xml]$x=$raw;$n=New-Object Xml.XmlNamespaceManager($x.NameTable);$n.AddNamespace('t',$x.DocumentElement.NamespaceURI);$p=$x.SelectSingleNode('//t:Principals/t:Principal',$n);try{$id=[string]$p.UserId;if($id-match'^S-\\d+(?:-\\d+)+$'){$sid=New-Object Security.Principal.SecurityIdentifier($id)}else{$sid=(New-Object Security.Principal.NTAccount($id)).Translate([Security.Principal.SecurityIdentifier])};[void]$sid.Translate([Security.Principal.NTAccount])}catch{throw'task principal identity is unresolved'};$trigger=$x.SelectSingleNode('//t:Triggers/t:LogonTrigger',$n);$triggerEnabled=if($trigger-and$trigger.Enabled){[bool]::Parse([string]$trigger.Enabled)}else{$null};$triggerUser=$null;if($trigger-and$trigger.UserId){try{$tid=[string]$trigger.UserId;if($tid-match'^S-\\d+(?:-\\d+)+$'){$tsid=New-Object Security.Principal.SecurityIdentifier($tid)}else{$tsid=(New-Object Security.Principal.NTAccount($tid)).Translate([Security.Principal.SecurityIdentifier])};[void]$tsid.Translate([Security.Principal.NTAccount]);$triggerUser=$tsid.Value}catch{throw'task trigger identity is unresolved'}};$triggerTypes=@($x.SelectNodes('//t:Triggers/*',$n)|ForEach-Object{$_.LocalName});$types=@($x.SelectNodes('//t:Actions/*',$n)|ForEach-Object{$_.LocalName});$acts=@($x.SelectNodes('//t:Actions/t:Exec',$n)|ForEach-Object{@{executable=$_.Command;arguments=$_.Arguments;workingDirectory=$_.WorkingDirectory}});$env=@{};foreach($k in @('NODE_OPTIONS','NODE_PATH')){foreach($scope in @('User','Machine')){$v=[Environment]::GetEnvironmentVariable($k,$scope);if($v){$env[$k]=$v}}};$folder=if($payload.taskPath -eq '\\'){'\\'}else{$payload.taskPath.TrimEnd('\\')};$com=New-Object -ComObject 'Schedule.Service';$com.Connect();$registered=$com.GetFolder($folder).GetTask($payload.serviceName);$sddl=$registered.GetSecurityDescriptor(7);$s=@{owner=$sid.Value;logonType=if($p.LogonType){[string]$p.LogonType}else{$null};runLevel=if($p.RunLevel){[string]$p.RunLevel}else{$null};enabled=if($x.Task.Settings.Enabled){[bool]::Parse([string]$x.Task.Settings.Enabled)}else{$null};logonTriggers=@($x.SelectNodes('//t:Triggers/t:LogonTrigger',$n)).Count;triggerTypes=$triggerTypes;logonTriggerEnabled=$triggerEnabled;logonTriggerUser=$triggerUser;actionTypes=$types;actions=$acts;executionEnvironment=$env;securityDescriptor='retained'};$sec=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sddl));@{missing=$false;definition=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($raw));security=$sec;running=if([string]$t.State -eq 'Running'){$true}elseif([string]$t.State -eq 'Ready'){$false}else{'unknown'};summary=$s}|ConvertTo-Json -Compress -Depth 8`;
const MUTATE = `$x=New-Object Xml.XmlDocument;$x.PreserveWhitespace=$true;$x.LoadXml([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($payload.definition)));$n=New-Object Xml.XmlNamespaceManager($x.NameTable);$n.AddNamespace('t',$x.DocumentElement.NamespaceURI);$a=@($x.SelectNodes('//t:Actions/*',$n));if($a.Count-ne1 -or $a[0].LocalName-ne'Exec'){throw'expected exactly one Exec action'};$a[0].Command=$payload.command;$a[0].Arguments=$payload.arguments;$a[0].WorkingDirectory=$payload.workingDirectory;[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($x.OuterXml))`;
export const WINDOWS_WRITE_SCRIPT = "Import-Module ScheduledTasks;$xml=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($payload.definition));Register-ScheduledTask -TaskName $payload.serviceName -TaskPath $payload.taskPath -Xml $xml -Force|Out-Null;$ok=$true;$actual=$null;if($payload.security){$folder=if($payload.taskPath-eq'\\'){'\\'}else{$payload.taskPath.TrimEnd('\\')};$com=New-Object -ComObject 'Schedule.Service';$com.Connect();$registered=$com.GetFolder($folder).GetTask($payload.serviceName);$requested=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload.security));$actual=$registered.GetSecurityDescriptor(7);if($actual -cne $requested){try{$registered.SetSecurityDescriptor($requested,16)}catch{};$actual=$registered.GetSecurityDescriptor(7);$ok=($actual -ceq $requested)}};if($ok){'{\"ok\":true}'}else{$stored=Export-ScheduledTask -TaskName $payload.serviceName -TaskPath $payload.taskPath;$task=Get-ScheduledTask -TaskName $payload.serviceName -TaskPath $payload.taskPath;@{ok=$false;definition=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($stored));security=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($actual));running=([string]$task.State -eq'Running')}|ConvertTo-Json -Compress}";

export class WindowsServiceAdapter implements ServiceAdapter {
  readonly platform = "win32" as const;
  #user?: Promise<string>;
  #stopInvoke: typeof invoke;
  #stopped?: string;
  constructor(stopInvoke: typeof invoke = invoke) { this.#stopInvoke = stopInvoke; }
  #proofKey(binding: ServiceBinding, expected: ServiceStopContext): string {
    return JSON.stringify([binding.platform, binding.serviceName, binding.taskPath, binding.workspace, binding.configRoot,
      binding.nodeExecutable, binding.logFile, binding.source.root, binding.source.commit, binding.source.digest, binding.source.kind, binding.source.verified,
      binding.supervisorGeneration, expected.pid, expected.startedAt, expected.sourceRoot]);
  }
  async proveStopped(binding: ServiceBinding, expected: ServiceStopContext, _proof: ServiceStopProof): Promise<void> {
    const proof = this.#stopped;
    this.#stopped = undefined;
    if (proof !== this.#proofKey(binding, expected)) throw Object.assign(new Error("Windows stop proof is missing or belongs to another instance"),
      { code: "STOP_IDENTITY_MISMATCH", familyUnproven: true });
  }
  async currentUser(): Promise<string> {
    this.#user ??= Promise.resolve().then(() => {
      const sid = invoke("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value", {});
      if (!/^S-\d+(?:-\d+)+$/.test(sid)) throw new Error("Scheduled Task current-user identity is unresolved");
      return sid;
    });
    return this.#user;
  }
  async read(binding: ServiceBinding): Promise<NativeServiceSnapshot | null> {
    const value = JSON.parse(invoke(WINDOWS_READ_SCRIPT, selector(binding))) as { missing: boolean; definition?: string; security?: string; running?: boolean | "unknown"; summary?: WindowsServiceSummary };
    if (value.missing) return null;
    if (!value.definition || !value.security || !value.summary) throw new Error("Scheduled Task readback is incomplete");
    return { definition: Buffer.from(value.definition, "base64"), security: Buffer.from(value.security, "base64"),
      running: value.running === true ? true : value.running === false ? false : "unknown", windows: value.summary };
  }
  async fresh(binding: ServiceBinding): Promise<Buffer> {
    const environment = JSON.parse(invoke("$v=@{};foreach($k in @('NODE_OPTIONS','NODE_PATH')){foreach($scope in @('User','Machine')){$x=[Environment]::GetEnvironmentVariable($k,$scope);if($x){$v[$k]=$x}}};$v|ConvertTo-Json -Compress", {})) as Record<string, string>;
    if (Object.keys(environment).length) throw new Error("host has execution-affecting Node environment variables");
    return windowsFreshXml(binding, await this.currentUser());
  }
  async freshSecurity(_binding: ServiceBinding): Promise<Buffer> { return Buffer.alloc(0); }
  async adoptionNode(snapshot: NativeServiceSnapshot, pid?: number): Promise<string> {
    const action = snapshot.windows?.actions[0];
    if (action && /^conhost(?:\.exe)?$/i.test(path.win32.basename(action.executable))) {
      const args = windowsArgs(action.arguments);
      const index = args.findIndex(value => value.toLowerCase() === "-nodeexe");
      if (index >= 0 && args[index + 1] && (path.win32.isAbsolute(args[index + 1]) || path.isAbsolute(args[index + 1]))) return args[index + 1];
    }
    if (pid) {
      const output = invoke(`$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$payload.pid);if($null -eq $p){'{"missing":true}'}else{@{missing=$false;executable=$p.ExecutablePath}|ConvertTo-Json -Compress}`, { pid });
      const process = JSON.parse(output) as { missing: boolean; executable?: string };
      if (!process.missing && process.executable && path.win32.isAbsolute(process.executable)) return process.executable;
    }
    throw new Error("Scheduled Task Node executable is unavailable");
  }
  async adoptionSourceRoot(snapshot: NativeServiceSnapshot): Promise<string> {
    const action = snapshot.windows?.actions[0];
    if (!action || !/^conhost(?:\.exe)?$/i.test(path.win32.basename(action.executable))) {
      throw new Error("Scheduled Task legacy source root is unavailable");
    }
    const args = windowsArgs(action.arguments);
    const index = args.findIndex(value => value.toLowerCase() === "-workspace");
    const root = index >= 0 ? args[index + 1] : undefined;
    if (!root || (!path.win32.isAbsolute(root) && !path.isAbsolute(root))) {
      throw new Error("Scheduled Task legacy source root is unavailable");
    }
    return root;
  }
  async adoptionLogFile(snapshot: NativeServiceSnapshot): Promise<string> {
    const action = snapshot.windows?.actions[0];
    if (!action) throw new Error("Scheduled Task legacy log path is unavailable");
    return windowsLegacyLogFile(action);
  }
  async adopted(snapshot: NativeServiceSnapshot, binding: ServiceBinding, priorSourceRoot: string): Promise<Buffer> {
    if (!snapshot.windows) throw new Error("Scheduled Task summary is missing");
    validateWindowsAdoption(snapshot.windows, binding, await this.currentUser(), priorSourceRoot);
    const action = windowsManagedAction(binding);
    const result = invoke(MUTATE, { definition: snapshot.definition.toString("base64"), command: action.executable,
      arguments: action.arguments, workingDirectory: action.workingDirectory });
    return Buffer.from(result, "base64");
  }
  async retargeted(snapshot: NativeServiceSnapshot, binding: ServiceBinding): Promise<Buffer> {
    // Persisted backups retain definition bytes, not live summaries; callers validate task authority separately.
    const action = windowsManagedAction(binding);
    const result = invoke(MUTATE, { definition: snapshot.definition.toString("base64"), command: action.executable,
      arguments: action.arguments, workingDirectory: action.workingDirectory });
    return Buffer.from(result, "base64");
  }
  async validateManaged(snapshot: NativeServiceSnapshot, binding: ServiceBinding): Promise<void> {
    if (!snapshot.windows) throw new Error("Scheduled Task summary is missing");
    validateWindowsManaged(snapshot.windows, binding, await this.currentUser());
  }
  async processOwned(pid: number, binding: ServiceBinding, startedAt: string, sourceRoot = binding.source.root): Promise<boolean> {
    const first = await processEvidence(this, binding, pid, startedAt, sourceRoot);
    if (!first) return false;
    let useFirst = true;
    await waitForWindowsQuiescence(async () => {
      if (useFirst) { useFirst = false; return first; }
      const current = await processEvidence(this, binding, pid, startedAt, sourceRoot);
      if (!current) throw new Error("Windows process ownership changed while waiting");
      return current;
    });
    return true;
  }
  async preflightStop(binding: ServiceBinding, expected: ServiceStopContext | undefined): Promise<void> {
    await this.#stop(binding, expected, true);
  }
  async write(binding: ServiceBinding, definition: Buffer, security: Buffer): Promise<void> {
    const output = invoke(WINDOWS_WRITE_SCRIPT,
      { ...selector(binding), definition: definition.toString("base64"), security: security.toString("base64") });
    let value: { ok?: boolean; definition?: string; security?: string; running?: boolean };
    try { value = JSON.parse(output) as typeof value; }
    catch { throw new Error("Scheduled Task write readback is incomplete"); }
    if (value.ok === true) return;
    if (value.ok !== false || !value.definition || !value.security || typeof value.running !== "boolean") {
      throw new Error("Scheduled Task write readback is incomplete");
    }
    const candidate: NativeServiceSnapshot = { definition: Buffer.from(value.definition, "base64"),
      security: Buffer.from(value.security, "base64"), running: value.running };
    if (!candidate.definition.length || !candidate.security.length) throw new Error("Scheduled Task write readback is incomplete");
    const error = new Error("Scheduled Task security readback differs") as FailedServiceWrite;
    Object.defineProperty(error, FAILED_WRITE_SNAPSHOT, { value: candidate });
    throw error;
  }
  async remove(binding: ServiceBinding): Promise<void> { invoke("Import-Module ScheduledTasks;Unregister-ScheduledTask -TaskName $payload.serviceName -TaskPath $payload.taskPath -Confirm:$false", selector(binding)); }
  async stop(binding: ServiceBinding, expected: ServiceStopContext | undefined): Promise<void> {
    this.#stopped = undefined;
    try { await this.#stop(binding, expected, false); }
    catch (error) { throw Object.assign(error instanceof Error ? error : new Error("Windows stop proof is unavailable"),
      { code: "STOP_UNKNOWN_DESCENDANTS", familyUnproven: true }); }
  }
  async #stop(binding: ServiceBinding, expected: ServiceStopContext | undefined, checkOnly: boolean): Promise<void> {
    if (checkOnly && expected) {
      await waitForWindowsQuiescence(() => stopEvidence(this, binding, expected));
      return;
    }
    const sourceRoot = expected?.sourceRoot ?? binding.source.root;
    const evidence = await actionEvidence(this, binding, sourceRoot, expected !== undefined);
    const daemon = { executable: binding.nodeExecutable, argv: [binding.nodeExecutable,
      ...(evidence.wrapper.kind === "managed" ? managedArguments(binding) : legacyDaemonArguments(binding, sourceRoot))] };
    const output = this.#stopInvoke(WINDOWS_STOP_SCRIPT, { ...selector(binding), action: evidence.action, wrapper: evidence.wrapper, checkOnly, daemon,
      definition: evidence.snapshot.definition.toString("base64"), security: evidence.snapshot.security.toString("base64"),
      expected: expected ? { pid: expected.pid, startedAt: expected.startedAt } : null }, checkOnly ? 30_000 : 65_000);
    if (!checkOnly && expected) {
      let proof: { version?: number; stopped?: boolean; daemonExited?: boolean; supervisorExited?: boolean;
        familyAbsent?: boolean; expected?: ServiceStopContext };
      try { proof = JSON.parse(output) as typeof proof; } catch { throw new Error("Windows stop proof is malformed"); }
      if (proof?.version !== 1 || proof.stopped !== true || proof.daemonExited !== true || proof.supervisorExited !== true
        || proof.familyAbsent !== true || proof.expected?.pid !== expected.pid || proof.expected.startedAt !== expected.startedAt) {
        throw new Error("Windows stop proof is incomplete");
      }
      this.#stopped = this.#proofKey(binding, expected);
    }
  }
  async start(binding: ServiceBinding): Promise<void> { invoke("Import-Module ScheduledTasks;Start-ScheduledTask -TaskName $payload.serviceName -TaskPath $payload.taskPath", selector(binding)); }
}
