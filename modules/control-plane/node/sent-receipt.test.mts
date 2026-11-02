import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listenerDir, wakeAudit } from "./autonomy.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { deliverForCodex } from "./deliver-codex.mts";
import { MAX_CONTEXT_BYTES } from "./deliver-core.mts";
import { deliverForHook } from "./deliver-hook.mts";
import { getSent, markNoticed, recordSent, writeDirectory, writeLocalSessions, writeOutbox } from "./exchange.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import { runMsg } from "./msg-cli.mts";
import type { SentState } from "./client.mts";
import { RECEIPT_LINES, stillUnnoticed, unnoticedNotices } from "./sent-notices.mts";

// Issue #402: the sending session hears once that its message was received,
// at its next delivery hook event, without a wake, a turn or budget.

const PEER = "00000000-0000-4000-8000-0000000000cc";
const SELF = "s-self";
const CODEX = "019a2b3c-4d5e-7f60-8123-456789abcdef";
const REPLY = 'node "/opt/kherep/modules/control-plane/node/cli.mts"';
const NOW = Date.UTC(2026, 9, 12, 12);

function setup(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.com", nodeId: "00000000-0000-4000-8000-0000000000aa",
    name: "node-a", publicKey: "x", privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  writeLocalSessions(paths, [{ sessionId: SELF, runtime: "claude-code", state: "busy", name: "review" },
    { sessionId: CODEX, runtime: "codex", state: "active", name: "codex-89abcdef" }]);
  writeDirectory(paths, { nodes: [{ nodeId: PEER, name: "node-b", status: "online" }], sessions: [], fetchedAt: new Date(0).toISOString() });
  return paths;
}

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (n: number): string => new Date(NOW + n).toISOString();

// A message this node sent from fromSession, recorded in the given state at NOW + n.
function sent(paths: NodePaths, n: number, state: SentState | null, fromSession = "review", reason?: string, fromSessionId?: string): string {
  writeOutbox(paths, { messageId: id(n), fromSession, ...(fromSessionId ? { fromSessionId } : {}), to: { nodeId: PEER, session: "planner" },
    text: "report", createdAt: at(0) });
  if (state) recordSent(paths, id(n), state, reason, NOW + n);
  return id(n);
}

const receipt = (messageId: string, n: number): string =>
  `Your message ${messageId} to node-b (${PEER})/planner was received (confirmed ${at(n)}).`;

function hook(paths: NodePaths, event: string, extra: Record<string, unknown> = {}): string {
  const output = deliverForHook({ session_id: SELF, hook_event_name: event, permission_mode: "default", ...extra },
    { paths, nonce: () => "t0k3n", replyCommand: REPLY, now: () => NOW + 1_000 });
  return output ? (JSON.parse(output).hookSpecificOutput.additionalContext as string) : "";
}

const noTurnTaken = (paths: NodePaths): void => {
  assert.equal(fs.existsSync(wakeAudit(paths)), false, "no wake.jsonl entry");
  assert.equal(fs.existsSync(path.join(listenerDir(paths), `${SELF}.turns.json`)), false, "no turn budget taken");
};

test("a delivered message is reported once to its sender at UserPromptSubmit", (t) => {
  const paths = setup(t);
  const messageId = sent(paths, 1, "delivered");
  assert.equal(hook(paths, "UserPromptSubmit"), `Kherep: messages this session sent were received.\n\n${receipt(messageId, 1)}`);
  assert.equal(getSent(paths, messageId)?.noticedAt, at(1_000));
  assert.equal(hook(paths, "UserPromptSubmit"), "", "not twice");
  assert.equal(hook(paths, "PostToolUse"), "");
  noTurnTaken(paths);
});

test("no receipt before delivered, after replied, when a reply arrived, or for another session's message", (t) => {
  const paths = setup(t);
  const queued = sent(paths, 1, null);
  const accepted = sent(paths, 2, "accepted");
  const replied = sent(paths, 3, "replied");
  const answered = sent(paths, 4, "delivered");
  storeMessage(paths.inbox, { messageId: id(40), from: { nodeId: PEER, session: "planner" }, toSession: "review", text: "done",
    inReplyTo: answered, createdAt: at(5) }, NOW + 5);
  const foreign = sent(paths, 6, "delivered", "someone-else");
  const context = hook(paths, "UserPromptSubmit");
  for (const messageId of [queued, accepted, replied, answered, foreign]) {
    assert.ok(!context.includes(`Your message ${messageId}`), messageId);
    assert.equal(getSent(paths, messageId)?.noticedAt, undefined);
  }
  // Issue #520: the reply settles the answered record replied on this node.
  assert.equal(getSent(paths, answered)?.state, "replied");
  // A message that becomes delivered later is reported then.
  recordSent(paths, accepted, "delivered", undefined, NOW + 7);
  assert.ok(hook(paths, "UserPromptSubmit").includes(receipt(accepted, 7)));
});

