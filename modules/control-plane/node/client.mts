import { compatibleDiagnostic, isMessageDiagnostic, type MessageDiagnostic } from "../protocol-diagnostics.mts";
import { RecordLockBusy } from "./inbox-record-lock.mts";
import type { BindingStorageSnapshot } from "./inbox-storage.mts";
import { isResolveRequest, SELECTED_BINDING_CAPABILITY } from "../protocol-message-binding.mts";
import type { MessageReferenceResolver } from "./message-reference.mts";
import { identitySnapshotOf } from "./session-identity.mts";
import {
  isCommandBody, makeEnvelope, MAX_FRAME_BYTES, parseEnvelope, PONG_FRAME, type ChallengeBody, type Envelope, type MessageType,
  type NodeFacts, type Phase1Command, type RuntimeInfo, type SessionCommand, type SessionInfo,
} from "../protocol.mts";
import {
  isTaskControlExecuteBody, isTaskControlQueryResultBody, isTaskControlRegistrationReceiptBody, isTaskControlResultReceiptBody,
  type TaskControlEventBody, type TaskControlExecuteBody, type TaskControlQueryResultBody, type TaskControlRegistrationReceiptBody,
  type TaskControlResultReceiptBody,
} from "../protocol-task-control.mts";
import {
  isCommandArgs, isTaskId, isTaskRequestResult, TASK_REQUEST_RESULT, type TaskReportBody, type TaskRequestBody, type TaskRequestResult,
  type TaskRuntime,
} from "../protocol-tasks.mts";
import {
  isDirectoryBody, isFinalMessageState, isMessageDeliverBody, isMessageId, isMessageReceiptBody, isMessageStatusBody, messageStatusAck,
  type DirectoryBody, type MessageDeliverBody, type MessageProgress, type MessageReceiptBody, type MessageSendBody, type MessageState,
} from "../protocol-messages.mts";
import { signChallenge, type NodeIdentity } from "./identity.mts";
import { discoverMcpSessions } from "./mcp-session-discovery.mts";
import { nativeMcpAssignment, assignmentWitness, type AssignmentContext } from "./mcp-assignment.mts";
import { acceptsMessage, advertisedCapabilities, isAllowed, mcpRuntimeEnabled, type NodePolicy } from "./policy.mts";
import {
  isMcpCredentialBody, isMcpInboxRequestBody, isMcpIntentReceiptBody, isMcpIntentRegistration, MCP_INBOX_TOO_LARGE,
  isMcpLeadConfirmRequest, MCP_LEAD_CONFIRM_MS,
  type McpCredentialBody, type McpInboxItem, type McpIntentReceiptBody, type McpIntentRegistration, type McpAssignmentNative,
} from "../protocol-mcp.mts";

// Session commands (item 5) take their validated args; a node without them
// answers ok:false.
export type CommandHandlers = Record<Phase1Command, () => Promise<unknown>>
  & Partial<Record<SessionCommand, (args: never) => Promise<unknown>>>;
// The state of a message this node sent: a Worker state, or error when the
// Worker rejected the message.send frame itself.
export type SentState = MessageState | "error";
// Issue #441: the bytes a stamp can add (seq and ack each grow to at most 16 digits).
export const STAMP_MARGIN = 32;
// Issue #706: a BOUND answer with less margin than this is logged as late.
const RESOLVE_LATE_MS = 1_000;

