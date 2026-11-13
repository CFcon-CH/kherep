import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  adoptMacDefinition, daemonArgumentsMatch, freshMacDefinition, legacyDaemonArguments, managedArguments, quoteWindowsArg,
  retargetMacDefinition, validateWindowsAdoption, validateWindowsManaged, windowsLegacyLogFile, windowsManagedAction,
  windowsSupervisorProcess,
} from "./service-definitions.mts";
import { decodeSupervisorBinding } from "./service-supervisor-data.mts";
import type { ServiceBinding, WindowsServiceSummary } from "./service-types.mts";

const binding = (root: string): ServiceBinding => ({
  serviceName: "com.example.kherep-node", platform: "darwin", workspace: path.join(root, "work space"),
  configRoot: path.join(root, "config"), nodeExecutable: path.join(root, "Node Runtime", "node.exe"),
  source: { root: path.join(root, "source pin"), commit: "a".repeat(40), digest: "b".repeat(64), kind: "pin", verified: true },
  logFile: path.join(root, "service logs", "daemon.log"),
  supervisorGeneration: "22222222-2222-4222-8222-222222222222",
});

test("managed service definitions keep executable arguments tokenized and escape Windows arguments", () => {
  const b = binding(path.resolve("synthetic root"));
  const args = managedArguments(b);
  assert.deepEqual(args, [path.join(b.source.root, "modules", "control-plane", "node", "service-runner.mts"),
    "--config-dir", b.configRoot, "--service-name", b.serviceName, "--workspace", b.workspace]);
  assert.deepEqual(freshMacDefinition(b).ProgramArguments, [b.nodeExecutable, ...args]);
  assert.equal(quoteWindowsArg("plain"), "plain");
  assert.equal(quoteWindowsArg("a b"), '"a b"');
  assert.equal(quoteWindowsArg('a\\"b'), '"a\\\\\\"b"');
  const action = windowsManagedAction({ ...b, platform: "win32", taskPath: "\\" });
  assert.equal(path.win32.basename(action.executable).toLowerCase(), "conhost.exe");
  assert.equal(path.win32.isAbsolute(action.executable), true);
  const actionArgs = action.arguments.split(" ");
  assert.equal(actionArgs[0], "--headless");
  assert.equal(action.arguments.includes("service-supervisor.mts"), true);
  const encoded = actionArgs.at(-1)!;
  assert.deepEqual(decodeSupervisorBinding(encoded), { ...b, platform: "win32", taskPath: "\\" });
  assert.equal(action.arguments.includes("--config-dir"), false, "the native action carries binding data, not a child command");
  assert.equal(daemonArgumentsMatch(legacyDaemonArguments(b), b), true);
  assert.equal(daemonArgumentsMatch([...legacyDaemonArguments(b), "--foreign"], b), false);
});

test("macOS adoption preserves benign settings and refuses execution-affecting environment", () => {
  const b = binding(path.resolve("synthetic"));
  const existing = {
    Label: b.serviceName, ProgramArguments: [b.nodeExecutable, path.join(b.source.root, "modules", "control-plane", "node", "cli.mts"), "daemon"],
    WorkingDirectory: "/preserved/work", StandardErrorPath: "/preserved/error.log", KeepAlive: { SuccessfulExit: false },
    EnvironmentVariables: { LANG: "en_US.UTF-8" },
  };
  const adopted = adoptMacDefinition(existing, b, process.getuid?.() ?? 1000);
  assert.deepEqual(adopted.ProgramArguments, [b.nodeExecutable, ...managedArguments(b)]);
  assert.deepEqual({ ...adopted, ProgramArguments: existing.ProgramArguments }, existing);
  assert.throws(() => adoptMacDefinition({ ...existing, EnvironmentVariables: { NODE_OPTIONS: "--import=/tmp/foreign.mjs" } }, b, 1000),
    /execution-affecting environment/);
  assert.throws(() => adoptMacDefinition({ ...existing, ProgramArguments: ["/bin/sh", "-c", "node daemon"] }, b, 1000),
    /unsupported program arguments/);
  assert.throws(() => adoptMacDefinition({ ...existing, Program: "/foreign/node" }, b, 1000), /Program overrides/);
  assert.throws(() => adoptMacDefinition({ ...existing, EnableGlobbing: true }, b, 1000), /globbing/);
});

