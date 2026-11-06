// Kherep Control Plane wire protocol, Phase 1 (GitHub issue #5).
// Shared by the Worker (modules/control-plane/worker) and the node daemon
// (modules/control-plane/node). Plain ECMAScript only: no Node or Workers
// imports, so both runtimes load the same file.

export const PROTOCOL_VERSION = 1;

// The message.* and directory types carry session-to-session messages and the
// directory of addressable sessions (Phase 2, issue #31); their bodies and
// validators live in protocol-messages.mts.
export const MESSAGE_TYPES = [
  "challenge", "auth", "register", "capabilities.update", "sessions.snapshot",
  "command", "command.ack", "command.result", "event", "error",
  "message.resolve.request", "message.resolve.response", "message.send", "message.deliver", "message.status", "directory.get", "directory",
  "task.report", "task.request",
  "mcp.credential.rotate", "mcp.credential", "mcp.intent.register", "mcp.intent.receipt",
  "mcp.inbox.request", "mcp.inbox.response",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

// The only commands Phase 1 dispatches. The Worker refuses anything else at the
// API, and the node refuses anything else even when it arrives authenticated.
export const PHASE1_COMMANDS = ["node.status", "runtime.list", "session.list"] as const;
export type Phase1Command = (typeof PHASE1_COMMANDS)[number];
// Session control (issue #31, item 5). Only the Worker's task dispatch sends
// them, never the command API; their args are validated per command in
// protocol-tasks.mts, and a node runs them only when its policy enables sessions.
export const SESSION_COMMANDS = ["session.start", "session.stop", "session.continue"] as const;
export type SessionCommand = (typeof SESSION_COMMANDS)[number];
export type NodeCommand = Phase1Command | SessionCommand;

export interface Envelope<B = unknown> {
  v: number;
  type: MessageType;
  id: string;
  seq: number;
  ack: number;
  ts: string;
  body: B;
}

// Application-level liveness frames. They are fixed strings, not envelopes,
// because the Durable Object answers them through setWebSocketAutoResponse,
// which matches the exact request text without waking the object.
// https://developers.cloudflare.com/durable-objects/api/state/#setwebsocketautoresponse
export const PING_FRAME = '{"type":"ping"}';
export const PONG_FRAME = '{"type":"pong"}';

export const MAX_FRAME_BYTES = 64 * 1024;
// A challenge nonce is valid for this long after the server issued it.
export const NONCE_TTL_MS = 30_000;
// The node's signed timestamp may differ from server time by at most this much.
export const CLOCK_SKEW_MS = 60_000;

const NODE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

export function isNodeId(value: unknown): value is string {
  return typeof value === "string" && NODE_ID.test(value);
}

export function isPhase1Command(value: unknown): value is Phase1Command {
  return typeof value === "string" && (PHASE1_COMMANDS as readonly string[]).includes(value);
}

export function isSessionCommand(value: unknown): value is SessionCommand {
  return typeof value === "string" && (SESSION_COMMANDS as readonly string[]).includes(value);
}

export function makeEnvelope<B>(type: MessageType, body: B, seq: number, ack: number, id: string = crypto.randomUUID()): Envelope<B> {
  return { v: PROTOCOL_VERSION, type, id, seq, ack, ts: new Date().toISOString(), body };
}

export type ParseResult = { ok: true; envelope: Envelope } | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseEnvelope(raw: string | ArrayBuffer): ParseResult {
  if (typeof raw !== "string") return { ok: false, error: "binary frames are not accepted" };
  if (raw.length > MAX_FRAME_BYTES) return { ok: false, error: "frame too large" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "frame is not JSON" };
  }
  if (!isObject(value)) return { ok: false, error: "envelope must be an object" };
  if (value.v !== PROTOCOL_VERSION) return { ok: false, error: "unsupported protocol version" };
  if (!(MESSAGE_TYPES as readonly unknown[]).includes(value.type)) return { ok: false, error: "unknown message type" };
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 128) return { ok: false, error: "invalid id" };
  if (!isCounter(value.seq) || !isCounter(value.ack)) return { ok: false, error: "invalid seq or ack" };
  if (typeof value.ts !== "string" || Number.isNaN(Date.parse(value.ts))) return { ok: false, error: "invalid ts" };
  if (!isObject(value.body)) return { ok: false, error: "body must be an object" };
  return { ok: true, envelope: value as unknown as Envelope };
}

// ---- Message bodies -------------------------------------------------------

