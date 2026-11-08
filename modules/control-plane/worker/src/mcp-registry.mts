import {
  SLOT_MCP_CAPABILITY, CLAUDE_MCP_CAPABILITY, MCP_INTENT_TTL_DEFAULT_MS, REMOTE_MCP_CAPABILITY, isMcpIntentClaim, isMcpIntentRegistration,
  type McpIntentClaim, type McpIntentRegistration, type McpRuntime,
  type McpAssignmentResult, type SelfAssignmentSlot,
  type McpLeadConfirmRequest, MCP_LEAD_CONFIRM_MS,
} from "../../protocol-mcp.mts";
import { replaceIntercomSlot } from "./intercom-slots.mts";
import { isNodeId } from "../../protocol.mts";
import { isMessageId } from "../../protocol-messages.mts";
import { MAX_HOLD_REFUSAL_REFS, type HoldRefusalRef } from "./message-store.mts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_credentials (
  node_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_intents (
  request_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL,
  runtime TEXT NOT NULL,
  session_id TEXT NOT NULL,
  thread_id TEXT,
  call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS mcp_intents_expiry ON mcp_intents(expires_at);
`;
const MAX_UNEXPIRED_INTENTS_PER_NODE = 128;
const MAX_RETAINED_INTENTS_PER_NODE = 32_768;
const INTENT_REUSE_RETENTION_MS = 24 * 60 * 60_000;

type Failure = { ok: false; error: string };
type Credential = { ok: true; token: string; version: number } | Failure;
type Registration = { ok: true; requestId: string; expiresAt: number; version: number } | Failure;
type Claim = { ok: true; disposition: "new" | "recovery"; sessionId: string; effectId: string } | Failure;
type AssignmentInspection = { ok: true; row: Record<string, SqlStorageValue>; sessionId: string } | Failure;
type LeadPreparation = { ok: true; result: McpAssignmentResult } | { ok: true; found: Extract<AssignmentInspection, { ok: true }>; stamp: string } | Failure;
export type McpOutcome = "succeeded" | "uncertain" | "failed";

const HOLD_REFUSALS_JSON_LIMIT = MAX_HOLD_REFUSAL_REFS * 128;
const invalidHoldRefusals = () => new Error("invalid hold refusal recovery metadata");
function checkedHoldRefusals(value: unknown): HoldRefusalRef[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_HOLD_REFUSAL_REFS) throw invalidHoldRefusals();
  const ids = new Set<string>();
  for (const ref of value) {
    if (!ref || typeof ref !== "object" || Object.keys(ref).length !== 2 || !isMessageId(ref.messageId)
      || !isNodeId(ref.nodeId) || ids.has(ref.messageId)) throw invalidHoldRefusals();
    ids.add(ref.messageId);
  }
  return value;
}

export class McpRegistry {
  private readonly confirmLead: (request: McpLeadConfirmRequest) => Promise<boolean>;
  private readonly atomicAssignment: <T>(run: () => T) => T;
  private readonly pendingLead = new Map<string, Promise<McpAssignmentResult>>();
  private readonly sql: SqlStorage;
  private readonly capabilitiesOf: (nodeId: string) => string[] | null;
  private readonly sessionRuntime: (nodeId: string, sessionId: string) => string | null;

  constructor(
    sql: SqlStorage,
    capabilitiesOf: (nodeId: string) => string[] | null,
    sessionRuntime: (nodeId: string, sessionId: string) => string | null,
    confirmLead: (request: McpLeadConfirmRequest) => Promise<boolean>,
    atomicAssignment: <T>(run: () => T) => T,
  ) {
    this.sql = sql;
    this.capabilitiesOf = capabilitiesOf;
    this.sessionRuntime = sessionRuntime;
    this.confirmLead = confirmLead;this.atomicAssignment = atomicAssignment;
    this.sql.exec(SCHEMA);
    const columns = new Set(this.sql.exec<{ name: string }>("PRAGMA table_info(mcp_intents)").toArray().map(row => row.name));
    for (const [name, type] of [["assignment_slot", "TEXT"], ["assignment_title", "TEXT"], ["assignment_turn_id", "TEXT"],
      ["assignment_revision", "INTEGER"], ["assignment_result", "TEXT"], ["lead_guard_version", "INTEGER"], ["original_root", "TEXT"], ["original_epoch", "TEXT"], ["hold_refusals_json", "TEXT"]]) {
      if (!columns.has(name)) this.sql.exec(`ALTER TABLE mcp_intents ADD COLUMN ${name} ${type}`);
    }
    this.sql.exec("CREATE TABLE IF NOT EXISTS mcp_registration_epochs(node_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS intercom_assignment_proofs (
      slot TEXT NOT NULL, revision INTEGER NOT NULL, node_id TEXT NOT NULL, runtime TEXT NOT NULL,
      session_id TEXT NOT NULL, operation_id TEXT NOT NULL, PRIMARY KEY(slot, revision))`);
  }

  saveHoldRefusals(nodeId: string, requestId: string, refs: HoldRefusalRef[]): void {
    const checked = checkedHoldRefusals(refs);
    const saved = this.sql.exec(`UPDATE mcp_intents SET hold_refusals_json=? WHERE node_id=? AND request_id=?
      AND claimed_at IS NOT NULL AND tool_name IN ('send','reply') AND hold_refusals_json IS NULL`, JSON.stringify(checked), nodeId, requestId);
    if (saved.rowsWritten !== 1) throw invalidHoldRefusals();
  }

  holdRefusals(nodeId: string, requestId: string): HoldRefusalRef[] {
    const row = this.sql.exec("SELECT hold_refusals_json FROM mcp_intents WHERE node_id=? AND request_id=?", nodeId, requestId).toArray()[0];
    if (!row) throw invalidHoldRefusals();
    if (row.hold_refusals_json === null) return [];
    if (typeof row.hold_refusals_json !== "string" || row.hold_refusals_json.length > HOLD_REFUSALS_JSON_LIMIT) throw invalidHoldRefusals();
    let refs: unknown;
    try { refs = JSON.parse(row.hold_refusals_json); } catch { throw invalidHoldRefusals(); }
    return checkedHoldRefusals(refs);
  }

  rotateHashed(nodeId: string, token: string, tokenHash: string, now: number): Credential {
    if (!this.enabled(nodeId)) return { ok: false, error: "remote MCP is not enabled for this node" };
    const prior = this.sql.exec("SELECT version FROM mcp_credentials WHERE node_id = ?", nodeId).toArray()[0];
    const version = prior ? Number(prior.version) + 1 : 1;
    this.sql.exec(`INSERT INTO mcp_credentials (node_id, token_hash, version, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET token_hash = excluded.token_hash, version = excluded.version,
      created_at = excluded.created_at`, nodeId, tokenHash, version, now);
    this.sql.exec("DELETE FROM mcp_intents WHERE node_id = ?", nodeId);
    return { ok: true, token, version };
  }

  authenticateHashed(tokenHash: string): { nodeId: string; version: number } | null {
    const row = this.sql.exec("SELECT node_id, version FROM mcp_credentials WHERE token_hash = ?", tokenHash).toArray()[0];
    if (!row) return null;
    const nodeId = String(row.node_id);
    return this.enabled(nodeId) ? { nodeId, version: Number(row.version) } : null;
  }

  register(nodeId: string, intent: McpIntentRegistration, now: number, assignmentDigest?: string): Registration {
    if (!isMcpIntentRegistration(intent)) return { ok: false, error: "invalid intent metadata" };
    if (intent.tool === "assign_self" && (!intent.assignment?.native || assignmentDigest !== intent.argumentsDigest)) {
      return { ok: false, error: "native original assignment evidence is required" };
    }
    if (!this.enabled(nodeId, intent.runtime)) return { ok: false, error: this.disabledError(nodeId, intent.runtime) };
    if (intent.tool === "assign_self" && !this.assignmentNode(nodeId)) return { ok: false, error: "Codex Mac assignment requires an eligible enrolled Mac node" };
    if (this.sessionRuntime(nodeId, intent.sessionId) !== intent.runtime && !this.pendingOriginal(nodeId, intent)) {
      return { ok: false, error: "native session is not registered on this node" };
    }
    const credential = this.sql.exec("SELECT version FROM mcp_credentials WHERE node_id = ?", nodeId).toArray()[0];
    if (!credential) return { ok: false, error: "remote MCP credential is not provisioned" };
    const existing = this.sql.exec("SELECT * FROM mcp_intents WHERE request_id = ?", intent.requestId).toArray()[0];
    if (existing) {
      if (this.matches(existing, nodeId, Number(credential.version), intent)) {
        return { ok: true, requestId: intent.requestId, expiresAt: Number(existing.expires_at), version: Number(existing.credential_version) };
      }
      return { ok: false, error: "requestId already has different intent metadata" };
    }
    this.sql.exec("DELETE FROM mcp_intents WHERE node_id = ? AND expires_at <= ?", nodeId, now - INTENT_REUSE_RETENTION_MS);
    const unexpired = Number(this.sql.exec(
      "SELECT COUNT(*) AS n FROM mcp_intents WHERE node_id = ? AND expires_at > ?", nodeId, now,
    ).one().n);
    if (unexpired >= MAX_UNEXPIRED_INTENTS_PER_NODE) {
      return { ok: false, error: "too many unexpired MCP intents" };
    }
    const retained = Number(this.sql.exec("SELECT COUNT(*) AS n FROM mcp_intents WHERE node_id = ?", nodeId).one().n);
    if (retained >= MAX_RETAINED_INTENTS_PER_NODE) return { ok: false, error: "too many retained MCP intents" };
    const expiresAt = now + (intent.ttlMs ?? MCP_INTENT_TTL_DEFAULT_MS);
    const assignmentRevision = intent.assignment ? this.sql.exec<{ revision: number }>(
      "SELECT revision FROM intercom_slots WHERE slot=?", intent.assignment.slot).toArray()[0]?.revision : null;
    if (intent.assignment && assignmentRevision === undefined) return { ok: false, error: "Intercom roster unavailable" };
    this.sql.exec(`INSERT INTO mcp_intents (request_id, node_id, credential_version, runtime, session_id, thread_id, call_id,
      tool_name, arguments_digest, created_at, expires_at, assignment_slot, assignment_title, assignment_turn_id, assignment_revision, lead_guard_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    intent.requestId, nodeId, Number(credential.version), intent.runtime, intent.sessionId, intent.threadId, intent.callId,
    intent.tool, intent.argumentsDigest, now, expiresAt, intent.assignment?.slot ?? null, intent.assignment?.native?.chatName ?? null,
    intent.assignment?.turnId ?? null, assignmentRevision, intent.assignment?.native?.leadGuardVersion ?? null);
    if (intent.originalRoot) this.sql.exec("UPDATE mcp_intents SET original_root=?, original_epoch=? WHERE request_id=?",
      JSON.stringify(intent.originalRoot), this.originalEpoch(nodeId), intent.requestId);
    return { ok: true, requestId: intent.requestId, expiresAt, version: Number(credential.version) };
  }

  private inspect(input: McpIntentClaim, now: number): { ok: true; row: Record<string, SqlStorageValue>; sessionId: string } | Failure {
    if (!isMcpIntentClaim(input)) return { ok: false, error: "invalid intent claim metadata" };
    if (!this.enabled(input.nodeId, input.runtime)) return { ok: false, error: this.disabledError(input.nodeId, input.runtime) };
    const credential = this.sql.exec("SELECT version FROM mcp_credentials WHERE node_id = ?", input.nodeId).toArray()[0];
    if (!credential || Number(credential.version) !== input.credentialVersion) {
      return { ok: false, error: "MCP credential is stale" };
    }
    const row = this.sql.exec("SELECT * FROM mcp_intents WHERE request_id = ?", input.requestId).toArray()[0];
    if (!row || String(row.node_id) !== input.nodeId || Number(row.credential_version) !== input.credentialVersion) {
      return { ok: false, error: "intent not found" };
    }
    if (Number(row.expires_at) <= now) return { ok: false, error: "intent expired; register a fresh native intent" };
    if (String(row.arguments_digest) !== input.argumentsDigest) return { ok: false, error: "tool arguments do not match intent" };
    if (!this.matchesClaim(row, input)) {
      return { ok: false, error: "native call identity does not match intent" };
    }
    const sessionId = String(row.session_id);
    if (this.sessionRuntime(input.nodeId, sessionId) !== input.runtime && !this.currentOriginal(row, input.nodeId)) {
      return { ok: false, error: "native session is no longer registered" };
    }
    if (input.runtime === "codex" && row.thread_id !== null && String(row.thread_id) !== input.threadId) return { ok: false, error: "native call identity does not match intent" };
    return { ok: true, row, sessionId };
  }
  registrationChanged(nodeId: string): void {
    this.sql.exec("INSERT INTO mcp_registration_epochs(node_id,epoch) VALUES (?,1) ON CONFLICT(node_id) DO UPDATE SET epoch=epoch+1",nodeId);
  }
  private originalEpoch(nodeId: string): string | null {
    const n = this.sql.exec("SELECT message_connection_token,registration_token,identity_generation,capabilities FROM nodes WHERE id=? AND revoked_at IS NULL AND public_key IS NOT NULL AND os='darwin'", nodeId).toArray()[0];
    if (!n || typeof n.message_connection_token !== "string" || n.registration_token !== n.message_connection_token
      || !JSON.parse(String(n.capabilities)).includes(SLOT_MCP_CAPABILITY)) return null;
    return JSON.stringify([n,this.sql.exec("SELECT epoch FROM mcp_registration_epochs WHERE node_id=?",nodeId).toArray()[0] ?? null]);
  }
  private pendingOriginal(nodeId: string, intent: McpIntentRegistration): boolean {
    return intent.runtime === "codex" && intent.originalRoot?.verified === true && intent.threadId === intent.sessionId
      && this.originalEpoch(nodeId) !== null && this.sql.exec("SELECT 1 FROM sessions WHERE node_id=? AND session_id=? AND runtime='codex' AND state='unknown'", nodeId, intent.sessionId).toArray().length === 1;
  }
  private currentOriginal(row: Record<string, SqlStorageValue>, nodeId: string): boolean {
    if (typeof row.original_root !== "string" || row.runtime !== "codex" || row.thread_id !== row.session_id
      || row.original_epoch === null || row.original_epoch !== this.originalEpoch(nodeId)) return false;
    const root = JSON.parse(row.original_root);
    return root.verified === true && root.threadId === row.session_id
      && this.sql.exec("SELECT 1 FROM sessions WHERE node_id=? AND session_id=? AND runtime='codex' AND state NOT IN ('closed','archived','deleted')", nodeId, row.session_id).toArray().length === 1;
  }
  originalClaim(input: McpIntentClaim, now = Date.now()) {
    const found = this.inspect(input, now);
    if (!found.ok) return found;
    return this.currentOriginal(found.row, input.nodeId) && input.runtime === "codex" && input.threadId === found.sessionId
      ? { ok: true as const, sessionId: found.sessionId, stamp: JSON.stringify(found.row) }
      : { ok: false as const, error: "current original native invocation is required" };
  }
  // Read-only: no claim, thread binding, or outcome mutation.
  peekClaimSession(input: McpIntentClaim, now: number): { ok: true; sessionId: string } | Failure {
    const found = this.inspect(input, now);
    return found.ok ? { ok: true, sessionId: found.sessionId } : found;
  }
  claim(input: McpIntentClaim, now: number): Claim {
    const found = this.inspect(input, now);
    if (!found.ok) return found;
    const { row, sessionId } = found;
    if (input.runtime === "codex" && row.thread_id === null) {
      this.sql.exec("UPDATE mcp_intents SET thread_id = ? WHERE request_id = ? AND thread_id IS NULL", input.threadId, input.requestId);
    } else if (input.runtime === "codex" && String(row.thread_id) !== input.threadId) {
      return { ok: false, error: "native call identity does not match intent" };
    }
    if (row.claimed_at !== null) {
      return { ok: true, disposition: "recovery", sessionId, effectId: input.requestId };
    }
    this.sql.exec("UPDATE mcp_intents SET claimed_at = ?, outcome = 'claimed' WHERE request_id = ?", now, input.requestId);
    return { ok: true, disposition: "new", sessionId, effectId: input.requestId };
  }

  private inspectAssignment(input: McpIntentClaim, slot: SelfAssignmentSlot, now: number): AssignmentInspection {
    const found = this.inspect(input, now);
    if (!found.ok) return found;
    const { row, sessionId } = found;
    if (!this.assignmentNode(input.nodeId)) return { ok: false, error: "Codex Mac assignment requires an eligible enrolled Mac node" };
    if (input.tool !== "assign_self" || input.runtime !== "codex" || input.threadId !== sessionId
      || row.thread_id !== sessionId || row.assignment_slot !== slot || typeof row.assignment_title !== "string"
      || !row.assignment_title || typeof row.assignment_turn_id !== "string" || !Number.isSafeInteger(row.assignment_revision)) {
      return { ok: false, error: "native assignment identity does not match intent" };
    }
    return { ok: true as const, row, sessionId };
  }

  assign(input: McpIntentClaim, slot: SelfAssignmentSlot, now: number): McpAssignmentResult {
    const found = this.inspectAssignment(input, slot, now);
    if (!found.ok) return found;
    if (found.row.assignment_result !== null) return JSON.parse(String(found.row.assignment_result)) as McpAssignmentResult;
    // No synchronous/internal caller can move an unconsumed Lead intent.
    if (slot === "kherep-lead") return { ok: false, error: "fresh native Lead confirmation is required" };
    return this.finishAssignment(input, slot, now, found.row, found.sessionId);
  }

  private finishAssignment(input: McpIntentClaim, slot: SelfAssignmentSlot, now: number,
    row: Record<string, SqlStorageValue>, sessionId: string): McpAssignmentResult {
    const revision = replaceIntercomSlot(this.sql, slot, Number(row.assignment_revision), {
      nodeId: input.nodeId, runtime: "codex", sessionId, chatName: String(row.assignment_title),
    });
    const result: McpAssignmentResult = revision === null
      ? { ok: false, error: "Intercom slot revision conflict", conflict: true } : { ok: true, slot, revision };
    if (revision !== null) this.sql.exec(`INSERT INTO intercom_assignment_proofs
      (slot,revision,node_id,runtime,session_id,operation_id) VALUES (?,?,?,?,?,?)`,
      slot, revision, input.nodeId, "codex", sessionId, input.requestId);
    this.sql.exec("UPDATE mcp_intents SET claimed_at=?, outcome=?, assignment_result=? WHERE request_id=?",
      now, revision === null ? "failed" : "succeeded", JSON.stringify(result), input.requestId);
    return result;
  }

  async assignLead(input: McpIntentClaim): Promise<McpAssignmentResult> {
    const prepare = (): LeadPreparation => {
      const found = this.inspectAssignment(input, "kherep-lead", Date.now());
      if (!found.ok) return found;
      if (found.row.assignment_result !== null) return { ok: true as const, result: JSON.parse(String(found.row.assignment_result)) as McpAssignmentResult };
      if (found.row.lead_guard_version !== 1) return { ok: false as const, error: "guarded native Lead evidence is required" };
      const connection = this.sql.exec("SELECT message_connection_token,registration_token,identity_generation FROM nodes WHERE id=? AND revoked_at IS NULL", input.nodeId).toArray()[0];
      if (!connection || typeof connection.message_connection_token !== "string" || !connection.message_connection_token
        || connection.registration_token !== connection.message_connection_token) return { ok: false as const, error: "current enrolled-node registration is required for Lead confirmation" };
      return { ok: true as const, found, stamp: JSON.stringify([found.row, connection]) };
    };
    const initial = prepare();
    if (!initial.ok) return initial;
    if ("result" in initial) return initial.result;
    const { row, sessionId } = initial.found;
    const existing = this.pendingLead.get(initial.stamp);
    if (existing) return existing;
    if (this.pendingLead.size >= 32) return { ok: false, error: "native Lead confirmation is busy" };
    const request: McpLeadConfirmRequest = { nonce: crypto.randomUUID(), nodeId: input.nodeId, requestId: input.requestId,
      sessionId, threadId: String(row.thread_id), turnId: String(row.assignment_turn_id), callId: String(row.call_id),
      slot: "kherep-lead", argumentsDigest: String(row.arguments_digest), credentialVersion: Number(row.credential_version),
      leadGuardVersion: 1, expiresAt: Math.min(Number(row.expires_at), Date.now() + MCP_LEAD_CONFIRM_MS) };
    const operation = (async (): Promise<McpAssignmentResult> => {
      let allowed = false;
      try { allowed = await this.confirmLead(request); } catch { /* Fail closed without remote error details. */ }
      return this.atomicAssignment(() => {
        const current = prepare();
        if (!current.ok) return current;
        if ("result" in current) return current.result;
        if (!allowed || Date.now() >= request.expiresAt || current.stamp !== initial.stamp) return { ok: false, error: "fresh native Lead confirmation failed" };
        return this.finishAssignment(input, "kherep-lead", Date.now(), current.found.row, current.found.sessionId);
      });
    })();
    this.pendingLead.set(initial.stamp, operation);
    try { return await operation; } finally { this.pendingLead.delete(initial.stamp); }
  }

  removeNode(nodeId: string): void {
    this.sql.exec("DELETE FROM mcp_intents WHERE node_id = ?", nodeId);
    this.sql.exec("DELETE FROM mcp_credentials WHERE node_id = ?", nodeId);
  }

  private assignmentNode(nodeId: string): boolean {
    return this.sql.exec("SELECT 1 FROM nodes WHERE id=? AND os='darwin' AND revoked_at IS NULL AND public_key IS NOT NULL", nodeId)
      .toArray().length === 1;
  }

  removeRuntime(nodeId: string, runtime: McpRuntime): void {
    this.sql.exec("DELETE FROM mcp_intents WHERE node_id = ? AND runtime = ?", nodeId, runtime);
  }

  recordOutcome(nodeId: string, requestId: string, outcome: McpOutcome): void {
    this.sql.exec("UPDATE mcp_intents SET outcome = ? WHERE request_id = ? AND node_id = ?", outcome, requestId, nodeId);
  }

  private enabled(nodeId: string, runtime: McpRuntime = "codex"): boolean {
    const capabilities = this.capabilitiesOf(nodeId);
    return capabilities?.includes(REMOTE_MCP_CAPABILITY) === true
      && (runtime !== "claude-code" || capabilities.includes(CLAUDE_MCP_CAPABILITY));
  }

  private disabledError(nodeId: string, runtime: McpRuntime): string {
    const capabilities = this.capabilitiesOf(nodeId);
    return capabilities?.includes(REMOTE_MCP_CAPABILITY) === true && runtime === "claude-code"
      ? "remote MCP runtime is not enabled for this node" : "remote MCP is not enabled for this node";
  }

  private matches(row: Record<string, SqlStorageValue>, nodeId: string, version: number,
    intent: McpIntentRegistration): boolean {
    return String(row.node_id) === nodeId && Number(row.credential_version) === version
      && String(row.runtime) === intent.runtime && String(row.session_id) === intent.sessionId
      && (row.thread_id === null ? intent.threadId === undefined : String(row.thread_id) === intent.threadId)
      && String(row.call_id) === intent.callId && String(row.tool_name) === intent.tool
      && String(row.arguments_digest) === intent.argumentsDigest
      && (intent.originalRoot ? row.original_root === JSON.stringify(intent.originalRoot) : row.original_root === null)
      && (intent.assignment ? row.assignment_slot === intent.assignment.slot
        && row.assignment_title === intent.assignment.native?.chatName && row.assignment_turn_id === intent.assignment.turnId
        && (row.lead_guard_version ?? null) === (intent.assignment.native?.leadGuardVersion ?? null)
        : row.assignment_slot === null);
  }

  private matchesClaim(row: Record<string, SqlStorageValue>, intent: McpIntentClaim): boolean {
    return String(row.node_id) === intent.nodeId && Number(row.credential_version) === intent.credentialVersion
      && String(row.runtime) === intent.runtime && String(row.call_id) === intent.callId
      && String(row.tool_name) === intent.tool && String(row.arguments_digest) === intent.argumentsDigest
      && (intent.runtime === "claude-code"
        ? row.thread_id === null
        : String(row.session_id) === intent.sessionId && (row.thread_id === null || String(row.thread_id) === intent.threadId));
  }
}