export interface ClientOptions {
  selectedReferences?: MessageReferenceResolver;
  bindingStorageReady?: () => boolean | BindingStorageSnapshot;
  bindingStorageFault?: () => void;
  nodeId: string;
  identity: NodeIdentity;
  policy: NodePolicy;
  handlers: CommandHandlers;
  facts: () => NodeFacts;
  runtimes: () => Promise<RuntimeInfo[]>;
  // Rejects when the listing failed, which is not the same as no sessions.
  sessions: (signal?: AbortSignal) => Promise<SessionInfo[]>;
  assignmentIdentity?: (sessionId: string, context?: AssignmentContext) => Promise<McpAssignmentNative | null>;
  // The daemon publishes this after authentication so service-drained session
  // discovery cannot postpone connectedAt. Transport-free clients keep the
  // original synchronous auth snapshot by default.
  deferInitialSessions?: boolean;
  // Stores an accepted message in the node inbox; throws when it cannot.
  storeMessage: (body: MessageDeliverBody) => void;
  // The last local session listing (sessions.json), so a policy rule for a
  // session name also accepts a message addressed by that session's id.
  localSessions?: () => { sessionId: string; name?: string }[];
  // Step 3a: the directory frame, and the state of a message this node sent.
  storeDirectory?: (body: DirectoryBody) => void;
  sentUpdate?: (messageId: string, state: SentState, reason?: string, progress?: MessageProgress, diagnostic?: MessageDiagnostic) => void;
  receiptUpdate?: (body: MessageReceiptBody) => void;
  // Item 5: the Worker's answer to a task.request this node sent.
  taskRequestResult?: (result: TaskRequestResult) => void;
  taskControlExecute?: (body: TaskControlExecuteBody) => Promise<void>;
  taskControlRegistrationReceipt?: (body: TaskControlRegistrationReceiptBody) => void;
  taskControlResultReceipt?: (body: TaskControlResultReceiptBody) => void;
  taskControlQueryResult?: (body: TaskControlQueryResultBody) => void;
  mcpCredentialPresent?: () => boolean;
  mcpCredential?: (body: McpCredentialBody) => void;
  mcpIntentReceipt?: (body: McpIntentReceiptBody) => void;
  mcpDisabled?: () => void;
  readMcpInbox?: (sessionId: string, limit: number, messageId?: string, runtime?: string) => McpInboxItem[] | Promise<McpInboxItem[]>;
  // Issue #308: the messages a returned inbox response carries, offered to their session.
  offerMcpInbox?: (messageIds: string[], sessionId: string, runtime: string) => void;
  // Issue #308: the item an MCP reply answers (mcp.inbox.request with reply).
  answerMcpInbox?: (messageIds: string[], sessionId: string, runtime: string) => void;
  // Issue #197: the runtimes whose last readiness probe passed; a change re-registers.
  readyRuntimes?: () => readonly TaskRuntime[];
  log?: (line: string) => void;
  now?: () => number;
}

// The node side of the protocol as a transport-free state machine: it takes
// one received frame and returns the frames to send. The daemon owns the
// socket; tests drive this class directly.
export class NodeClient {
  private readonly options: ClientOptions;
  private policy: NodePolicy;
  private lastRuntimes: RuntimeInfo[] = [];
  private registrationDirty = false;
  private registrationFrames: string[] | null = null;
  private credentialRotationPending = false;
  private credentialRequestPending: string | null = null;
  // The ready runtimes the last register frame carried, as JSON.
  private advertisedReady: string | undefined;
  private storageReady = false;
  private storageGeneration = 0;
  // Issue #441: built numbers frames in build order (provisional); sent is the
  // wire seq, assigned by stamp() at the daemon's single send step.
  private built = 0;
  private sent = 0;
  // Highest command seq processed. Survives reconnects within this process so
  // the auth message tells the server what not to resend.
  private processedSeq = 0;
  // The session list last sent in sessions.snapshot, as JSON.
  private lastSnapshot: string | null = null;
  // Issue #706: the last trimmed or withheld line, so an unchanged count logs once.
  private snapshotLimitLog: string | null = null;
  authenticated = false;
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private assignmentGeneration = 0;
  private readonly leadAdmissions = new Map<string, { binding: McpIntentRegistration; witness: string; generation: number; expiresAt: number; version?: number }>();
  // Issue #408, PR 4 (design r3 section 3.3): what the Worker of the current
  // authenticated connection named in a directory frame received on it; null
  // until that frame, again at every close and every auth.ok. Never read from
  // directory.json, so a stale file or an old connection proves nothing.
  workerCapabilities: readonly string[] | null = null;

  constructor(options: ClientOptions) {
    this.options = options;
    this.policy = options.policy;
    this.sampleStorage();
  }

  get ack(): number {
    return this.processedSeq;
  }

  private setStorageReady(ready: boolean, generation = this.storageGeneration): void {
    if (ready === this.storageReady && generation === this.storageGeneration) return;
    this.storageGeneration = generation;
    this.storageReady = ready;
    this.options.selectedReferences?.clear();
    this.registrationDirty = true;
    this.registrationFrames = null;
  }

  private sampleStorage(): void {
    try {
      const snapshot = this.options.bindingStorageReady?.() ?? false;
      this.setStorageReady(typeof snapshot === "boolean" ? snapshot : snapshot.ready,
        typeof snapshot === "boolean" ? this.storageGeneration : snapshot.generation);
    } catch {
      this.options.bindingStorageFault?.();
      this.options.selectedReferences?.clear();
      this.setStorageReady(false);
    }
  }