export interface ChallengeBody { nonce: string; serverTime: number }
export interface AuthBody { nodeId: string; nonce: string; timestamp: number; signature: string }
export interface RuntimeInfo { name: string; kind: "cli" | "local-endpoint"; version?: string; endpoint?: string }
// name, cwd and kind were added in Phase 2 (issue #31); older nodes omit them.
// label (issue #74) is the display name of a task session, for example
// "intercom: claude@sekhmet"; the session keeps its task-<8> name.
// title (issue #88) is the Codex thread title the Codex app shows; display
// only, never an address. Older nodes and Workers omit or ignore it.
import { isCanonicalIdentity, type CanonicalIdentityV1 } from "./protocol-session-identity.mts";
export interface SessionInfo {
  sessionId: string; runtime: string; state: string; startedAt?: string; name?: string; cwd?: string; kind?: string; label?: string;
  title?: string; canonicalIdentity?: CanonicalIdentityV1;
}
export interface NodeFacts { hostname: string; os: string; arch: string; cpus: number; memoryBytes: number }
export interface RegisterBody { facts: NodeFacts; runtimes: RuntimeInfo[]; capabilities: string[] }
// args: only session commands carry them (protocol-tasks.mts isCommandArgs).
export interface CommandBody { commandId: string; command: NodeCommand; args?: Record<string, unknown> }
export interface CommandAckBody { commandId: string }
export interface CommandResultBody { commandId: string; ok: boolean; result?: unknown; error?: string }

export function isAuthBody(body: unknown): body is AuthBody {
  return isObject(body) && isNodeId(body.nodeId) && typeof body.nonce === "string" && B64URL.test(body.nonce)
    && isCounter(body.timestamp) && typeof body.signature === "string" && B64URL.test(body.signature);
}

// A display label (issue #74): letters, digits, space, ":", "@", "-", "_"
// and ".", at most 64 characters, not starting or ending with a space.
export function isLabel(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9:@._-]([A-Za-z0-9 :@._-]{0,62}[A-Za-z0-9:@._-])?$/.test(value);
}

// A session title (issue #88): 1 to MAX_TITLE_CHARS characters without control,
// format or line-separator characters, not starting or ending with whitespace.
export const MAX_TITLE_CHARS = 60;
export function isTitle(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u.test(value)
    && [...value].length <= MAX_TITLE_CHARS;
}

function isShortString(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function isRuntimeInfo(value: unknown): value is RuntimeInfo {
  return isObject(value) && isShortString(value.name, 64) && (value.kind === "cli" || value.kind === "local-endpoint")
    && (value.version === undefined || isShortString(value.version))
    && (value.endpoint === undefined || isShortString(value.endpoint));
}

export function isSessionInfo(value: unknown): value is SessionInfo {
  return isObject(value) && isShortString(value.sessionId, 128) && isShortString(value.runtime, 64)
    && isShortString(value.state, 32) && (value.startedAt === undefined || isShortString(value.startedAt, 64))
    && (value.name === undefined || isShortString(value.name, 128)) && (value.cwd === undefined || isShortString(value.cwd, 512))
    && (value.kind === undefined || isShortString(value.kind, 32)) && (value.label === undefined || isLabel(value.label))
    && (value.title === undefined || isTitle(value.title))
    && (value.canonicalIdentity === undefined || isCanonicalIdentity(value.canonicalIdentity)
      && value.canonicalIdentity.sessionId === value.sessionId && value.canonicalIdentity.runtime === value.runtime);
}

export function isNodeFacts(value: unknown): value is NodeFacts {
  return isObject(value) && isShortString(value.hostname) && isShortString(value.os, 64) && isShortString(value.arch, 32)
    && isCounter(value.cpus) && isCounter(value.memoryBytes);
}

export function isRuntimeList(value: unknown): value is RuntimeInfo[] {
  return Array.isArray(value) && value.length <= 64 && value.every(isRuntimeInfo);
}

export function isSessionList(value: unknown): value is SessionInfo[] {
  return Array.isArray(value) && value.length <= 512 && value.every(isSessionInfo);
}

export function isRegisterBody(body: unknown): body is RegisterBody {
  return isObject(body) && isNodeFacts(body.facts) && isRuntimeList(body.runtimes)
    && Array.isArray(body.capabilities) && body.capabilities.length <= 64 && body.capabilities.every((c) => isShortString(c, 64));
}

export function isCommandBody(body: unknown): body is CommandBody {
  return isObject(body) && isShortString(body.commandId, 128) && typeof body.command === "string"
    && (body.args === undefined || isObject(body.args));
}

export function isCommandResultBody(body: unknown): body is CommandResultBody {
  return isObject(body) && isShortString(body.commandId, 128) && typeof body.ok === "boolean"
    && (body.error === undefined || isShortString(body.error, 1024));
}

// ---- Challenge signature --------------------------------------------------

// The exact bytes a node signs with its Ed25519 key. Domain-separated so a
// signature cannot be replayed into another protocol that uses the same key.
export function challengeMessage(nonce: string, nodeId: string, timestamp: number): Uint8Array {
  return new TextEncoder().encode(`kherep-control/v${PROTOCOL_VERSION}/auth\n${nonce}\n${nodeId}\n${timestamp}`);
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/(?<!=)=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  if (!B64URL.test(text)) throw new Error("not base64url");
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
