import assert from "node:assert/strict";
import test from "node:test";
import { closedNode, deliver, SESSION } from "./closed-fixture.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { getMessageDiagnostic, getMessageProgress } from "./inbox.mts";
import { recordSent, writeDirectory, writeOutbox } from "./exchange.mts";
import { createReadiness } from "./runtime-readiness.mts";
import { runMsg } from "./msg-cli.mts";
import { taskId, T0 } from "./task-fixture.mts";
import { writeTask } from "./task-records.mts";
import { observeClaudeDeliveryProgress } from "./delivery-progress.mts";
import { publishSynthetic } from "./session-authority-fixture.mts";
async function output(node: ReturnType<typeof closedNode>, id: string) {
  const lines: string[] = [];
  assert.equal(await runMsg(["status", id], { paths: node.paths, env: {}, now: () => T0, out: line => lines.push(line), err: line => { throw new Error(line); } }), 0);
  return lines.join("\n");
}
for (const cause of ["runtime-pending", "task-concurrency", "target-not-idle"] as const) test(`msg status renders actual stored ${cause} cause with time and stage`, async t => {
  const node = closedNode(t, { maxConcurrent: 1 }), id = deliver(node), deps = node.deps();
  if (cause === "runtime-pending") deps.readiness = createReadiness(async () => ({ ok: false, cause: "timeout", detail: "synthetic timeout" }), { now: () => T0 });
  if (cause === "task-concurrency") writeTask(node.paths, { taskId: taskId(780), name: "synthetic-task", state: "running", runtime: "claude", permissionMode: "auto", cwd: node.workspace,
    startedAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60_000).toISOString() }, T0);
  if (cause === "target-not-idle") {
    const target = { runtime: "claude-code", sessionId: SESSION };
    publishSynthetic(node.paths, [target], T0, [{ ...target, state: "unknown" }], node.livenessAuthority);
    observeClaudeDeliveryProgress(deps);
  } else await deliverToClosed(deps);
  const diagnostic = getMessageDiagnostic(node.paths.inbox, id)!;
  assert.equal(diagnostic.kind === "blocker" && diagnostic.code, cause);
  const received = await output(node, id);
  assert.match(received, /stage target-progress/);
  writeOutbox(node.paths, { messageId: id, fromSession: "synthetic-sender", to: { nodeId: "00000000-0000-4000-8000-0000000000aa", session: SESSION }, text: "synthetic", createdAt: new Date(T0).toISOString() });
  recordSent(node.paths, id, "accepted", undefined, T0, getMessageProgress(node.paths.inbox, id)!, diagnostic);
  const sent = await output(node, id);
  assert.match(sent, /Observed 2026-09-25T12:00:00.000Z; stage target-progress/);
  const phrases = { "runtime-pending": "Waiting: target runtime readiness is not confirmed", "task-concurrency": "Waiting: target task limit reached", "target-not-idle": "Target state is unknown; idle-loaded was not established" };
  assert.ok(sent.includes(phrases[cause]), sent);
  console.log(`EXAMPLE ${cause}: ${sent.split("\n").at(-1)}`);
});
test("legacy waiting records state detailed cause unavailable", async t => {
  const node = closedNode(t), id = deliver(node);
  assert.match(await output(node, id), /Waiting; detailed cause unavailable\./, "old received accepted");
  writeOutbox(node.paths, { messageId: id, fromSession: "synthetic", to: { nodeId: "00000000-0000-4000-8000-0000000000aa", session: SESSION }, text: "synthetic", createdAt: new Date(T0).toISOString() });
  writeDirectory(node.paths, { nodes: [], sessions: [], fetchedAt: new Date(T0).toISOString() });
  recordSent(node.paths, id, "queued", undefined, T0);
  assert.match(await output(node, id), /Waiting; detailed cause unavailable\./, "old sent queued");
  recordSent(node.paths, id, "accepted", undefined, T0);
  assert.match(await output(node, id), /Waiting; detailed cause unavailable\./, "old sent accepted");
});
