import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { managedArguments, quoteWindowsArg, windowsManagedAction } from "./service-definitions.mts";
import { normalizeTaskPath, splitWindowsService, windowsFreshXml, WindowsServiceAdapter } from "./service-platform-windows.mts";
import { supervisorArguments } from "./service-supervisor-data.mts";
import { setup } from "./service-transaction-fixture.mts";
import type { NativeServiceSnapshot, ServiceAction, WindowsServiceSummary } from "./service-types.mts";

const owner = "S-1-5-21-1-2-3-1001";

function snapshot(action: ServiceAction): NativeServiceSnapshot & { windows: WindowsServiceSummary } {
  return { definition: Buffer.from("synthetic XML"), security: Buffer.from("synthetic descriptor"), running: false,
    windows: { owner, logonType: "InteractiveToken", runLevel: "LeastPrivilege", enabled: true, logonTriggers: 1,
      triggerTypes: ["LogonTrigger"], logonTriggerEnabled: true, logonTriggerUser: owner, actionTypes: ["Exec"],
      actions: [action], executionEnvironment: {}, securityDescriptor: "retained" } };
}

test("Windows selectors refuse invalid task names and paths before native invocation", () => {
  assert.deepEqual(splitWindowsService("Node"), { serviceName: "Node", taskPath: "\\" });
  assert.deepEqual(splitWindowsService("/Folder/Node"), { serviceName: "Node", taskPath: "\\Folder\\" });
  assert.equal(normalizeTaskPath("/Folder"), "\\Folder\\");
  for (const name of ["/", "Node?", "x".repeat(201)]) assert.throws(() => splitWindowsService(name), /invalid Scheduled Task name/);
  for (const taskPath of ["relative", "/Folder/../Other"]) {
    assert.throws(() => splitWindowsService("Node", taskPath), /invalid Scheduled Task path/);
  }
});

test("legacy adoption extracts absolute quoted paths from a conhost action", async t => {
  const { old } = setup(t);
  const adapter = new WindowsServiceAdapter();
  const legacy = { executable: "C:\\Windows\\System32\\CONHOST.EXE", workingDirectory: old.workspace };
  const node = "C:\\Program Files\\Node\\node.exe", workspace = "C:\\Legacy Source", log = "C:\\Legacy Logs\\daemon.log";
  const action = (args: string[]) => snapshot({ ...legacy, arguments: args.map(quoteWindowsArg).join(" ") });
  const prior = action(["-NODEEXE", node, "-WORKSPACE", workspace, "-LOGFILE", log]);
  assert.equal(await adapter.adoptionNode(prior), node);
  assert.equal(await adapter.adoptionSourceRoot(prior), workspace);
  assert.equal(await adapter.adoptionLogFile(prior), log);

  for (const unusable of [action([]), action(["-NodeExe", "node.exe", "-Workspace", "relative", "-LogFile", "daemon.log"])]) {
    await assert.rejects(adapter.adoptionNode(unusable), /Node executable is unavailable/);
    await assert.rejects(adapter.adoptionSourceRoot(unusable), /legacy source root is unavailable/);
    await assert.rejects(adapter.adoptionLogFile(unusable), /legacy supervisor log path is unavailable/);
  }
  const noSummary = { ...prior, windows: undefined };
  await assert.rejects(adapter.adoptionNode(noSummary), /Node executable is unavailable/);
  await assert.rejects(adapter.adoptionSourceRoot(noSummary), /legacy source root is unavailable/);
  await assert.rejects(adapter.adoptionLogFile(noSummary), /legacy log path is unavailable/);
  await assert.rejects(adapter.adopted(noSummary, old, workspace), /summary is missing/);
  await assert.rejects(adapter.validateManaged(noSummary, old), /summary is missing/);
});

