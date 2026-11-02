import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { TURN_SPACING_MS } from "./autonomy.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { ACCEPT_ALL, audits, closedSince, deliver } from "./closed-fixture.mts";
import { fakeCodexBin, THREAD, waitFor } from "./codex-fixture.mts";
import { readExit } from "./codex-output.mts";
import { intercomMcpOverrides, resetMcpCache } from "./codex-mcp.mts";
import { codexFiles, detachCodex, WINDOWLESS, type CodexDeps } from "./codex-process.mts";
import { spawnRun } from "./codex-runner.mts";
import { beginServiceDrain, serviceAdmissionsIdle } from "./service-drain.mts";
import { watchCodexTasks } from "./codex-watch.mts";
import { pollCodexInbound } from "./codex-wake.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { getMessage, markOffered } from "./inbox.mts";
import { T0, taskId, taskNode, testServiceOwner } from "./task-fixture.mts";
import { listTasks, readTask, writeTask, type TaskRecord } from "./task-records.mts";
import { fixtureEvidence, publishSynthetic } from "./session-authority-fixture.mts";

// Issue #119: a daemon-started Codex intercom run on Windows is not detached,
// so it opens no console windows but ends with the daemon. Its messages must
// then be offered again, never counted as delivered.

const CLOSED = "0199a000-0000-7000-8000-0000000000c2";

// Doubles as CodexDeps.processStart: a stable start time while the pid lives, null once it ended.
const alive = (pid: number): string | null => {
  try {
    process.kill(pid, 0);
    return "fake";
  } catch {
    return null;
  }
};

test("only a Windows intercom run shares the daemon's console; operator tasks and other platforms stay detached", () => {
  assert.equal(detachCodex("win32", true), false);
  assert.equal(detachCodex("win32", false), true);
  assert.equal(detachCodex("linux", true), true);
  assert.equal(detachCodex("darwin", true), true);
});

test("a service drain rejects every Codex run at the shared spawn boundary", async (t) => {
  const node = taskNode(t, { runtimes: ["claude", "codex"] });
  const endDrain = beginServiceDrain(node.paths);
  t.after(endDrain);
  let spawned = false;
  const record: TaskRecord = { taskId: taskId(1), runtime: "codex", name: "task-1", cwd: node.workspace,
    permissionMode: "auto", state: "started", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 3_600_000).toISOString(),
    updatedAt: new Date(T0).toISOString() };
  const codex: CodexDeps = { findCodex: () => "codex-fake", spawn: (() => { spawned = true; throw new Error("spawned"); }) as never };
  await assert.rejects(spawnRun({ ...node.deps(), codex }, record, () => ["exec"], "hello"), /draining new session admissions/);
  assert.equal(spawned, false);
  assert.equal(readTask(node.paths, record.taskId), null);
});

test("spawnRun passes detached false only for an intercom record on win32, and wraps only the detached win32 run (issue #124)", async (t) => {
  resetMcpCache();
  t.after(resetMcpCache);
  const node = taskNode(t, { runtimes: ["claude", "codex"] });
  const seen: { detached: unknown; windowsHide: unknown; wrapped: boolean }[] = [];
  // spawnCodex unrefs the child, so its exit event alone keeps no event loop alive: poll instead.
  const children: ChildProcess[] = [];
  const record = (n: number, local?: "intercom"): TaskRecord => ({ taskId: taskId(n), runtime: "codex", name: `task-${n}`, cwd: node.workspace,
    permissionMode: "auto", state: "started", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 3_600_000).toISOString(),
    updatedAt: new Date(T0).toISOString(), ...(local ? { local } : {}) });
  for (const [n, platform, local] of [[1, "win32", "intercom"], [2, "win32", undefined], [3, "linux", "intercom"]] as const) {
    const codex: CodexDeps = { platform, findCodex: () => "codex-fake", processStart: () => "t",
      mcpList: async () => ({ code: 0, stdout: "[]", stderr: "" }),
      spawn: ((file: string, args: string[], options: { detached?: boolean; windowsHide?: boolean }) => {
        seen.push({ detached: options.detached, windowsHide: options.windowsHide, wrapped: file === process.execPath && args[0] === WINDOWLESS });
        const child = spawn(process.execPath, ["-e", ""], { ...options, cwd: node.workspace });
        children.push(child);
        return child;
      }) as unknown as typeof spawn };
    await spawnRun({ ...node.deps(), codex }, record(n, local), () => ["exec"], "hello");
  }
  await waitFor(() => children.every((c) => c.exitCode !== null || c.signalCode !== null), "the spawned processes");
  assert.deepEqual(seen, [{ detached: false, windowsHide: true, wrapped: false }, { detached: true, windowsHide: true, wrapped: true },
    { detached: true, windowsHide: true, wrapped: false }]);
});

