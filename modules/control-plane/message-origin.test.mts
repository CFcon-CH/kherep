import assert from "node:assert/strict";
import test from "node:test";
import { checkOrigin, MESSAGE_ADMISSION_MS, senderTime } from "./message-origin.mts";
const source = "00000000-0000-4000-8000-000000000001";
const T = Date.parse("2026-01-01T00:00:00.000Z");
const origin = { nodeId: source, sentAt: new Date(T).toISOString() };
test("24 hours start at sender time, with strict final deadline equality", () => {
  assert.deepEqual(checkOrigin(origin, source, T + 23 * 60 * 60_000), { ok: true, sentAtMs: T, deadlineMs: T + MESSAGE_ADMISSION_MS });
  assert.equal(checkOrigin(origin, source, T + MESSAGE_ADMISSION_MS - 1).ok, true);
  for (const now of [T + MESSAGE_ADMISSION_MS, T + MESSAGE_ADMISSION_MS + 1]) {
    assert.deepEqual(checkOrigin(origin, source, now), { ok: false, code: "origin-expired" });
  }
  assert.deepEqual(checkOrigin(origin, source, T - 1), { ok: false, code: "origin-future" });
});
test("legacy, malformed, unbound and unsafe clocks cannot authorize admission", () => {
  assert.deepEqual(checkOrigin(undefined, source, T), { ok: false, code: "origin-missing" });
  assert.deepEqual(checkOrigin(origin, "other", T), { ok: false, code: "origin-unbound" });
  for (const now of [NaN, Infinity, -1, T + 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(checkOrigin(origin, source, now), { ok: false, code: "origin-invalid" });
  }
  for (const sentAt of ["bad", "2026-01-01T00:00:00Z", "2026-02-30T00:00:00.000Z", "1969-12-31T23:59:59.999Z", "+275760-09-13T00:00:00.000Z", null]) {
    assert.equal(senderTime(sentAt), null);
    assert.deepEqual(checkOrigin({ ...origin, sentAt }, source, T), { ok: false, code: "origin-invalid" });
  }
});
