import assert from "node:assert/strict";
import test from "node:test";

import { deliverToClosed } from "./closed-delivery.mts";
import { closedNode, COPY, copyingExec, deliver, endedIntercom, missListings, SESSION } from "./closed-fixture.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessage, refuseUndeliverable, UNDELIVERABLE_AFTER_MS } from "./inbox.mts";
import { runMsg } from "./msg-cli.mts";

// Issue #111, message 96ad5a0f: a message for a closed session, readdressed to
// the copy its intercom session was resumed as and answered from there, got
// "not delivered: target session not running" an hour later. The copy's first
// UserPromptSubmit ran before the node readdressed the message to it, so no
// turn offered it; the copy read it with `msg inbox` and answered with
// --reply-to, which left it accepted. Once the copy ended, the undeliverable
// sweep refused it.

async function reply(node: ReturnType<typeof closedNode>, session: string, messageId: string, now: number): Promise<number> {
  return runMsg(["send", "--reply-to", messageId, "green"], { paths: node.paths, env: { CLAUDE_CODE_SESSION_ID: session },
    now: () => now, out: () => {}, err: () => {}, sleep: async () => {} });
}

test("a readdressed message the copy answered is not refused when the copy has ended", async (t) => {
  const node = closedNode(t);
  const { id } = await endedIntercom(node);
  const fake = copyingExec(node, true, () => {});
  await deliverToClosed(fake.deps);
  const now = fake.deps.now!();
  assert.deepEqual([getMessage(node.paths.inbox, id)?.toSession, getMessage(node.paths.inbox, id)?.closedTo], [COPY, SESSION]);
  assert.equal(await reply(node, COPY, id, now), 0);
  const later = now + UNDELIVERABLE_AFTER_MS + 60_000;
  assert.deepEqual(refuseUndeliverable(node.paths.inbox, [], later), []);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "delivered");
});

test("a readdressed message is judged from its handover, not from its arrival", async (t) => {
  const node = closedNode(t);
  const { id } = await endedIntercom(node);
  const fake = copyingExec(node, true, () => {});
  // It arrived more than an hour before the intercom session took it over.
  node.tick(UNDELIVERABLE_AFTER_MS);
  const handed = fake.deps.now!();
  missListings(node, 1, handed);
  await deliverToClosed(fake.deps);
  assert.equal(getMessage(node.paths.inbox, id)?.toSession, COPY);
  assert.deepEqual(refuseUndeliverable(node.paths.inbox, [], handed + 60_000), []);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
  // Unanswered an hour after the handover, with its session gone: refused.
  assert.deepEqual(refuseUndeliverable(node.paths.inbox, [], handed + UNDELIVERABLE_AFTER_MS + 60_000), [], "unknown still waits");
  assert.deepEqual(refuseUndeliverable(node.paths.inbox, [], handed + UNDELIVERABLE_AFTER_MS + 60_000,
    undefined, undefined, () => false, ref => ref === COPY), [id], "fresh positive closure is independently required");
});

test("a message for a session that is not running is still refused after an hour", async (t) => {
  const node = closedNode(t);
  const id = deliver(node, { toSession: "e0e0e0e0-0000-4000-8000-000000000000" });
  const received = Date.parse(getMessage(node.paths.inbox, id)!.receivedAt);
  assert.deepEqual(refuseUndeliverable(node.paths.inbox, [], received + UNDELIVERABLE_AFTER_MS), []);
  assert.deepEqual(refuseUndeliverable(node.paths.inbox, [], received + UNDELIVERABLE_AFTER_MS + 1), [], "age alone cannot refuse UNKNOWN");
  assert.deepEqual(refuseUndeliverable(node.paths.inbox, [], received + UNDELIVERABLE_AFTER_MS + 1,
    undefined, undefined, () => false, ref => ref === "e0e0e0e0-0000-4000-8000-000000000000"), [id]);
  assert.equal(getMessage(node.paths.inbox, id)?.reason, "target session not running");
});

test("a reply marks the waiting message it answers as delivered, and nothing else", async (t) => {
  const node = closedNode(t);
  const answered = deliver(node);
  const other = deliver(node, { text: "and the lint?" });
  const now = node.deps().now!();
  assert.equal(await reply(node, SESSION, answered, now), 0);
  assert.deepEqual([getMessage(node.paths.inbox, answered)?.state, getMessage(node.paths.inbox, other)?.state], ["delivered", "accepted"]);
});