  connectionClosed(): void {
    this.assignmentGeneration++;this.leadAdmissions.clear();
    this.options.selectedReferences?.clear();
    this.authenticated = false;
    this.workerCapabilities = null;
    this.registrationDirty = true;
    this.registrationFrames = null;
    this.credentialRequestPending = null;
  }

  // live: the frame arrived on the socket that is current and open when it is
  // handled (the daemon decides; tests and the default take it as live).
  async onFrame(raw: string, live = true): Promise<string[]> {
    this.sampleStorage();
    if (raw === PONG_FRAME) return [];
    const parsed = parseEnvelope(raw);
    if (!parsed.ok) return [];
    const envelope = parsed.envelope;
    switch (envelope.type) {
      case "challenge":
        return [this.frame("auth", this.authBody(envelope.body as unknown as ChallengeBody), false)];
      case "event":
        if (isMessageReceiptBody(envelope.body) && this.authenticated) {
          const body = envelope.body;
          this.callback(body.messageId, () => this.options.receiptUpdate?.(body));
          return [];
        }
        if ((envelope.body as { name?: unknown }).name === TASK_REQUEST_RESULT && this.authenticated) {
          const body = envelope.body;
          if (isTaskRequestResult(body)) this.callback(body.requestId, () => this.options.taskRequestResult?.(body));
          return [];
        }
        if (this.authenticated && isTaskControlExecuteBody(envelope.body)) {
          try {
            await this.options.taskControlExecute?.(envelope.body);
          } catch (error) {
            this.options.log?.(`kherep-node: could not execute task control ${envelope.body.operationId}: ${String((error as Error).message ?? error)}`);
          }
          return [];
        }
        if (this.authenticated && isTaskControlRegistrationReceiptBody(envelope.body)) {
          this.callback(envelope.body.registrationId, () => this.options.taskControlRegistrationReceipt?.(envelope.body as TaskControlRegistrationReceiptBody));
          return [];
        }
        if (this.authenticated && isTaskControlResultReceiptBody(envelope.body)) {
          this.callback(envelope.body.operationId, () => this.options.taskControlResultReceipt?.(envelope.body as TaskControlResultReceiptBody));
          return [];
        }
        if (this.authenticated && isTaskControlQueryResultBody(envelope.body)) {
          this.callback(envelope.body.requestId, () => this.options.taskControlQueryResult?.(envelope.body as TaskControlQueryResultBody));
          return [];
        }
        if ((envelope.body as { name?: unknown }).name !== "auth.ok") return [];
        this.assignmentGeneration++;this.leadAdmissions.clear();
        this.options.selectedReferences?.clear();
        this.authenticated = true;
        this.workerCapabilities = null;
        this.lastSnapshot = null;
        this.lastRuntimes = await this.options.runtimes();
        this.registrationDirty = true;
        this.credentialRotationPending ||= this.policy.remoteMcp?.enabled === true
          && this.options.mcpCredentialPresent?.() !== true;
        return [
          ...this.pendingRegistrationFrames(),
          ...(this.options.deferInitialSessions ? [] : await this.sessionsSnapshot()),
          ...this.directoryRequest(),
        ];
      case "command":
        return this.authenticated ? this.onCommand(envelope) : [];
      case "message.resolve.request": {
        const body = envelope.body, references = this.options.selectedReferences;
        const skip = (reason: string): string[] => { this.logResolve(`skipped: ${reason}`, body); return []; };
        if (!live) return skip("not live");
        if (!this.authenticated) return skip("not authenticated");
        if (!this.storageReady) return skip("storage not ready");
        if (!references) return skip("no resolver");
        if (!isResolveRequest(body)) return skip("malformed");
        const response = references.resolve(body, JSON.stringify(this.policy));
        const late = body.expiresAt - (this.options.now?.() ?? Date.now()) < RESOLVE_LATE_MS;
        if (late || response.results.some(r => r.code !== "BOUND")) {
          this.logResolve(`answered ${response.results.map(r => `${r.role}:${r.code}`).join(",")}`, body);
        }
        return [this.frame("message.resolve.response", { ...response })];
      }
      case "message.deliver":
        if (!live || !this.authenticated || !isMessageDeliverBody(envelope.body)) return [];
        return this.onDeliver(envelope.body);
      case "directory":
        if (!live || !this.authenticated || !isDirectoryBody(envelope.body)) return [];
        this.callback("directory", () => this.options.storeDirectory?.(envelope.body as DirectoryBody));
        // A frame without worker comes from an older Worker: no capability.
        if (live && this.authenticated) this.workerCapabilities = [...envelope.body.worker?.capabilities ?? []];
        return [];
      case "message.status": {
        const body = envelope.body;
        if (!isMessageStatusBody(body)) return [];
        const recorded = this.callback(body.messageId, () => this.options.sentUpdate?.(body.messageId, body.state, body.reason, body.progress, body.diagnostic));
        // Issue #308: a final status recorded here (or with no local record) is acknowledged.
        return recorded && this.authenticated && isFinalMessageState(body.state)
          ? [this.frame("event", { ...messageStatusAck(body.messageId, body.state) })] : [];
      }
      case "mcp.credential":
        if (this.authenticated && this.policy.remoteMcp?.enabled === true) {
          const body = envelope.body;
          if (isMcpCredentialBody(body) && body.requestId === this.credentialRequestPending) {
            this.assignmentGeneration++;this.leadAdmissions.clear();
            const stored = body.ok && this.callback(body.requestId, () => this.options.mcpCredential?.(body));
            this.credentialRequestPending = null;
            if (!stored) {
              this.registrationDirty = true;
              this.registrationFrames = null;
              this.credentialRotationPending = true;
            }
          }
        }
        return [];
      case "mcp.intent.receipt":
        if (this.authenticated && this.policy.remoteMcp?.enabled === true) {
          const body = envelope.body;
          if (isMcpIntentReceiptBody(body)) {
            const admission = this.leadAdmissions.get(body.requestId);
            if (admission) { if (body.ok) { admission.version = body.version;admission.expiresAt = Math.min(admission.expiresAt, body.expiresAt); }
              else this.leadAdmissions.delete(body.requestId); }
            this.callback(body.requestId, () => this.options.mcpIntentReceipt?.(body));
          }
        }
        return [];
      case "mcp.lead.confirm.request": {
        const body = envelope.body;
        if (!live || !this.authenticated || !isMcpLeadConfirmRequest(body)) return [];
        const admission = this.leadAdmissions.get(body.requestId), now = this.now();
        const eligible = () => live && this.authenticated && mcpRuntimeEnabled(this.policy, "codex")
          && admission?.generation === this.assignmentGeneration && admission.expiresAt > this.now()
          && body.expiresAt > this.now() && body.expiresAt <= now + MCP_LEAD_CONFIRM_MS
          && body.nodeId === this.options.nodeId && admission.version === body.credentialVersion
          && admission.binding.sessionId === body.sessionId && admission.binding.threadId === body.threadId
          && admission.binding.callId === body.callId && admission.binding.argumentsDigest === body.argumentsDigest
          && admission.binding.assignment?.slot === body.slot && admission.binding.assignment.turnId === body.turnId
          && this.knownMcpIntents([admission.binding]).length === 1;
        let allowed = false;
        if (eligible() && admission) {
          try {
            const current = await (this.options.assignmentIdentity ?? nativeMcpAssignment)(body.sessionId, body);
            allowed = eligible() && !!current && current.leadGuardVersion === 1
              && current.chatName === admission.binding.assignment?.native?.chatName
              && assignmentWitness(current) === admission.witness;
          } catch { /* A fixed denial never includes local reader errors. */ }
        }
        return [this.frame("mcp.lead.confirm.response", { nonce: body.nonce, allowed })];
      }
      case "mcp.inbox.request": {
        if (!this.authenticated || !isMcpInboxRequestBody(envelope.body)) return [];
        const body = envelope.body;
        if (!mcpRuntimeEnabled(this.policy, body.runtime ?? "codex")) return [];
        try {
          const items = await this.options.readMcpInbox?.(body.sessionId, body.limit, body.messageId, body.runtime ?? "codex");
          const response = this.frame("mcp.inbox.response", items
            ? { requestId: body.requestId, ok: true, items }
            : { requestId: body.requestId, ok: false, error: "local inbox reader is unavailable" });
          if (Buffer.byteLength(response, "utf8") + STAMP_MARGIN > MAX_FRAME_BYTES) {
            return [this.frame("mcp.inbox.response", { requestId: body.requestId, ok: false, error: MCP_INBOX_TOO_LARGE })];
          }
          if (items) {
            const ids = items.map((item) => item.messageId);
            if (body.reply) this.callback("MCP reply", () => this.options.answerMcpInbox?.(ids, body.sessionId, body.runtime ?? "codex"));
            else this.callback("MCP inbox offer", () => this.options.offerMcpInbox?.(ids, body.sessionId, body.runtime ?? "codex"));
          }
          return [response];
        } catch {
          return [this.frame("mcp.inbox.response", { requestId: body.requestId, ok: false, error: "local inbox read failed" })];
        }
      }
      case "error": {
        // The Worker answers a message.send it cannot take with an error frame
        // that names the message.
        const { messageId, error, diagnostic } = envelope.body as { messageId?: unknown; error?: unknown; diagnostic?: unknown };
        if (isMessageId(messageId)) this.callback(messageId, () => this.options.sentUpdate?.(messageId, "error", String(error).slice(0, 256), undefined, isMessageDiagnostic(diagnostic) ? diagnostic : undefined));
        else {
          // Issue #706: a rejected snapshot is not a sent one; retry it instead of caching it.
          if (error === "frame too large") this.lastSnapshot = null;
          // Issue #441: otherwise the one signal that a frame bypassed the stamp or was malformed.
          this.options.log?.(`kherep-node: control plane rejected a frame: ${String(error).slice(0, 256)}`);
        }
        return [];
      }
      default:
        return [];
    }
  }

