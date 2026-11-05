// Archived real validator: kherep@d1bf1f3a4e5aa90de22650130f69f91ca8da99eb. Only import paths relocated.
// Kherep Control Plane messaging bodies, Phase 2 step 1 (GitHub issue #31).
// Session-to-session messages between nodes, routed and queued by the Worker.
// Plain ECMAScript like protocol.mts, so the Worker and the node load it alike.

import { isDeliveryBinding, type DeliveryBinding } from "../protocol-message-binding.mts";
import { isLoopAdmissionV1, type LoopAdmissionV1 } from "../protocol-loop-brake.mts";
export { isLoopAdmissionV1, type LoopAdmissionV1 } from "../protocol-loop-brake.mts";

import { isNodeId, isSessionInfo, type SessionInfo } from "../protocol.mts";

// A node advertises this capability when it can take message.deliver. The
// Worker routes only to nodes that registered it.
export const MESSAGING_CAPABILITY = "messaging.v1";
// Issue #408, PR 4: a Worker that validates proxyOf names this in the directory
// frame's worker.capabilities; a node relays a proxy answer only to such a Worker.
export const MESSAGING_PROXY_CAPABILITY = "messaging.proxy.v1";

// The sender node id of a message that an operator sent through the API.
export const OPERATOR_NODE_ID = "operator";

export const MAX_MESSAGE_TEXT = 16_384;
export const MAX_REPLY_DEPTH = 6;
export const MAX_SESSION_REF = 128;
export const MAX_STATUS_REASON = 256;

export const MESSAGE_STATES = ["queued", "accepted", "delivered", "replied", "expired", "refused"] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

// The states a node may report. queued and expired are set by the Worker only.
export const NODE_REPORTED_STATES = ["accepted", "delivered", "refused"] as const;
export type NodeReportedState = (typeof NODE_REPORTED_STATES)[number];

// The states after which a message changes no more (issue #308): the sending
// node acknowledges each with message.status.ack.
export const FINAL_MESSAGE_STATES = ["delivered", "replied", "refused", "expired"] as const;
export type FinalMessageState = (typeof FINAL_MESSAGE_STATES)[number];

export const MESSAGE_PROGRESS_CODES = {
  waiting: ["awaiting-user-turn", "awaiting-turn-confirmation", "target-busy", "wake-unconfirmed", "retry-pending", "wake-disabled", "wake-not-authorized",
    "permission-restricted", "operator-stopped", "reply-limit", "budget-exhausted", "ambiguous-target", "cwd-refused"],
  waking: ["wake-pending"],
  fallback: ["fallback-starting", "fallback-running"],
  failed: ["wake-failed", "fallback-failed"],
} as const;
export type MessageProgressPhase = keyof typeof MESSAGE_PROGRESS_CODES;
export type MessageProgressCode = (typeof MESSAGE_PROGRESS_CODES)[MessageProgressPhase][number];
export interface MessageProgress { phase: MessageProgressPhase; code: MessageProgressCode; observedAt: string; retryAt?: string }

// Issue #396: a sending node that validates the progress codes added from
// issue #396 on (cwd-refused) advertises this capability. The Worker hands any
// other sender the older code it validates, so its message.status frames stay valid.
export const MESSAGING_PROGRESS_V2_CAPABILITY = "messaging.progress.v2";
const LEGACY_PROGRESS_CODES: Partial<Record<MessageProgressCode, MessageProgressCode>> = { "cwd-refused": "wake-not-authorized" };

export function legacyProgress(progress: MessageProgress, capabilities: readonly string[] | null): MessageProgress {
  const legacy = LEGACY_PROGRESS_CODES[progress.code];
  return legacy === undefined || capabilities?.includes(MESSAGING_PROGRESS_V2_CAPABILITY) ? progress : { ...progress, code: legacy };
}

// What a sender reads (issue #197). running and stopped refine accepted from
// its existing progress codes and never go on the wire, so a Worker or node
// of an older version validates every frame as before.
export type SenderState<S extends string = MessageState> = S | "running" | "stopped";
const RUNNING_CODES: readonly MessageProgressCode[] = ["awaiting-turn-confirmation", "fallback-running"];

export function senderState<S extends string>(state: S, progress?: MessageProgress | null): SenderState<S> {
  if (state !== "accepted" || !progress) return state;
  if (progress.code === "operator-stopped") return "stopped";
  return RUNNING_CODES.includes(progress.code) ? "running" : state;
}

// An accepted message without any progress from its target node for this
// long is shown with an actionable reason instead of a bare accepted.
export const ACCEPTED_SILENCE_MS = 5 * 60_000;

export function silentlyAccepted(state: string, progress: MessageProgress | null | undefined, updatedAt: number, now: number): boolean {
  return state === "accepted" && !progress && now - updatedAt >= ACCEPTED_SILENCE_MS;
}

// The likely causes of such a silence, shared by `msg status` and the MCP status tool.
export const ACCEPTED_SILENCE_CAUSES = "the target session may not be running (refused after 60 minutes), "
  + "or the target node is offline or runs an older kherep-node";

