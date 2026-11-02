import { DurableObject } from "cloudflare:workers";

import {
  isCommandResultBody, isNodeId, isPhase1Command, isRegisterBody, isRuntimeList, isSessionCommand, isSessionList,
  makeEnvelope, NONCE_TTL_MS, parseEnvelope, PING_FRAME, PONG_FRAME, type Envelope, type MessageType, type NodeCommand,
} from "../../protocol.mts";
import {
  isDirectoryGetBody, isMessageSendBody, isMessageStatusAckBody, isNodeMessageStatusBody, MESSAGE_STATUS_ACK,
} from "../../protocol-messages.mts";
import { isCommandArgs } from "../../protocol-tasks.mts";
import {
  isMcpCredentialRotateBody, isMcpInboxResponseBody, isMcpIntentRegistration, MCP_INBOX_TOO_LARGE,
  type McpInboxResponseBody, type McpRuntime,
} from "../../protocol-mcp.mts";
import { handleTaskFrame } from "./task-frames.mts";
import { flushTaskControl, handleTaskControlEvent } from "./task-control-frames.mts";
import type { LocalControlNode } from "./task-control-routing.mts";
import { randomToken } from "./crypto.mts";
import { registryStub, type Env } from "./env.mts";
import { checkAuth, CLOSE, type Attachment } from "./handshake.mts";
import { isProxyDelivery, routeEffects, type LocalNode } from "./message-routing.mts";
import { SessionStore, type CommandRecord } from "./session-store.mts";

// Offline detection (issue #5 decision 2): while a node is online an alarm
// fires every 5 minutes; after 3 intervals without activity it is offline.
export const ALARM_INTERVAL_MS = 5 * 60_000;
export const MISSED_INTERVALS = 3;
export const MESSAGE_STATUS_PAGE_SIZE = 32;
export const MCP_INBOX_TIMEOUT_MS = 5_000;
export const MCP_INBOX_MAX_PENDING = 32;

export type EnqueueResult = { ok: true; commandId: string; seq: number; delivered: boolean } | { ok: false; error: string };

// One object per node (idFromName(nodeId)). Holds the node's hibernatable
// WebSocket, the pending-command log and the liveness state.
export class NodeSession extends DurableObject<Env> {
  private readonly store: SessionStore;
  private readonly pendingInbox = new Map<string, {
    socket: WebSocket;
    resolve: (body: McpInboxResponseBody) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SessionStore(ctx.storage.sql);
    // Answered by the runtime without waking the object and without billed
    // duration; the last answer time is read back in alarm().
    // https://developers.cloudflare.com/durable-objects/api/state/#setwebsocketautoresponse
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
    const nodeId = new URL(request.url).searchParams.get("nodeId");
    if (!isNodeId(nodeId)) return new Response("invalid nodeId", { status: 400 });
    const now = Date.now();
    this.closeStaleUnauthenticated(now);
    this.store.set("nodeId", nodeId);

    const [client, server] = Object.values(new WebSocketPair());
    // acceptWebSocket (not ws.accept) lets the object hibernate with the socket open.
    // https://developers.cloudflare.com/durable-objects/best-practices/websockets/
    this.ctx.acceptWebSocket(server);
    const nonce = randomToken(16);
    const attachment: Attachment = { nodeId, authed: false, nonce, nonceIssuedAt: now, connectedAt: now, lastNodeSeq: 0 };
    server.serializeAttachment(attachment);
    server.send(JSON.stringify(makeEnvelope("challenge", { nonce, serverTime: now }, 0, 0)));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return ws.close(CLOSE.protocol, "no session state");
    const parsed = parseEnvelope(message);
    if (!parsed.ok) {
      if (!attachment.authed) return ws.close(CLOSE.protocol, parsed.error);
      return this.sendControl(ws, "error", { error: parsed.error });
    }
    const envelope = parsed.envelope;
    if (!attachment.authed) return this.handleAuth(ws, attachment, envelope);

    if (envelope.ack > 0) this.store.ackThrough(envelope.ack);
    if (envelope.seq > 0 && envelope.seq <= attachment.lastNodeSeq) return; // duplicate on this connection
    this.store.set("lastSeen", Date.now());
    if (envelope.seq > 0) {
      attachment.lastNodeSeq = envelope.seq;
      ws.serializeAttachment(attachment);
    }
    await this.dispatch(ws, attachment.nodeId, envelope);
  }