  // A sessions.snapshot frame when the session list changed since the last
  // one sent on this connection. A failed listing sends nothing, so the
  // Registry keeps its last known list instead of being wiped.
  async sessionsSnapshot(): Promise<string[]> {
    if (!this.authenticated) return [];
    let sessions: SessionInfo[];
    try {
      sessions = await this.options.sessions();
    } catch (error) {
      this.options.log?.(`kherep-node: session listing failed, snapshot skipped: ${String((error as Error).message ?? error)}`);
      return [];
    }
    return this.sessionFrames(sessions);
  }

  sessionFrames(sessions: SessionInfo[]): string[] {
    if (!this.authenticated) return [];
    const identitySnapshot = identitySnapshotOf(sessions);
    const extras = identitySnapshot ? { identitySnapshot } : {};
    const rows = this.rowsWithinFrame(sessions, extras);
    if (!rows) {
      this.lastSnapshot = null;
      return [];
    }
    const body = { sessions: rows, ...extras };
    const json = JSON.stringify(body);
    if (json === this.lastSnapshot) return [];
    this.lastSnapshot = json;
    return [this.frame("sessions.snapshot", body)];
  }

  // Issue #706: the Worker rejects a whole frame over the limit. An unknown row
  // without proof means the same to admission as no row, so those rows go first,
  // from the end, where the longest-carried ones are. Null: the rest alone is too large.
  private rowsWithinFrame(sessions: SessionInfo[], extras: object): SessionInfo[] | null {
    const envelope = makeEnvelope("sessions.snapshot", { sessions, ...extras }, this.built + 1, this.processedSeq);
    let excess = Buffer.byteLength(JSON.stringify(envelope), "utf8") + STAMP_MARGIN - MAX_FRAME_BYTES;
    if (excess <= 0) {
      this.snapshotLimitLog = null;
      return sessions;
    }
    const rows = [...sessions];
    for (let i = rows.length - 1; i >= 0 && excess > 0; i--) {
      if (rows[i].state !== "unknown" || rows[i].canonicalIdentity) continue;
      excess -= Buffer.byteLength(JSON.stringify(rows[i]), "utf8") + 1; // its comma
      rows.splice(i, 1);
    }
    const line = excess > 0
      ? `kherep-node: sessions.snapshot withheld: ${rows.length} live rows exceed one frame`
      : `kherep-node: sessions.snapshot trimmed ${sessions.length - rows.length} of ${sessions.length} rows (frame too large)`;
    if (line !== this.snapshotLimitLog) this.options.log?.(line);
    this.snapshotLimitLog = line;
    return excess > 0 ? null : rows;
  }

