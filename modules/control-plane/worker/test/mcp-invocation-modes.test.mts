import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { SessionInfo } from "../../protocol.mts";
import { registry } from "./helpers.mts";
import {
  CHAT_A, CHAT_B, PEER_SESSION, WAIT, claudeMeta, delivered, peerSend, sessionsOf, startNativeNode, startPeer,
  type HookOutput, type NativeNode,
} from "./mcp-two-chat-fixture.mts";

// Issue #193 at source level: parallel, resumed and subagent calls and the
// normal permission flow, each through the real trusted hook, node intent
// exchange, Registry and MCP HTTP tools. All identifiers are synthetic. This
// does not replace the real-client canaries the issue requires.
type Input = Record<string, unknown>;
const nativeInput = (sessionId: string, toolUseId: string, tool: string, input: Input, extra: Input = {}): Input => ({
  hook_event_name: "PreToolUse", tool_name: `mcp__kherep_messaging__${tool}`, session_id: sessionId,
  tool_use_id: toolUseId, tool_input: input, ...extra,
});

// Normal permission flow: the Claude hook output is exactly the argument
// rewrite and never carries a permission decision, so Claude's own approval applies.
function claudeRewrite(output: HookOutput | null, input: Input): Input {
  expect(output).toStrictEqual({ hookSpecificOutput: { hookEventName: "PreToolUse",
    updatedInput: { ...input, requestId: expect.any(String) } } });
  return output!.hookSpecificOutput.updatedInput!;
}

const intentRows = (ids: unknown[]) => runInDurableObject(registry(), (_instance, state) => ids.map((id) =>
  state.storage.sql.exec("SELECT * FROM mcp_intents WHERE request_id = ?", String(id)).one()));
const messageOf = async (node: NativeNode, id: unknown) =>
  (await registry().listMessages(node.nodeId, 100)).find((message) => message.messageId === id);
const listedOn = async (node: NativeNode, sessionId: string) =>
  (await registry().directory()).sessions.some((session) => session.nodeId === node.nodeId && session.sessionId === sessionId);

