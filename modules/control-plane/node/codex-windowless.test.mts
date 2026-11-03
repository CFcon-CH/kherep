import { windowControl } from "./target-delivery-window.mts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fakeCodexBin, LAST_MESSAGE, THREAD, waitFor } from "./codex-fixture.mts";
import { readExit } from "./codex-output.mts";
import { codexFiles, launchCommand, processStart, startArgs, WINDOWLESS, type CodexDeps } from "./codex-process.mts";
import { spawnRun } from "./codex-runner.mts";
import { watchCodexTasks } from "./codex-watch.mts";
import { T0, taskId, taskNode } from "./task-fixture.mts";
import { readTask, type TaskRecord } from "./task-records.mts";

// Issue #124: operator Codex tasks on Windows start through a detached wrapper
// that runs codex attached, in a console without a window, and forwards its
// stdio and exit code.

test("only a detached run on Windows goes through the wrapper, run with this Node", () => {
  const command = { file: "C:\\codex\\codex.exe", args: ["exec", "-"] };
  assert.deepEqual(launchCommand(command, "win32", true, "C:\\node\\node.exe"),
    { file: "C:\\node\\node.exe", args: [WINDOWLESS, "C:\\codex\\codex.exe", "exec", "-"] });
  assert.equal(launchCommand(command, "win32", false), command, "an intercom run shares the daemon's console");
  assert.equal(launchCommand(command, "linux", true), command);
  assert.equal(launchCommand(command, "darwin", true), command);
});

// Runs the wrapper as spawnCodex does: stdin piped, stdout and stderr into files.
async function wrapped(t: test.TestContext, args: string[], input: string, useWrapper = true, timeoutMs = 20_000): Promise<{ code: number | null; out: string; err: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-windowless-"));
  const outFile = path.join(dir, "out");
  const errFile = path.join(dir, "err");
  const out = fs.openSync(outFile, "w");
  const err = fs.openSync(errFile, "w");
  const child = spawn(useWrapper ? process.execPath : args[0]!, useWrapper ? [WINDOWLESS, ...args] : args.slice(1),
    { stdio: ["pipe", out, err], detached: true, windowsHide: true });
  fs.closeSync(out);
  fs.closeSync(err);
  let killed = false;
  const stopTree = () => {
    if (killed || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    killed = true;
    try {
      if (process.platform === "win32") execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 5_000, stdio: "ignore" });
      else process.kill(-child.pid, "SIGKILL");
    } catch { child.kill("SIGKILL"); }
  };
  t.after(() => { stopTree(); fs.rmSync(dir, { recursive: true, force: true }); });
  child.stdin!.on("error", () => {});
  child.stdin!.end((useWrapper?windowControl({kind:"operator"},undefined,args[0]!,args.slice(1),WINDOWLESS):"")+input);
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { stopTree(); reject(new Error("windowless probe timed out")); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  // Node versions that still flag type stripping print an ExperimentalWarning
  // for the wrapper itself; it is Node's line, not one the wrapper forwarded.
  const nodeWarning = /^\(node:\d+\) ExperimentalWarning: .*\n|^\(Use `node --trace-warnings \.\.\.` .*\n/gm;
  return { code, out: fs.readFileSync(outFile, "utf8"), err: fs.readFileSync(errFile, "utf8").replace(nodeWarning, "") };
}

test("the wrapper forwards stdin, stdout, stderr and the exit code", async (t) => {
  const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write('got '+s+'\\n');"
    + "process.stderr.write('warn\\n');process.exit(7);});";
  const result = await wrapped(t, [process.execPath, "-e", script], "the prompt");
  assert.deepEqual(result, { code: 7, out: "got the prompt\n", err: "warn\n" });
});

test("a wrapper whose program cannot start exits 1 with the reason on stderr", async (t) => {
  const result = await wrapped(t, [path.join(os.tmpdir(), "kherep-no-such-codex.exe")], "");
  assert.equal(result.code, 1);
  assert.match(result.err,/failed to start/);
});

test("the unwrapped control launches the supplied program", async (t) => {
  const result = await wrapped(t, [process.execPath, "-e", "process.stdout.write('control\\n')"], "", false);
  assert.deepEqual(result, { code: 0, out: "control\n", err: "" });
});

test("a stalled wrapper probe fails within its deadline", async (t) => {
  await assert.rejects(wrapped(t, [process.execPath, "-e", "setInterval(() => {}, 1000)"], "", true, 100),
    /windowless probe timed out/);
});

const win32 = { skip: process.platform === "win32" ? false : "Windows only" };

test("Windows: a shell child of wrapped codex has no visible console window", win32, async (t) => {
  const native = [
    "using System; using System.Runtime.InteropServices; public static class KherepWindow {",
    "[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow();",
    "[DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h); }",
  ].join(" ");
  const probe = [
    `Add-Type -TypeDefinition '${native}'`,
    "$handle = [KherepWindow]::GetConsoleWindow()",
    "$visible = [KherepWindow]::IsWindowVisible($handle)",
    "[Console]::Out.WriteLine(\"visible=$visible\")",
  ].join("; ");
  // No windowsHide on the shell: it must inherit the windowless console from
  // the wrapped process, as a Codex shell child does.
  const codex = `const { spawn } = require("node:child_process");`
    + `const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ${JSON.stringify(probe)}], { stdio: "pipe" });`
    + `child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);`
    + `child.on("close", (code) => { process.exitCode = code ?? 1; });`;
  const command = [process.execPath, "-e", codex];
  const baseline = await wrapped(t, command, "", false);
  assert.equal(baseline.code, 0, baseline.err);
  assert.equal(baseline.out.trim().toLowerCase(), "visible=true",
    "the runner must reproduce the visible-window regression before checking the fix");
  const result = await wrapped(t, command, "");
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out.trim().toLowerCase(), "visible=false");
});

