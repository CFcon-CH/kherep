import { identityDiagnostic } from "./message-identity-diagnostics.mts";
import { type MessageDiagnostic } from "../../protocol-diagnostics.mts";
import { bindingContext, prepareMessageBinding } from "./message-binding.mts";
import { isSelectedPair, loopCapability, type SelectedPair, type SelectedIdentityEvidence } from "./message-loop-identity-api.mts";
import { RegistrySessionIdentity } from "./registry-session-identity.mts";
import type { IdentitySnapshotV1 } from "../../protocol-session-identity.mts";
import type { LoopSigner } from "./message-loop-signals.mts";
import { LOOP_STALE } from "../../protocol-loop-brake.mts";
import { DurableObject } from "cloudflare:workers";

import type { NodeFacts, RuntimeInfo, SessionInfo } from "../../protocol.mts";
import type { DirectoryNodeIntake } from "../../protocol-intake.mts";
import { MAX_DIRECTORY_NODES, type DirectoryBody, type MessageStatusAckBody, type MessageStatusBody, type NodeReportedState } from "../../protocol-messages.mts";
import type {
  TaskControlRegisterBody, TaskControlResultBody, TaskControlSubmitBody,
} from "../../protocol-task-control.mts";
import { randomToken, sha256 } from "./crypto.mts";
import { sessionStub, type Env } from "./env.mts";
import { directoryBody } from "./directory.mts";
import { routeEffects } from "./message-routing.mts";
import { MessageStore, type MessageEffects, type MessageRecord, type NewMessage, type SendResult } from "./message-store.mts";
import { earliest, type MessageStatusView } from "./message-retention.mts";
import { messageSummary, type MessageSummary } from "./message-summary.mts";
import { TaskStore, type CreateResult, type NewTask, type TaskRow } from "./task-store.mts";
import { TaskControlRegistry } from "./task-control-registry.mts";
import { McpRegistry, type McpOutcome } from "./mcp-registry.mts";
import { intakeRows, recordTaken } from "./node-intake.mts";
import { SqlMeter, type SqlRows } from "./sql-meter.mts";
import {
  CLAUDE_MCP_CAPABILITY, REMOTE_MCP_CAPABILITY, type McpInboxItem, type McpIntentClaim, type McpIntentRegistration,
} from "../../protocol-mcp.mts";
import type { TaskReportBody } from "../../protocol-tasks.mts";
import {
  ENROLLMENT_TTL_DEFAULT_S, ENROLLMENT_TTL_MAX_S, ENROLLMENT_TTL_MIN_S, migrateRegistry, NODE_COLUMNS, REGISTRY_SCHEMA, toNodeRow,
  type NodeRow, type NodeStatus,
} from "./registry-schema.mts";

export interface EnrollRequest { code: string; publicKey: string; name: string; facts: NodeFacts; runtimes: RuntimeInfo[] }
export type EnrollResult = { ok: true; nodeId: string } | { ok: false; reason: "invalid-code" | "expired-code" | "used-code" };

// Single-instance registry of nodes, runtimes, sessions, enrollments and the
// audit trail. SQLite-backed (exports storage "sqlite"); every mutation below is
// synchronous SQL, so no request can interleave with it. Every request path
// runs its SQL inside one measured synchronous region, which logs the rows it
// read and wrote (issue #308).
export class Registry extends DurableObject<Env> {
  private readonly meter: SqlMeter;
  private readonly sql: SqlStorage;
  private readonly messages: MessageStore;
  private readonly sessionIdentity: RegistrySessionIdentity;
  private readonly tasks: TaskStore;
  private readonly taskControl: TaskControlRegistry;
  private readonly mcp: McpRegistry;
  private readonly loopSigner: Promise<LoopSigner>;
  // Directory rows, read again after any write to nodes, runtimes or sessions
  // (issue #308) and, for the queue heads, after any message transaction
  // (issue #441): every node asks every minute and on each `msg` call.
  private directoryRows: { nodes: Record<string, SqlStorageValue>[]; sessions: ReturnType<Registry["listSessions"]>;
    intake: Map<string, DirectoryNodeIntake> } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.meter = new SqlMeter(ctx.storage.sql);
    this.sql = this.meter.sql;
    this.loopSigner = ctx.blockConcurrencyWhile(async () => {
      let secret = await ctx.storage.get<Uint8Array>("loop-hmac-v1");
      if (secret === undefined) {
        const retained = this.sql.exec(`SELECT 1 FROM message_loop_pairs LIMIT 1`).toArray().length
          || this.sql.exec("SELECT 1 FROM messages WHERE loop_pair IS NOT NULL OR delivery_pair IS NOT NULL LIMIT 1").toArray().length
          || this.sql.exec("SELECT 1 FROM message_tombstones WHERE loop_pair IS NOT NULL LIMIT 1").toArray().length;
        if (retained) throw new Error("loop-crypto-unavailable");
        secret = crypto.getRandomValues(new Uint8Array(32));
        await ctx.storage.put("loop-hmac-v1", secret);
      }
      if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new Error("loop-crypto-unavailable");
      const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return async (domain: string, value: string) => {
        const input = domain === "kherep-loop-pair-v1" ? value : JSON.stringify([domain, value]);
        const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
        return [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
      };
    });
    this.sql.exec(REGISTRY_SCHEMA);
    migrateRegistry(this.sql);
    this.sessionIdentity = new RegistrySessionIdentity(this.sql);
    this.messages = new MessageStore(this.sql, (...args) => this.audit(...args), (nodeId) => this.capabilitiesOf(nodeId));
    this.tasks = new TaskStore(this.sql, (...args) => this.audit(...args));
    this.taskControl = new TaskControlRegistry(this.sql, this.messages, this.tasks, (...args) => this.audit(...args));
    this.mcp = new McpRegistry(this.sql, (nodeId) => this.capabilitiesOf(nodeId), (nodeId, sessionId) => {
      // Retained UNKNOWN identities remain addressable, but do not establish
      // the native-session permission required for MCP registration or claim.
      const row = this.sql.exec("SELECT runtime FROM sessions WHERE node_id = ? AND session_id = ? AND state NOT IN ('unknown', 'closed', 'archived', 'deleted')", nodeId, sessionId).toArray()[0];
      return row ? String(row.runtime) : null;
    });
  }