test("a receipt alone never continues a turn at Stop; it waits for the next event and rides along with messages", (t) => {
  const paths = setup(t);
  const first = sent(paths, 1, "delivered");
  assert.equal(hook(paths, "Stop"), "");
  assert.equal(getSent(paths, first)?.noticedAt, undefined);
  noTurnTaken(paths);
  assert.ok(hook(paths, "PostToolUse", { tool_name: "Bash", tool_input: {}, tool_response: {} }).includes(receipt(first, 1)));
  noTurnTaken(paths);

  const second = sent(paths, 2, "delivered");
  storeMessage(paths.inbox, { messageId: id(50), from: { nodeId: PEER, session: "build" }, toSession: "review", text: "message 50",
    createdAt: at(3) }, NOW + 3);
  const atStop = hook(paths, "Stop", { stop_hook_active: false });
  assert.ok(atStop.includes("message 50") && atStop.includes(receipt(second, 2)));
});

test("receipts and failures together get one intro naming both; failure lines are unchanged", (t) => {
  const paths = setup(t);
  const refused = sent(paths, 1, "refused", "review", "target session not running");
  const delivered = sent(paths, 2, "delivered", SELF);
  const context = hook(paths, "UserPromptSubmit");
  assert.equal(context, "Kherep: some messages this session sent were not delivered; others were received.\n\n"
    + `Your message ${refused} to node-b (${PEER})/planner was not delivered: "target session not running"\n\n${receipt(delivered, 2)}`);
});

test("beyond RECEIPT_LINES receipts the older ones are counted in one line and all are marked", (t) => {
  const paths = setup(t);
  const ids = Array.from({ length: RECEIPT_LINES + 2 }, (_, i) => sent(paths, i + 1, "delivered"));
  const lines = hook(paths, "UserPromptSubmit").split("\n");
  assert.equal(lines[2], "2 earlier messages this session sent were received too.");
  assert.deepEqual(lines.slice(3), ids.slice(2).map((messageId, i) => receipt(messageId, i + 3)));
  for (const messageId of ids) assert.ok(getSent(paths, messageId)?.noticedAt);
});

test("receipts give way to peer messages when the context budget is short", (t) => {
  const paths = setup(t);
  const delivered = sent(paths, 1, "delivered");
  storeMessage(paths.inbox, { messageId: id(60), from: { nodeId: PEER, session: "build" }, toSession: "review",
    text: "x".repeat(MAX_CONTEXT_BYTES), createdAt: at(2) }, NOW + 2);
  const context = hook(paths, "UserPromptSubmit");
  assert.ok(context.includes(id(60)) && !context.includes(delivered));
  assert.equal(getSent(paths, delivered)?.noticedAt, undefined);
  assert.ok(hook(paths, "PostToolUse").includes(receipt(delivered, 1)));
});

test("a Codex sender sees the receipt at UserPromptSubmit and never at Stop", (t) => {
  const paths = setup(t);
  const codex = (event: string) => deliverForCodex({ session_id: CODEX, cwd: "/work/repo", hook_event_name: event, stop_hook_active: false },
    { paths, nonce: () => "t0k3n", replyCommand: REPLY, now: () => NOW + 1_000 });
  const messageId = sent(paths, 1, "delivered", CODEX);
  assert.equal(codex("Stop"), "");
  assert.equal(getSent(paths, messageId)?.noticedAt, undefined);
  const context: string = JSON.parse(codex("UserPromptSubmit")).hookSpecificOutput.additionalContext;
  assert.ok(context.startsWith(`Kherep: messages this session sent were received.\n\n${receipt(messageId, 1)}\n`));
  assert.ok(!JSON.parse(codex("UserPromptSubmit")).hookSpecificOutput.additionalContext.includes(messageId), "not twice");
  assert.equal(fs.existsSync(wakeAudit(paths)), false);
  assert.equal(fs.existsSync(path.join(listenerDir(paths), `${CODEX}.turns.json`)), false);
});

test("a receipt matches the sender by name alone or by its session id after a rename", (t) => {
  const paths = setup(t);
  const byName = sent(paths, 1, "delivered", "review");
  const byId = sent(paths, 2, "delivered", "old-name", undefined, SELF);
  const elsewhere = sent(paths, 3, "delivered", "old-name", undefined, "s-other");
  const context = hook(paths, "UserPromptSubmit");
  assert.ok(context.includes(receipt(byName, 1)) && context.includes(receipt(byId, 2)));
  assert.ok(!context.includes(elsewhere));
});