  async refreshPolicy(policy: NodePolicy): Promise<string[]> {
    this.sampleStorage();
    const previous = advertisedCapabilities(this.policy);
    const capabilities = advertisedCapabilities(policy);
    const wasMcpEnabled = this.policy.remoteMcp?.enabled === true;
    const mcpEnabled = policy.remoteMcp?.enabled === true;
    if (JSON.stringify(this.policy) !== JSON.stringify(policy)) {
      this.options.selectedReferences?.clear();this.assignmentGeneration++;this.leadAdmissions.clear();
    }
    this.policy = policy;
    if (wasMcpEnabled && !mcpEnabled) {
      this.credentialRequestPending = null;
      this.credentialRotationPending = false;
      this.callback("remote MCP state", () => this.options.mcpDisabled?.());
    }
    const readyChanged = this.advertisedReady !== undefined && this.advertisedReady !== JSON.stringify(this.readyRuntimes());
    if (JSON.stringify(previous) !== JSON.stringify(capabilities) || readyChanged) {
      this.registrationDirty = true;
      this.registrationFrames = null;
      this.credentialRotationPending ||= !wasMcpEnabled && mcpEnabled;
    }
    if (mcpEnabled && !this.registrationDirty && !this.credentialRequestPending
      && this.options.mcpCredentialPresent?.() !== true) {
      this.registrationDirty = true;
      this.registrationFrames = null;
      this.credentialRotationPending = true;
    }
    return this.pendingRegistrationFrames();
  }

