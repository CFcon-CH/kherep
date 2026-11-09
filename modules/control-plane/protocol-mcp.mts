import { isSessionList, type SessionInfo } from "./protocol.mts";
import { isIdentitySnapshot, type IdentitySnapshotV1 } from "./protocol-session-identity.mts";

// Shared remote MCP identity protocol. This file intentionally has no Node or
// Workers imports so the authenticated node and Worker validate identical data.

export const REMOTE_MCP_CAPABILITY = "mcp.messaging.v1";
export const CLAUDE_MCP_CAPABILITY = "mcp.messaging.claude.v1";
export const MCP_INBOX_TOO_LARGE = "inbox response exceeds transport limit; retry with a smaller limit or use the local inbox CLI";
export const MCP_INTENT_TTL_DEFAULT_MS = 120_000;
export const MCP_INTENT_TTL_MAX_MS = 300_000;

export const MCP_TOOLS = ["sessions", "send", "inbox", "reply", "status", "assign_self"] as const;
export type McpTool = (typeof MCP_TOOLS)[number];
export type McpRuntime = "codex" | "claude-code";
export const SELF_ASSIGNMENT_SLOTS = ["codex-mac", "kherep-lead"] as const;
export type SelfAssignmentSlot = (typeof SELF_ASSIGNMENT_SLOTS)[number];
export interface McpAssignmentNative { sessionId: string; chatName: string; platform: "darwin"; originalMain: true; leadGuardVersion?: 1 }
export interface McpAssignment { slot: SelfAssignmentSlot; turnId: string; native?: McpAssignmentNative }
export type McpAssignmentResult = { ok: true; slot: SelfAssignmentSlot; revision: number }
  | { ok: false; error: string; conflict?: true };
export interface McpLeadConfirmRequest {
  nonce: string; nodeId: string; requestId: string; sessionId: string; threadId: string; turnId: string;
  callId: string; slot: "kherep-lead"; argumentsDigest: string; credentialVersion: number; leadGuardVersion: 1; expiresAt: number;
}
export interface McpLeadConfirmResponse { nonce: string; allowed: boolean }
export const MCP_LEAD_CONFIRM_MS = 5_000;

interface McpIntentCommon {
  requestId: string;
  sessionId: string;
  callId: string;
  tool: McpTool;
  argumentsDigest: string;
  ttlMs?: number;
  assignment?: McpAssignment;
}

export type McpIntentRegistration = McpIntentCommon & (
  { runtime: "codex"; threadId?: string }
  | { runtime: "claude-code"; threadId?: never }
);

// Disjoint from the legacy intent: old peers reject it without a fallback.
export const CODEX_ACTIVITY_INGRESS_MS = 8_000;
export const CODEX_ACTIVITY_EVIDENCE_MS = 60_000;
export interface CodexActivityStamp { kind: "codex-activity-v1"; intent: McpIntentRegistration; observedAt: number }
export interface CodexActivityRegistration extends CodexActivityStamp { sessions: SessionInfo[]; identitySnapshot: IdentitySnapshotV1 }
export function isCodexActivityStamp(value: unknown): value is CodexActivityStamp {
  return isObject(value) && Object.keys(value).sort((left, right) => {
    if (left < right) return -1;
    return left > right ? 1 : 0;
  }).join(",") === "intent,kind,observedAt"
    && activityFields(value, false);
}
function activityFields(value: Record<string, unknown>, native: boolean): boolean {
  if (value.kind !== "codex-activity-v1" || !Number.isSafeInteger(value.observedAt) || Number(value.observedAt) < 0
    || !Number.isSafeInteger(Number(value.observedAt) + CODEX_ACTIVITY_EVIDENCE_MS)
    || !isMcpIntentRegistration(value.intent)) return false;
  const intent = value.intent;
  return intent.runtime === "codex" && intent.tool === "assign_self" && intent.assignment?.slot === "codex-mac"
    && intent.ttlMs === undefined && Object.hasOwn(intent.assignment, "native") === native;
}
export function isCodexActivityRegistration(value: unknown): value is CodexActivityRegistration {
  return isObject(value) && Object.keys(value).sort((left, right) => {
    if (left < right) return -1;
    return left > right ? 1 : 0;
  }).join(",") === "identitySnapshot,intent,kind,observedAt,sessions"
    && activityFields(value, true) && isSessionList(value.sessions) && isIdentitySnapshot(value.identitySnapshot)
    && new Set(value.sessions.map(row => row.sessionId)).size === value.sessions.length;
}

interface McpIntentClaimCommon {
  nodeId: string;
  credentialVersion: number;
  requestId: string;
  callId: string;
  tool: McpTool;
  argumentsDigest: string;
}

