import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nodePaths } from "./config.mts";
import { deliverForHook } from "./deliver-hook.mts";
import { writeLocalSessions } from "./exchange-sessions.mts";
import { getMessage, markClosedAttempt, setDeliveryTask, storeMessage } from "./inbox.mts";
import { acknowledgeCodexOffer, prepareCodexOffers } from "./codex-inbox-ack.mts";
import { readMcpInbox } from "./mcp-local.mts";
import { pending } from "./wake-pending.mts";
import { handoverTaskMessages } from "./task-handover.mts";
import { automaticReplyDecision } from "./reply-admission.mts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PEER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
test("S06: Claude hook cannot consume exact owner through another owner's alias", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-bound-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  writeLocalSessions(paths, [{ sessionId: A, runtime: "claude-code", state: "unknown" },
    { sessionId: B, name: A, runtime: "claude-code", state: "unknown" }]);
  const owner = { sessionId: A, runtime: "claude-code", lifecycleGeneration: null };
  storeMessage(paths.inbox, { messageId: ID, from: { nodeId: PEER, session: "source" }, toSession: A,
    text: "Synthetic exact-owner message", createdAt: new Date(0).toISOString(),
    binding: { version: 1, mode: "exact", from: { ...owner, sessionId: "source", runtime: "codex" }, to: owner, leaseId: ID, localGeneration: null } } as never);
  const wrong = deliverForHook({ hook_event_name: "UserPromptSubmit", session_id: B }, { paths });
  assert.equal(wrong, "");
  assert.equal(getMessage(paths.inbox, ID)?.state, "accepted");
  const right = deliverForHook({ hook_event_name: "UserPromptSubmit", session_id: A }, { paths });
  assert.match(right, /Synthetic exact-owner message/);
  assert.equal(getMessage(paths.inbox, ID)?.state, "offered");
});

test("S06 S30 S31: bound Codex records reject foreign runtime intake, ACK, wake and retarget", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-bound-consumers-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  writeLocalSessions(paths, [{ sessionId: A, runtime: "codex", state: "unknown" }, { sessionId: B, name: A, runtime: "claude-code", state: "unknown" }]);
  const owner = { sessionId: A, runtime: "codex", lifecycleGeneration: null };
  const body = { messageId: ID, from: { nodeId: PEER, session: "source" }, toSession: A, text: "Synthetic bound message",
    createdAt: new Date(0).toISOString(), binding: { version: 1 as const, mode: "exact" as const,
      from: { ...owner, sessionId: "source" }, to: owner, leaseId: ID, localGeneration: null } };
  const record = storeMessage(paths.inbox, body, 100);
  assert.equal(deliverForHook({ hook_event_name: "UserPromptSubmit", session_id: A }, { paths }), "");
  assert.deepEqual(readMcpInbox(paths, A, 10, undefined, "claude-code"), []);
  assert.equal(readMcpInbox(paths, A, 10, undefined, "codex").length, 1);
  assert.deepEqual(pending(paths, [B, A], B, { event: "SessionStart", startedAt: 0 }, 10000).fresh, []);
  assert.deepEqual(prepareCodexOffers(paths, [record], B, crypto.randomUUID(), 200, "receive"), []);
  const token = crypto.randomUUID();
  assert.equal(prepareCodexOffers(paths, [record], A, token, 200, "receive").length, 1);
  assert.throws(() => acknowledgeCodexOffer(paths, B, token, [B, A]), /wrong-owner/);
  assert.throws(() => markClosedAttempt(paths.inbox, ID, 300, B), /bound owner/);
  assert.throws(() => setDeliveryTask(paths.inbox, ID, { taskId: PEER, runtime: "codex", sessionId: B }), /bound delivery owner/);
  handoverTaskMessages(paths.inbox, A, B, { taskId: PEER, runtime: "codex" });
  assert.equal(getMessage(paths.inbox, ID)?.toSession, A);
  assert.equal(automaticReplyDecision({ ...record, binding: { ...record.binding!, version: 2 as 1 } }).allowed, false);
  assert.match(acknowledgeCodexOffer(paths, A, token, [A]), /local processing ACK committed/);
});