  audit(actor: string, action: string, target: string | null, detail: unknown = null): void {
    this.metered("audit", () => this.sql.exec("INSERT INTO audit (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)",
      Date.now(), actor, action, target, detail === null ? null : JSON.stringify(detail)));
  }

  // Rows read and written by this Registry instance since it started.
  sqlStats(): SqlRows {
    return this.meter.stats();
  }

  async createEnrollment(actor: string, ttlSeconds?: number): Promise<{ code: string; expiresAt: number }> {
    const ttl = Math.min(ENROLLMENT_TTL_MAX_S, Math.max(ENROLLMENT_TTL_MIN_S, Math.floor(ttlSeconds ?? ENROLLMENT_TTL_DEFAULT_S)));
    const code = randomToken(16);
    const now = Date.now();
    const expiresAt = now + ttl * 1000;
    // Only the hash is stored; the plain code is shown once to the operator.
    const hash = await sha256(code);
    this.metered("createEnrollment", () => {
      this.sql.exec("INSERT INTO enrollments (code_hash, created_at, expires_at, created_by) VALUES (?, ?, ?, ?)", hash, now, expiresAt, actor);
      this.audit(actor, "enrollment.create", null, { expiresAt });
    });
    return { code, expiresAt };
  }

  async redeemEnrollment(request: EnrollRequest): Promise<EnrollResult> {
    const hash = await sha256(request.code);
    const now = Date.now();
    // Synchronous from here on: the check and the consumption cannot interleave
    // with a second redemption of the same code.
    return this.metered("redeemEnrollment", (): EnrollResult => {
      const row = this.sql.exec("SELECT expires_at, used_at FROM enrollments WHERE code_hash = ?", hash).toArray()[0];
      if (!row) return { ok: false, reason: "invalid-code" };
      if (row.used_at !== null) return { ok: false, reason: "used-code" };
      if (Number(row.expires_at) <= now) return { ok: false, reason: "expired-code" };
      const nodeId = crypto.randomUUID();
      const { facts } = request;
      this.ctx.storage.transactionSync(() => {
        this.directoryRows = null;
        this.sql.exec("UPDATE enrollments SET used_at = ?, used_by_node = ? WHERE code_hash = ?", now, nodeId, hash);
        this.sql.exec(`INSERT INTO nodes (id, name, public_key, status, hostname, os, arch, cpus, memory_bytes, enrolled_at)
          VALUES (?, ?, ?, 'offline', ?, ?, ?, ?, ?, ?)`,
          nodeId, request.name, request.publicKey, facts.hostname, facts.os, facts.arch, facts.cpus, facts.memoryBytes, now);
        this.writeRuntimes(nodeId, request.runtimes);
        this.audit(`node:${nodeId}`, "node.enroll", nodeId, { name: request.name });
      });
      return { ok: true, nodeId };
    });
  }

  // The bound public key, or null when the node is unknown or revoked.
  getNodeKey(nodeId: string): string | null {
    const row = this.metered("getNodeKey", () =>
      this.sql.exec("SELECT public_key FROM nodes WHERE id = ? AND revoked_at IS NULL", nodeId).toArray()[0]);
    return row && typeof row.public_key === "string" ? row.public_key : null;
  }

  listNodes(): NodeRow[] {
    return this.metered("listNodes", () => this.sql.exec(`SELECT ${NODE_COLUMNS} FROM nodes ORDER BY name`).toArray().map(toNodeRow));
  }

