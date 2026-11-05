import assert from "node:assert/strict";
import test from "node:test";
import { isMessageStatusBody } from "./protocol-messages.mts";
const messageId = "00000000-0000-4000-8000-000000000001";
const observedAt = "2026-11-05T00:00:00.000Z";
const diagnostic = { version: 1, kind: "blocker", stage: "target-progress", observedAt, code: "runtime-pending" };
test("status accepts a strictly bounded diagnostic without changing the legacy state", () => {
  assert.equal(isMessageStatusBody({ messageId, state: "accepted", diagnostic }), true);
  for (const invalid of [{ ...diagnostic, version: 2 }, { ...diagnostic, code: "invented" }, { ...diagnostic, value: "private" },
    { ...diagnostic, stage: "invented" }, { ...diagnostic, observedAt: "yesterday" }, { ...diagnostic, dimensions: ["owner"] }]) {
    assert.equal(isMessageStatusBody({ messageId, state: "accepted", diagnostic: invalid }), false);
  }
});

test("identity dimensions reject duplicates, unsorted, unknown and unbounded detail", async () => {
  const { isMessageDiagnostic, sortedDimensions, renderMessageDiagnostic, compatibleDiagnostic, MESSAGING_DIAGNOSTICS_CAPABILITY } = await import("./protocol-diagnostics.mts");
  const identity = { version: 1, kind: "identity-change", stage: "send-admission", observedAt, dimensions: ["capability", "connection"] };
  assert.equal(isMessageDiagnostic(identity), true);
  for (const dimensions of [[], ["owner", "owner"], ["owner", "capability"], ["value"], Array(11).fill("owner")]) assert.equal(isMessageDiagnostic({ ...identity, dimensions }), false);
  assert.deepEqual(sortedDimensions(["owner", "capability", "owner"]), ["capability", "owner"]);
  assert.match(renderMessageDiagnostic(identity as never, "refused"), /Refused: identity changed \(capability, connection\)/);
  assert.equal(renderMessageDiagnostic(null, "queued"), "Waiting; detailed cause unavailable.");
  const body = { messageId, state: "accepted", diagnostic: diagnostic as never };
  assert.deepEqual(compatibleDiagnostic(body, null), { messageId, state: "accepted" });
  assert.deepEqual(compatibleDiagnostic(body, [MESSAGING_DIAGNOSTICS_CAPABILITY]), body);
});

test("every closed code renders fixed plain words and compatibility passes archived status validation", async () => {
  const { BLOCKER_CODES, blockerDiagnostic, renderMessageDiagnostic, compatibleDiagnostic } = await import("./protocol-diagnostics.mts");
  const archived = await import("./test/fixtures/diagnostics-pre-v1.mts");
  for (const code of BLOCKER_CODES) {
    const detail = blockerDiagnostic(code, 0);
    assert.equal(isMessageStatusBody({ messageId, state: "queued", diagnostic: detail }), true);
    assert.match(renderMessageDiagnostic(detail, "queued"), /Observed 1970-01-01T00:00:00.000Z; stage target-progress/);
    assert.equal(archived.isMessageStatusBody(compatibleDiagnostic({ messageId, state: "queued", diagnostic: detail }, [])), true);
  }
  assert.match(renderMessageDiagnostic(blockerDiagnostic("target-not-idle", 0, "target-progress", "unknown"), "accepted"), /Target state is unknown/);
});

test("blocker wording follows the current message state", async () => {
  const { blockerDiagnostic, renderMessageDiagnostic } = await import("./protocol-diagnostics.mts");
  for (const state of ["queued", "accepted", "offered", "refused", "delivered", "replied", "expired", "error"]) {
    const prefix = ["queued", "accepted", "offered"].includes(state) ? "Waiting:" : state === "refused" ? "Refused:" : "Last blocker:";
    assert.ok(renderMessageDiagnostic(blockerDiagnostic("runtime-pending", 0), state).startsWith(prefix), state);
  }
});

test("the turn-budget lock has a precise code and wording without a storage alias", async () => {
  const { renderMessageDiagnostic, isMessageDiagnostic } = await import("./protocol-diagnostics.mts");
  const lock = { ...diagnostic, code: "budget-lock-unavailable" };
  assert.equal(isMessageDiagnostic(lock), true);
  assert.equal(isMessageDiagnostic({ ...lock, code: "budget-storage-unavailable" }), false);
  assert.match(renderMessageDiagnostic(lock as never, "queued"), /Waiting: target turn-budget lock is unavailable/);
});
