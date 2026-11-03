import assert from "node:assert/strict";
import test from "node:test";

import { TURN_SPACING_MS } from "./autonomy.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { audits, closedNode, deliver, SESSION, turnDone, type Node } from "./closed-fixture.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessage, getMessageProgress, type InboxRecord } from "./inbox.mts";
import { NO_PROGRESS_MS } from "./run-progress.mts";
import { BAD_IDS, bgRuns, label, listingVariant, turnsOf } from "./session-id-fixture.mts";
import { T0 } from "./task-fixture.mts";
import { listTasks, MAPPING_WINDOW_MS, type TaskRecord } from "./task-records.mts";
import { written } from "./task-watch-invalid-fixture.mts";
import { watchTasks } from "./task-watch.mts";

// Issue #639: a new intercom session started by the closed-session fallback
// whose listing shows a malformed full id stays delivery-pending under its task
// name; the early attempt mark stays before the start. A later valid listing
// maps it, its completed turn delivers. Synthetic ids and a fake claude only.
const FIRST = "5e550000-0000-4000-8000-000000000001";
const stops = (node: Node): string[] => node.calls.filter((c) => c.args[0] === "stop").map((c) => c.args[1]);
const leaked = (node: Node, bad: string): boolean => written(node).includes(JSON.stringify(bad).slice(1, -1));

// Steps 1-2: one accepted message for the closed session; the fallback's start lists bad.
async function malformedStart(t: test.TestContext, bad: string) {
  const node = closedNode(t);
  const id = deliver(node);
  const seen: { during: InboxRecord | null } = { during: null };
  const listing = listingVariant(node, node.deps(), (args) => { if (args[0] === "--bg") seen.during = getMessage(node.paths.inbox, id); });
  listing.arm(bad);
  const lines: string[] = [];
  await deliverToClosed({ ...listing.deps, log: (l) => lines.push(l) }, (l) => lines.push(l));
  return { node, listing, id, during: seen.during, lines };
}

// Step 3: the state after the start, read from the files.
function assertPendingStart(node: Node, id: string, during: InboxRecord | null, bad: string, lines: string[]): TaskRecord {
  assert.deepEqual([during?.state, during?.toSession, during?.offeredBy, during?.delivery], ["offered", SESSION, "intercom", {taskId:listTasks(node.paths)[0].taskId,runtime:"claude"}]);
  assert.ok(during?.closedAttempt, "the attempt was marked before the native start");
  const tasks = listTasks(node.paths);
  assert.equal(tasks.length, 1);
  const [task] = tasks;
  assert.deepEqual([task.state, task.sessionId, task.shortId, task.deliveryPending, task.carried, task.local],
    ["started", undefined, "b0000000", [id], [id], "intercom"]);
  const runs = node.calls.filter((c) => c.args[0] === "--bg");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].args[5].split(`--reply-to ${id} `).length - 1, 1, "the message is framed once");
  const message = getMessage(node.paths.inbox, id)!;
  assert.deepEqual([message.state, message.offers, message.offeredBy, message.toSession, message.closedTo, message.delivery],
    ["offered", 1, "intercom", SESSION, undefined, { taskId: task.taskId, runtime: "claude" }]);
  assert.ok(message.closedAttempt);
  assert.equal(getMessageProgress(node.paths.inbox, id)?.code, "fallback-running");
  assert.deepEqual(node.reports(), [], "an intercom task reports nothing");
  assert.deepEqual(audits(node).map((a) => [a.outcome, a.messageIds]), [["new", [id]]]);
  assert.ok(!leaked(node, bad) && !lines.some((l) => l.includes(bad)), "the malformed id is neither written nor logged");
  return task;
}

