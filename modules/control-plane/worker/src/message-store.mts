import { identityDiagnostic, selectedProofDimensions, type IdentityComparison } from "./message-identity-diagnostics.mts";
import { blockerDiagnostic, MESSAGING_DIAGNOSTICS_CAPABILITY } from "../../protocol-diagnostics.mts";
import { readDiagnostic, storeDiagnostic } from "./message-diagnostics.mts";
import type { MessageDiagnostic } from "../../protocol-diagnostics.mts";
import { compatibleDiagnostic } from "../../protocol-diagnostics.mts";
import { egressBinding } from "./message-egress-binding.mts";
import { changedIdentityDimension, sameLoopIdentity } from "./message-semantic-identity.mts";
import { duplicateSendError, recoveryOwnerError } from "./message-dedup.mts";
import { RESOLUTION_REQUIRED, type MessageBinding } from "../../protocol-message-binding.mts";
import { bindingContext, selectedAgreesWithProof, type PreparedBinding } from "./message-binding.mts";
import { BINDING_COLUMNS, migrateMessageBinding, storedMessageBinding } from "./message-binding-store.mts";
import { LOOP_LINEAGE, LOOP_STALE, LOOP_COMPATIBILITY, safeLoopReason, MESSAGING_LOOP_BRAKE_CAPABILITY, type LoopAdmissionV1 } from "../../protocol-loop-brake.mts";
import { LoopIdentity, LOOP_COLUMNS, ALL_LOOP_FIELDS, loopColumnType, parentOf, pairIdentity, storedLoopLineage, type LoopSnapshot } from "./message-loop-identity.mts";
import { MessageLoopStore, LOOP_QUERIES } from "./message-loop-store.mts";
import { prepareLoopSignal, type LoopSigner, type LoopSignal } from "./message-loop-signals.mts";
import {
  MAX_REPLY_DEPTH, MESSAGING_CAPABILITY, OPERATOR_NODE_ID, type MessageAddress, type MessageDeliverBody, type MessageProgress, type MessageReceiptBody, type MessageState,
  type MessageStatusBody, type NodeReportedState, legacyProgress,
} from "../../protocol-messages.mts";
import { depthExceeded, DEPTH_QUERIES, REPLY_DEPTH_EXCEEDED, replyDepth } from "./message-depth.mts";
import { isQueued, PROXY_QUERIES, PROXY_SUPERSEDED, PROXY_SUPERSEDED_READ, proxyRefusal, supersededProxies } from "./message-proxy.mts";
import { MessageRetention, RETENTION_QUERIES } from "./message-retention.mts";
import { QUEUE_HEAD } from "./node-intake.mts";

// The Registry's `messages` table (issue #31). Additive: an existing Registry
// gains the table on its next start. The message text is kept only while a
// message is queued; every later state sets it to NULL, so the cloud never
// holds text that the target node already has.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_node TEXT NOT NULL,
  from_session TEXT NOT NULL,
  to_node TEXT NOT NULL,
  to_session TEXT NOT NULL,
  in_reply_to TEXT,
  text TEXT,
  state TEXT NOT NULL,
  reason TEXT,
  diagnostic_json TEXT,
  progress_phase TEXT,
  progress_code TEXT,
  progress_observed_at TEXT,
  progress_retry_at TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_to_state ON messages (to_node, state, created_at);