  // Completes the closing handshake. The docs note that with
  // web_socket_auto_reply_to_close the runtime replies itself and calling
  // close() stays safe; local workerd did not deliver the reply without it.
  // Liveness is decided by the alarm, not by a close, so a node that
  // reconnects within its backoff window never flaps to offline.
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }

  async alarm(): Promise<void> {
    if (this.store.get("status") !== "online") return;
    const now = Date.now();
    let last = Number(this.store.get("lastSeen") ?? "0");
    for (const ws of this.ctx.getWebSockets()) {
      const auto = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      if (auto && auto.getTime() > last) last = auto.getTime();
    }
    this.closeStaleUnauthenticated(now);
    if (now - last >= MISSED_INTERVALS * ALARM_INTERVAL_MS) {
      this.store.set("status", "offline");
      const nodeId = this.store.get("nodeId");
      if (nodeId) await registryStub(this.env).setStatus(nodeId, "offline", last);
      for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE.offline, "offline");
      return; // not re-armed while offline
    }
    await this.ctx.storage.setAlarm(now + ALARM_INTERVAL_MS);
  }

  // Operator API: queue one Phase 1 command, or (task dispatch, item 5) one
  // session command with its args. Refuses anything else, and args that do
  // not validate for the command, even though the Worker already checked them.
  async enqueue(command: NodeCommand, args?: Record<string, unknown>): Promise<EnqueueResult> {
    if (!isPhase1Command(command) && !isSessionCommand(command)) return { ok: false, error: "command not allowed" };
    if (!isCommandArgs(command, args)) return { ok: false, error: "invalid command arguments" };
    if (this.store.get("status") === "revoked") return { ok: false, error: "node revoked" };
    const commandId = crypto.randomUUID();
    const seq = this.store.appendCommand(commandId, command, args);
    const ws = this.authedSocket();
    const body = { commandId, command, ...(args === undefined ? {} : { args }) };
    if (ws) ws.send(JSON.stringify(makeEnvelope("command", body, seq, this.lastNodeSeq(ws), commandId)));
    return { ok: true, commandId, seq, delivered: ws !== null };
  }

  recentCommands(limit = 20): CommandRecord[] {
    return this.store.recentCommands(Math.min(100, Math.max(1, limit)));
  }

  status(): { status: string | null; lastSeen: number | null; pending: number; connected: boolean } {
    const lastSeen = this.store.get("lastSeen");
    return { status: this.store.get("status"), lastSeen: lastSeen ? Number(lastSeen) : null,
      pending: this.store.outboxSize(), connected: this.authedSocket() !== null };
  }

  async revoke(): Promise<void> {
    this.store.set("status", "revoked");
    this.store.clearOutbox();
    await this.ctx.storage.deleteAlarm();
    for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE.unknownOrRevoked, "revoked");
  }

  private async handleAuth(ws: WebSocket, attachment: Attachment, envelope: Envelope): Promise<void> {
    const now = Date.now();
    const verdict = await checkAuth(attachment, envelope, now, (nodeId) => registryStub(this.env).getNodeKey(nodeId));
    if (!verdict.ok) return ws.close(verdict.code, verdict.reason);

    ws.serializeAttachment({ nodeId: attachment.nodeId, authed: true, connectedAt: attachment.connectedAt, lastNodeSeq: 0 } satisfies Attachment);
    for (const other of this.ctx.getWebSockets()) if (other !== ws) other.close(CLOSE.replaced, "replaced by newer connection");
    this.store.set("status", "online");
    this.store.set("lastSeen", now);
    await registryStub(this.env).setStatus(attachment.nodeId, "online", now);
    await this.ctx.storage.setAlarm(now + ALARM_INTERVAL_MS);

    // Resume: drop what the node already processed, resend the rest in order.
    if (envelope.ack > 0) this.store.ackThrough(envelope.ack);
    this.sendControl(ws, "event", { name: "auth.ok", nodeId: attachment.nodeId });
    for (const pending of this.store.pendingEnvelopes(0)) ws.send(JSON.stringify(pending));
    // Messages queued while the node was away, oldest first.
    const registry = registryStub(this.env);
    await routeEffects(this.env, await registry.pendingMessagesFor(attachment.nodeId), this.local(ws, attachment.nodeId));
    let cursor = 0;
    for (;;) {
      const page = await registry.messageStatusPageFor(attachment.nodeId, cursor, MESSAGE_STATUS_PAGE_SIZE);
      await routeEffects(this.env, page.effects, this.local(ws, attachment.nodeId));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
  }

  // Registry-routed message frames for this node. Returns false when the node
  // is not connected; queued messages then wait for its next authentication.
  // Issue #408 (design r3 section 4.3): a proxy delivery re-reads its row here,
  // in the object that sends, and is dropped unless it is still queued.
  async pushFrame(type: "message.deliver" | "message.status" | "event", body: Record<string, unknown>): Promise<boolean> {
    if (isProxyDelivery(type, body) && !await registryStub(this.env).messageQueued(String(body.messageId))) return false;
    if (type === "message.deliver" && body.loop !== undefined && !await registryStub(this.env).messageDeliveryReady(String(body.messageId))) return false;
    const ws = this.authedSocket();
    if (ws) this.sendControl(ws, type, body);
    return ws !== null;
  }

  // messageId (issue #308): one item, for an MCP reply whose parent row is
  // gone; the node marks it answered. An older node ignores both fields.
  requestMcpInbox(sessionId: string, limit: number, runtime: McpRuntime, messageId?: string): Promise<McpInboxResponseBody> {
    const ws = this.authedSocket();
    if (!ws) return Promise.resolve({ requestId: crypto.randomUUID(), ok: false, error: "originating node is offline" });
    const requestId = crypto.randomUUID();
    if (this.pendingInbox.size >= MCP_INBOX_MAX_PENDING) {
      return Promise.resolve({ requestId, ok: false, error: "originating node inbox reader is busy" });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingInbox.delete(requestId);
        resolve({ requestId, ok: false, error: "originating node did not answer inbox request" });
      }, MCP_INBOX_TIMEOUT_MS);
      this.pendingInbox.set(requestId, { socket: ws, resolve, timer });
      this.sendControl(ws, "mcp.inbox.request", { requestId, sessionId, limit, runtime, ...(messageId ? { messageId, reply: true } : {}) });
    });
  }

  private local(ws: WebSocket, nodeId: string): LocalNode {
    return { nodeId, send: (type, body) => this.sendControl(ws, type, body) };
  }

  private localControl(ws: WebSocket, nodeId: string): LocalControlNode {
    return { nodeId, send: (body) => this.sendControl(ws, "event", { ...body }) };
  }
  private async dispatch(ws: WebSocket, nodeId: string, envelope: Envelope): Promise<void> {
    const body = envelope.body as Record<string, unknown>;
    const registry = registryStub(this.env);
    switch (envelope.type) {
      case "register":
        if (!isRegisterBody(body)) return this.sendControl(ws, "error", { error: "invalid register body" });
        await registry.updateRegistration(nodeId, body.facts, body.runtimes, body.capabilities);
        return flushTaskControl(this.env, nodeId, this.localControl(ws, nodeId));
      case "capabilities.update":
        if (!isRuntimeList(body.runtimes)) return this.sendControl(ws, "error", { error: "invalid runtimes" });
        return registry.replaceRuntimes(nodeId, body.runtimes);
      case "sessions.snapshot":
        if (!isSessionList(body.sessions)) return this.sendControl(ws, "error", { error: "invalid sessions" });
        return registry.replaceSessions(nodeId, body.sessions);
      case "command.ack":
        if (typeof body.commandId === "string") this.store.markCommand(body.commandId, "acked");
        return;
      case "command.result":
        return this.handleResult(nodeId, body);
      case "message.send": {
        if (!isMessageSendBody(body)) return this.sendControl(ws, "error", { error: "invalid message.send body" });
        // The sender is the authenticated connection, never a field of the body.
        const result = await registry.sendMessage({ messageId: body.messageId, from: { nodeId, session: body.fromSession },
          to: { nodeId: body.to.nodeId, session: body.to.session }, text: body.text, inReplyTo: body.inReplyTo, taskId: body.taskId,
          proxyOf: body.proxyOf },
        `node:${nodeId}`);
        if (!result.ok) return this.sendControl(ws, "error", { error: result.error, messageId: body.messageId });
        this.sendControl(ws, "message.status", { ...result.status });
        return routeEffects(this.env, result.effects, this.local(ws, nodeId));
      }
      case "message.status": {
        if (!isNodeMessageStatusBody(body)) return this.sendControl(ws, "error", { error: "invalid message.status body" });
        const result = await registry.reportMessageStatus(nodeId, body);
        await routeEffects(this.env, result.effects, this.local(ws, nodeId));
        if (result.receipt) this.sendControl(ws, "event", { ...result.receipt });
        return;
      }
      case "directory.get":
        if (!isDirectoryGetBody(body)) return this.sendControl(ws, "error", { error: "invalid directory.get body" });
        return this.sendControl(ws, "directory", { ...await registry.directory() });
      case "mcp.credential.rotate": {
        if (!isMcpCredentialRotateBody(body)) return this.sendControl(ws, "error", { error: "invalid MCP credential request" });
        const rotated = await registry.rotateMcpCredential(nodeId);
        return this.sendControl(ws, "mcp.credential", { requestId: body.requestId, ...rotated });
      }
      case "mcp.intent.register": {
        if (!isMcpIntentRegistration(body)) return this.sendControl(ws, "error", { error: "invalid MCP intent metadata" });
        const registered = await registry.registerMcpIntent(nodeId, body);
        return this.sendControl(ws, "mcp.intent.receipt", registered.ok
          ? { requestId: body.requestId, ok: true, expiresAt: registered.expiresAt, version: registered.version }
          : { requestId: body.requestId, ok: false, error: registered.error });
      }
      case "mcp.inbox.response": {
        if (!isMcpInboxResponseBody(body)) return this.sendControl(ws, "error", { error: "invalid MCP inbox response" });
        const pending = this.pendingInbox.get(body.requestId);
        if (!pending || pending.socket !== ws) return;
        clearTimeout(pending.timer);
        this.pendingInbox.delete(body.requestId);
        pending.resolve(body.ok ? body : { requestId: body.requestId, ok: false,
          error: body.error === MCP_INBOX_TOO_LARGE ? MCP_INBOX_TOO_LARGE : "originating node inbox read failed" });
        return;
      }
      case "task.report":
      case "task.request":
        return handleTaskFrame(this.env, nodeId, envelope.type, body, (type, reply) => this.sendControl(ws, type, reply));
      case "event":
        if (body.name === MESSAGE_STATUS_ACK) {
          if (!isMessageStatusAckBody(body)) return this.sendControl(ws, "error", { error: "invalid message.status.ack body" });
          return registry.ackMessageStatus(nodeId, body);
        }
        return typeof body.name === "string" && body.name.startsWith("task.control.")
          ? handleTaskControlEvent(this.env, nodeId, body, (type, reply) => this.sendControl(ws, type, reply),
            this.localControl(ws, nodeId))
          : undefined;
      case "error":
        return; // activity already recorded
      default:
        return this.sendControl(ws, "error", { error: `unexpected ${envelope.type}` });
    }
  }

  private async handleResult(nodeId: string, body: Record<string, unknown>): Promise<void> {
    if (!isCommandResultBody(body)) return;
    const command = this.store.markCommand(body.commandId, body.ok ? "done" : "failed", body.result ?? null, body.error ?? null);
    if (!body.ok) return;
    if (command === "runtime.list" && isRuntimeList(body.result)) await registryStub(this.env).replaceRuntimes(nodeId, body.result);
    if (command === "session.list" && isSessionList(body.result)) await registryStub(this.env).replaceSessions(nodeId, body.result);
  }

  private sendControl(ws: WebSocket, type: MessageType, body: Record<string, unknown>): void {
    ws.send(JSON.stringify(makeEnvelope(type, body, 0, this.lastNodeSeq(ws))));
  }

  private lastNodeSeq(ws: WebSocket): number {
    return (ws.deserializeAttachment() as Attachment | null)?.lastNodeSeq ?? 0;
  }

  private authedSocket(): WebSocket | null {
    return this.ctx.getWebSockets().find((ws) => (ws.deserializeAttachment() as Attachment | null)?.authed === true) ?? null;
  }

  // Sockets that never completed the handshake are closed once their nonce is
  // stale; no timer is used because timers prevent hibernation.
  private closeStaleUnauthenticated(now: number): void {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a && !a.authed && now - (a.nonceIssuedAt ?? 0) > NONCE_TTL_MS) ws.close(CLOSE.nonceExpired, "handshake timeout");
    }
  }
}