test("a legacy Windows stop requires daemon context and uses the prior verified source", async t => {
  const { old, candidate } = setup(t);
  const wrapper = path.join(old.source.root, "legacy wrapper.ps1");
  fs.writeFileSync(wrapper, "# synthetic legacy wrapper\n");
  const action = { executable: "powershell.exe", arguments: `-File ${quoteWindowsArg(wrapper)}` };
  const prior = snapshot(action);
  const expected = { pid: 41, startedAt: "2026-10-14T10:00:00.000Z", sourceRoot: old.source.root };
  const calls: unknown[] = [];
  const adapter = new WindowsServiceAdapter((call, _script, payload, timeout) => {
    calls.push({ call, payload, timeout });
    return JSON.stringify({ version: 1, stopped: true, daemonExited: true, supervisorExited: true,
      familyAbsent: true, expected: { pid: expected.pid, startedAt: expected.startedAt } });
  });
  adapter.read = async () => prior;
  adapter.currentUser = async () => owner;

  await assert.rejects(adapter.stop(candidate, undefined), { message: /unowned legacy supervisor/, notIssued: true });
  assert.deepEqual(calls, []);
  await adapter.stop(candidate, expected);
  assert.deepEqual(calls, [{ call: "task-stop", timeout: 65_000, payload: {
    serviceName: candidate.serviceName, taskPath: candidate.taskPath, action,
    wrapper: { executable: "powershell.exe", argv: ["powershell.exe", "-File", wrapper], kind: "legacy" },
    checkOnly: false,
    daemon: { executable: candidate.nodeExecutable,
      argv: [candidate.nodeExecutable, path.join(old.source.root, "modules", "control-plane", "node", "cli.mts"), "daemon"] },
    definition: prior.definition.toString("base64"), security: prior.security.toString("base64"),
    expected: { pid: expected.pid, startedAt: expected.startedAt },
  } }]);
});

test("Windows preflight without a daemon checks the managed action without issuing a stop", async t => {
  const { old } = setup(t);
  const prior = snapshot(windowsManagedAction(old));
  const calls: unknown[] = [];
  const adapter = new WindowsServiceAdapter((call, _script, payload, timeout) => {
    calls.push({ call, payload, timeout });
    return "";
  });
  adapter.read = async () => prior;
  adapter.currentUser = async () => owner;

  await adapter.preflightStop(old, undefined);
  assert.deepEqual(calls, [{ call: "task-stop-check", timeout: 30_000, payload: {
    serviceName: old.serviceName, taskPath: old.taskPath, action: prior.windows.actions[0],
    wrapper: { executable: old.nodeExecutable, argv: [old.nodeExecutable, ...supervisorArguments(old)], kind: "managed" },
    checkOnly: true, daemon: { executable: old.nodeExecutable, argv: [old.nodeExecutable, ...managedArguments(old)] },
    definition: prior.definition.toString("base64"), security: prior.security.toString("base64"), expected: null,
  } }]);
});

test("Windows stop distinguishes failed action lookup from invalid post-stop proof", async t => {
  const { old } = setup(t);
  const prior = snapshot(windowsManagedAction(old));
  const expected = { pid: 41, startedAt: "2026-10-14T10:00:00.000Z" };
  let issued = 0;
  const adapter = new WindowsServiceAdapter(() => { issued++; return "invalid JSON"; });
  adapter.read = async () => null;
  await assert.rejects(adapter.preflightStop(old, expected), /action is unavailable/);
  await assert.rejects(adapter.processOwned(expected.pid, old, expected.startedAt), /action is unavailable/);
  await assert.rejects(adapter.stop(old, expected), { message: /action is unavailable/, notIssued: true, familyUnproven: false });
  assert.equal(issued, 0);

  adapter.read = async () => prior;
  adapter.currentUser = async () => owner;
  await assert.rejects(adapter.stop(old, expected), { message: /stop proof is malformed/, notIssued: false, familyUnproven: true });
  assert.equal(issued, 1);
});

test("Windows adoption rewrites only the legacy Exec action in a synthetic task definition",
  { skip: process.platform !== "win32" && "requires the Windows PowerShell XML transformer" }, async t => {
    const { old, candidate } = setup(t);
    const wrapper = path.join(old.source.root, "legacy wrapper.ps1");
    fs.writeFileSync(wrapper, "# synthetic legacy wrapper\n");
    const action = { executable: "powershell.exe", arguments: `-File ${quoteWindowsArg(wrapper)}`, workingDirectory: old.workspace };
    const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const exec = /<Exec>.*<\/Exec>/;
    const priorXml = windowsFreshXml(old, owner).toString("utf16le").replace(exec, () =>
      `<Exec><Command>${action.executable}</Command><Arguments>${escape(action.arguments)}</Arguments>`
      + `<WorkingDirectory>${escape(action.workingDirectory)}</WorkingDirectory></Exec>`);
    const prior = { ...snapshot(action), definition: Buffer.from(priorXml, "utf16le") };
    const adapter = new WindowsServiceAdapter();
    adapter.currentUser = async () => owner;

    const adopted = (await adapter.adopted(prior, candidate, old.source.root)).toString("utf16le");
    const desiredAction = windowsFreshXml(candidate, owner).toString("utf16le").match(exec)?.[0];
    assert.ok(desiredAction);
    assert.equal(adopted.match(exec)?.[0], desiredAction.replaceAll("&quot;", '"'));
    assert.equal(adopted.replace(exec, ""), priorXml.replace(exec, ""));
    assert.equal(prior.definition.toString("utf16le"), priorXml);
  });
