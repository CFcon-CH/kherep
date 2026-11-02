import assert from "node:assert/strict";
import test from "node:test";
import { isMessageDeliverBody, isMessageSendBody } from "./protocol-messages.mts";

const id = "00000000-0000-4000-8000-000000000001";
const delivery = { messageId: id, from: { nodeId: id, session: "synthetic-a" }, toSession: "synthetic-b", text: "work",
  createdAt: new Date(0).toISOString() };
const loop = { version: 1, threadId: id, depth: 20, generation: 0, ordinal: 21 };

test("Worker delivery accepts absent or valid loop metadata and refuses malformed present metadata", () => {
  assert.equal(isMessageDeliverBody(delivery), true);
  assert.equal(isMessageDeliverBody({ ...delivery, loop }), true);
  for (const invalid of [null, {}, { ...loop, version: 2 }, { ...loop, depth: -1 }, { ...loop, depth: NaN },
    { ...loop, depth: Number.MAX_SAFE_INTEGER + 1 }, { ...loop, ordinal: 257 }, { ...loop, ordinal: 0 },
    { ...loop, generation: 1.5 }, { ...loop, threadId: "invented" }, { ...loop, extra: true }]) {
    assert.equal(isMessageDeliverBody({ ...delivery, loop: invalid }), false, JSON.stringify(invalid));
  }
});

test("node send cannot submit Worker loop metadata or direction", () => {
  const send = { messageId: id, fromSession: "synthetic", to: { nodeId: id, session: "peer" }, text: "work" };
  assert.equal(isMessageSendBody(send), true);
  for (const authority of [{ loop }, { loop_direction: 0 }, { loop_pair: "invented" }]) assert.equal(isMessageSendBody({ ...send, ...authority }), false);
});

// Fixed diagnostics keep status readback from becoming a free-text exfiltration path.
test("loop status reasons accept only finite diagnostics and canonical hold IDs", async () => {
  const { safeLoopReason } = await import("./protocol-loop-brake.mts");
  assert.equal(safeLoopReason("loop-lineage-unavailable"), "loop-lineage-unavailable");
  const held = `loop-held: ack-or-repeat; hold=${id}; operator release required`;
  assert.equal(safeLoopReason(held), held);
  for (const text of ["private peer text", "loop-held: unknown; hold=x; operator release required", held + " extra"]) assert.equal(safeLoopReason(text), undefined);
});