  getNode(nodeId: string): (NodeRow & { runtimes: RuntimeInfo[] }) | null {
    return this.metered("getNode", () => {
      const row = this.sql.exec(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ?`, nodeId).toArray()[0];
      if (!row) return null;
      const runtimes = this.sql.exec("SELECT name, kind, version, endpoint FROM runtimes WHERE node_id = ? ORDER BY name", nodeId)
        .toArray().map((r) => ({
          name: String(r.name), kind: r.kind as RuntimeInfo["kind"],
          ...(r.version === null ? {} : { version: String(r.version) }),
          ...(r.endpoint === null ? {} : { endpoint: String(r.endpoint) }),
        }));
      return { ...toNodeRow(row), runtimes };
    });
  }

  listSessions(): (SessionInfo & { nodeId: string; updatedAt: number })[] {
    return this.metered("listSessions", () => this.sql.exec(`SELECT node_id, session_id, runtime, state, started_at, name, cwd, kind, label,
      title, updated_at FROM sessions ORDER BY node_id, session_id`).toArray().map((r) => ({
        nodeId: String(r.node_id), sessionId: String(r.session_id), runtime: String(r.runtime), state: String(r.state),
        ...(r.started_at === null ? {} : { startedAt: String(r.started_at) }),
        ...(r.name === null ? {} : { name: String(r.name) }),
        ...(r.cwd === null ? {} : { cwd: String(r.cwd) }),
        ...(r.kind === null ? {} : { kind: String(r.kind) }),
        ...(r.label === null ? {} : { label: String(r.label) }),
        ...(r.title === null ? {} : { title: String(r.title) }),
        updatedAt: Number(r.updated_at),
      })));
  }

  // The directory frame (issue #31, step 3a): non-revoked nodes and their
  // sessions. Not audited: nodes ask for it every minute, and it carries no
  // message content.
  // One row past MAX_DIRECTORY_NODES only marks the directory truncated; the
  // queue heads are read for the listed nodes alone (issue #441). The id
  // breaks ties between equal names, so the listed prefix is deterministic.
  directory(): DirectoryBody {
    return this.metered("directory", () => {
      if (!this.directoryRows) {
        const nodes = this.sql.exec(`SELECT id, name, status, last_accepted_at FROM nodes WHERE revoked_at IS NULL
          ORDER BY name, id LIMIT ?`, MAX_DIRECTORY_NODES + 1).toArray();
        this.directoryRows = { nodes, sessions: this.listSessions(), intake: intakeRows(this.sql, nodes.slice(0, MAX_DIRECTORY_NODES)) };
      }
      return directoryBody(this.directoryRows.nodes, this.directoryRows.sessions, Date.now(), this.directoryRows.intake);
    });
  }

  setStatus(nodeId: string, status: Exclude<NodeStatus, "revoked">, lastSeen: number, connectionToken?: string): void {
    this.tx("setStatus", () => {
      const row = this.sql.exec("SELECT status_connection_token,message_connection_token FROM nodes WHERE id=? AND revoked_at IS NULL", nodeId).toArray()[0];
      if (!row || connectionToken !== undefined && (typeof connectionToken !== "string" || !connectionToken || row.status_connection_token !== connectionToken
        || status === "online" && row.message_connection_token !== connectionToken)) return;
      this.directoryRows = null;
      if (status === "offline") this.sql.exec("UPDATE nodes SET status_connection_token=NULL,message_connection_token=NULL,registration_token=NULL WHERE id=? AND revoked_at IS NULL", nodeId);
      this.sql.exec("UPDATE nodes SET status = ?, last_seen = ? WHERE id = ? AND revoked_at IS NULL", status, lastSeen, nodeId);
      this.audit(`node:${nodeId}`, `node.${status}`, nodeId);
    });
  }

  beginMessageConnection(nodeId: string, token: string): boolean {
    return this.tx("beginMessageConnection", () => {
      if (typeof token !== "string" || !token) return false;
      this.sql.exec("UPDATE nodes SET status_connection_token=?,message_connection_token=?,registration_token=NULL WHERE id=? AND revoked_at IS NULL", token, token, nodeId);
      return this.sql.exec("SELECT message_connection_token FROM nodes WHERE id=? AND revoked_at IS NULL", nodeId).toArray()[0]?.message_connection_token === token;
    });
  }
  invalidateMessageConnection(nodeId: string, token: string): void {
    this.tx("invalidateMessageConnection", () => this.sql.exec("UPDATE nodes SET message_connection_token=NULL,registration_token=NULL WHERE id=? AND message_connection_token=?", nodeId, token));
  }
  updateRegistration(nodeId: string, facts: NodeFacts, runtimes: RuntimeInfo[], capabilities: string[], connectionToken?: string): boolean {
    return this.tx("updateRegistration", () => {
      if (connectionToken !== undefined && this.sql.exec("SELECT message_connection_token FROM nodes WHERE id=? AND revoked_at IS NULL", nodeId).toArray()[0]?.message_connection_token !== connectionToken) return false;
      this.directoryRows = null;
      this.sql.exec(`UPDATE nodes SET hostname = ?, os = ?, arch = ?, cpus = ?, memory_bytes = ?, capabilities = ?, registration_token = ?
        WHERE id = ? AND revoked_at IS NULL`,
        facts.hostname, facts.os, facts.arch, facts.cpus, facts.memoryBytes, JSON.stringify(capabilities), connectionToken ?? null, nodeId);
      this.writeRuntimes(nodeId, runtimes);
      if (!capabilities.includes(REMOTE_MCP_CAPABILITY)) this.mcp.removeNode(nodeId);
      else if (!capabilities.includes(CLAUDE_MCP_CAPABILITY)) this.mcp.removeRuntime(nodeId, "claude-code");
      return true;
    });
  }

  replaceRuntimes(nodeId: string, runtimes: RuntimeInfo[]): void {
    this.tx("replaceRuntimes", () => {
      this.directoryRows = null;
      this.writeRuntimes(nodeId, runtimes);
    });
  }

  replaceSessions(nodeId: string, sessions: SessionInfo[], identitySnapshot?: IdentitySnapshotV1): { ok: true } | { ok: false; code: "IDENTITY_SNAPSHOT_REJECTED" | "IDENTITY_SNAPSHOT_UNAVAILABLE" } {
    const now = Date.now();
    try { this.tx("replaceSessions", () => {
      if (!this.sessionIdentity.accept(nodeId, sessions, identitySnapshot)) return;
      const pending = new Map(sessions.map(session => [session.sessionId, session]));
      const existing = this.sql.exec(`SELECT session_id, runtime, state, started_at, name, cwd, kind, label, title, canonical_identity
        FROM sessions WHERE node_id = ?`, nodeId).toArray();
      for (const row of existing) {
        const sessionId = String(row.session_id);
        const session = pending.get(sessionId);
        if (!session) {
          this.directoryRows = null;
          this.sql.exec("DELETE FROM sessions WHERE node_id = ? AND session_id = ?", nodeId, sessionId);
          continue;
        }
        pending.delete(sessionId);
        const unchanged = row.runtime === session.runtime && row.state === session.state
          && row.started_at === (session.startedAt ?? null) && row.name === (session.name ?? null)
          && row.cwd === (session.cwd ?? null) && row.kind === (session.kind ?? null)
          && row.label === (session.label ?? null) && row.title === (session.title ?? null)
          && row.canonical_identity === (session.canonicalIdentity ? JSON.stringify(session.canonicalIdentity) : null);
        if (unchanged) continue;
        this.directoryRows = null;
        this.sql.exec(`UPDATE sessions SET runtime = ?, state = ?, started_at = ?, name = ?, cwd = ?, kind = ?, label = ?, title = ?, canonical_identity = ?,
          updated_at = ? WHERE node_id = ? AND session_id = ?`, session.runtime, session.state, session.startedAt ?? null,
          session.name ?? null, session.cwd ?? null, session.kind ?? null, session.label ?? null, session.title ?? null, session.canonicalIdentity ? JSON.stringify(session.canonicalIdentity) : null, now, nodeId, sessionId);
      }
      if (pending.size > 0) this.directoryRows = null;
      for (const session of pending.values()) {
        this.sql.exec(`INSERT INTO sessions (node_id, session_id, runtime, state, started_at, name, cwd, kind, label, title,
          canonical_identity, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, nodeId, session.sessionId, session.runtime, session.state,
          session.startedAt ?? null, session.name ?? null, session.cwd ?? null, session.kind ?? null, session.label ?? null,
          session.title ?? null, session.canonicalIdentity ? JSON.stringify(session.canonicalIdentity) : null, now);
      }
    });
      return { ok: true };
    } catch (error) {
      const rejected = error instanceof Error && ["identity-population-invalid", "identity-duplicate", "identity-snapshot-invalid", "identity-proof-invalid", "identity-node-invalid", "identity-generation-rollback", "identity-generation-conflict"].includes(error.message);
      return { ok: false, code: rejected ? "IDENTITY_SNAPSHOT_REJECTED" : "IDENTITY_SNAPSHOT_UNAVAILABLE" };
    }
  }

  // Narrow two-selector read; never uses a directory or command-history accessor.
  selectedLoopIdentityCheck(body: SelectedPair): SelectedIdentityEvidence {
    if (!isSelectedPair(body)) throw new Error("identity-selection-invalid");
    return this.metered("selectedLoopIdentityCheck", () => {
      const n = this.sql.exec("SELECT capabilities, registration_token, identity_generation FROM nodes WHERE id = ? AND revoked_at IS NULL", body.nodeId).toArray()[0];
      const refs = body.selectors.map(s => this.sessionIdentity.resolveCanonicalReference({ nodeId: body.nodeId, session: s.ref }, Date.now()));
      const endpoints = refs.map((r, i) => ({ canonicalMatch: !!r.address && r.address.session === body.selectors[i].expectedSessionId
        && r.runtime === body.selectors[i].expectedRuntime, attested: r.code === "ATTESTED",
        availabilityUnknown: !!r.address && r.unknown, code: r.code }));
      const registryCapability = !!n && loopCapability(JSON.parse(String(n.capabilities)) as string[]);
      return { stamp: JSON.stringify([n ?? null, refs]), registrationToken: typeof n?.registration_token === "string" ? n.registration_token : null,
        registryCapability, endpointA: endpoints[0], endpointB: endpoints[1],
        samePairEligible: registryCapability && endpoints.every(e => e.canonicalMatch && e.attested)
          && refs[0].address?.session !== refs[1].address?.session };
    });
  }
  selectedLoopIdentityUnchanged(body: SelectedPair, stamp: string): boolean {
    return this.selectedLoopIdentityCheck(body).stamp === stamp;
  }

  // Revocation deletes the key binding (design section 2). The row stays, marked
  // revoked, so the audit trail keeps its target. Messages still queued for the
  // node are refused in the same transaction; the caller pushes the returned
  // statuses to their senders. The node's own final messages are due for
  // deletion (#308). Returns null when there was nothing to revoke.
  async revoke(nodeId: string, actor: string): Promise<MessageEffects | null> {
    return this.messageTx("revoke", () => {
      const found = this.sql.exec("SELECT id FROM nodes WHERE id = ? AND revoked_at IS NULL", nodeId).toArray().length > 0;
      if (!found) return null;
      const now = Date.now();
      this.directoryRows = null;
      this.sql.exec("UPDATE nodes SET public_key = NULL, status_connection_token=NULL,message_connection_token=NULL,registration_token=NULL, status = 'revoked', revoked_at = ? WHERE id = ?", now, nodeId);
      this.sql.exec("DELETE FROM runtimes WHERE node_id = ?", nodeId);
      this.sql.exec("DELETE FROM sessions WHERE node_id = ?", nodeId);
      this.mcp.removeNode(nodeId);
      this.messages.loops.revoke(nodeId);
      this.audit(actor, "node.revoke", nodeId);
      this.messages.retention.senderRevoked(nodeId, now);
      return this.messages.refuseQueuedFor(nodeId, "target node revoked", actor, now);
    });
  }

  async rotateMcpCredential(nodeId: string) {
    const token = randomToken(32);
    const hash = await sha256(token);
    return this.tx("rotateMcpCredential", () => this.mcp.rotateHashed(nodeId, token, hash, Date.now()));
  }

  async authenticateMcpCredential(token: string) {
    const hash = await sha256(token);
    return this.metered("authenticateMcpCredential", () => this.mcp.authenticateHashed(hash));
  }

  registerMcpIntent(nodeId: string, intent: McpIntentRegistration, now = Date.now()) {
    return this.tx("registerMcpIntent", () => this.mcp.register(nodeId, intent, now));
  }

  claimMcpIntent(intent: McpIntentClaim, now = Date.now()) {
    return this.tx("claimMcpIntent", () => this.mcp.claim(intent, now));
  }

  private async recoverMcpMessage(intent: McpIntentClaim) {
    if (!this.messages.replay(intent.requestId, intent.nodeId, false)) return null;
    return this.messageTx("recoverMcpMessage", () => {
      const peek = this.mcp.peekClaimSession(intent, Date.now());
      if (!peek.ok) return { ...peek, denied: true as const };
      const ownerError = this.messages.recoveryOwnerError(intent.requestId, intent.nodeId, peek.sessionId, intent.runtime);
      if (ownerError) return { ok: false as const, error: ownerError };
      if (this.messages.tombstoneOnlyPayload(intent.requestId)) return { ok: false as const, error: "duplicate messageId" };
      const claim = this.mcp.claim(intent, Date.now());
      if (!claim.ok) return { ...claim, denied: true as const };
      const effects = this.messages.expireDue(Date.now());
      const sent = this.messages.replay(intent.requestId, intent.nodeId);
      return sent?.ok ? { ...sent, effects: { deliveries: [...effects.deliveries, ...sent.effects.deliveries], statuses: [...effects.statuses, ...sent.effects.statuses] }, claim } : sent;
    });
  }

  // A failed claim is an authorization denial; its fixed error is visible to the caller.
  async sendMcpMessage(intent: McpIntentClaim, to: { nodeId: string; session: string }, text: string, inReplyTo?: string) {
    this.directoryRows = null;
    const replay = await this.recoverMcpMessage(intent);
    if (replay) return replay;
    const peek = this.mcp.peekClaimSession(intent, Date.now());
    if (!peek.ok) return { ...peek, denied: true as const };
    const message: NewMessage = { messageId: intent.requestId, from: { nodeId: intent.nodeId, session: peek.sessionId }, to, text, inReplyTo };
    const prepared = await this.prepareMessage(message);
    return this.messageTx("sendMcpMessage", () => {
      const current = this.mcp.peekClaimSession(intent, Date.now());
      if (!current.ok) return { ...current, denied: true as const };
      const comparison = current.sessionId !== peek.sessionId ? { matches: false } : this.messages.compareContext(message, prepared);
      if (current.sessionId !== peek.sessionId || !comparison.matches) {
        const error = prepared.error ?? LOOP_STALE;
        const diagnostic = error === LOOP_STALE ? identityDiagnostic(prepared, comparison, "mcp-claim", Date.now(), current.sessionId !== peek.sessionId ? ["owner"] : []) : undefined;
        return { ok: false as const, error, ...(diagnostic ? { diagnostic } : {}) };
      }
      const claim = this.mcp.claim(intent, Date.now());
      if (!claim.ok) return { ...claim, denied: true as const };
      const sent = this.messages.send({ messageId: claim.effectId,
        from: { nodeId: intent.nodeId, session: claim.sessionId }, to, text, inReplyTo }, `mcp:${intent.nodeId}`, Date.now(), prepared);
      this.mcp.recordOutcome(intent.nodeId, intent.requestId, sent.ok ? "succeeded" : "failed");
      return sent.ok ? { ...sent, claim } : sent;
    });
  }

  recordMcpOutcome(nodeId: string, requestId: string, outcome: McpOutcome): void {
    this.tx("recordMcpOutcome", () => this.mcp.recordOutcome(nodeId, requestId, outcome));
  }

  // Without the parent row (deleted after its ack, #308) the first call asks
  // for a lookup; the caller reads that inbox item from the replying node and
  // calls again with it (null when the node did not return it). The second
  // call recovers the same claim.
  async replyMcpMessage(intent: McpIntentClaim, inReplyTo: string, text: string, item?: McpInboxItem | null) {
    this.directoryRows = null;
    const replay = await this.recoverMcpMessage(intent);
    if (replay) return replay;
    const peek = this.mcp.peekClaimSession(intent, Date.now());
    if (!peek.ok) return { ...peek, denied: true as const };
    const target = this.messages.replyTarget(inReplyTo, intent.nodeId, peek.sessionId);
    if (target === "missing" && item === undefined) return { ok: false as const, lookup: peek.sessionId };
    const to = target === "missing" ? this.messages.retention.inboxReplyTarget({ nodeId: intent.nodeId, session: peek.sessionId }, inReplyTo, item ?? null) : target;
    if (!to) return { ok: false as const, error: "reply relationship or depth is not allowed" };
    const message: NewMessage = { messageId: intent.requestId, from: { nodeId: intent.nodeId, session: peek.sessionId }, to, text, inReplyTo };
    const prepared = await this.prepareMessage(message);
    return this.messageTx("replyMcpMessage", () => {
      const current = this.mcp.peekClaimSession(intent, Date.now());
      if (!current.ok) return { ...current, denied: true as const };
      const comparison = current.sessionId !== peek.sessionId ? { matches: false } : this.messages.compareContext(message, prepared);
      if (current.sessionId !== peek.sessionId || !comparison.matches) {
        const error = prepared.error ?? LOOP_STALE;
        const diagnostic = error === LOOP_STALE ? identityDiagnostic(prepared, comparison, "mcp-claim", Date.now(), current.sessionId !== peek.sessionId ? ["owner"] : []) : undefined;
        return { ok: false as const, error, ...(diagnostic ? { diagnostic } : {}) };
      }
      const claim = this.mcp.claim(intent, Date.now());
      if (!claim.ok) return { ...claim, denied: true as const };
      const sent = this.messages.send(message, `mcp:${intent.nodeId}`, Date.now(), prepared);
      this.mcp.recordOutcome(intent.nodeId, intent.requestId, sent.ok ? "succeeded" : "failed");
      return sent.ok ? { ...sent, claim } : sent;
    });
  }

  private async prepareMessage(message: NewMessage) {
    const signer = await this.loopSigner;
    const prepared = await this.messages.prepare(message, signer);
    const binding = await prepareMessageBinding(this.sql, message, signer,
      (nodeId, request) => sessionStub(this.env, nodeId).resolveMessageReferencesDetailed(request));
    if (message.connectionToken && bindingContext(this.sql, message).nodes[0]?.token !== message.connectionToken) { binding.error = LOOP_STALE; binding.connectionChanged = true; }
    return { ...prepared, binding };
  }
  async prepareMessageDelivery(messageId: string, phase?: "auth" | "registration") {
    const candidate = this.messages.deliveryCandidate(messageId);
    const prepared = candidate?.required && candidate.binding ? await prepareMessageBinding(this.sql, candidate.message, await this.loopSigner,
      (nodeId, request) => sessionStub(this.env, nodeId).resolveMessageReferencesDetailed(request), "egress", candidate.binding ?? undefined) : null;
    const result = await this.messageTx("prepareMessageDelivery", () => this.messages.prepareDelivery(messageId, prepared, Date.now(), phase));
    const canonical = result.effects.statuses.filter(effect => !effect.observational);
    if (canonical.length) await routeEffects(this.env, { ...result.effects, statuses: canonical });
    const observational = result.effects.statuses.filter(effect => effect.observational);
    if (observational.length) try { await routeEffects(this.env, { deliveries: [], statuses: observational }); }
    catch { /* Optional diagnostics must not interrupt blocked egress or later frames. */ }
    return result.body;
  }
  observeMessageDiagnostic(messageId: string, nodeId: string | null, diagnostic: MessageDiagnostic) {
    return this.messageTx("observeMessageDiagnostic", () => this.messages.observeDiagnostic(messageId, nodeId, diagnostic));
  }
  // ---- Messages (issue #31). The caller pushes the returned effects. -------

  async sendMessage(message: NewMessage, actor: string): Promise<SendResult> {
    const prepared = await this.prepareMessage(message);
    return this.messageTx("sendMessage", (): SendResult => {
      if (message.taskId !== undefined && !this.tasks.taskOnEitherNode(message.taskId, message.from.nodeId, message.to.nodeId)) {
        return { ok: false, error: "unknown task for this message" };
      }
      if (message.connectionToken && bindingContext(this.sql, message).nodes[0]?.token !== message.connectionToken) { prepared.binding.error = LOOP_STALE; prepared.binding.connectionChanged = true; }
      return this.messages.send(message, actor, Date.now(), prepared);
    });
  }

  // A report that took a message out of queued is this node's last intake (issue #441).
  async reportMessageStatus(nodeId: string, status: MessageStatusBody & { state: NodeReportedState }) {
    return this.messageTx("reportMessageStatus", () => {
      const now = Date.now();
      const result = this.messages.report(nodeId, status, now);
      if (result.advancedFrom === "queued") recordTaken(this.sql, nodeId, now);
      return result;
    });
  }

  // The sender acknowledged a final status: the row may go (#308).
  async ackMessageStatus(nodeId: string, body: MessageStatusAckBody): Promise<void> {
    await this.messageTx("ackMessageStatus", () => this.messages.retention.ack(nodeId, body, Date.now()));
  }

  // Issue #408 (design r3 section 4.3): the push boundary of a proxy delivery re-reads its row.
  messageQueued(messageId: string): boolean {
    return this.metered("messageQueued", () => this.messages.isQueued(messageId));
  }

  async messageDeliveryReady(messageId: string): Promise<boolean> {
    const result = await this.messageTx("messageDeliveryReady", () => this.messages.deliveryReady(messageId, Date.now()));
    const canonical = result.effects.statuses.filter(effect => !effect.observational);
    if (canonical.length) await routeEffects(this.env, { ...result.effects, statuses: canonical });
    const observational = result.effects.statuses.filter(effect => effect.observational);
    if (observational.length) try { await routeEffects(this.env, { deliveries: [], statuses: observational }); }
    catch { /* Optional diagnostics must not interrupt blocked egress or later frames. */ }
    return result.ready;
  }
  listMessageHolds(limit: number) { return this.metered("listMessageHolds", () => this.messages.loops.listHolds(limit)); }
  async releaseMessageHold(id: string, version: number, actor: string) {
    return this.messageTx("releaseMessageHold", () => {
      const result = this.messages.loops.release(id, version, Date.now());
      if (result.status === 200 && result.changed) this.audit(actor, "message.loop.release", null, { holdId: id, generation: result.generation, version: result.version });
      return result;
    });
  }

  pendingMessagesFor(nodeId: string): MessageEffects {
    this.directoryRows = null; // expiry may drain a queue (issue #441)
    return this.tx("pendingMessagesFor", () => this.messages.pendingFor(nodeId, Date.now()));
  }

  messageStatusPageFor(nodeId: string, afterRowId: number, limit: number) {
    return this.metered("messageStatusPageFor", () => this.messages.statusPageFor(nodeId, afterRowId, limit));
  }

  listMessages(nodeId: string | null, limit: number): MessageRecord[] {
    return this.metered("listMessages", () => this.messages.list(nodeId, limit));
  }

  // Issue #493: diagnostic only. Reads every row of one sender, so it is logged
  // under its own path and never mistaken for a hot one.
  messageSummary(fromNode: string, now = Date.now()): MessageSummary {
    return this.metered("messageSummary", () => messageSummary(this.sql, fromNode, now));
  }

  // A replied message also names the reply that marked it (issue #200); a
  // deleted message answers from its tombstone (#308).
  mcpMessageStatus(nodeId: string, messageId: string): (MessageRecord & { replyMessageId?: string }) | MessageStatusView | null {
    return this.metered("mcpMessageStatus", () => {
      const record = this.messages.visibleTo(nodeId, messageId);
      if (!record) return this.messages.retention.statusFor(nodeId, messageId);
      if (record.state !== "replied") return record;
      const replyMessageId = this.messages.replyMessageIdOf(messageId);
      return replyMessageId ? { ...record, replyMessageId } : record;
    });
  }

  // ---- Tasks (issue #31, item 5). The caller dispatches session.start. ----

  createTask(input: NewTask): CreateResult {
    return this.tx("createTask", () => this.tasks.create(input, Date.now()));
  }

  getTask(taskId: string): TaskRow | null {
    return this.metered("getTask", () => this.tasks.get(taskId));
  }

  listTasks(limit: number): TaskRow[] {
    return this.metered("listTasks", () => this.tasks.list(limit));
  }

  reportTask(nodeId: string, body: TaskReportBody): boolean {
    return this.tx("reportTask", () => this.tasks.report(nodeId, body, Date.now()));
  }

  setTaskState(taskId: string, state: string, reason: string, actor: string): void {
    this.metered("setTaskState", () => this.tasks.setState(taskId, state, reason, actor, Date.now()));
  }

  isTaskSession(nodeId: string, session: string): boolean {
    return this.metered("isTaskSession", () => this.tasks.isTaskSession(nodeId, session));
  }

  hasActiveTasks(nodeId: string): boolean {
    return this.metered("hasActiveTasks", () => this.tasks.hasActiveTasks(nodeId));
  }

  // ---- Owner task control (issue #134). Registry owns durable delivery. ----

  registerTaskControl(nodeId: string, body: TaskControlRegisterBody) {
    return this.tx("registerTaskControl", () => this.taskControl.register(nodeId, body));
  }

  submitTaskControl(nodeId: string, body: TaskControlSubmitBody) {
    return this.tx("submitTaskControl", () => this.taskControl.submit(nodeId, body));
  }

  queryTaskControl(nodeId: string, requestId: string) {
    return this.tx("queryTaskControl", () => this.taskControl.query(nodeId, requestId));
  }

  retryTaskControl(nodeId: string, requestId: string) {
    return this.tx("retryTaskControl", () => this.taskControl.retry(nodeId, requestId));
  }

  pendingTaskControlFor(nodeId: string, limit: number) {
    return this.tx("pendingTaskControlFor", () => this.taskControl.pendingFor(nodeId, limit));
  }

  pendingTaskControlPageFor(nodeId: string, afterRowId: number, limit: number) {
    return this.tx("pendingTaskControlPageFor", () => this.taskControl.pendingPageFor(nodeId, afterRowId, limit));
  }

  recordTaskControlResult(nodeId: string, body: TaskControlResultBody) {
    return this.tx("recordTaskControlResult", () => this.taskControl.recordResult(nodeId, body));
  }

  markTaskControlDelivered(operationId: string): void {
    this.metered("markTaskControlDelivered", () => this.taskControl.markDelivered(operationId));
  }
  // Expiry is checked on every message access and, so that the text of an
  // expired message never waits for the next access, by an alarm set to the
  // earliest expiry of a queued message, fallback deletion or tombstone
  // expiry (#308). A full deletion batch re-arms it after one second.
  async alarm(): Promise<void> {
    const { effects, more } = await this.messageTx("alarm", () => {
      const now = Date.now();
      const effects = this.messages.expireDue(now);
      const swept = this.messages.retention.sweepDue(now);
      const pruned = this.messages.retention.pruneTombstones(now);
      const loops = this.messages.loops.cleanup(now);
      return { effects, more: pruned || swept || loops };
    });
    if (more) await this.ctx.storage.setAlarm(Date.now() + 1000);
    await routeEffects(this.env, effects);
  }

  private metered<T>(path: string, run: () => T): T {
    return this.meter.measure(path, run);
  }

  private tx<T>(path: string, run: () => T): T {
    return this.meter.measure(path, () => this.ctx.storage.transactionSync(run));
  }

  // A message transaction and the earliest queued expiry or retention deadline,
  // read in the same measured region; arming the alarm afterwards is storage, not SQL.
  // Every queue change runs here, so the cached queue heads go (issue #441).
  private async messageTx<T>(path: string, run: () => T): Promise<T> {
    this.directoryRows = null;
    const { result, next } = this.metered(path, () => {
      const result = this.ctx.storage.transactionSync(run);
      return { result, next: earliest(this.messages.nextExpiry(), this.messages.retention.nextDue(), this.messages.loops.nextExpiry()) };
    });
    if (next !== null) {
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > next) await this.ctx.storage.setAlarm(next);
    }
    return result;
  }

  private capabilitiesOf(nodeId: string): string[] | null {
    const row = this.sql.exec("SELECT capabilities FROM nodes WHERE id = ? AND revoked_at IS NULL", nodeId).toArray()[0];
    return row ? JSON.parse(String(row.capabilities)) as string[] : null;
  }

  private writeRuntimes(nodeId: string, runtimes: RuntimeInfo[]): void {
    this.sql.exec("DELETE FROM runtimes WHERE node_id = ?", nodeId);
    for (const r of runtimes) {
      this.sql.exec("INSERT OR REPLACE INTO runtimes (node_id, name, kind, version, endpoint) VALUES (?, ?, ?, ?, ?)",
        nodeId, r.name, r.kind, r.version ?? null, r.endpoint ?? null);
    }
  }
}