  registrationSent(): void {
    this.registrationDirty = false;
    this.registrationFrames = null;
    this.credentialRotationPending = false;
  }

  directoryRequest(): string[] {
    return this.authenticated ? [this.frame("directory.get", {})] : [];
  }

  sendMessage(body: MessageSendBody): string[] {
    return this.authenticated ? [this.frame("message.send", { ...body, to: { ...body.to } })] : [];
  }

  registerMcpIntent(body: McpIntentRegistration): string[] {
    return body.tool !== "assign_self" && this.authenticated && isMcpIntentRegistration(body) && mcpRuntimeEnabled(this.policy, body.runtime)
      ? [this.frame("mcp.intent.register", { ...body })] : [];
  }

  async registerMcpAssignment(body: McpIntentRegistration, beforePublish?: () => Promise<boolean>): Promise<string[]> {
    if (body.tool !== "assign_self" || body.runtime !== "codex" || !body.assignment) return [];
    const local: McpIntentRegistration = { ...body, assignment: { slot: body.assignment.slot, turnId: body.assignment.turnId } };
    if (!this.authenticated || !isMcpIntentRegistration(local) || !mcpRuntimeEnabled(this.policy, "codex")) return [];
    const lead = local.assignment!.slot === "kherep-lead", generation = this.assignmentGeneration;
    const context = { ...local.assignment!, requestId: local.requestId, callId: local.callId };
    const reader = this.options.assignmentIdentity ?? nativeMcpAssignment;
    let native: McpAssignmentNative | null;
    try { native = await reader(local.sessionId, context); } catch { return []; }
    if (beforePublish && !await beforePublish()) return [];
    if (lead) {
      if (!native || native.leadGuardVersion !== 1 || !assignmentWitness(native)) return [];
      const witness = assignmentWitness(native);
      try { native = await reader(local.sessionId, context); } catch { return []; }
      if (!native || assignmentWitness(native) !== witness) return [];
    }
    if (!native || native.sessionId !== local.sessionId || !this.authenticated || !mcpRuntimeEnabled(this.policy, "codex")
      || generation !== this.assignmentGeneration || this.knownMcpIntents([local]).length !== 1) return [];
    const enriched: McpIntentRegistration = { ...local, assignment: { ...local.assignment!, native } };
    if (!isMcpIntentRegistration(enriched)) return [];
    if (lead) {
      for (const [id, saved] of this.leadAdmissions) if (saved.expiresAt <= this.now()) this.leadAdmissions.delete(id);
      if (this.leadAdmissions.size >= 128) return [];
      this.leadAdmissions.set(local.requestId, { binding: enriched, witness: assignmentWitness(native)!, generation,
        expiresAt: this.now() + (local.ttlMs ?? 120_000) });
    }
    return [this.frame("mcp.intent.register", { ...enriched })];
  }

  knownMcpIntents(intents: McpIntentRegistration[]): McpIntentRegistration[] {
    const sessions: SessionInfo[] = this.lastSnapshot ? JSON.parse(this.lastSnapshot).sessions : [];
    const runtimes = new Map(sessions.map(session => [session.sessionId, session.runtime]));
    return intents.filter(intent => runtimes.get(intent.sessionId) === intent.runtime);
  }

