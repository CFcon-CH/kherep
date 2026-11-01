import { acknowledgeCodexOffer } from "./codex-inbox-ack.mts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { probesSettled, tuiMarker, tuiReachability } from "./codex-daemon.mts";
import { MAX_NATIVE_ATTEMPTS, nativeAttemptDir } from "./codex-queue-producer.mts";
import { nativeQueueNode } from "./codex-queue-producer-fixture.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { deliverForCodex } from "./deliver-codex.mts";
import { getMessage, markOffered, MAX_REPLY_DEPTH, writeJsonAtomic } from "./inbox.mts";
import { T0, TASK } from "./task-fixture.mts";
import { writeTask } from "./task-records.mts";

test("a new TUI marker blocks a scheduled automatic App grant, including a reachable owner", async (t) => {
  for (const reachable of [false, true]) await t.test(String(reachable), async (sub) => {
    const node = nativeQueueNode(sub);
    node.add();
    const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8"));
    policy.wake = { enabled: true, sessions: [], codexApp: true, nativeQueue: true };
    fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
    const dir = path.join(node.home, "sessions", "2026", "10", "14");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-${node.owner}.jsonl`), JSON.stringify({ type: "session_meta",
      payload: { id: node.owner, originator: "Codex Desktop", source: "vscode" } }) + "\n");
    pollCodexQueue(node.deps());
    const marker = tuiMarker(node.home, node.owner);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, "");
    const probe = tuiReachability(node.home, async () => reachable ? new Set([node.owner]) : null, T0);
    probe(node.owner);
    await probesSettled();
    assert.equal(probe(node.owner), reachable);
    await codexQueueIdle();
    assert.equal(node.fake.runs().length, 0);
  });
});

test("full-id authorization permits a marked TUI without the automatic App grant", async (t) => {
  const node = nativeQueueNode(t);
  node.add();
  const marker = tuiMarker(node.home, node.owner);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, "");
  await node.poll();
  assert.equal(node.fake.runs().length, 1);
});

test("native submission rechecks policy, enrollment, kill switch, mode and task ownership", async (t) => {
  for (const change of ["policy", "opt-out", "enrollment", "kill", "mode", "task"] as const) await t.test(change, async (sub) => {
    const node = nativeQueueNode(sub);
    const id = node.add();
    pollCodexQueue(node.deps());
    if (change === "policy") fs.writeFileSync(node.paths.policy, '{"version":1,"wake":{"enabled":false}}');
    // Issue #429: withdrawing the opt-in after scheduling cancels the snapshotted submission.
    if (change === "opt-out") {
      const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8"));
      delete policy.wake.nativeQueue;
      fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
    }
    if (change === "enrollment") fs.renameSync(node.paths.config, `${node.paths.config}.saved`);
    if (change === "kill") fs.writeFileSync(path.join(node.paths.dir, "wake.disabled"), "synthetic");
    if (change === "mode") recordCodexSession(node.paths, node.owner, node.workspace, T0, "bypassPermissions");
    if (change === "task") writeTask(node.paths, { taskId: TASK, runtime: "codex", name: "task-3f2a1b0c", cwd: node.workspace,
      permissionMode: "auto", state: "done", startedAt: new Date(T0).toISOString(), deadline: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(), sessionId: node.owner });
    await codexQueueIdle();
    assert.equal(node.fake.runs().length, 0);
    assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
  });
});

test("current offer, address and depth changes suppress a snapshotted native submission", async (t) => {
  for (const change of ["offered", "address", "depth"] as const) await t.test(change, async (sub) => {
    const node = nativeQueueNode(sub);
    const id = node.add();
    pollCodexQueue(node.deps());
    if (change === "offered") markOffered(node.paths.inbox, id, T0);
    else {
      const record = getMessage(node.paths.inbox, id)!;
      if (change === "depth") record.depth = MAX_REPLY_DEPTH;
      else record.toSession = "01a0db01-0000-7000-8000-000000000002";
      writeJsonAtomic(path.join(node.paths.inbox, `${id}.json`), record);
    }
    await codexQueueIdle();
    assert.equal(node.fake.runs().length, 0);
  });
});

test("partial attempt files and a full bounded store fail closed while CP hints remain", async (t) => {
  for (const kind of ["partial", "full", "overfull"] as const) await t.test(kind, async (sub) => {
    const node = nativeQueueNode(sub);
    const id = node.add();
    if (kind === "overfull") node.add("Another public message");
    const dir = nativeAttemptDir(node.deps(), node.owner);
    fs.mkdirSync(dir, { recursive: true });
    if (kind === "partial") fs.writeFileSync(path.join(dir, `${id}.json`), "");
    else for (let n = 0; n < MAX_NATIVE_ATTEMPTS + (kind === "overfull" ? 1 : 0); n++) fs.writeFileSync(path.join(dir, `synthetic-${n}.json`), "");
    await node.poll();
    assert.equal(node.fake.runs().length, 0);
    assert.ok(fs.existsSync(path.join(node.paths.dir, "listeners", `${node.owner}.busy-hint.json`)));
    assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
  });
});

test("a native rejection retains uncertainty without copying native diagnostic text", async (t) => {
  const node = nativeQueueNode(t, "fa110001-0000-7000-8000-000000000001");
  const id = node.add();
  await node.poll();
  const raw = fs.readFileSync(path.join(nativeAttemptDir(node.deps(), node.owner), `${id}.json`), "utf8");
  assert.equal(JSON.parse(raw).state, "uncertain");
  assert.ok(!raw.includes("Secret1"));
  assert.ok(!raw.includes("token"));
});

test("native enqueue, original Receive, Stop and explicit processing ACK remain separate events", async (t) => {
  const node = nativeQueueNode(t);
  const id = node.add();
  await node.poll();
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
  const hook = { session_id: node.owner, cwd: node.workspace, permission_mode: "default" };
  const context = deliverForCodex({ ...hook, hook_event_name: "UserPromptSubmit" }, node.deps());
  assert.ok(context.includes("Public synthetic peer content"));
  assert.equal(getMessage(node.paths.inbox, id)?.state, "offered");
  deliverForCodex({ ...hook, hook_event_name: "Stop" }, node.deps());
  assert.equal(getMessage(node.paths.inbox, id)?.state, "offered");
  const token = context.match(/msg inbox --ack ([0-9a-f-]{36}) --from /)![1]!;
  acknowledgeCodexOffer(node.paths, node.owner, token, [node.owner]);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "delivered");
});

test("unknown or terminal liveness vetoes an already scheduled queue before the launch spy", async (t) => {
  const { publishLiveness, livenessFile } = await import("./session-lifecycle.mts");
  for (const state of ["unknown", "archived", "deleted"] as const) await t.test(state, async sub => {
    const node = nativeQueueNode(sub);
    const id = node.add();
    pollCodexQueue(node.deps());
    if (state === "unknown") fs.rmSync(livenessFile(node.paths));
    else publishLiveness(node.paths, [{ runtime: "codex", sessionId: node.owner, lifecycle: {
      status: "value", value: { state, generation: 1 }, observedAt: T0, source: "native-lifecycle", complete: true, reasonCode: "observed",
    } }], T0);
    await codexQueueIdle();
    assert.equal(node.fake.runs().length, 0);
    assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
  });
});