for (const bad of BAD_IDS) {
  test(`R3: a fallback start listed with ${label(bad)} full id hands over, maps later and delivers on completion`, async (t) => {
    const { node, listing, id, during, lines } = await malformedStart(t, bad);
    const task = assertPendingStart(node, id, during, bad, lines);
    // Step 4: a valid listing before any deadline maps the pending delivery identity.
    listing.disarm();
    node.tick(30_000);
    await watchTasks(listing.deps);
    const mapped = listTasks(node.paths)[0];
    assert.deepEqual([mapped.sessionId, mapped.deliveryPending, mapped.mappingPendingSince], [FIRST, undefined, undefined]);
    let message = getMessage(node.paths.inbox, id)!;
    assert.deepEqual([message.state, message.offers, message.toSession, message.closedTo, message.delivery],
      ["offered", 1, FIRST, SESSION, { taskId: task.taskId, runtime: "claude", sessionId: FIRST }], "offered, not delivered");
    assert.ok(message.closedAttempt);
    assert.equal(bgRuns(node), 1);
    // Step 5: its completed turn delivers; another round starts and offers nothing again.
    await turnDone(node);
    message = getMessage(node.paths.inbox, id)!;
    assert.equal(message.state, "delivered");
    assert.equal(listTasks(node.paths)[0].carried, undefined);
    await deliverToClosed(listing.deps);
    await watchTasks(listing.deps);
    assert.equal(bgRuns(node), 1);
    assert.equal(getMessage(node.paths.inbox, id)?.offers, 1);
  });

  test(`R3b: ${label(bad)} full id still listed keeps the task pending past both windows; the deadline stops it by short id`, async (t) => {
    const { node, listing, id, during, lines } = await malformedStart(t, bad);
    const task = assertPendingStart(node, id, during, bad, lines);
    const deadline = Date.parse(task.deadline);
    assert.ok(deadline > T0 + NO_PROGRESS_MS + MAPPING_WINDOW_MS, "the deadline lies beyond both windows");
    for (const at of [T0 + MAPPING_WINDOW_MS + 1_000, T0 + NO_PROGRESS_MS + 1_000]) {
      node.tick(at - node.deps().now!());
      await watchTasks(listing.deps, (l) => lines.push(l));
      const saved = listTasks(node.paths)[0];
      assert.deepEqual([saved.state, saved.sessionId, saved.deliveryPending, saved.carried], ["started", undefined, [id], [id]], `at ${at - T0}`);
      const message = getMessage(node.paths.inbox, id)!;
      assert.deepEqual([message.state, message.offers, message.toSession], ["offered", 1, SESSION]);
      assert.equal(getMessageProgress(node.paths.inbox, id)?.code, "fallback-running", "no refusal");
      assert.deepEqual([node.reports(), stops(node), bgRuns(node)], [[], [], 1]);
      assert.ok(!leaked(node, bad) && !lines.some((l) => l.includes(bad)));
    }
    node.tick(deadline - node.deps().now!());
    await watchTasks(listing.deps, (l) => lines.push(l));
    assert.deepEqual(stops(node), ["b0000000"], "the deadline stop uses the usable short id");
    const stopped = listTasks(node.paths)[0];
    assert.deepEqual([stopped.state, stopped.reason, stopped.sessionId, stopped.running], ["stopped", "max runtime reached", undefined, undefined]);
    assert.equal(bgRuns(node), 1);
    assert.ok(!leaked(node, bad));
  });
}

test("running reuse: a further message for the pending intercom task attaches under its name, without a run", async (t) => {
  const bad = BAD_IDS[1];
  const { node, listing, id, during, lines } = await malformedStart(t, bad);
  const task = assertPendingStart(node, id, during, bad, lines);
  const turns = turnsOf(node, SESSION);
  node.tick(TURN_SPACING_MS * 2);
  writeLocalSessions(node.paths, [], T0 + TURN_SPACING_MS * 2);
  const second = deliver(node, { text: "and the lint?" });
  await deliverToClosed(listing.deps);
  assert.equal(bgRuns(node), 1, "no extra run");
  assert.deepEqual(listTasks(node.paths)[0].deliveryPending, [id],"unmeasured original attempt keeps exactly its original members");
  const message = getMessage(node.paths.inbox, second)!;
  assert.deepEqual([message.state,message.toSession,message.closedTo,message.delivery],["accepted",SESSION,undefined,undefined]);
  assert.equal(message.closedAttempt,undefined);
  assert.ok(message.targetAttempt===undefined,"no pre-claim readdress or attachment");
  assert.equal(turnsOf(node, SESSION), turns, "no budget turn for a running reuse");
});
