import assert from "node:assert/strict";
import test from "node:test";
import { automaticReplyDecision } from "./reply-admission.mts";
const loop = { version: 1 as const, threadId: "00000000-0000-4000-8000-000000000001", depth: 20, generation: 0, ordinal: 21 };
test("guarded depth twenty and ordinal256 pass; legacy six and malformed metadata fail closed", () => {
  assert.deepEqual(automaticReplyDecision({ depth: 20, loop }), { allowed: true, mode: "guarded" });
  assert.equal(automaticReplyDecision({ depth: 20, loop: { ...loop, ordinal: 256 } }).allowed, true);
  for (const depth of [6, 20, -1, NaN, Infinity, null as unknown as number]) assert.equal(automaticReplyDecision({ depth }).allowed, false);
  assert.deepEqual(automaticReplyDecision({}), { allowed: true, mode: "legacy" });
  for (const bad of [{ depth: 19, loop }, { depth: 20, loop: { ...loop, ordinal: 257 } }, { loop: undefined }]) {
    assert.equal(automaticReplyDecision(bad).allowed, false);
  }
});
