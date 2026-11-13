import { isFixedSlot, type FixedSlot } from "./protocol.mts";
import { isMessageDiagnostic, type MessageDiagnostic } from "./protocol-diagnostics.mts";
// Kherep Control Plane messaging bodies, Phase 2 step 1 (GitHub issue #31).
// Session-to-session messages between nodes, routed and queued by the Worker.
// Plain ECMAScript like protocol.mts, so the Worker and the node load it alike.

import { isDeliveryBinding, type DeliveryBinding } from "./protocol-message-binding.mts";
import { isLoopAdmissionV1, type LoopAdmissionV1 } from "./protocol-loop-brake.mts";
export { isLoopAdmissionV1, type LoopAdmissionV1 } from "./protocol-loop-brake.mts";

import { isNodeId, isSessionInfo, type SessionInfo } from "./protocol.mts";

// A node advertises this capability when it can take message.deliver. The
// Worker routes only to nodes that registered it.
export const MESSAGING_CAPABILITY = "messaging.v1";
// Issue #408, PR 4: a Worker that validates proxyOf names this in the directory
// frame's worker.capabilities; a node relays a proxy answer only to such a Worker.
export const MESSAGING_PROXY_CAPABILITY = "messaging.proxy.v1";

// The sender node id of a message that an operator sent through the API.
export const OPERATOR_NODE_ID = "operator";
// Issue #761: the sender session of a notice the Worker itself writes for a
// committed Intercom slot change. The operator API refuses this actor, and a
// peer cannot send as OPERATOR_NODE_ID, so only the Worker can mint it.
export const CONTROL_PLANE_SESSION = "control-plane";

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
export interface MessageStatusBody { messageId: string; state: MessageState; reason?: string; progress?: MessageProgress; diagnostic?: MessageDiagnostic }
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
  return isObject(body) && only(body, ["messageId", "state", "reason", "progress", "diagnostic"])
    && isMessageId(body.messageId) && isMessageState(body.state)
    && (body.diagnostic === undefined || isMessageDiagnostic(body.diagnostic))
    && (body.reason === undefined || isText(body.reason, MAX_STATUS_REASON))
    && (body.progress === undefined || (body.reason === undefined && body.state === "accepted" && isMessageProgress(body.progress)));
}

// A status as a node may send it: only the node-reportable states.
export function isNodeMessageStatusBody(body: unknown): body is MessageStatusBody & { state: NodeReportedState } {
  return isMessageStatusBody(body) && isNodeReportedState(body.state);
}

export function isMessageReceiptBody(body: unknown): body is MessageReceiptBody {
  return isObject(body) && only(body, ["name", "messageId", "requestedState", "storedState", "storedProgressAt"])
    && body.name === "message.receipt" && isMessageId(body.messageId)
    && isNodeReportedState(body.requestedState) && isMessageState(body.storedState)
    && (body.storedProgressAt === undefined || (body.requestedState === "accepted" && body.storedState === "accepted"
      && isIsoInstant(body.storedProgressAt)));
}

// ---- Status acknowledgement (issue #308) ------------------------------------
// Sending node -> Worker, an event once the node recorded a final
// message.status it received: the Worker may then drop the message row. An
// event, because an older Worker ignores unknown events; message.status and
// message.receipt keep their key-strict bodies. A node that sends it
// advertises MESSAGING_ACK_CAPABILITY.
export const MESSAGING_ACK_CAPABILITY = "messaging.ack.v1";
export const MESSAGE_STATUS_ACK = "message.status.ack";
export interface MessageStatusAckBody { name: typeof MESSAGE_STATUS_ACK; messageId: string; state: FinalMessageState }

export function isFinalMessageState(value: unknown): value is FinalMessageState {
  return (FINAL_MESSAGE_STATES as readonly unknown[]).includes(value);
}

export function messageStatusAck(messageId: string, state: FinalMessageState): MessageStatusAckBody {
  return { name: MESSAGE_STATUS_ACK, messageId, state };
}

export function isMessageStatusAckBody(body: unknown): body is MessageStatusAckBody {
  return isObject(body) && only(body, ["name", "messageId", "state"]) && body.name === MESSAGE_STATUS_ACK
    && isMessageId(body.messageId) && isFinalMessageState(body.state);
}