test("macOS managed retarget changes only the product action", () => {
  const root = path.resolve("synthetic");
  const oldBinding = binding(root);
  const nextBinding = { ...oldBinding, source: { ...oldBinding.source, root: path.join(root, "next pin"), commit: "c".repeat(40) } };
  const existing = {
    Label: oldBinding.serviceName, ProgramArguments: [oldBinding.nodeExecutable, ...managedArguments(oldBinding)],
    WorkingDirectory: "/preserved/work", StandardErrorPath: "/preserved/error.log", KeepAlive: { SuccessfulExit: false },
    EnvironmentVariables: { LANG: "en_US.UTF-8" }, ProcessType: "Background",
  };
  const retargeted = retargetMacDefinition(existing, nextBinding);
  assert.deepEqual(retargeted.ProgramArguments, [nextBinding.nodeExecutable, ...managedArguments(nextBinding)]);
  assert.deepEqual({ ...retargeted, ProgramArguments: existing.ProgramArguments }, { ...existing, ExitTimeOut: 60 });
});

// Issue #420: launchd waits ExitTimeOut seconds between SIGTERM and SIGKILL
// (launchd.plist(5)); 60 covers the 45 s probe bound plus the 10 s listing.
test("macOS definitions give a stopping daemon 60 seconds before launchd sends SIGKILL", () => {
  const b = binding(path.resolve("synthetic"));
  assert.equal(freshMacDefinition(b).ExitTimeOut, 60, "fresh");
  const managed = { Label: b.serviceName, ProgramArguments: [b.nodeExecutable, ...managedArguments(b)] };
  assert.equal(retargetMacDefinition(managed, b).ExitTimeOut, 60, "added on retarget when absent");
  assert.equal(retargetMacDefinition({ ...managed, ExitTimeOut: 120 }, b).ExitTimeOut, 120, "an operator's value stays");
  const legacy = { Label: b.serviceName,
    ProgramArguments: [b.nodeExecutable, path.join(b.source.root, "modules", "control-plane", "node", "cli.mts"), "daemon"] };
  assert.equal("ExitTimeOut" in adoptMacDefinition(legacy, b, 1000), false, "adoption keeps the adopted plist's keys");
});

