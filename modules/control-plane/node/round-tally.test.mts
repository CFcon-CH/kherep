import assert from "node:assert/strict";
import test from "node:test";

import { makeEnvelope, MAX_FRAME_BYTES, MESSAGE_TYPES, PHASE1_COMMANDS, PONG_FRAME, SESSION_COMMANDS } from "../protocol.mts";
import { MESSAGE_STATES } from "../protocol-messages.mts";
import { TASK_CONTROL_ACTIONS } from "../protocol-task-control.mts";
import { classifySocketError, roundTally, SOCKET_ERROR_CODES, TALLY_KINDS, tallyKind } from "./round-tally.mts";

// Issue #493 D2 (design revision 2, section 4.4 items 1-4): the counters line
// names only closed kinds and counts, never a received string.

const MARKER = "synthetic-private-marker";
const ID = "00000000-0000-4000-8000-000000000001";
const frame = (type: string, body: Record<string, unknown>): string => JSON.stringify(makeEnvelope(type as never, body, 0, 0));
const command = (name: unknown): string => frame("command", { commandId: "c1", command: name });
const control = (action: string): string => frame("event", { name: "task.control.execute", operationId: ID,
  requestId: "00000000-0000-4000-8000-000000000002", taskId: "00000000-0000-4000-8000-000000000004", action, ownerNodeId: ID, targetNodeId: ID,
  runtime: "codex", origin: { kind: "source-request", sourceRequestId: "00000000-0000-4000-8000-000000000003" }, grantVersion: 1,
  ...(action === "stop" ? { expectedRunVersion: "0".repeat(64) } : {}) });
const SUMMARY = new RegExp(`^((${[...TALLY_KINDS, "other"].map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}) \\d+(, |$))*$`);