export type McpIntentClaim = McpIntentClaimCommon & (
  { runtime: "codex"; sessionId: string; threadId: string }
  | { runtime: "claude-code"; sessionId?: never; threadId?: never }
);

export interface McpCredentialRotateBody { requestId: string }
export type McpCredentialBody = { requestId: string; ok: true; token: string; version: number }
  | { requestId: string; ok: false; error: string };
export type McpIntentReceiptBody = { requestId: string; ok: true; expiresAt: number; version: number }
  | { requestId: string; ok: false; error: string };
// messageId and reply (issue #308): the one item an MCP reply answers, whose
// parent row the Worker no longer holds; the node marks it answered.
export interface McpInboxRequestBody { requestId: string; sessionId: string; limit: number; runtime?: McpRuntime; messageId?: string; reply?: true }
export interface McpInboxItem {
  messageId: string;
  from: { nodeId: string; session: string };
  createdAt: string;
  text: string;
  inReplyTo?: string;
  depth: number;
}
export type McpInboxResponseBody = { requestId: string; ok: true; items: McpInboxItem[] }
  | { requestId: string; ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[A-Za-z0-9_-]{43,64}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isShortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
export function isSelfAssignmentSlot(value: unknown): value is SelfAssignmentSlot {
  return typeof value === "string" && (SELF_ASSIGNMENT_SLOTS as readonly string[]).includes(value);
}
export function isMcpAssignment(value: unknown, sessionId: string): value is McpAssignment {
  if (!isObject(value) || Object.keys(value).some(key => !["slot", "turnId", "native"].includes(key))
    || !isSelfAssignmentSlot(value.slot) || !isShortString(value.turnId, 128)) return false;
  if (value.native === undefined) return true;
  const native = value.native;
  const keys = value.slot === "kherep-lead" ? "chatName,leadGuardVersion,originalMain,platform,sessionId" : "chatName,originalMain,platform,sessionId";
  return isObject(native) && Object.keys(native).sort((left, right) => {
    if (left < right) return -1;
    return left > right ? 1 : 0;
  }).join(",") === keys && (value.slot !== "kherep-lead" || native.leadGuardVersion === 1)
    && native.originalMain === true && native.platform === "darwin" && native.sessionId === sessionId
    && isShortString(native.chatName, 1024) && native.chatName.trim().length > 0
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(native.chatName);
}

export function isMcpLeadConfirmRequest(value: unknown): value is McpLeadConfirmRequest {
  return isObject(value) && Object.keys(value).sort((left, right) => {
    if (left < right) return -1;
    return left > right ? 1 : 0;
  }).join(",") === "argumentsDigest,callId,credentialVersion,expiresAt,leadGuardVersion,nodeId,nonce,requestId,sessionId,slot,threadId,turnId"
    && typeof value.nonce === "string" && UUID.test(value.nonce) && value.nonce !== value.requestId
    && typeof value.nodeId === "string" && UUID.test(value.nodeId)
    && typeof value.requestId === "string" && UUID.test(value.requestId)
    && typeof value.sessionId === "string" && UUID.test(value.sessionId) && value.threadId === value.sessionId
    && isShortString(value.turnId, 128) && isShortString(value.callId, 128)
    && value.slot === "kherep-lead" && value.leadGuardVersion === 1
    && typeof value.argumentsDigest === "string" && DIGEST.test(value.argumentsDigest)
    && Number.isSafeInteger(value.credentialVersion) && Number(value.credentialVersion) > 0 && Number.isSafeInteger(value.expiresAt);
}
export function isMcpLeadConfirmResponse(value: unknown): value is McpLeadConfirmResponse {
  return isObject(value) && Object.keys(value).sort((left, right) => {
    if (left < right) return -1;
    return left > right ? 1 : 0;
  }).join(",") === "allowed,nonce"
    && typeof value.nonce === "string" && UUID.test(value.nonce) && typeof value.allowed === "boolean";
}

export function isMcpTool(value: unknown): value is McpTool {
  return typeof value === "string" && (MCP_TOOLS as readonly string[]).includes(value);
}

export function isMcpIntentRegistration(value: unknown): value is McpIntentRegistration {
  if (!isObject(value)) return false;
  const ttl = value.ttlMs;
  const runtime = value.runtime;
  if (value.tool === "assign_self") {
    if (runtime !== "codex" || typeof value.sessionId !== "string" || !UUID.test(value.sessionId)
      || value.threadId !== value.sessionId || !isMcpAssignment(value.assignment, value.sessionId)
      || Object.keys(value).some(key => !["requestId", "runtime", "sessionId", "threadId", "callId", "tool", "argumentsDigest", "ttlMs", "assignment"].includes(key))) return false;
  } else if (value.assignment !== undefined) return false;
  return typeof value.requestId === "string" && UUID.test(value.requestId)
    && (runtime === "codex" || runtime === "claude-code")
    && isShortString(value.sessionId, 128)
    && (runtime === "claude-code" ? !Object.hasOwn(value, "threadId")
      : value.threadId === undefined || isShortString(value.threadId, 128))
    && isShortString(value.callId, 128)
    && isMcpTool(value.tool)
    && typeof value.argumentsDigest === "string" && DIGEST.test(value.argumentsDigest)
    && (ttl === undefined || (Number.isSafeInteger(ttl) && Number(ttl) > 0 && Number(ttl) <= MCP_INTENT_TTL_MAX_MS));
}

export function isMcpIntentClaim(value: unknown): value is McpIntentClaim {
  if (!isObject(value)) return false;
  const common = typeof value.nodeId === "string" && UUID.test(value.nodeId)
    && Number.isSafeInteger(value.credentialVersion) && Number(value.credentialVersion) > 0
    && typeof value.requestId === "string" && UUID.test(value.requestId)
    && isShortString(value.callId, 128) && isMcpTool(value.tool)
    && typeof value.argumentsDigest === "string" && DIGEST.test(value.argumentsDigest);
  if (!common) return false;
  if (value.runtime === "codex") return isShortString(value.sessionId, 128) && isShortString(value.threadId, 128);
  return value.runtime === "claude-code" && !Object.hasOwn(value, "sessionId") && !Object.hasOwn(value, "threadId");
}

export function isMcpCredentialRotateBody(value: unknown): value is McpCredentialRotateBody {
  return isObject(value) && typeof value.requestId === "string" && UUID.test(value.requestId);
}

export function isMcpCredentialBody(value: unknown): value is McpCredentialBody {
  if (!isObject(value) || typeof value.requestId !== "string" || !UUID.test(value.requestId) || typeof value.ok !== "boolean") return false;
  return value.ok === true
    ? isShortString(value.token, 256) && Number.isSafeInteger(value.version) && Number(value.version) > 0
    : isShortString(value.error, 256);
}

export function isMcpIntentReceiptBody(value: unknown): value is McpIntentReceiptBody {
  if (!isObject(value) || typeof value.requestId !== "string" || !UUID.test(value.requestId) || typeof value.ok !== "boolean") return false;
  return value.ok === true
    ? Number.isSafeInteger(value.expiresAt) && Number.isSafeInteger(value.version) && Number(value.version) > 0
    : isShortString(value.error, 256);
}

export function isMcpInboxRequestBody(value: unknown): value is McpInboxRequestBody {
  return isObject(value) && typeof value.requestId === "string" && UUID.test(value.requestId)
    && isShortString(value.sessionId, 128) && Number.isSafeInteger(value.limit) && Number(value.limit) > 0 && Number(value.limit) <= 20
    && (value.runtime === undefined || value.runtime === "codex" || value.runtime === "claude-code")
    && (value.messageId === undefined || (typeof value.messageId === "string" && UUID.test(value.messageId)))
    && (value.reply === undefined || (value.reply === true && value.messageId !== undefined));
}

export function isMcpInboxResponseBody(value: unknown): value is McpInboxResponseBody {
  if (!isObject(value) || typeof value.requestId !== "string" || !UUID.test(value.requestId) || typeof value.ok !== "boolean") return false;
  if (value.ok === false) return isShortString(value.error, 256);
  return Array.isArray(value.items) && value.items.length <= 20 && value.items.every((item) => {
    if (!isObject(item) || typeof item.messageId !== "string" || !UUID.test(item.messageId)
      || !isObject(item.from) || typeof item.from.nodeId !== "string" || !(UUID.test(item.from.nodeId) || item.from.nodeId === "operator")
      || !isShortString(item.from.session, 128) || !isShortString(item.createdAt, 64) || Number.isNaN(Date.parse(item.createdAt))
      || !isShortString(item.text, 16_384) || !Number.isSafeInteger(item.depth) || Number(item.depth) < 0) return false;
    return item.inReplyTo === undefined || (typeof item.inReplyTo === "string" && UUID.test(item.inReplyTo));
  });
}

function compareCanonicalKeys([a]: [string, unknown], [b]: [string, unknown]): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("MCP arguments must contain finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(compareCanonicalKeys);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError("MCP arguments must be JSON values");
}

export async function digestMcpArguments(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/(?<!=)=+$/, "");
}