async function unconfirmedMcpAdmission(t: test.TestContext, cache: "cold" | "pending" | "latched"): Promise<void> {
  resetMcpCache();
  t.after(resetMcpCache);
  const node = taskNode(t, { runtimes: ["claude", "codex"] });
  const helper = Object.assign(new EventEmitter(), {
    pid: 4570, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
  });
  const children: ChildProcess[] = [];
  let spawns = 0;
  let shutdownNotices = 0;
  const codex: CodexDeps = { platform: "linux", findCodex: () => "codex-fake", processStart: () => "t", mcpListTimeoutMs: 5,
    signal: () => {}, onUnconfirmedShutdown: () => { shutdownNotices += 1; },
    spawn: ((_file: string, _args: string[], options: object) => {
      if (spawns++ === 0) return helper;
      const child = spawn(process.execPath, ["-e", ""], { ...options, cwd: node.workspace });
      children.push(child);
      return child;
    }) as unknown as typeof spawn };
  const pending = cache === "cold" ? undefined : intercomMcpOverrides(codex, T0);
  if (cache === "latched") await pending;
  const record: TaskRecord = { taskId: taskId(1), runtime: "codex", name: "task-1", cwd: node.workspace,
    permissionMode: "auto", state: "started", local: "intercom", startedAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 3_600_000).toISOString(), updatedAt: new Date(T0).toISOString() };
  const started = spawnRun({ ...node.deps(), codex }, record, () => ["exec"], "hello");
  await Promise.all([started, ...(pending ? [pending] : [])]);
  await waitFor(() => children.every((child) => child.exitCode !== null || child.signalCode !== null), "the task process");
  assert.ok(shutdownNotices > 0, "the caller's shutdown callback remains subscribed");
  assert.equal(serviceAdmissionsIdle(node.paths, testServiceOwner), false, `${cache} uncertain helper retains the spawn admission`);
}

test("spawnRun retains its admission when its cold MCP helper shutdown is unconfirmed", async (t) => {
  await unconfirmedMcpAdmission(t, "cold");
});

test("spawnRun retains its admission when joining a pending uncertain MCP helper", async (t) => {
  await unconfirmedMcpAdmission(t, "pending");
});

test("spawnRun retains its admission when consuming a latched uncertain MCP result", async (t) => {
  await unconfirmedMcpAdmission(t, "latched");
});

function closedCodexNode(t: test.TestContext) {
  // First, so its cleanup ends the runs before the node directory goes.
  const codex = fakeCodexBin(t);
  const node = taskNode(t, { runtimes: ["claude", "codex"], delegate: { accept: true } },
    { messaging: { ...ACCEPT_ALL, resumeClosed: true } });
  const repo = path.join(node.workspace, "repo");
  recordCodexSession(node.paths, CLOSED, repo, T0 - 13 * 3_600_000, "default");
  closedSince(node, { sessionId: CLOSED, runtime: "codex", state: "idle" });
  const codexDeps: CodexDeps = { findCodex: () => codex.file, processStart: alive, startWaitMs: 5_000, graceMs: 300,
    // Only fixture-owned PIDs are supplied; never enumerate the host's processes.
    processTree: pid => { assert.ok(codex.runs().some(run => run.pid === pid));
      return [pid, codex.child()].filter((id): id is number => id !== null)
        .flatMap(id => alive(id) === null ? [] : [{ pid: id, start: "fake" }]); } };
  const deps = () => ({ ...node.deps(), codex: codexDeps });
  return { node, codex, deps };
}