test("item 1: marker and cardinality stay bounded to TALLY_KINDS", () => {
  assert.equal(TALLY_KINDS.length, 1 + 1 + 1 + 1 + 2 + 1 + 6 + 2 + 6 + 1 + 24 + 1);
  assert.equal(TALLY_KINDS.length, 47);
  assert.equal(tallyKind(command(MARKER)), "command:unknown");
  const tally = roundTally();
  for (let n = 0; n < 200; n++) tally.add(tallyKind(command(`${MARKER}-${n}`)));
  const commands = tally.take();
  assert.deepEqual(commands, { total: 200, summary: "command:unknown 200" });
  for (let n = 0; n < 100; n++) tally.add(n === 50 ? MARKER : `synthetic-kind-${n}`);
  const added = tally.take();
  assert.deepEqual(added, { total: 100, summary: "unknown 100" });
  assert.ok(!`${commands.summary}${added.summary}`.includes(MARKER));
  for (const kind of TALLY_KINDS) for (let n = 0; n <= TALLY_KINDS.indexOf(kind) % 5; n++) tally.add(kind);
  for (let n = 0; n < 50; n++) tally.add(`${MARKER}-${n}`);
  const mixed = tally.take();
  const listed = [...mixed.summary.matchAll(/ (\d+)(?:, |$)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  assert.equal(listed, mixed.total, "listed counts plus other equal the total");
  assert.equal(mixed.summary.split(", ").length, 9, "eight kinds and other");
  assert.match(mixed.summary, SUMMARY);
  assert.deepEqual(tally.take(), { total: 0, summary: "" });
});

test("item 2: malformed bodies map to fixed buckets, valid ones to their closed member", () => {
  assert.equal(tallyKind(`not json ${MARKER}`), "frame:invalid");
  assert.equal(tallyKind(JSON.stringify({ ...makeEnvelope("event", { name: "x" }, 0, 0), type: MARKER })), "frame:invalid");
  assert.equal(tallyKind(frame("message.status", { messageId: ID, state: "synthetic-state" })), "frame:message.status:invalid");
  assert.equal(tallyKind(control("synthetic-action")), "frame:event");
  assert.equal(tallyKind(frame("event", { name: MARKER })), "frame:event");
  assert.equal(tallyKind(frame("command", { command: "node.status" })), "command:invalid");
  for (const state of MESSAGE_STATES) {
    assert.equal(tallyKind(frame("message.status", { messageId: ID, state })), `frame:message.status:${state}`);
  }
  for (const action of TASK_CONTROL_ACTIONS) assert.equal(tallyKind(control(action)), `task-control:${action}`);
  for (const name of [...PHASE1_COMMANDS, ...SESSION_COMMANDS]) assert.equal(tallyKind(command(name)), `command:${name}`);
  assert.equal(tallyKind(command(7)), "command:invalid");
  assert.equal(tallyKind(PONG_FRAME), "pong");
  assert.equal(tallyKind(frame("event", { name: "pong" })), "frame:event", "a pong inside an envelope is not a pong");
  assert.equal(tallyKind(frame("event", { name: "auth.ok" })), "auth");
  assert.equal(tallyKind(frame("event", { name: "message.receipt", messageId: ID, requestedState: "accepted", storedState: "accepted" })),
    "frame:event:receipt");
  assert.equal(tallyKind(frame("event", { name: "message.receipt", messageId: ID, text: MARKER })), "frame:event");
});

test("item 3: oversize frames are invalid without an exception, a frame of exactly the limit is classified", () => {
  assert.equal(tallyKind("x".repeat(MAX_FRAME_BYTES + 1)), "frame:invalid");
  const pad = (target: number): string => {
    const base = frame("message.status", { messageId: ID, state: "refused", reason: "" });
    return frame("message.status", { messageId: ID, state: "refused", reason: "r".repeat(target - base.length) });
  };
  assert.equal(pad(MAX_FRAME_BYTES + 1).length, MAX_FRAME_BYTES + 1);
  assert.equal(tallyKind(pad(MAX_FRAME_BYTES + 1)), "frame:invalid");
  const exact = pad(MAX_FRAME_BYTES);
  assert.equal(exact.length, MAX_FRAME_BYTES);
  // A valid envelope; the long reason fails isMessageStatusBody, so it lands in the closed invalid bucket.
  assert.equal(tallyKind(exact), "frame:message.status:invalid");
  const accepted = frame("message.status", { messageId: ID, state: "accepted" });
  const padded = "{" + " ".repeat(MAX_FRAME_BYTES - accepted.length) + accepted.slice(1);
  assert.equal(padded.length, MAX_FRAME_BYTES);
  assert.equal(tallyKind(padded), "frame:message.status:accepted");
});

test("item 4: every MESSAGE_TYPES member yields a TALLY_KINDS member", () => {
  const tally = roundTally();
  for (const type of MESSAGE_TYPES) {
    const kind = tallyKind(frame(type, {}));
    assert.ok((TALLY_KINDS as readonly string[]).includes(kind), `${type} -> ${kind}`);
    if (!["event", "command", "message.status"].includes(type)) assert.equal(kind, `frame:${type}`);
    tally.add(kind);
  }
  const { total, summary } = tally.take();
  assert.equal(total, MESSAGE_TYPES.length);
  assert.match(summary, SUMMARY);
});

test("D2b: classifySocketError returns a listed code, unknown or missing, never a message", () => {
  const error = (code: unknown): unknown => ({ error: Object.assign(new Error(`${MARKER} 192.0.2.1`), { code }) });
  for (const code of SOCKET_ERROR_CODES) assert.equal(classifySocketError(error(code)), code);
  assert.equal(classifySocketError(error(MARKER)), "unknown");
  assert.equal(classifySocketError(error("EPROTO")), "unknown");
  assert.equal(classifySocketError(error(42)), "missing");
  assert.equal(classifySocketError({ error: new Error(MARKER) }), "missing");
  assert.equal(classifySocketError({ message: MARKER }), "missing");
  assert.equal(classifySocketError(null), "missing");
});
