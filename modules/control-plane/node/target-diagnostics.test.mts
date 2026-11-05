import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { listenerDir, takeTurn } from "./autonomy.mts";
import { closedNode, deliver, SESSION } from "./closed-fixture.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { getMessageDiagnostic, getMessageProgress, markDelivered, setMessageProgress, unreportedStatuses } from "./inbox.mts";
import { blockerDiagnostic } from "../protocol-diagnostics.mts";
import { createReadiness } from "./runtime-readiness.mts";
import { taskId, T0 } from "./task-fixture.mts";
import { writeTask } from "./task-records.mts";
import type { TaskRecord } from "./task-records.mts";
const diagnosticCode = (node: ReturnType<typeof closedNode>, id: string) => {
  const d = getMessageDiagnostic(node.paths.inbox, id);
  return d?.kind === "blocker" ? d.code : undefined;
};
const record = (node: ReturnType<typeof closedNode>, extra: Partial<TaskRecord>): TaskRecord => ({ taskId: taskId(901), name: "task-00000385",
  permissionMode: "auto", cwd: path.join(node.workspace, "repo"), state: "done", runtime: "claude", startedAt: new Date(T0).toISOString(),
  deadline: new Date(T0 + 60_000).toISOString(), updatedAt: new Date(T0).toISOString(), ...extra });
for (const code of ["task-concurrency", "task-starts-daily"] as const) test(`closed fallback derives ${code} from persisted task population without spending a turn`, async t => {
  const node = closedNode(t, { maxConcurrent: 1, maxStartsPerDay: 1 });
  writeTask(node.paths, record(node, { state: code === "task-concurrency" ? "running" : "done" }), T0);
  const id = deliver(node);
  await deliverToClosed(node.deps());
  assert.equal(diagnosticCode(node, id), code);
  assert.equal(takeTurn(node.paths, SESSION, T0), "ok");
  assert.equal(node.calls.length, 0);
});
for (const code of ["runtime-pending", "turn-spacing", "budget-lock-unavailable"] as const) test(`closed fallback derives ${code} from its real admission operands`, async t => {
  const node = closedNode(t), id = deliver(node), deps = node.deps();
  if (code === "runtime-pending") deps.readiness = createReadiness(async () => ({ ok: false, cause: "timeout", detail: "synthetic timeout" }), { now: () => T0 });
  if (code === "turn-spacing") assert.equal(takeTurn(node.paths, SESSION, T0 - 1), "ok");
  if (code === "budget-lock-unavailable") {
    fs.mkdirSync(listenerDir(node.paths), { recursive: true });
    fs.writeFileSync(path.join(listenerDir(node.paths), `${SESSION}.turns.json.lock`), "held");
  }
  await deliverToClosed(deps);
  assert.equal(diagnosticCode(node, id), code);
  assert.equal(node.calls.length, 0);
  assert.equal(fs.existsSync(path.join(listenerDir(node.paths), `${SESSION}.turns.json`)), code === "turn-spacing");
});
test("closed fallback distinguishes active task and a still-running prior process", async t => {
  for (const active of [true, false]) {
    const node = closedNode(t), id = deliver(node);
    writeTask(node.paths, record(node, { sessionId: SESSION, state: active ? "running" : "done", pid: process.pid, pidStart: "synthetic-start" }), T0);
    const deps = node.deps();
    deps.codex = { platform: "linux", processStart: async () => "synthetic-start" } as never;
    await deliverToClosed(deps);
    assert.equal(diagnosticCode(node, id), active ? "task-active" : "process-still-running");
    assert.equal(node.calls.length, 0);
  }
});
test("diagnostics travel with progress; advancement clears obsolete detail and failed writes do not alter admission", async t => {
  const node = closedNode(t), id = deliver(node);
  setMessageProgress(node.paths.inbox, id, "waiting", "retry-pending", T0, undefined, blockerDiagnostic("runtime-pending", T0));
  assert.equal(unreportedStatuses(node.paths.inbox, T0)[0].diagnostic?.kind, "blocker");
  setMessageProgress(node.paths.inbox, id, "waking", "wake-pending", T0 + 1);
  assert.equal(getMessageDiagnostic(node.paths.inbox, id), null);
  assert.equal(getMessageProgress(node.paths.inbox, id)?.code, "wake-pending");
  markDelivered(node.paths.inbox, id);
  assert.equal(getMessageDiagnostic(node.paths.inbox, id), null);
  const other = deliver(node);
  const dir = path.join(node.paths.inbox, "progress");
  fs.rmSync(dir, { recursive: true, force: true }); fs.writeFileSync(dir, "blocked");
  const deps = node.deps(); deps.readiness = createReadiness(async () => ({ ok: false, cause: "timeout", detail: "synthetic timeout" }), { now: () => T0 });
  await deliverToClosed(deps);
  assert.equal(node.calls.length, 0);
  assert.equal(takeTurn(node.paths, SESSION, T0), "ok");
  assert.ok(other);
});
test("actual offer and closed-attempt advancement suppress old detail but preserve later stuck-offer observations", async t => {
  const { markOffered, markClosedAttempt } = await import("./inbox.mts");
  const { isMessageStatusBody } = await import("../protocol-messages.mts");
  const node = closedNode(t), id = deliver(node);
  const observe = (now: number) => setMessageProgress(node.paths.inbox, id, "waiting", "retry-pending", now, undefined, blockerDiagnostic("runtime-pending", now));
  observe(T0);
  assert.equal(diagnosticCode(node, id), "runtime-pending");
  markOffered(node.paths.inbox, id, T0, "prompt");
  assert.equal(getMessageDiagnostic(node.paths.inbox, id), null, "even a same-millisecond accepted-to-offered advance invalidates old detail");
  assert.equal(getMessageProgress(node.paths.inbox, id)?.code, "retry-pending", "legacy progress remains readable");
  observe(T0 + 1);
  assert.equal(diagnosticCode(node, id), "runtime-pending", "a later stuck-offer check remains observable");
  const report = unreportedStatuses(node.paths.inbox, T0 + 1)[0];
  assert.equal(isMessageStatusBody({ messageId: id, state: "accepted", progress: report.progress, diagnostic: report.diagnostic }), true);
  assert.equal(JSON.stringify(report).includes("diagnosticContext"), false, "internal binding never enters a report");
  markOffered(node.paths.inbox, id, T0 + 2, "prompt");
  assert.equal(getMessageDiagnostic(node.paths.inbox, id), null, "a new offer invalidates the previous observation");
  observe(T0 + 3); markClosedAttempt(node.paths.inbox, id, T0 + 4);
  assert.equal(getMessageDiagnostic(node.paths.inbox, id), null);
  observe(T0 + 5);
  assert.equal(diagnosticCode(node, id), "runtime-pending", "the current closed-attempt observation remains readable");
});