// session is a session id or a session name on that node.
export interface MessageAddress { nodeId: string; session: string }
// node -> Worker. The sender node is always the authenticated connection;
// the body has no field for it. taskId (item 5): the task the message belongs
// to; the session started for that task may be woken by it (task grant).
// proxyOf (issue #408): a proxy answer to that message, one hop deeper, never
// a reply; never together with inReplyTo.
export interface MessageSendBody {
  messageId: string; fromSession: string; to: MessageAddress; text: string; inReplyTo?: string; taskId?: string; proxyOf?: string;
}
// Worker -> target node.
export interface MessageDeliverBody {
  messageId: string; from: MessageAddress; toSession: string; text: string; inReplyTo?: string; createdAt: string; taskId?: string;
  proxyOf?: string; loop?: LoopAdmissionV1; binding?: DeliveryBinding;
}
// node -> Worker (target reports progress) and Worker -> sending node.
export interface MessageStatusBody { messageId: string; state: MessageState; reason?: string; progress?: MessageProgress }
// Worker -> reporting node, carried as an authenticated event only after the
// Registry transaction completed. requestedState identifies the report being
// acknowledged; storedState is the canonical state after that transaction.
// storedProgressAt confirms the newest accepted-state progress made durable.
export interface MessageReceiptBody {
  name: "message.receipt"; messageId: string; requestedState: NodeReportedState; storedState: MessageState; storedProgressAt?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function isMessageId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

// Session references end up in single header lines of the text a delivery
// hook hands to a session, so control characters (line breaks included) are
// refused: a sender must not be able to forge lines outside its message body.
export function isSessionRef(value: unknown): value is string {
  return isText(value, MAX_SESSION_REF) && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isMessageText(value: unknown): value is string {
  return isText(value, MAX_MESSAGE_TEXT);
}

export function isMessageState(value: unknown): value is MessageState {
  return (MESSAGE_STATES as readonly unknown[]).includes(value);
}

export function isNodeReportedState(value: unknown): value is NodeReportedState {
  return (NODE_REPORTED_STATES as readonly unknown[]).includes(value);
}

// allowOperator admits the literal "operator" as nodeId, which only
// API-originated messages carry as their sender.
export function isMessageAddress(value: unknown, allowOperator = false): value is MessageAddress {
  return isObject(value) && (isNodeId(value.nodeId) || (allowOperator && value.nodeId === OPERATOR_NODE_ID))
    && isSessionRef(value.session);
}

// An optional message or task id (both uuids).
function isOptionalReplyTo(value: unknown): boolean {
  return value === undefined || isMessageId(value);
}

// At most one lineage: a reply (inReplyTo) or a proxy answer (proxyOf).
function isLineage(body: Record<string, unknown>): boolean {
  return isOptionalReplyTo(body.inReplyTo) && isOptionalReplyTo(body.proxyOf) && !(body.inReplyTo !== undefined && body.proxyOf !== undefined);
}

export function isMessageSendBody(body: unknown): body is MessageSendBody {
  return isObject(body) && !Object.keys(body).some((k) => k === "loop" || k.startsWith("loop_") || k === "binding" || k.startsWith("delivery_") || k === "denyPairKey")
    && isMessageId(body.messageId) && isSessionRef(body.fromSession) && isMessageAddress(body.to)
    && isMessageText(body.text) && isLineage(body) && isOptionalReplyTo(body.taskId);
}

export function isMessageDeliverBody(body: unknown): body is MessageDeliverBody {
  return isObject(body) && isMessageId(body.messageId) && isMessageAddress(body.from, true) && isSessionRef(body.toSession)
    && isMessageText(body.text) && isLineage(body) && isOptionalReplyTo(body.taskId)
    && (!Object.hasOwn(body, "loop") || isLoopAdmissionV1(body.loop))
    && (!Object.hasOwn(body, "binding") || isDeliveryBinding(body.binding) && body.binding.to.sessionId === body.toSession && body.binding.from.sessionId === body.from.session)
    && typeof body.createdAt === "string" && !Number.isNaN(Date.parse(body.createdAt));
}

export function isMessageProgress(value: unknown): value is MessageProgress {
  if (!isObject(value) || !only(value, ["phase", "code", "observedAt", "retryAt"]) || !isIsoInstant(value.observedAt)) return false;
  if (typeof value.phase !== "string" || !Object.hasOwn(MESSAGE_PROGRESS_CODES, value.phase)) return false;
  const phase = value.phase as MessageProgressPhase;
  if (!(MESSAGE_PROGRESS_CODES[phase] as readonly unknown[]).includes(value.code)) return false;
  return value.retryAt === undefined || (isIsoInstant(value.retryAt) && Date.parse(value.retryAt) >= Date.parse(value.observedAt));
}

export function isMessageStatusBody(body: unknown): body is MessageStatusBody {
  return isObject(body) && only(body, ["messageId", "state", "reason", "progress"])
    && isMessageId(body.messageId) && isMessageState(body.state)
    && (body.reason === undefined || isText(body.reason, MAX_STATUS_REASON))
    && (body.progress === undefined || (body.reason === undefined && body.state === "accepted" && isMessageProgress(body.progress)));
}

// A status as a node may send it: only the node-reportable states.
export function isNodeMessageStatusBody(body: unknown): body is MessageStatusBody & { state: NodeReportedState } {
  return isMessageStatusBody(body) && isNodeReportedState(body.state);
}