describe("native MCP invocation modes (issue #193)", () => {
  it("claims concurrent calls from one chat in one turn exactly once, each as that chat", async () => {
    const peer = await startPeer();
    const node = await startNativeNode("modes-parallel", sessionsOf(CHAT_A, CHAT_B));
    try {
      const to = { nodeId: peer.nodeId, session: PEER_SESSION };
      const seen = peerSend(peer.socket, { nodeId: node.nodeId, session: CHAT_A }, "synthetic text for chat A");
      await vi.waitFor(async () => expect(await messageOf(node, seen)).toBeDefined(), WAIT);
      const calls = [["toolu_parallel_1", "send", { to, text: "synthetic first text" }],
        ["toolu_parallel_2", "send", { to, text: "synthetic second text" }],
        ["toolu_parallel_3", "status", { messageId: seen }], ["toolu_parallel_4", "sessions", {}]] as const;
      // Claude Code runs the PreToolUse hook of each parallel call concurrently.
      const outputs = await Promise.all(calls.map(([id, tool, input]) => node.nativeHook(nativeInput(CHAT_A, id, tool, input))));
      const args = outputs.map((output, index) => claudeRewrite(output, calls[index]![2]));
      expect(new Set(args.map((value) => value.requestId)).size).toBe(calls.length);

      // One chat, one MCP connection, concurrent requests.
      const chat = await node.mcp();
      const callAll = (shift: number) => Promise.all(calls.map(([, tool], index) => chat.callTool({ name: tool,
        arguments: args[index], _meta: claudeMeta(calls[(index + shift) % calls.length]![0]) })));
      const results = await callAll(0);
      expect(results.map((result) => result.isError ?? false)).toEqual([false, false, false, false]);
      expect(results[0]!.structuredContent).toMatchObject({ ok: true, messageId: args[0]!.requestId });
      expect(results[1]!.structuredContent).toMatchObject({ ok: true, messageId: args[1]!.requestId });
      expect(results[2]!.structuredContent).toMatchObject({ ok: true, messageId: seen });
      expect(results[3]!.structuredContent).toMatchObject({ ok: true, source: { nodeId: node.nodeId, sessionId: CHAT_A } });
      const rows = await intentRows(args.map((value) => value.requestId));
      expect(rows.map((row) => [row.session_id, row.call_id, row.tool_name, row.claimed_at !== null]))
        .toEqual(calls.map(([id, tool]) => [CHAT_A, id, tool, true]));
      for (const index of [0, 1]) {
        expect(await messageOf(node, args[index]!.requestId)).toMatchObject({ fromNode: node.nodeId, fromSession: CHAT_A,
          toNode: peer.nodeId, toSession: PEER_SESSION });
      }
      const frames = await delivered(peer.socket, 2);
      expect(frames.map((frame) => frame.from)).toEqual([{ nodeId: node.nodeId, session: CHAT_A }, { nodeId: node.nodeId, session: CHAT_A }]);

      // Exactly once: a retry recovers the same claim, and no call's tool-use ID claims another call's intent.
      const count = (await registry().listMessages(node.nodeId, 100)).length;
      const retried = await callAll(0);
      expect(retried.map((result) => result.isError ?? false)).toEqual([false, false, false, false]);
      expect(retried[0]!.structuredContent).toMatchObject({ ok: true, messageId: args[0]!.requestId });
      expect((await intentRows(args.map((value) => value.requestId))).map((row) => row.claimed_at))
        .toEqual(rows.map((row) => row.claimed_at));
      for (const crossed of await callAll(1)) {
        expect(crossed.content).toEqual([{ type: "text", text: "native call identity does not match intent" }]);
      }
      expect(await registry().listMessages(node.nodeId, 100)).toHaveLength(count);
    } finally {
      await node.close();
      peer.socket.ws.close(1000, "done");
    }
  }, 20_000);

  it("accepts a resumed chat under its kept session id although the last snapshot lacks it", async () => {
    const peer = await startPeer();
    const listed = sessionsOf(CHAT_A);
    const node = await startNativeNode("modes-resumed", listed);
    try {
      await vi.waitFor(async () => expect(await listedOn(node, CHAT_A)).toBe(true), WAIT);
      expect(await listedOn(node, CHAT_B)).toBe(false);
      // `claude --resume` keeps the session id; the resumed chat reappears only in the local listing.
      listed.push(...sessionsOf(CHAT_B));
      const input = { to: { nodeId: peer.nodeId, session: PEER_SESSION }, text: "synthetic text after resume" };
      const args = claudeRewrite(await node.nativeHook(nativeInput(CHAT_B, "toolu_resumed_1", "send", input,
        { transcript_path: "/synthetic/resumed.jsonl" })), input);
      expect(await listedOn(node, CHAT_B)).toBe(true);
      const sent = await (await node.mcp()).callTool({ name: "send", arguments: args, _meta: claudeMeta("toolu_resumed_1") });
      expect(sent.structuredContent).toMatchObject({ ok: true, messageId: args.requestId });
      expect(await messageOf(node, args.requestId)).toMatchObject({ fromNode: node.nodeId, fromSession: CHAT_B });
    } finally {
      await node.close();
      peer.socket.ws.close(1000, "done");
    }
  }, 20_000);

  it("keeps a chat's identity and prior intent across a node daemon restart", async () => {
    const peer = await startPeer();
    const node = await startNativeNode("modes-restart", sessionsOf(CHAT_A));
    try {
      const to = { nodeId: peer.nodeId, session: PEER_SESSION };
      const before = await node.hook(CHAT_A, "toolu_before_restart", "send", { to, text: "synthetic text before restart" });
      await node.restart();
      const input = { to, text: "synthetic text after restart" };
      const after = claudeRewrite(await node.nativeHook(nativeInput(CHAT_A, "toolu_after_restart", "send", input)), input);
      const chat = await node.mcp();
      for (const [args, toolUseId] of [[before, "toolu_before_restart"], [after, "toolu_after_restart"]] as const) {
        const sent = await chat.callTool({ name: "send", arguments: args, _meta: claudeMeta(toolUseId) });
        expect(sent.structuredContent).toMatchObject({ ok: true, messageId: args.requestId });
        expect(await messageOf(node, args.requestId)).toMatchObject({ fromNode: node.nodeId, fromSession: CHAT_A });
      }
    } finally {
      await node.close();
      peer.socket.ws.close(1000, "done");
    }
  }, 20_000);

  it("denies an UNKNOWN retained chat at claim and registration while keeping its addressable identity", async () => {
    const peer = await startPeer();
    const listed = sessionsOf(CHAT_A, CHAT_B);
    const node = await startNativeNode("modes-ended", listed);
    try {
      const input = { to: { nodeId: peer.nodeId, session: PEER_SESSION }, text: "synthetic text from an ended chat" };
      const registered = await node.hook(CHAT_B, "toolu_ended_1", "send", input);
      listed.splice(listed.findIndex((session) => session.sessionId === CHAT_B), 1);
      await node.publishSessions();
      await vi.waitFor(async () => expect((await registry().directory()).sessions.find(
        (session) => session.nodeId === node.nodeId && session.sessionId === CHAT_B)?.state).toBe("unknown"), WAIT);
      expect(await listedOn(node, CHAT_B)).toBe(true);
      const late = await (await node.mcp()).callTool({ name: "send", arguments: registered, _meta: claudeMeta("toolu_ended_1") });
      expect(late.isError).toBe(true);
      expect(late.content).toEqual([{ type: "text", text: "native session is no longer registered" }]);
      expect(await node.nativeHook(nativeInput(CHAT_B, "toolu_ended_2", "send", input))).toStrictEqual({ hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "remote_mcp_intent_rejected" } });
      expect(await registry().listMessages(node.nodeId, 100)).toEqual([]);
    } finally {
      await node.close();
      peer.socket.ws.close(1000, "done");
    }
  }, 20_000);

  it("attributes a subagent call to the hook input's session, never to its agent fields", async () => {
    const peer = await startPeer();
    const node = await startNativeNode("modes-subagent", sessionsOf(CHAT_A, CHAT_B));
    try {
      // Claude Code hooks reference: a subagent's PreToolUse carries the common
      // input fields plus agent_id and agent_type. The agent_id here even names chat B.
      const input = { to: { nodeId: peer.nodeId, session: PEER_SESSION }, text: "synthetic text from a subagent" };
      const args = claudeRewrite(await node.nativeHook(nativeInput(CHAT_A, "toolu_subagent_1", "send", input,
        { agent_id: CHAT_B, agent_type: "Explore" })), input);
      const [row] = await intentRows([args.requestId]);
      expect([row!.session_id, row!.call_id]).toEqual([CHAT_A, "toolu_subagent_1"]);
      const chat = await node.mcp();
      const borrowed = await chat.callTool({ name: "send", arguments: args, _meta: claudeMeta("toolu_main_thread") });
      expect(borrowed.content).toEqual([{ type: "text", text: "native call identity does not match intent" }]);
      const sent = await chat.callTool({ name: "send", arguments: args, _meta: claudeMeta("toolu_subagent_1") });
      expect(sent.structuredContent).toMatchObject({ ok: true, messageId: args.requestId });
      expect(await messageOf(node, args.requestId)).toMatchObject({ fromNode: node.nodeId, fromSession: CHAT_A });
      expect((await delivered(peer.socket, 1))[0]!.from).toEqual({ nodeId: node.nodeId, session: CHAT_A });
    } finally {
      await node.close();
      peer.socket.ws.close(1000, "done");
    }
  }, 20_000);

  it("returns exactly allow plus the rewrite for Codex and claims it as the Codex session", async () => {
    const peer = await startPeer();
    const codex: SessionInfo = { sessionId: "synthetic-codex-chat", runtime: "codex", state: "running" };
    const node = await startNativeNode("modes-codex", [codex]);
    try {
      const input = { to: { nodeId: peer.nodeId, session: PEER_SESSION }, text: "synthetic text from codex" };
      const output = await node.nativeHook(nativeInput(codex.sessionId, "synthetic-codex-call", "send", input), "codex");
      expect(output).toStrictEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
        updatedInput: { ...input, requestId: expect.any(String) } } });
      const args = output!.hookSpecificOutput.updatedInput!;
      const sent = await (await node.mcp()).callTool({ name: "send", arguments: args,
        _meta: { sessionId: codex.sessionId, threadId: codex.sessionId, callId: "synthetic-codex-call" } });
      expect(sent.structuredContent).toMatchObject({ ok: true, messageId: args.requestId });
      expect(await messageOf(node, args.requestId)).toMatchObject({ fromNode: node.nodeId, fromSession: codex.sessionId });
    } finally {
      await node.close();
      peer.socket.ws.close(1000, "done");
    }
  }, 20_000);
});