  async sessionsBeforeMcpIntents(beforeSnapshot?: () => Promise<boolean>, remainingMs?: number): Promise<string[] | null> {
    if (!this.authenticated || this.policy.remoteMcp?.enabled !== true) return null;
    let discovered: SessionInfo[];
    try { discovered = await discoverMcpSessions(this.options.sessions, remainingMs); }
    catch (error) {
      this.options.log?.(`kherep-node: native session discovery failed, registration skipped: ${String((error as Error).message ?? error)}`);
      return null;
    }
    if (beforeSnapshot && !await beforeSnapshot()) return null;
    if (!this.authenticated || this.policy.remoteMcp?.enabled !== true) return null;
    return this.sessionFrames(discovered);
  }

  invalidateSessionsSnapshot(): void {
    this.lastSnapshot = null;
  }

  // The state the target session reached: delivered, or refused with a reason.
  reportStatus(messageId: string, state: "accepted" | "delivered" | "refused", reason?: string, progress?: MessageProgress, diagnostic?: MessageDiagnostic): string[] {
    return this.authenticated ? [this.frame("message.status",
      compatibleDiagnostic({ messageId, state, ...(reason ? { reason } : {}), ...(state === "accepted" && progress ? { progress } : {}), ...(diagnostic ? { diagnostic } : {}) }, this.workerCapabilities))] : [];
  }

  reportTask(body: TaskReportBody): string[] {
    return this.authenticated ? [this.frame("task.report", { ...body })] : [];
  }

  sendTaskControl(body: TaskControlEventBody): string[] {
    return this.authenticated ? [this.frame("event", { ...body })] : [];
  }
  requestTask(body: TaskRequestBody): string[] {
    const { requestId, title, text, requirements, directive, requestedBy, label } = body;
    return this.authenticated
      ? [this.frame("task.request", { requestId, title, text, requirements: { ...requirements }, directive, requestedBy,
        ...(label ? { label } : {}) })] : [];
  }

  // Issue #706: metadata only. A skipped body is unchecked, so only a UUID requestId and an integer expiresAt are used.
  private logResolve(outcome: string, body: unknown): void {
    const { requestId, expiresAt } = body as { requestId?: unknown; expiresAt?: unknown };
    const margin = Number.isSafeInteger(expiresAt) ? Number(expiresAt) - (this.options.now?.() ?? Date.now()) : "unknown";
    this.options.log?.(`kherep-node: message.resolve ${outcome} requestId=${isMessageId(requestId) ? requestId : "invalid"} margin_ms=${margin}`);
  }

  // A failing local write is logged; the frame loop goes on.
  private callback(what: string, run: () => void): boolean {
    try {
      run();
      return true;
    } catch (error) {
      this.options.log?.(`kherep-node: could not record ${what}: ${String((error as Error).message ?? error)}`);
      return false;
    }
  }

  // Refused unless the local policy accepts this sender for this session.
  // A message that cannot be stored gets no answer, so the Worker keeps it
  // queued for the next same-socket retry or authentication.
  private onDeliver(body: MessageDeliverBody): string[] {
    const { messageId } = body;
    if (body.binding && (!this.storageReady || !this.options.selectedReferences?.validate(messageId, body.binding, JSON.stringify(this.policy)))) {
      // Lease loss is a deferred receipt: keep durable queued work for a fresh lease.
      return [];
    }
    let local: { sessionId: string; name?: string }[] = [];
    try {
      local = this.options.localSessions?.() ?? [];
    } catch {
      // unreadable listing: only the addressed reference itself matches
    }
    if (!acceptsMessage(this.policy, body.toSession, body.from.nodeId, body.binding ? local.filter(s => s.sessionId === body.toSession) : local)) {
      return [this.frame("message.status", { messageId, state: "refused", reason: "not accepted by node policy" })];
    }
    try {
      this.options.storeMessage(body);
    } catch (error) {
      if (error instanceof RecordLockBusy) return []; // Another writer defers this receipt without faulting storage.
      this.options.bindingStorageFault?.();
      this.options.selectedReferences?.clear();
      this.setStorageReady(false);
      this.options.log?.(`kherep-node: could not store message ${messageId}: ${String((error as Error).message ?? error)}`);
      return [];
    }
    return [this.frame("message.status", { messageId, state: "accepted" })];
  }

  private authBody(challenge: ChallengeBody): Record<string, unknown> {
    const now = this.options.now?.() ?? Date.now();
    return { ...signChallenge(this.options.identity, this.options.nodeId, challenge.nonce, now) };
  }