function operatorTask(t: test.TestContext) {
  // First, so its cleanup ends the runs before the node directory goes.
  const codex = fakeCodexBin(t);
  const node = taskNode(t, { runtimes: ["claude", "codex"] });
  const codexDeps: CodexDeps = { findCodex: () => codex.file, startWaitMs: 5_000, graceMs: 300 };
  const deps = () => ({ ...node.deps(), codex: codexDeps });
  const record = (n: number): TaskRecord => ({ taskId: taskId(n), runtime: "codex", name: `task-${n}`, cwd: node.workspace,
    permissionMode: "auto", state: "started", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 3_600_000).toISOString(),
    updatedAt: new Date(T0).toISOString() });
  const start = (n: number, prompt: string) => spawnRun(deps(), record(n), (files, outbox) => startArgs(node.workspace, "auto", files, outbox), prompt,undefined,{kind:"operator"});
  return { node, codex, deps, start };
}

test("Windows: the task records the wrapper's pid and start time, and its exit.json carries codex's exit code", win32, async (t) => {
  const { node, codex, deps, start } = operatorTask(t);
  const done = await start(1, "go");
  await waitFor(() => readExit(codexFiles(node.paths, taskId(1))) !== null, "the exit", 15_000);
  assert.notEqual(done.pid, codex.runs()[0].pid, "the recorded pid is the wrapper's, not codex's");
  assert.ok(done.pidStart);
  assert.deepEqual(readExit(codexFiles(node.paths, taskId(1))), { code: 0, signal: null });
  assert.equal(codex.runs()[0].stdin, "go", "the prompt reached codex on stdin");
  await watchCodexTasks(deps());
  const record = readTask(node.paths, taskId(1))!;
  assert.deepEqual([record.state, record.sessionId], ["done", THREAD]);
  assert.deepEqual(node.reports(), [{ taskId: taskId(1), state: "done", summary: LAST_MESSAGE.trim(), sessionId: THREAD }]);

  await start(2, "go [fail]");
  await waitFor(() => readExit(codexFiles(node.paths, taskId(2))) !== null, "the exit", 15_000);
  assert.deepEqual(readExit(codexFiles(node.paths, taskId(2))), { code: 1, signal: null });
  await watchCodexTasks(deps());
  assert.deepEqual([readTask(node.paths, taskId(2))?.state, readTask(node.paths, taskId(2))?.reason], ["failed", "model refused"]);
});

test("Windows: the deadline stops the wrapper, codex and codex's children", win32, async (t) => {
  const { node, codex, deps, start } = operatorTask(t);
  const saved = await start(3, "work [tree] [sleep]");
  await waitFor(() => codex.child() !== null, "the child of the run", 15_000);
  const tree = [saved.pid!, codex.runs()[0].pid, codex.child()!];
  // As every() did: in order, stopping at the first pid that does not match.
  const all = async (ended: boolean): Promise<boolean> => {
    for (const pid of tree) if ((await processStart(pid) === null) !== ended) return false;
    return true;
  };
  assert.ok(await all(false), "all running");
  node.tick(2 * 3_600_000);
  await watchCodexTasks(deps());
  await waitFor(() => all(true), "the whole tree", 20_000);
  assert.equal(readTask(node.paths, taskId(3))?.state, "stopped");
});