CREATE INDEX IF NOT EXISTS messages_queued_expiry ON messages (expires_at) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS messages_from_node ON messages (from_node);
-- For a later sweep of final-state rows by age (issue #308); not read yet.
CREATE INDEX IF NOT EXISTS messages_state_updated ON messages (state, updated_at);
`;

export const MESSAGE_TTL_MS = 24 * 60 * 60_000;
export const MAX_QUEUED_PER_NODE = 100;
// One exact unordered pair can settle at most two target queues.
export const MAX_HOLD_REFUSAL_REFS = 2 * MAX_QUEUED_PER_NODE;
export type HoldRefusalRef = { messageId: string; nodeId: string };

// Forward-only order of the node-reported progress states. refused and
// expired are final; a duplicate or late report never moves a message back.
const RANK: Partial<Record<MessageState, number>> = { queued: 0, accepted: 1, delivered: 2, replied: 3 };

export interface MessageRecord {
  messageId: string; fromNode: string; fromSession: string; toNode: string; toSession: string; inReplyTo: string | null;
  proxyOf: string | null; state: MessageState; reason: string | null; progress: MessageProgress | null; diagnostic?: MessageDiagnostic;
  loop?: LoopAdmissionV1;
  createdAt: number; updatedAt: number; expiresAt: number;
}

// proxyOf: a proxy answer (message-proxy.mts, issue #408), never with inReplyTo.
export interface NewMessage {
  messageId: string; from: MessageAddress; to: MessageAddress; text: string; inReplyTo?: string; taskId?: string; proxyOf?: string; connectionToken?: string; slotBinding?: MessageBinding;
}

// Frames the caller must push to nodes after the SQL work is done.
export interface MessageEffects {
  deliveries: { nodeId: string; body: MessageDeliverBody }[];
  statuses: { nodeId: string; body: MessageStatusBody; observational?: true }[];
}

export type SendResult = { ok: true; status: MessageStatusBody; effects: MessageEffects } | { ok: false; error: string; diagnostic?: MessageDiagnostic; effects?: MessageEffects };
// advancedFrom: the state a node report moved the message out of (issue #441).
export interface MessageReportResult { effects: MessageEffects; receipt: MessageReceiptBody | null; advancedFrom?: MessageState }

type Audit = (actor: string, action: string, target: string | null, detail: unknown) => void;
// Registered capabilities of an enrolled, non-revoked node, or null.
type Capabilities = (nodeId: string) => string[] | null;

const COLUMNS = "diagnostic_json, id, from_node, from_session, to_node, to_session, in_reply_to, proxy_of, state, reason, progress_phase, progress_code, progress_observed_at, progress_retry_at, created_at, updated_at, expires_at, depth, " + LOOP_COLUMNS + ", " + BINDING_COLUMNS;

// The queries that run on every send, status report and sender reconnect.
// Each names its index of SCHEMA (INDEXED BY fails the query rather than fall
// back to another plan), so its cost does not grow with the final-state rows
// the table keeps (issue #308). Exported with sample bindings for the
// query-plan test.
const EXPIRE_DUE = `SELECT ${COLUMNS} FROM messages INDEXED BY messages_queued_expiry
  WHERE state = 'queued' AND expires_at <= ?`;
const NEXT_EXPIRY = "SELECT MIN(expires_at) AS next FROM messages INDEXED BY messages_queued_expiry WHERE state = 'queued'";
// Issue #493: the replay index. Partial on the acknowledged state, so a
// sender's settled rows are not in it, and a state change by any Worker
// version puts the row back. Runs after the column loop added settled_state
// to an existing table (SCHEMA runs before the column exists). The query
// repeats the index's WHERE term verbatim, so the planner can use the index.
const REPLAY_INDEX = "CREATE INDEX IF NOT EXISTS messages_replay ON messages (from_node) WHERE settled_state IS NOT state";
const STATUS_PAGE = `SELECT rowid AS cursor, ${COLUMNS} FROM messages INDEXED BY messages_replay
  WHERE from_node = ? AND settled_state IS NOT state AND rowid > ? ORDER BY rowid LIMIT ?`;
export const HOT_MESSAGE_QUERIES = {
  expireDue: { sql: EXPIRE_DUE, args: [0] },
  nextExpiry: { sql: NEXT_EXPIRY, args: [] },
  statusPage: { sql: STATUS_PAGE, args: ["node", 0, 128] },
  queueHead: { sql: QUEUE_HEAD, args: ["node"] },
  ...DEPTH_QUERIES, ...RETENTION_QUERIES, ...PROXY_QUERIES, ...LOOP_QUERIES,
} as const;

export interface PreparedLoop { slotBinding?: MessageBinding; binding?: PreparedBinding; snapshot: LoopSnapshot; key: string | null; signal: LoopSignal | null; error?: string }
function loopOf(row: Record<string, SqlStorageValue>): LoopAdmissionV1 | undefined {
  const lineage = storedLoopLineage(row);
  if (lineage.kind === "guarded-invalid") throw new Error(LOOP_LINEAGE);
  return lineage.kind === "guarded" ? lineage.loop : undefined;
}

function recordMetadata(row: Record<string, SqlStorageValue>): MessageRecord {
  const diagnostic = readDiagnostic(row.diagnostic_json, String(row.state), row.progress_observed_at);
  return {
    messageId: String(row.id), fromNode: String(row.from_node), fromSession: String(row.from_session),
    toNode: String(row.to_node), toSession: String(row.to_session), inReplyTo: row.in_reply_to as string | null,
    proxyOf: (row.proxy_of ?? null) as string | null, state: row.state as MessageState, reason: row.reason as string | null,
    progress: row.progress_phase === null || row.progress_phase === undefined ? null : {
      phase: String(row.progress_phase) as MessageProgress["phase"], code: String(row.progress_code) as MessageProgress["code"],
      observedAt: String(row.progress_observed_at),
      ...(row.progress_retry_at === null || row.progress_retry_at === undefined ? {} : { retryAt: String(row.progress_retry_at) }),
    },
    ...(diagnostic ? { diagnostic } : {}),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), expiresAt: Number(row.expires_at),
  };
}

function toRecord(row: Record<string, SqlStorageValue>): MessageRecord {
  const metadata = recordMetadata(row);
  // Refused corrupt proof remains stored verbatim. Only its fixed terminal
  // status may be projected; no authoritative loop context or legacy parent.
  if (metadata.state === "refused" && metadata.reason === LOOP_LINEAGE && storedLoopLineage(row).kind === "guarded-invalid") return metadata;
  const loop = loopOf(row);
  return { ...metadata, ...(loop ? { loop } : {}) };
}

function statusBody(messageId: string, state: MessageState, reason: string | null, progress: MessageProgress | null = null, diagnostic?: MessageDiagnostic): MessageStatusBody {
  return { messageId, state, ...(reason === null || progress ? {} : { reason }), ...(state === "accepted" && progress ? { progress } : {}), ...(diagnostic ? { diagnostic } : {}) };
}

function statusOf(record: MessageRecord): MessageStatusBody {
  return statusBody(record.messageId, record.state, record.reason, record.progress, record.diagnostic);
}

// Builds the deliver body from a queued row, which always still has its text.
function deliverBodyOf(row: Record<string, SqlStorageValue>): MessageDeliverBody {
  const loop = loopOf(row);
  return {
    messageId: String(row.id), from: { nodeId: String(row.from_node), session: String(row.from_session) },
    toSession: String(row.to_session), text: String(row.text),
    ...(row.in_reply_to === null ? {} : { inReplyTo: String(row.in_reply_to) }),
    ...(row.proxy_of === null || row.proxy_of === undefined ? {} : { proxyOf: String(row.proxy_of) }),
    ...(row.task_id === null || row.task_id === undefined ? {} : { taskId: String(row.task_id) }),
    ...(loop ? { loop } : {}),
    createdAt: new Date(Number(row.created_at)).toISOString(),
  };
}

const none = (): MessageEffects => ({ deliveries: [], statuses: [] });

// Synchronous SQL only; the Registry runs each call inside one transaction.
export class MessageStore {
  // Issue #308: tombstones and the deletion of acknowledged messages.
  readonly retention: MessageRetention;
  readonly loops: MessageLoopStore;
  private readonly identity: LoopIdentity;
  private readonly sql: SqlStorage;
  private readonly audit: Audit;
  private readonly capabilities: Capabilities;

  constructor(sql: SqlStorage, audit: Audit, capabilities: Capabilities) {
    this.sql = sql;
    this.audit = audit;
    this.capabilities = capabilities;
    this.sql.exec(SCHEMA);
    // Item 5: the task a message belongs to, added to an existing table.
    const columns = this.sql.exec("PRAGMA table_info(messages)").toArray().map((c) => String(c.name));
    if (!columns.includes("task_id")) this.sql.exec("ALTER TABLE messages ADD COLUMN task_id TEXT");
    for (const [name, type] of [["diagnostic_json", "TEXT"], ["progress_phase", "TEXT"], ["progress_code", "TEXT"], ["progress_observed_at", "TEXT"],
      ["progress_retry_at", "TEXT"], ["reply_message_id", "TEXT"], ["depth", "INTEGER"], ["delete_after", "INTEGER"],
      ["deletable", "INTEGER"], ["proxy_of", "TEXT"], ["settled_state", "TEXT"], ...ALL_LOOP_FIELDS.map((name) => [name, loopColumnType(name)] as const)] as const) {
      if (!columns.includes(name)) this.sql.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
    }
    migrateMessageBinding(this.sql);
    this.sql.exec(REPLAY_INDEX);
    this.retention = new MessageRetention(sql, audit, capabilities);
    this.loops = new MessageLoopStore(sql);
    this.identity = new LoopIdentity(sql, capabilities);
  }

  private compareSnapshots(prepared: PreparedLoop, current: LoopSnapshot, now: number) {
    if (prepared.slotBinding) return { matches: sameLoopIdentity(prepared.snapshot,current,{parentRetirementEquivalent:true}), parentRetirementEquivalent:true };
    const parentRetirementEquivalent = this.identity.parentRetirementEquivalent(prepared.snapshot, current, prepared.key, now);
    return { matches: sameLoopIdentity(prepared.snapshot, current, { parentRetirementEquivalent }), parentRetirementEquivalent };
  }
  compareContext(message: NewMessage, prepared: PreparedLoop): IdentityComparison {
    if (prepared.error) return { matches: false };
    if (prepared.slotBinding) return this.compareSnapshots(prepared,this.slotSnapshot(message,prepared.slotBinding),Date.now());
    const context = prepared.binding ? bindingContext(this.sql, message) : undefined;
    if (prepared.binding && context?.stamp !== prepared.binding.stamp) return { matches: false, context };
    const now = Date.now(), current = this.identity.snapshot(message.from, message.to, message.inReplyTo ?? message.proxyOf, now);
    return { ...this.compareSnapshots(prepared, current, now), current, context };
  }
  async prepare(message: NewMessage, sign: LoopSigner): Promise<PreparedLoop> {
    const snapshot = message.slotBinding ? this.slotSnapshot(message, message.slotBinding) : this.identity.snapshot(message.from, message.to, message.inReplyTo ?? message.proxyOf);
    if (!snapshot.encoding) return { snapshot, key: null, signal: null };
    try {
      const key = await sign("kherep-loop-pair-v1", snapshot.encoding);
      // Prefix stripping has exactly the same live-original authorization as admission.
      const proxy = message.proxyOf && proxyRefusal(this.sql, message.proxyOf, message.from, message.to) === null
        ? { owner: message.from.session, messageId: message.proxyOf } : undefined;
      const signal = snapshot.both && snapshot.from && snapshot.to ? await prepareLoopSignal(message.text, sign, proxy) : null;
      return { snapshot, key, signal, ...(message.slotBinding ? { slotBinding: message.slotBinding,
        binding: { stamp: "slot-admission", binding: message.slotBinding, denyKey: key, leaseId: null, localGeneration: null } } : {}) };
    } catch { return { snapshot, key: null, signal: null, error: "loop-crypto-unavailable" }; }
  }

  private slotSnapshot(message: NewMessage, binding: MessageBinding): LoopSnapshot {
    const pair = pairIdentity(message.from, message.to);
    const both = [message.from, message.to].every(a => this.capabilities(a.nodeId)?.includes(MESSAGING_LOOP_BRAKE_CAPABILITY));
    return { from: message.from, to: message.to, both, parent: parentOf(this.sql, message.inReplyTo),
      encoding: pair?.encoding ?? null, direction: pair?.direction ?? null, identityBinding: null,
      compatibility: both, proofs: binding, connections: [] };
  }
  private slotMode(snapshot: LoopSnapshot, message: NewMessage, key: string | null): "guarded" | { reason: string } {
    if (!snapshot.both || snapshot.direction === null || !key) return {reason:LOOP_COMPATIBILITY};
    if (!message.inReplyTo) return "guarded";
    const p = snapshot.parent, original = this.retention.slotOperation(message.inReplyTo)?.binding;
    if (p.kind !== "guarded" || !original || p.pair !== key || snapshot.direction !== 1-p.direction
      || !["accepted","delivered","replied"].includes(String(p.row.state))
      || p.row.from_node !== original.slot?.fromNode || p.row.to_node !== original.slot?.toNode
      || p.row.from_session !== null && p.row.from_session !== original.from.sessionId
      || p.row.to_session !== null && p.row.to_session !== original.to.sessionId
      || original.slot?.toNode !== message.from.nodeId || original.to.sessionId !== message.from.session
      || original.slot?.fromNode !== message.to.nodeId || original.from.sessionId !== message.to.session
      || JSON.stringify(original.to) !== JSON.stringify(message.slotBinding?.from)
      || JSON.stringify(original.from) !== JSON.stringify(message.slotBinding?.to)) return {reason:LOOP_LINEAGE};
    return "guarded";
  }

  // Authorization is checked by the caller; replay never scores or creates a delivery.
  replay(messageId: string, fromNode: string, revalidate = true): SendResult | null {
    const effects = none();
    const row = this.sql.exec(`SELECT ${COLUMNS} FROM messages WHERE id = ?`, messageId).toArray()[0];
    if (revalidate && row?.from_node === fromNode && row.state === "queued") this.queueDeliveryAllowed(row, Date.now(), effects);
    const existing = !revalidate && row ? recordMetadata(row) : this.get(messageId);
    if (existing) return existing.fromNode !== fromNode ? { ok: false, error: "duplicate messageId" }
      : { ok: true, status: this.statusFor(fromNode, statusOf(existing)), effects };
    const settled = this.retention.resend(messageId, fromNode);
    return settled ? settled.ok ? { ...settled, effects: none() } : settled : null;
  }

  // Tombstones intentionally retain no endpoint identity/body. A payload retry
  // cannot establish the original owner from historical status alone.
  tombstoneOnlyPayload(messageId: string): boolean {
    return this.sql.exec("SELECT id FROM messages WHERE id=?", messageId).toArray().length === 0
      && this.sql.exec("SELECT id FROM message_tombstones WHERE id=?", messageId).toArray().length !== 0;
  }

  recoveryOwnerError(messageId: string, nodeId: string, sessionId: string, runtime: string): string | null {
    const row = this.sql.exec(`SELECT ${COLUMNS} FROM messages WHERE id=?`, messageId).toArray()[0];
    return row ? recoveryOwnerError(row, nodeId, sessionId, runtime) : null;
  }

  // Re-offer only this rejected operation's unacknowledged terminal statuses.
  // Never read payloads, expire rows, admit work or resolve current role holders.
  outstandingHoldRefusals(reason: string, refs: readonly HoldRefusalRef[]): MessageEffects {
    if (!reason.startsWith("loop-held:") || safeLoopReason(reason) !== reason || refs.length > MAX_HOLD_REFUSAL_REFS) {
      throw new Error("invalid hold refusal recovery metadata");
    }
    const senders = new Map<string, string>();
    for (let start = 0; start < refs.length; start += 64) {
      const batch = refs.slice(start, start + 64);
      for (const row of this.sql.exec(`SELECT id,from_node FROM messages WHERE id IN (${batch.map(()=>"?").join(",")})
        AND state='refused' AND reason=? AND settled_state IS NOT state`, ...batch.map(ref=>ref.messageId), reason).toArray()) {
        senders.set(String(row.id), String(row.from_node));
      }
    }
    const effects = none(), enrolled = new Map<string, boolean>();
    for (const ref of refs) {
      if (senders.get(ref.messageId) !== ref.nodeId) continue;
      if (!enrolled.has(ref.nodeId)) enrolled.set(ref.nodeId, this.capabilities(ref.nodeId) !== null);
      if (enrolled.get(ref.nodeId)) effects.statuses.push({nodeId:ref.nodeId,body:{messageId:ref.messageId,state:"refused",reason}});
    }
    return effects;
  }

  // Records one message as queued, or as refused when the target cannot take
  // it. A bound retry proves the same exact owners before returning status.
  send(message: NewMessage, actor: string, now: number, prepared?: PreparedLoop): SendResult {
    if (!message.slotBinding && (this.retention.slotOperation(message.messageId)
      || (message.inReplyTo || message.proxyOf) && this.retention.slotOperation((message.inReplyTo ?? message.proxyOf)!))) return {ok:false,error:"protected native route required"};
    const effects = this.expireDue(now);
    const row = this.sql.exec(`SELECT ${COLUMNS}, text, task_id FROM messages WHERE id = ?`, message.messageId).toArray()[0];
    if (row) {
      const comparison = prepared ? this.compareContext(message, prepared) : undefined;
      const error = duplicateSendError(row, message, prepared, comparison?.matches === true);
      if (error) {
        const diagnostic = error === LOOP_STALE && prepared && comparison ? identityDiagnostic(prepared, comparison, "duplicate", now)
          : error === RESOLUTION_REQUIRED && storedMessageBinding(row) !== "invalid" && prepared?.binding?.diagnosticCode
            ? blockerDiagnostic(prepared.binding.diagnosticCode, now, "duplicate") : undefined;
        return { ok: false, error, ...(diagnostic ? { diagnostic: compatibleDiagnostic({ diagnostic }, this.capabilities(message.from.nodeId)).diagnostic } : {}) };
      }
      if (row.state === "queued") this.queueDeliveryAllowed(row, now, effects);
      const existing = this.get(message.messageId)!;
      return { ok: true, status: this.statusFor(existing.fromNode, statusOf(existing)), effects };
    }
    const settled = this.retention.resend(message.messageId, message.from.nodeId);
    if (settled) return { ok: false, error: "duplicate messageId" };
    if (message.proxyOf !== undefined && message.inReplyTo !== undefined) return { ok: false, error: "a proxy answer is not a reply" };
    const target = message.to.nodeId;
    const capabilities = this.capabilities(target);
    // A proxy answer is one hop deeper than its original, like a reply.
    let depth = replyDepth(this.sql, message.inReplyTo ?? message.proxyOf);
    const proxy = message.proxyOf === undefined ? null : proxyRefusal(this.sql, message.proxyOf, message.from, message.to);
    let reason: string | null = null;
    if (proxy !== null) reason = proxy;
    else if (capabilities === null) reason = "unknown or revoked target node";
    else if (!capabilities.includes(MESSAGING_CAPABILITY)) reason = `target node lacks ${MESSAGING_CAPABILITY}`;
    else if (this.queuedCount(target) >= MAX_QUEUED_PER_NODE) reason = `more than ${MAX_QUEUED_PER_NODE} queued messages for the target node`;
    let loop: LoopAdmissionV1 | undefined;
    const current = message.slotBinding ? this.slotSnapshot(message, message.slotBinding) : this.identity.snapshot(message.from, message.to, message.inReplyTo ?? message.proxyOf, now);
    const mode = message.slotBinding ? this.slotMode(current, message, prepared?.key ?? null) : this.identity.validate(current, prepared?.key ?? null, !!(message.inReplyTo ?? message.proxyOf), now);
    const comparison = prepared ? this.compareSnapshots(prepared, current, now) : undefined;
    const denyKey = prepared?.binding?.binding ? prepared.binding.denyKey : prepared?.key;
    const bindingRequired = !!message.slotBinding || this.loops.hasHeldNodeScope(message.from.nodeId, target)
      || (mode === "guarded" && current.identityBinding !== null);
    let currentContext: ReturnType<typeof bindingContext> | undefined;
    let selectedMismatch = false;
    if (reason === null) {
      if (comparison && !comparison.matches) reason = LOOP_STALE;
      else if (prepared?.error || prepared?.binding?.error) reason = prepared.error ?? prepared.binding!.error!;
      else if (!message.slotBinding && prepared?.binding && prepared.binding.stamp !== (currentContext = bindingContext(this.sql, message)).stamp) reason = LOOP_STALE;
      else if (denyKey && this.loops.held(denyKey)) reason = this.loops.held(denyKey);
      else if (typeof mode === "object") reason = mode.reason;
      else if (bindingRequired && !prepared?.binding?.binding) reason = RESOLUTION_REQUIRED;
      else if (bindingRequired && prepared?.binding?.binding && current.identityBinding !== null
        && (current.from?.session !== prepared.binding.binding.from.sessionId || current.to?.session !== prepared.binding.binding.to.sessionId
          || !selectedAgreesWithProof(prepared.binding.binding, current.identityBinding, current.direction))) { selectedMismatch = true; reason = LOOP_STALE; }
      else if (mode === "legacy") { if (depthExceeded(depth)) reason = REPLY_DEPTH_EXCEEDED; }
      else if (!prepared?.key || !prepared.signal || current.direction === null) reason = "loop-crypto-unavailable";
      else {
        const parent = current.parent.kind === "guarded" ? current.parent : null;
        depth = parent ? parent.depth + 1 : 0;
        if (!Number.isSafeInteger(depth)) reason = LOOP_LINEAGE;
        else {
          const admitted = this.loops.admit({ key: prepared.key, fromNode: message.from.nodeId, toNode: message.to.nodeId,
            messageId: message.messageId, threadId: parent?.threadId ?? message.messageId, depth,
            ...(parent ? { parentGeneration: parent.generation } : {}), signal: prepared.signal, now });
          if ("reason" in admitted) reason = admitted.reason;
          else loop = admitted.loop;
        }
      }
    }
    const deniedKey = reason?.startsWith("loop-held:") ? denyKey : null;
    if (deniedKey) {
      for (const row of this.sql.exec(`SELECT ${COLUMNS} FROM messages INDEXED BY messages_delivery_pair
        WHERE delivery_pair = ? AND state = 'queued'`, deniedKey).toArray()) this.setState(recordMetadata(row), "refused", reason!, actor, now, effects);
      for (const row of this.sql.exec(`SELECT ${COLUMNS} FROM messages INDEXED BY messages_loop_queued
        WHERE loop_pair = ? AND state = 'queued'`, deniedKey).toArray()) {
        this.setState(toRecord(row), "refused", reason!, actor, now, effects);
      }
    }
    // A rejected protected attempt has no message row, but the semantic hold
    // still settles earlier queued traffic and must publish its status effects.
    if (message.slotBinding && reason !== null) return { ok: false, error: reason, effects };
    const diagnostic = reason === LOOP_STALE && prepared ? identityDiagnostic(prepared, { ...comparison, matches: false, current, context: currentContext }, "send-admission", now,
      selectedMismatch ? selectedProofDimensions(prepared, current) : []) : reason === RESOLUTION_REQUIRED && prepared?.binding?.diagnosticCode
      ? blockerDiagnostic(prepared.binding.diagnosticCode, now, "send-admission") : undefined;
    const state: MessageState = reason === null ? "queued" : "refused";

    // Bind queued attested rows to exact canonical endpoints. Delivery rechecks
    // these identities, so a later alias reassignment cannot redirect the queue.
    const binding = reason === null && bindingRequired
      ? prepared?.binding?.binding ?? null : null;
    const storedFrom = binding ? { nodeId: message.from.nodeId, session: binding.from.sessionId } : loop && current.identityBinding ? current.from! : message.from;
    const storedTo = binding ? { nodeId: target, session: binding.to.sessionId } : loop && current.identityBinding ? current.to! : message.to;
    // deletable = 1: a row this Worker version stored, which it may delete (#308).
    this.sql.exec(`INSERT INTO messages (id, from_node, from_session, to_node, to_session, in_reply_to, text, state, reason,
      created_at, updated_at, expires_at, task_id, depth, deletable, proxy_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      message.messageId, storedFrom.nodeId, storedFrom.session, target, storedTo.session, message.inReplyTo ?? null,
      state === "queued" ? message.text : null, state, reason, now, now, now + MESSAGE_TTL_MS, message.taskId ?? null, depth,
      message.proxyOf ?? null);
    if (loop) this.sql.exec(`UPDATE messages SET loop_thread = ?, loop_pair = ?, loop_generation = ?, loop_ordinal = ?, loop_direction = ?, loop_identity = ? WHERE id = ?`,
      loop.threadId, prepared!.key, loop.generation, loop.ordinal, current.direction, current.identityBinding, message.messageId);
    if (binding) this.sql.exec("UPDATE messages SET delivery_binding=?, delivery_pair=? WHERE id=?",
      JSON.stringify(binding), prepared!.binding!.denyKey, message.messageId);
    storeDiagnostic(this.sql, message.messageId, diagnostic);
    this.retention.finalized(message.messageId, message.from.nodeId, state, now);
    this.audit(actor, "message.send", target, { messageId: message.messageId, toSession: message.to.session, state, reason, ...(reason === LOOP_STALE && prepared ? { ...(diagnostic ? { changedDimension: changedIdentityDimension(prepared.snapshot, current,
      { parentRetirementEquivalent: comparison?.parentRetirementEquivalent }) } : { diagnosticGap: true }) } : {}) });
    if (state === "queued") {
      effects.deliveries.push({ nodeId: target, body: {
        messageId: message.messageId, from: storedFrom, toSession: storedTo.session, text: message.text,
        ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
        ...(message.proxyOf === undefined ? {} : { proxyOf: message.proxyOf }),
        ...(message.taskId === undefined ? {} : { taskId: message.taskId }), ...(loop ? { loop } : {}), createdAt: new Date(now).toISOString(),
      } });
      this.markReplied(message, now, effects);
    }
    return { ok: true, status: this.statusFor(message.from.nodeId, statusBody(message.messageId, state, reason, null, diagnostic)), effects };
  }

  // A status reported by the target node. A row or tombstone of another target
  // node gets no receipt. An id without a row settles from its tombstone, or as
  // expired when none is left (lateReceipt), so the node stops re-reporting it.
  // Valid duplicates get the canonical state again so a lost receipt heals on
  // the node's next retry.
  report(nodeId: string, status: MessageStatusBody & { state: NodeReportedState }, now: number): MessageReportResult {
    const effects = this.expireDue(now);
    let record = this.get(status.messageId);
    if (!record) return { effects, receipt: this.retention.lateReceipt(nodeId, status) };
    if (record.toNode !== nodeId) return { effects, receipt: null };
    // Issue #408 (design r3 section 4.3): a refused proxy its target reports taken reached it anyway.
    if (record.state === "refused" && record.proxyOf !== null && (status.state === "accepted" || status.state === "delivered")) {
      this.audit(`node:${nodeId}`, "message.proxy.late-delivery", record.toNode, { messageId: record.messageId, reported: status.state });
    }
    let advancedFrom: MessageState | undefined;
    if (this.mayAdvance(record.state, status.state)) {
      advancedFrom = record.state;
      this.setState(record, status.state, status.reason ?? null, `node:${nodeId}`, now, effects, status.progress, status.diagnostic);
      // Issue #408: the owner read (or refused) the original; a proxy of it not yet delivered loses.
      if (status.state === "delivered" || status.state === "refused") {
        this.refuseQueuedProxies(record, PROXY_SUPERSEDED_READ, `node:${nodeId}`, now, effects);
      }
      record = this.get(status.messageId) ?? record;
    } else if (record.state === "accepted" && status.state === "accepted" && status.progress
      && (!record.progress || Date.parse(status.progress.observedAt) > Date.parse(record.progress.observedAt))) {
      this.setProgress(record, status.progress, `node:${nodeId}`, now, effects, status.diagnostic);
      record = this.get(status.messageId) ?? record;
    }
    return { effects, ...(advancedFrom ? { advancedFrom } : {}), receipt: {
      name: "message.receipt", messageId: status.messageId, requestedState: status.state, storedState: record.state,
      ...(record.state === "accepted" && record.progress ? { storedProgressAt: record.progress.observedAt } : {}),
    } };
  }

  // Metadata-only provenance for local task-control registration. The caller
  // derives authority from the stored sender and target, never from a frame.
  taskControlSource(messageId: string): { ownerNodeId: string; targetNodeId: string } | null {
    const record = this.get(messageId);
    return record ? { ownerNodeId: record.fromNode, targetNodeId: record.toNode } : this.retention.source(messageId);
  }
  // Queued messages for a target that just authenticated. The existing queue
  // limit bounds this set independently of sender-status history.
  pendingFor(nodeId: string, now: number): MessageEffects {
    const effects = this.expireDue(now);
    const rows = this.sql.exec(`SELECT ${COLUMNS}, text, task_id FROM messages
      WHERE to_node = ? AND state = 'queued' ORDER BY created_at, rowid`, nodeId).toArray();
    for (const row of rows) {
      if (this.queueDeliveryAllowed(row, now, effects)) effects.deliveries.push({ nodeId, body: deliverBodyOf(row) });
    }
    return effects;
  }

  // One metadata-only cursor page for a sender reconnect. NodeSession keeps
  // requesting pages until nextCursor is null, so every row whose current
  // state its sender has not acknowledged is replayed (#493) without an
  // unbounded allocation or frame batch; history is complete for what the
  // sender does not yet hold.
  statusPageFor(nodeId: string, afterRowId: number, limit: number): { effects: MessageEffects; nextCursor: number | null } {
    const effects = none();
    const pageSize = Math.min(128, Math.max(1, Math.floor(limit)));
    const cursor = Math.max(0, Math.floor(afterRowId));
    const rows = this.sql.exec(STATUS_PAGE, nodeId, cursor, pageSize).toArray();
    for (const row of rows) effects.statuses.push({ nodeId, body: this.statusFor(nodeId, statusOf(toRecord(row))) });
    const nextCursor = rows.length === pageSize ? Number(rows.at(-1)?.cursor) : null;
    return { effects, nextCursor };
  }

  // Queued messages past their 24 h lifetime become expired and lose their text.
  expireDue(now: number): MessageEffects {
    const effects = none();
    for (const row of this.sql.exec(EXPIRE_DUE, now).toArray()) {
      this.setState(toRecord(row), "expired", null, "system", now, effects);
    }
    return effects;
  }

  // Refuses every message still queued for a node, for example on revocation.
  refuseQueuedFor(nodeId: string, reason: string, actor: string, now: number): MessageEffects {
    const effects = none();
    for (const row of this.sql.exec(`SELECT ${COLUMNS} FROM messages WHERE to_node = ? AND state = 'queued' ORDER BY created_at, rowid`,
      nodeId).toArray()) {
      this.setState(toRecord(row), "refused", reason!, actor, now, effects);
    }
    return effects;
  }

  nextExpiry(): number | null {
    const row = this.sql.exec(NEXT_EXPIRY).one();
    return row.next === null ? null : Number(row.next);
  }

  // Metadata only; the text column is never selected here.
  list(nodeId: string | null, limit: number): MessageRecord[] {
    const rows = nodeId === null
      ? this.sql.exec(`SELECT ${COLUMNS} FROM messages ORDER BY created_at DESC, rowid DESC LIMIT ?`, limit)
      : this.sql.exec(`SELECT ${COLUMNS} FROM messages WHERE from_node = ? OR to_node = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        nodeId, nodeId, limit);
    return rows.toArray().map(toRecord);
  }

  visibleTo(nodeId: string, messageId: string): MessageRecord | null {
    const record = this.get(messageId);
    return record && (record.fromNode === nodeId || record.toNode === nodeId) ? record : null;
  }

  // "missing": no parent row (deleted after its ack, #308); the caller asks the node.
  replyTarget(messageId: string, nodeId: string, session: string): MessageAddress | "missing" | null {
    let record = this.get(messageId);
    if (!record) return "missing";
    if (record.toNode !== nodeId || !["accepted", "delivered", "replied"].includes(record.state)) return null;
    const to = { nodeId: record.fromNode, session: record.fromSession };
    const parent = parentOf(this.sql, messageId);
    if (parent.kind === "guarded-invalid") return null;
    if (parent.kind === "guarded") return this.identity.resolve({ nodeId, session: record.toSession })?.session
      === this.identity.resolve({ nodeId, session })?.session && this.identity.resolve({ nodeId, session }) ? to : null;
    if (record.toSession !== session) return null;
    let depth = 0;
    const seen = new Set<string>();
    while (record.inReplyTo !== null) {
      if (seen.has(record.messageId) || depth >= MAX_REPLY_DEPTH) return null;
      seen.add(record.messageId);
      const parent = this.get(record.inReplyTo);
      if (!parent) break; // deleted after its ack (#308); the depth column bounds the chain
      if (record.fromNode !== parent.toNode || record.fromSession !== parent.toSession
        || record.toNode !== parent.fromNode || record.toSession !== parent.fromSession) return null;
      record = parent;
      depth++;
    }
    return depth < MAX_REPLY_DEPTH && !depthExceeded(replyDepth(this.sql, messageId)) ? to : null;
  }

  private mayAdvance(from: MessageState, to: NodeReportedState | "replied"): boolean {
    if (from === "refused" || from === "expired" || from === "replied") return false;
    if (to === "refused") return from === "queued" || from === "accepted";
    const current = RANK[from];
    const next = RANK[to];
    return current !== undefined && next !== undefined && next > current;
  }

  private markReplied(message: NewMessage, now: number, effects: MessageEffects): void {
    if (!message.inReplyTo) return;
    const original = this.get(message.inReplyTo);
    if (!original || original.toNode !== message.from.nodeId || original.fromNode !== message.to.nodeId
      || original.fromSession !== message.to.session) return;
    if (!this.mayAdvance(original.state, "replied")) return;
    this.setState(original, "replied", null, `node:${message.from.nodeId}`, now, effects);
    // The reply that marked the original, kept for MCP status (issue #200).
    this.sql.exec("UPDATE messages SET reply_message_id = ? WHERE id = ?", message.messageId, original.messageId);
    // Issue #408: the owner's own answer wins over a proxy answer not yet delivered.
    this.refuseQueuedProxies(original, PROXY_SUPERSEDED, `node:${message.from.nodeId}`, now, effects);
  }

  // Issue #408 (design r3 section 4.2): only the queued proxies, never the original.
  private refuseQueuedProxies(original: MessageRecord, reason: string, actor: string, now: number, effects: MessageEffects): void {
    for (const id of supersededProxies(this.sql, original)) {
      const proxy = this.get(id);
      if (proxy) this.setState(proxy, "refused", reason, actor, now, effects);
    }
  }

  // Issue #408 (design r3 section 4.3): a proxy delivery goes out only while its row is queued.
  isQueued(messageId: string): boolean { return isQueued(this.sql, messageId); }
  deliveryReady(messageId: string, now: number): { ready: boolean; effects: MessageEffects } {
    const effects = none();
    const row = this.sql.exec(`SELECT ${COLUMNS} FROM messages WHERE id = ?`, messageId).toArray()[0];
    return { ready: !!row && row.state === "queued" && this.queueDeliveryAllowed(row, now, effects), effects };
  }

  deliveryCandidate(messageId: string): { message: NewMessage; binding: MessageBinding | null; required: boolean } | null {
    const row = this.sql.exec(`SELECT ${COLUMNS}, text, task_id FROM messages WHERE id=? AND state='queued'`, messageId).toArray()[0];
    if (!row) return null;
    const binding = storedMessageBinding(row);
    if (binding === "invalid") return null;
    return { message: { messageId, from: { nodeId: String(row.from_node), session: String(row.from_session) },
      to: { nodeId: String(row.to_node), session: String(row.to_session) }, text: String(row.text) }, binding,
      required: !!binding || row.loop_identity !== null || this.loops.hasHeldNodeScope(String(row.from_node), String(row.to_node)) };
  }
  observeDiagnostic(messageId: string, nodeId: string | null, diagnostic: MessageDiagnostic): MessageEffects {
    const effects = none(), record = this.get(messageId);
    if (!record || record.state !== "queued" || record.toNode !== nodeId
      || record.diagnostic && record.diagnostic.observedAt > diagnostic.observedAt) return effects;
    storeDiagnostic(this.sql, messageId, diagnostic);
    if (record.fromNode !== OPERATOR_NODE_ID && this.capabilities(record.fromNode)?.includes(MESSAGING_DIAGNOSTICS_CAPABILITY)) effects.statuses.push({ nodeId: record.fromNode, observational: true,
      body: this.statusFor(record.fromNode, statusBody(messageId, record.state, record.reason, record.progress, diagnostic)) });
    return effects;
  }
  prepareDelivery(messageId: string, prepared: PreparedBinding | null, now: number, phase?: "auth" | "registration"): { body: MessageDeliverBody | null; effects: MessageEffects } {
    const effects = this.expireDue(now);
    const row = this.sql.exec(`SELECT ${COLUMNS}, text, task_id FROM messages WHERE id=? AND state='queued'`, messageId).toArray()[0];
    if (!row || !this.queueDeliveryAllowed(row, now, effects)) return { body: null, effects };
    const message = { messageId, from: { nodeId: String(row.from_node), session: String(row.from_session) },
      to: { nodeId: String(row.to_node), session: String(row.to_session) } };
    const stored = storedMessageBinding(row);
    if (stored === "invalid") {
      const observed = this.observeDiagnostic(messageId, message.to.nodeId, blockerDiagnostic("stored-binding-missing", now, "upstream-egress"));
      effects.statuses.push(...observed.statuses); return { body: null, effects };
    }
    const required = !!stored || row.loop_identity !== null || this.loops.hasHeldNodeScope(message.from.nodeId, message.to.nodeId);
    const detail: { code?: import("../../protocol-diagnostics.mts").BlockerCode } = {};
    const egress = egressBinding(this.sql, row, prepared, required, phase, detail);
    if (!egress) {
      if (detail.code) effects.statuses.push(...this.observeDiagnostic(messageId, message.to.nodeId, blockerDiagnostic(detail.code, now, "upstream-egress")).statuses);
      return { body: null, effects };
    }
    const key = prepared?.denyKey ?? row.delivery_pair ?? row.loop_pair;
    const held = typeof key === "string" ? this.loops.held(key) : null;
    if (held) { this.setState(recordMetadata(row), "refused", held, "system", now, effects); return { body: null, effects }; }
    if (egress.binding) this.sql.exec("UPDATE messages SET delivery_pair=? WHERE id=? AND state='queued'", prepared!.denyKey, messageId);
    return { body: { ...deliverBodyOf(row), ...egress }, effects };
  }
  private queueDeliveryAllowed(row: Record<string, SqlStorageValue>, now: number, effects: MessageEffects): boolean {
    const lineage = storedLoopLineage(row);
    const denyKey = typeof row.delivery_pair === "string" ? row.delivery_pair : lineage.kind === "guarded" ? lineage.pair : null;
    const held = denyKey ? this.loops.held(denyKey) : null;
    const protectedBinding = storedMessageBinding(row);
    const protectedInvalid = protectedBinding && protectedBinding !== "invalid" && protectedBinding.mode === "slot-exact"
      && (!this.retention.slotOperation(String(row.id))?.binding || !this.capabilities(String(row.from_node)) || !this.capabilities(String(row.to_node)));
    const reason = held ?? (protectedInvalid ? LOOP_COMPATIBILITY : storedMessageBinding(row) === "invalid" ? RESOLUTION_REQUIRED : lineage.kind === "guarded-invalid" ? LOOP_LINEAGE
      : lineage.kind === "guarded" && (!protectedBinding || protectedBinding === "invalid" || protectedBinding.mode !== "slot-exact") && lineage.identityBinding !== null && !this.identity.deliveryValid(row, lineage.identityBinding, now) ? LOOP_COMPATIBILITY
      : lineage.kind === "guarded" && (!this.capabilities(String(row.from_node))?.includes(MESSAGING_LOOP_BRAKE_CAPABILITY)
        || !this.capabilities(String(row.to_node))?.includes(MESSAGING_LOOP_BRAKE_CAPABILITY)) ? LOOP_COMPATIBILITY : null);
    if (reason === null) return true;
    this.setState(recordMetadata(row), "refused", reason, "system", now, effects);
    return false;
  }

  // The reply recorded when a message was marked replied; null for other
  // states and for rows marked before the column existed.
  replyMessageIdOf(messageId: string): string | null {
    const row = this.sql.exec("SELECT reply_message_id FROM messages WHERE id = ?", messageId).toArray()[0];
    return typeof row?.reply_message_id === "string" ? row.reply_message_id : null;
  }

  // Issue #396: a sending node without messaging.progress.v2 gets the older
  // progress code it validates. The row and the audit keep the reported code.
  private statusFor(nodeId: string, body: MessageStatusBody): MessageStatusBody {
    if (nodeId === OPERATOR_NODE_ID) return body;
    body = compatibleDiagnostic(body, this.capabilities(nodeId));
    if (!body.progress) return body;
    return { ...body, progress: legacyProgress(body.progress, this.capabilities(nodeId)) };
  }

  private get(messageId: string): MessageRecord | null {
    const row = this.sql.exec(`SELECT ${COLUMNS} FROM messages WHERE id = ?`, messageId).toArray()[0];
    return row ? toRecord(row) : null;
  }

  private queuedCount(nodeId: string): number {
    return Number(this.sql.exec("SELECT COUNT(*) AS n FROM messages WHERE to_node = ? AND state = 'queued'", nodeId).one().n);
  }

  private setState(record: MessageRecord, state: MessageState, reason: string | null, actor: string, now: number,
    effects: MessageEffects, progress?: MessageProgress, diagnostic?: MessageDiagnostic): void {
    // Only a queued message keeps its text. Progress belongs only to accepted.
    const kept = state === "accepted" ? progress ?? null : null;
    const keptDiagnostic = state === "accepted" ? diagnostic : undefined;
    this.sql.exec(`UPDATE messages SET state = ?, reason = ?, text = NULL, progress_phase = ?, progress_code = ?,
      progress_observed_at = ?, progress_retry_at = ?, updated_at = ? WHERE id = ?`, state, reason, kept?.phase ?? null,
    kept?.code ?? null, kept?.observedAt ?? null, kept?.retryAt ?? null, now, record.messageId);
    this.audit(actor, "message.state", record.toNode, { messageId: record.messageId, state, reason, ...(kept ? { progress: kept } : {}) });
    storeDiagnostic(this.sql, record.messageId, keptDiagnostic);
    this.retention.finalized(record.messageId, record.fromNode, state, now);
    if (record.fromNode !== OPERATOR_NODE_ID) {
      const body = statusBody(record.messageId, state, reason, kept, keptDiagnostic);
      effects.statuses.push({ nodeId: record.fromNode, body: this.statusFor(record.fromNode, body) });
    }
  }

  private setProgress(record: MessageRecord, progress: MessageProgress, actor: string, now: number, effects: MessageEffects, diagnostic?: MessageDiagnostic): void {
    this.sql.exec(`UPDATE messages SET progress_phase = ?, progress_code = ?, progress_observed_at = ?, progress_retry_at = ?,
      updated_at = ? WHERE id = ? AND state = 'accepted'`, progress.phase, progress.code, progress.observedAt,
    progress.retryAt ?? null, now, record.messageId);
    storeDiagnostic(this.sql, record.messageId, diagnostic);
    this.audit(actor, "message.progress", record.toNode, { messageId: record.messageId, progress });
    if (record.fromNode !== OPERATOR_NODE_ID) {
      const body = statusBody(record.messageId, "accepted", null, progress, diagnostic);
      effects.statuses.push({ nodeId: record.fromNode, body: this.statusFor(record.fromNode, body) });
    }
  }
}
