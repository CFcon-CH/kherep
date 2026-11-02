import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { children } from "./child-run.mts";
import { AUTH_OK, deliver, flush, intakeHarness, messageId, statuses } from "./daemon-intake-fixture.mts";
import { EXCHANGE_INTERVAL_MS } from "./exchange.mts";
import { getMessage } from "./inbox.mts";
import { taskId } from "./task-fixture.mts";
import { writeTask } from "./task-records.mts";
import { fixtureEvidence } from "./session-authority-fixture.mts";

// Issue #473: a start-time read is an awaited child process. While one is
// pending, here for ever, the daemon still stores and acknowledges a
// delivery to another session. No PowerShell or ps runs: children.run is faked.

const TASK_SESSION = "0199a000-0000-7000-8000-0000000004a3";

test("a delivery is stored while a process-identity read never returns", async (t) => {
  const h = intakeHarness(t, { livenessSource: { observe: () => { const now = Date.now();
    return { status: "value", value: [fixtureEvidence({ runtime: "codex", sessionId: TASK_SESSION }, "idle-loaded", now)],
      source: "native-app", complete: true, observedAt: now, reasonCode: "observed" }; } }, policy: { version: 1, allowedCommands: [],
    sessions: { enabled: true, workspaceRoots: [os.tmpdir()], runtimes: ["codex"] }, messaging: { accept: [{ from: ["*"], session: "*" }] } } });
  const now = Date.now();
  writeTask(h.paths, { taskId: taskId(4731), name: "task-4731", sessionId: TASK_SESSION, runtime: "codex", state: "done",
    permissionMode: "auto", cwd: h.paths.dir, pid: process.pid, pidStart: "synthetic-start", startedAt: new Date(now).toISOString(),
    deadline: new Date(now + 60_000).toISOString(), updatedAt: new Date(now).toISOString() }, now);
  const reads: string[] = [];
  t.mock.method(children, "run", (file: string) => { reads.push(file); return new Promise<string>(() => {}); });
  await flush();
  const socket = h.socket();
  socket.message(AUTH_OK);
  await flush();
  h.release([{ runtime: "codex", sessionId: TASK_SESSION, state: "idle-loaded" }]);
  await flush();
  socket.message(deliver(1, TASK_SESSION));
  await flush();
  assert.ok(getMessage(h.paths.inbox, messageId(1)), "the message that wakes the task is stored");
  h.timers.get(EXCHANGE_INTERVAL_MS)![0]!();
  await flush();
  assert.equal(reads.length, 1, "the round waits inside the start-time read of the task's previous run");
  const started = Date.now();
  socket.message(deliver(2, "synthetic-other-session"));
  await flush();
  assert.ok(getMessage(h.paths.inbox, messageId(2))?.receivedAt, "stored while the read is pending");
  assert.ok(Date.now() - started < 1_000, "stored within 1 s");
  assert.equal(statuses(socket, messageId(2)).length, 1, "acknowledged while the read is pending");
  assert.equal(reads.length, 1, "the read is still pending");
});