test("a new intercom run that a daemon restart ends leaves its message offered again, and the next round resumes it", async (t) => {
  const { node, codex, deps } = closedCodexNode(t);
  // [fail] keeps the fake from answering, [sleep] keeps it running until killed.
  const id = deliver(node, { toSession: CLOSED, text: "status? [fail] [sleep]" });
  await deliverToClosed(deps());
  assert.equal(listTasks(node.paths).length, 1, JSON.stringify(audits(node)));
  await waitFor(() => codex.runs().length === 1, "the intercom run");
  const [task] = listTasks(node.paths);
  assert.equal(task.local, "intercom");
  const handed = getMessage(node.paths.inbox, id)!;
  assert.equal(handed.state, "offered", "a message is not delivered before the run completes its turn");
  assert.equal(handed.toSession, task.name, "the message now waits for the intercom session");
  assert.deepEqual(readTask(node.paths, task.taskId)?.offered, [id]);

  // The daemon exits: its attached run ends with it, and no exit is recorded.
  const pid = codex.runs()[0].pid;
  process.kill(pid, "SIGKILL");
  const files = codexFiles(node.paths, task.taskId);
  await waitFor(() => alive(pid) === null && readExit(files) !== null, "the end of the run");
  fs.rmSync(files.exit);
  await watchCodexTasks(deps());
  const after = readTask(node.paths, task.taskId)!;
  assert.equal(after.state, "failed");
  assert.equal(after.offered, undefined);
  assert.equal(after.sessionId, THREAD);
  const retry = getMessage(node.paths.inbox, id)!;
  assert.deepEqual([retry.state, retry.retry], ["offered", true], "offered again, not delivered and not lost");

  node.tick(TURN_SPACING_MS * 2);
  const now = node.deps().now!();
  const target = { runtime: "codex", sessionId: THREAD };
  publishSynthetic(node.paths, [fixtureEvidence(target, "idle-loaded", now)], now,
    [{ ...target, state: "idle-loaded" }], node.livenessAuthority);
  await pollCodexInbound(deps());
  await waitFor(() => codex.runs().length === 2, "the resumed run");
  const resume = codex.runs()[1];
  assert.deepEqual(resume.argv.slice(0, 2), ["exec", "resume"]);
  assert.equal(resume.argv.at(-2), THREAD);
  assert.ok(resume.stdin.includes(`--reply-to ${id} -- <reply text>`));
  assert.deepEqual(readTask(node.paths, task.taskId)?.offered, [id]);
});

test("a new intercom run that failed its turn offers its message again", async (t) => {
  const { node, codex, deps } = closedCodexNode(t);
  const id = deliver(node, { toSession: CLOSED, text: "status? [fail]" });
  await deliverToClosed(deps());
  const [task] = listTasks(node.paths);
  await waitFor(() => readExit(codexFiles(node.paths, task.taskId)) !== null && alive(codex.runs()[0].pid) === null, "the end of the run");
  assert.equal(getMessage(node.paths.inbox, id)?.state, "offered");
  await watchCodexTasks(deps());
  assert.equal(readTask(node.paths, task.taskId)?.state, "failed");
  assert.equal(getMessage(node.paths.inbox, id)?.retry, true);
});

test("an ended intercom task settles its offers from its events: delivered after turn.completed, offered again otherwise", async (t) => {
  const node = taskNode(t, { runtimes: ["claude", "codex"] });
  const codex: CodexDeps = { processStart: () => null };
  for (const [n, completed] of [[1, true], [2, false]] as const) {
    const id = deliver(node, { toSession: `task-${n}` });
    markOffered(node.paths.inbox, id, T0);
    writeTask(node.paths, { taskId: taskId(n), runtime: "codex", name: `task-${n}`, cwd: node.workspace, permissionMode: "auto",
      state: "started", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 3_600_000).toISOString(),
      updatedAt: new Date(T0).toISOString(), local: "intercom", sessionId: THREAD, pid: 4_000_000, pidStart: "gone", offered: [id] });
    const files = codexFiles(node.paths, taskId(n));
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.events, [{ type: "thread.started", thread_id: THREAD }, ...(completed ? [{ type: "turn.completed" }] : [])]
      .map((e) => JSON.stringify(e)).join("\n") + "\n");
    await watchCodexTasks({ ...node.deps(), codex });
    const message = getMessage(node.paths.inbox, id)!;
    assert.deepEqual([message.state, message.retry], completed ? ["delivered", undefined] : ["offered", true]);
    const record = readTask(node.paths, taskId(n))!;
    assert.deepEqual([record.state, record.offered], [completed ? "done" : "failed", undefined]);
  }
});

test("the deadline stops an attached intercom run with its whole process tree", async (t) => {
  const { node, codex, deps } = closedCodexNode(t);
  const id = deliver(node, { toSession: CLOSED, text: "work [fail] [tree] [sleep]" });
  await deliverToClosed(deps());
  assert.equal(listTasks(node.paths).length, 1, JSON.stringify(audits(node)));
  await waitFor(() => codex.child() !== null, "the child of the run");
  const [task] = listTasks(node.paths);
  node.tick(2 * 60 * 60_000);
  await watchCodexTasks(deps(), (line) => t.diagnostic(line));
  await waitFor(() => alive(codex.runs()[0].pid) === null && alive(codex.child()!) === null, "the whole tree", 15_000);
  assert.equal(readTask(node.paths, task.taskId)?.state, "stopped");
  const retry = getMessage(node.paths.inbox, id)!;
  assert.deepEqual([retry.state, retry.retry], ["offered", true]);
});