  private async onCommand(envelope: Envelope): Promise<string[]> {
    if (!isCommandBody(envelope.body)) return [];
    const { commandId, command, args } = envelope.body;
    // At-least-once delivery: a resent command that was already processed is
    // only acknowledged again, never executed twice.
    if (envelope.seq <= this.processedSeq) return [this.frame("command.ack", { commandId })];
    // Issue #441: processed once the frames that answer it exist. Every frame
    // carries processedSeq as its ack, and a status sent on the intake lane
    // while the handler runs must not let the Worker drop its resend copy.
    // The daemon's frame lane runs one command at a time, so a resend waits
    // behind the handler and then takes the duplicate branch above.
    const ack = (): string => {
      this.processedSeq = Math.max(this.processedSeq, envelope.seq);
      return this.frame("command.ack", { commandId });
    };
    if (!isAllowed(this.policy, command)) return [ack(), this.failedResult(commandId, command, args, "rejected by local policy")];
    const handler = this.options.handlers[command] as ((args?: unknown) => Promise<unknown>) | undefined;
    if (!isCommandArgs(command, args) || !handler) {
      return [ack(), this.failedResult(commandId, command, args, handler ? "invalid command arguments" : "command not supported")];
    }
    // Issue #441: the ack's seq is allocated after the handler, next to its
    // result. A delivery answered on the intake lane meanwhile carries a lower
    // seq, so the Worker never drops this ack as a duplicate.
    try {
      const result = await handler(args);
      return [ack(), this.frame("command.result", { commandId, ok: true, result })];
    } catch (error) {
      return [ack(), this.failedResult(commandId, command, args, String((error as Error).message ?? error).slice(0, 1024))];
    }
  }

  // Issue #240: every failed command result is logged with its task id and
  // the error, one line of at most 256 characters; command args never are.
  private failedResult(commandId: string, command: string, args: unknown, error: string): string {
    const taskId = (args as { taskId?: unknown } | undefined)?.taskId;
    const line = error.replace(/\s+/g, " ").trim().slice(0, 256);
    this.options.log?.(`kherep-node: command ${JSON.stringify(String(command).slice(0, 64))} ${commandId}${isTaskId(taskId) ? ` for task ${taskId}` : ""} failed: ${line}`);
    return this.frame("command.result", { commandId, ok: false, error });
  }

  private frame(type: MessageType, body: Record<string, unknown>, sequenced = true): string {
    return JSON.stringify(makeEnvelope(type, body, sequenced ? ++this.built : 0, this.processedSeq));
  }

  // Issue #441: the seq a built frame carries is provisional. The daemon stamps
  // the wire seq and the current cumulative ack at its single send step, so
  // frames from any lane reach the Worker in strictly increasing order whatever
  // promise hops lie between building and sending. Unsequenced frames (seq 0)
  // keep seq 0 and get the current ack. An unparseable frame is sent as is.
  stamp(frame: string): string {
    let envelope: { seq?: unknown; ack?: unknown } & Record<string, unknown>;
    try { envelope = JSON.parse(frame); } catch { return frame; }
    if (typeof envelope?.seq !== "number") return frame;
    if (envelope.seq > 0) envelope.seq = ++this.sent;
    envelope.ack = this.processedSeq;
    return JSON.stringify(envelope);
  }

  private readyRuntimes(): readonly TaskRuntime[] {
    return this.options.readyRuntimes?.() ?? [];
  }

  private registrationFrame(): string {
    const ready = this.readyRuntimes();
    this.advertisedReady = JSON.stringify(ready);
    return this.frame("register", {
      facts: this.options.facts(), runtimes: this.lastRuntimes, capabilities: [...advertisedCapabilities(this.policy, ready),
        ...(this.storageReady && this.options.selectedReferences ? [SELECTED_BINDING_CAPABILITY] : [])],
    });
  }

  private pendingRegistrationFrames(): string[] {
    if (!this.authenticated || !this.registrationDirty) return [];
    if (!this.registrationFrames) {
      this.registrationFrames = [this.registrationFrame()];
      if (this.credentialRotationPending) {
        this.credentialRequestPending = crypto.randomUUID();
        this.registrationFrames.push(this.frame("mcp.credential.rotate", { requestId: this.credentialRequestPending }));
      }
    }
    return [...this.registrationFrames];
  }
}
