import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { TURN_SPACING_MS, TURNS_PER_HOUR } from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { storeMessage } from "./inbox.mts";
import { writeTask } from "./task-records.mts";
import { WAKE_POLL_MS, wakeText } from "./wake-hook.mts";
import { auditLines, id, listen, SELF, setup, T0 } from "./wake-fixture.mts";

// Task grant (issue #31, item 5): the session this node started for a task is
// woken by messages of that task even when the wake allowlist does not name
// it; the budget and the bypassPermissions exclusion still apply.

const TASK = "3f2a1b0c-0000-4000-8000-000000000001";
const PEER = "00000000-0000-4000-8000-0000000000cc";

// Waking is off unless the test says otherwise (an absent section wakes every session, issue #390).
function taskSession(t: test.TestContext, wake: unknown = { enabled: false }) {
  const { paths } = setup(t, { wake });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], ...(wake === undefined ? {} : { wake }),
    sessions: { enabled: true, workspaceRoots: [paths.dir] } }));
  writeTask(paths, { taskId: TASK, name: "task-3f2a1b0c", cwd: paths.dir, permissionMode: "auto", state: "running", sessionId: SELF,
    startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 7_200_000).toISOString(), updatedAt: new Date(T0).toISOString() });
  return paths;
}

// A message for the session that arrives at the second poll, of the task or not.
function listenFor(paths: NodePaths, n: number, withTask: boolean, start = T0, mode = "auto") {
  return listen(paths, { start, mode, maxWaitMs: 20_000, tick: (clock) => {
    if (clock !== start + 2 * WAKE_POLL_MS) return;
    storeMessage(paths.inbox, { messageId: id(n), from: { nodeId: PEER, session: "build" }, toSession: SELF, text: `about the task ${n}`,
      createdAt: new Date(clock).toISOString(), ...(withTask ? { taskId: TASK } : {}) }, clock);
  } });
}

test("a task session is woken by its task's messages without being on the allowlist", async (t) => {
  for (const wake of [{ enabled: false }, { enabled: true, sessions: ["someone-else"] }]) {
    const paths = taskSession(t, wake);
    assert.deepEqual(await listenFor(paths, 1, true), { code: 2, text: wakeText(1) }, JSON.stringify(wake));
    const other = taskSession(t, wake);
    // A message without the task id does not wake it; the listener only re-arms at its deadline.
    await listenFor(other, 2, false);
    assert.deepEqual(auditLines(other).map((l) => l.action), ["rearm"]);
  }
});

test("the grant needs sessions enabled and a task started for this session", async (t) => {
  const paths = taskSession(t);
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: false } }));
  assert.deepEqual(await listenFor(paths, 1, true), { code: 0 });
});

test("the budget and the bypassPermissions exclusion still apply", async (t) => {
  const bypass = taskSession(t);
  assert.deepEqual(await listenFor(bypass, 1, true, T0, "bypassPermissions"), { code: 0 });
  assert.deepEqual(auditLines(bypass).map((l) => l.action), ["permission-mode"]);

  const paths = taskSession(t);
  let start = T0;
  for (let n = 1; n <= TURNS_PER_HOUR; n++) {
    assert.equal((await listenFor(paths, n, true, start)).code, 2, `wake ${n}`);
    start += TURN_SPACING_MS + 10 * WAKE_POLL_MS;
  }
  assert.deepEqual(await listenFor(paths, 99, true, start), { code: 0 });
  assert.equal(auditLines(paths).findLast(line => line.action === "budget")?.action, "budget");
});