// ---- Directory (step 3a) ---------------------------------------------------
// directory.get (node -> Worker) has an empty body; the Worker answers with
// directory: every non-revoked node and the sessions it last reported.

export const MAX_DIRECTORY_NODES = 256;
export const MAX_DIRECTORY_SESSIONS = 1024;

// intake (issue #441; reader rules in protocol-intake.mts, which the closed MCP
// client graph does not carry): absent when the Worker did not measure the queue.
export interface DirectoryNodeIntake { lastAcceptedAt: string | null; oldestQueuedAt: string | null; queued: number }
export interface DirectoryNode { nodeId: string; name: string; status: string; intake?: DirectoryNodeIntake }
export const MAX_INTAKE_QUEUED = 10_000;

export function isDirectoryNodeIntake(value: unknown): value is DirectoryNodeIntake {
  return isObject(value) && only(value, ["lastAcceptedAt", "oldestQueuedAt", "queued"])
    && (value.lastAcceptedAt === null || isIsoInstant(value.lastAcceptedAt)) && (value.oldestQueuedAt === null || isIsoInstant(value.oldestQueuedAt))
    && Number.isSafeInteger(value.queued) && (value.queued as number) >= 0 && (value.queued as number) <= MAX_INTAKE_QUEUED;
}
export type DirectorySession = Omit<SessionInfo, "startedAt"> & { nodeId: string };
// truncated is set when the Worker left sessions out to stay within one frame.
// worker (issue #408): what the Worker itself supports; an older node ignores it.
export interface DirectoryBody {
  nodes: DirectoryNode[]; sessions: DirectorySession[]; fetchedAt: string; truncated?: boolean; worker?: { capabilities: string[] };
}

export function isDirectoryGetBody(body: unknown): body is Record<string, never> {
  return isObject(body) && Object.keys(body).length === 0;
}

function isDirectoryNode(value: unknown): value is DirectoryNode {
  return isObject(value) && isNodeId(value.nodeId) && isText(value.name, 128) && isText(value.status, 32)
    && (value.intake === undefined || isDirectoryNodeIntake(value.intake));
}

function isDirectorySession(value: unknown): value is DirectorySession {
  return isObject(value) && isNodeId(value.nodeId) && isSessionInfo(value) && value.startedAt === undefined;
}

export function isDirectoryBody(body: unknown): body is DirectoryBody {
  return isObject(body) && Array.isArray(body.nodes) && body.nodes.length <= MAX_DIRECTORY_NODES && body.nodes.every(isDirectoryNode)
    && Array.isArray(body.sessions) && body.sessions.length <= MAX_DIRECTORY_SESSIONS && body.sessions.every(isDirectorySession)
    && typeof body.fetchedAt === "string" && !Number.isNaN(Date.parse(body.fetchedAt))
    && (body.truncated === undefined || typeof body.truncated === "boolean")
    && (body.worker === undefined || (isObject(body.worker) && Array.isArray(body.worker.capabilities)
      && body.worker.capabilities.length <= 64 && body.worker.capabilities.every((c) => isText(c, 64))));
}

// Disjoint from the inventory shape. Never store this reply as directory.json.
export interface SlotAddressRequest { slot: FixedSlot; requestId: string }
export type SlotAddressResult = SlotAddressRequest & { kind: "slot-address" } &
  ({ address: MessageAddress } | { error: "unavailable" });
export function isSlotAddressRequest(v: unknown): v is SlotAddressRequest {
  return isObject(v) && Object.keys(v).length === 2 && isFixedSlot(v.slot) && isNodeId(v.requestId);
}
export function isSlotAddressResult(v: unknown): v is SlotAddressResult {
  return isObject(v) && v.kind === "slot-address" && isFixedSlot(v.slot) && isNodeId(v.requestId)
    && Object.keys(v).length === 4 && (Object.hasOwn(v, "address")
      ? isObject(v.address) && Object.keys(v.address).length === 2 && isNodeId(v.address.nodeId) && isNodeId(v.address.session)
      : v.error === "unavailable");
}