test("a receipt of another session id is not shown to a later session that reuses its name", (t) => {
  const paths = setup(t);
  const reused = sent(paths, 1, "delivered", "review", undefined, "s-other");
  assert.equal(hook(paths, "UserPromptSubmit"), "");
  assert.equal(getSent(paths, reused)?.noticedAt, undefined);
});

test("at Stop a receipt rides along with a failure notice and is marked", (t) => {
  const paths = setup(t);
  const refused = sent(paths, 1, "refused", "review", "target session not running");
  const delivered = sent(paths, 2, "delivered", "review", undefined, SELF);
  const context = hook(paths, "Stop", { stop_hook_active: false });
  assert.ok(context.includes(`Your message ${refused} to node-b (${PEER})/planner was not delivered: "target session not running"`));
  assert.ok(context.includes(receipt(delivered, 2)));
  assert.equal(getSent(paths, refused)?.noticedAt, at(1_000));
  assert.equal(getSent(paths, delivered)?.noticedAt, at(1_000));
});

test("receipts never cost a peer message block: they take only the room left after the blocks", (t) => {
  const seen = new Set<string>();
  const offeredWith = (receiptToo: boolean, size: number): number => {
    const paths = setup(t);
    if (receiptToo) sent(paths, 1, "delivered");
    const ids = [70, 71, 72].map((n) => {
      storeMessage(paths.inbox, { messageId: id(n), from: { nodeId: PEER, session: "build" }, toSession: "review",
        text: "y".repeat(size), createdAt: at(n) }, NOW + n);
      return id(n);
    });
    const context = hook(paths, "UserPromptSubmit");
    const printed = context.includes("was received");
    if (receiptToo) {
      assert.equal(printed, getSent(paths, id(1))?.noticedAt !== undefined, "only printed receipts are marked");
      seen.add(printed ? "printed" : "dropped");
    }
    return ids.filter((messageId) => getMessage(paths.inbox, messageId)?.state === "offered" && !context.includes("[truncated")).length;
  };
  for (let size = 1_800; size <= 2_100; size += 10) assert.equal(offeredWith(true, size), offeredWith(false, size), `size ${size}`);
  assert.deepEqual([...seen].sort(), ["dropped", "printed"], "the sizes cross the boundary where the receipt no longer fits");
});

test("Codex msg inbox --receive shows a receipt once", async (t) => {
  const paths = setup(t);
  recordCodexSession(paths, CODEX, "/work/repo", NOW);
  const messageId = sent(paths, 1, "delivered", CODEX);
  const receive = async (): Promise<string> => {
    const out: string[] = [];
    await runMsg(["inbox", "--from", CODEX, "--receive"], { paths, env: {}, now: () => NOW + 1_000, out: (l) => out.push(l), err: () => {} });
    return out.join("\n");
  };
  assert.ok((await receive()).includes(receipt(messageId, 1)));
  assert.equal(await receive(), "no messages waiting for this continuation");
});

test("a mid-turn call rereads only the records its one sent/ scan found, and drops those told meanwhile", (t) => {
  const paths = setup(t);
  const [told, due] = [sent(paths, 1, "delivered"), sent(paths, 2, "delivered")];
  const failure = sent(paths, 3, "refused", "review", "policy");
  const found = unnoticedNotices(paths, [SELF, "review"]);
  markNoticed(paths, told, NOW);
  sent(paths, 4, "delivered"); // after the scan: waits for the next call
  const fresh = stillUnnoticed(paths, found);
  assert.deepEqual([fresh.receipts.map((r) => r.messageId), fresh.failures.map((r) => r.messageId)], [[due], [failure]]);
});

test("a loop hold is shown once without an outgoing message, wake or autonomous turn", async (t) => {
  const paths = setup(t);
  const reason = `loop-held: ack-or-repeat; hold=${id(91)}; operator release required`;
  const messageId = sent(paths, 90, "refused", "review", reason);
  const first = hook(paths, "UserPromptSubmit");
  assert.ok(first.includes(reason));
  assert.equal(hook(paths, "UserPromptSubmit"), "");
  assert.ok(getSent(paths, messageId)?.noticedAt);
  assert.deepEqual(fs.readdirSync(paths.outbox), []);
  noTurnTaken(paths);
  const out: string[] = [];
  const code = await runMsg(["status", messageId], { paths, env: {}, now: () => NOW, out: (s) => out.push(s), err: assert.fail, sleep: async () => {} });
  assert.equal(code, 0); assert.ok(out.join("\n").includes(reason));
});