test("Windows adoption accepts native defaults and one bounded legacy wrapper, then rejects hostile execution", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-service-definition-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const b = { ...binding(root), platform: "win32" as const };
  const wrapper = path.join(b.source.root, "modules", "control-plane", "node", "legacy-supervisor.ps1");
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(wrapper, "& $node $cli daemon\n");
  const summary: WindowsServiceSummary = {
    owner: "EXAMPLE\\operator", logonType: "InteractiveToken", runLevel: null, enabled: null,
    logonTriggers: 1, triggerTypes: ["LogonTrigger"], logonTriggerEnabled: null, logonTriggerUser: null,
    actionTypes: ["Exec"], actions: [{ executable: "powershell.exe", arguments: `-NoProfile -NonInteractive -File \"${wrapper}\"` }],
    executionEnvironment: {}, securityDescriptor: "synthetic-sddl",
  };
  assert.doesNotThrow(() => validateWindowsAdoption(summary, b, "example\\OPERATOR"));
  assert.throws(() => validateWindowsAdoption({ ...summary, runLevel: "HighestAvailable" }, b, summary.owner), /least privilege/);
  assert.throws(() => validateWindowsAdoption({ ...summary, actions: [{ executable: "powershell.exe", arguments: "-Command node daemon" }] }, b, summary.owner),
    /unsupported PowerShell wrapper/);
  assert.throws(() => validateWindowsAdoption({ ...summary, actionTypes: ["Exec", "ComHandler"] }, b, summary.owner),
    /exactly one Exec action/);
  assert.throws(() => validateWindowsAdoption({ ...summary, executionEnvironment: { NODE_PATH: "C:\\foreign" } }, b, summary.owner),
    /execution-affecting environment/);
  assert.throws(() => validateWindowsAdoption({ ...summary, logonTriggerEnabled: false }, b, summary.owner), /logon trigger is disabled/);
  assert.throws(() => validateWindowsAdoption({ ...summary, logonTriggerUser: "S-1-5-21-1-2-3-2002" }, b, summary.owner),
    /another user/);

  const external = path.join(root, "dedicated supervisor.ps1");
  const log = path.join(root, "logs", "daemon.log");
  fs.writeFileSync(external, "& $NodeExe $Cli daemon\n");
  const conhost = { ...summary, actions: [{ executable: "C:\\Windows\\System32\\conhost.exe", arguments:
    `--headless pwsh.exe -NoProfile -NonInteractive -File "${external}" -Workspace "${b.source.root}" -NodeExe "${b.nodeExecutable}" -LogFile "${log}"` }] };
  assert.doesNotThrow(() => validateWindowsAdoption(conhost, b, summary.owner));
  assert.equal(windowsLegacyLogFile(conhost.actions[0]), log);
  assert.equal(windowsSupervisorProcess(conhost.actions[0], { ...b, supervisorGeneration: undefined }).kind, "legacy",
    "legacy stop provenance must not fabricate a managed supervisor generation");
  assert.throws(() => validateWindowsAdoption({ ...conhost, actions: [{ ...conhost.actions[0], arguments:
    conhost.actions[0].arguments.replace(b.source.root, path.join(root, "foreign")) }] }, b, summary.owner), /workspace/);
  fs.writeFileSync(external, "$env:NODE_OPTIONS='--import=C:\\foreign.mjs'\n");
  assert.throws(() => validateWindowsAdoption(conhost, b, summary.owner), /execution-affecting Node/);
  fs.writeFileSync(external, "Import-Module C:\\foreign\\module.psm1\n");
  assert.throws(() => validateWindowsAdoption(conhost, b, summary.owner), /external wrapper chain/);
  fs.writeFileSync(external, "& C:\\foreign\\next.ps1\n");
  assert.throws(() => validateWindowsAdoption(conhost, b, summary.owner), /external wrapper chain/);
  // Issue #906: a chain starts a line after horizontal blanks; & or . inside a line is no chain.
  for (const chain of ["\n\n  \t. .\\next.ps1\n", "$x = 1\r\n& '\\\\host\\share\\a.ps1'\r\n"]) {
    fs.writeFileSync(external, chain);
    assert.throws(() => validateWindowsAdoption(conhost, b, summary.owner), /external wrapper chain/, chain);
  }
  for (const text of ["$a = $b & C:\\x\n", "Write-Host .\n", "\n".repeat(50_000)]) {
    fs.writeFileSync(external, text);
    const started = performance.now();
    assert.doesNotThrow(() => validateWindowsAdoption(conhost, b, summary.owner), text.slice(0, 20));
    assert.ok(performance.now() - started < 200, "linear on a run of line ends");
  }
});

test("Windows managed validation requires an enabled task with one logon trigger", () => {
  const b = { ...binding(path.resolve("synthetic")), platform: "win32" as const, taskPath: "\\" };
  const action = windowsManagedAction(b);
  const summary: WindowsServiceSummary = {
    owner: "S-1-5-21-1-2-3-1001", logonType: "InteractiveToken", runLevel: "LeastPrivilege", enabled: true,
    logonTriggers: 1, triggerTypes: ["LogonTrigger"], logonTriggerEnabled: null, logonTriggerUser: null,
    actionTypes: ["Exec"], actions: [action], executionEnvironment: {}, securityDescriptor: "retained",
  };
  assert.doesNotThrow(() => validateWindowsManaged(summary, b, summary.owner));
  assert.throws(() => validateWindowsManaged({ ...summary, enabled: false }, b, summary.owner), /disabled/);
  assert.throws(() => validateWindowsManaged({ ...summary, logonTriggers: 0 }, b, summary.owner), /exactly one logon trigger/);
  assert.throws(() => validateWindowsManaged({ ...summary, logonTriggers: 2 }, b, summary.owner), /exactly one logon trigger/);
  assert.throws(() => validateWindowsManaged({ ...summary, triggerTypes: ["LogonTrigger", "RegistrationTrigger"] }, b, summary.owner),
    /no other triggers/);
  assert.throws(() => validateWindowsManaged({ ...summary, triggerTypes: ["LogonTrigger", "TimeTrigger"] }, b, summary.owner),
    /no other triggers/);
  assert.doesNotThrow(() => validateWindowsManaged({ ...summary, logonTriggerUser: summary.owner }, b, summary.owner));
  assert.throws(() => validateWindowsManaged({ ...summary, logonTriggerEnabled: false }, b, summary.owner), /logon trigger is disabled/);
  assert.throws(() => validateWindowsManaged({ ...summary, logonTriggerUser: "S-1-5-21-1-2-3-2002" }, b, summary.owner),
    /another user/);
});
