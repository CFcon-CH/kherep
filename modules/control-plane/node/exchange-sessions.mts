import { CODEX_ACTIVITY_EVIDENCE_MS, CODEX_ACTIVITY_INGRESS_MS, isCodexActivityStamp, type CodexActivityStamp } from "../protocol-mcp.mts";
import fs from "node:fs";
import { listenerDir } from "./autonomy.mts";
import { labelsFile, policyStamp, readBindingView, recordLocalLabels } from "./session-labels.mts";
import { attachIdentitySnapshot, uniqueSourceRows } from "./session-identity.mts";
import { currentIdentity } from "../protocol-session-identity.mts";
import { commitAuthority, faultAuthority, observationBelongs, revokeAuthority, type AdmissionAuthority } from "./session-authority.mts";
import { listingObservation } from "./liveness-pass.mts";
import { closedReference, publishLiveness, readLivenessSnapshot, sessionVerdict, terminalReference } from "./session-lifecycle.mts";
import { DISPLAY_TTL_MS, directoryVisibility, observationReason, targetKey } from "./session-liveness.mts";
import type { Observation, SessionEvidence } from "./session-liveness.mts";
import type { SessionInfo } from "../protocol.mts";
import { ensureDir, readConfig, type NodePaths } from "./config.mts";
import { listInbox, readJson, refuseUndeliverable, UNDELIVERABLE_AFTER_MS, writeJsonAtomic, type InboxRecord } from "./inbox.mts";
import { knownSessionsFile, markUnseen, rememberSessions, unlistedRuntimes, type KnownSession } from "./known-sessions.mts";
import { readPolicy } from "./policy.mts";
import { snapshotObject } from "./wake-snapshot.mts";

// sessions.json, the node's sessions from the last successful listing, and the
// listing wrapper that records it (moved here from exchange.mts, issue #487).

export interface LocalSession { sessionId: string; name?: string; runtime?: string; state?: string }

export function writeLocalSessions(paths: NodePaths, sessions: SessionInfo[], now: number = Date.now(), generation = readLivenessSnapshot(paths)?.generation): void {
  ensureDir(paths.dir);
  const local: LocalSession[] = sessions.map((s) => ({ sessionId: s.sessionId, ...(s.name ? { name: s.name } : {}),
    runtime: s.runtime, state: s.state }));
  let witness:unknown;
  try { witness=readJson<{labelBindingEpoch?:unknown}>(paths.sessions)?.labelBindingEpoch; }
  catch { witness="history-unavailable"; }
  writeJsonAtomic(paths.sessions, { ...(witness === undefined ? {} : {labelBindingEpoch:witness}), generation, sessions: local, unseen: [...unlistedRuntimes(sessions)], updatedAt: new Date(now).toISOString() });
}

export function readLocalSessions(paths: NodePaths, now: number = Date.now()): LocalSession[] {
  const value = readJson<{ sessions?: unknown; generation?: unknown }>(paths.sessions);
  const snapshot = readLivenessSnapshot(paths);
  if (!Array.isArray(value?.sessions)) return [];
  return (value.sessions as LocalSession[]).map(s => ({ ...s, state: snapshot && snapshot.generation === value.generation
    ? sessionVerdict(paths, { runtime: s.runtime ?? "unknown", sessionId: s.sessionId }, now).state : "unknown" }));
}

// Adds a session this node just resumed (issue #102), so the delivery hook of
// its first turn finds it by name before the next listing replaces the file.
// The row has no runtime on purpose: a row with one survives the next listing
// (recordingSessions carries prior runtime rows), a provisional row must not.
export function addLocalSession(paths: NodePaths, session: { sessionId: string; name?: string }): void {
  const value = readJson<{ sessions?: unknown }>(paths.sessions);
  const sessions = (Array.isArray(value?.sessions) ? value.sessions : [])
    .filter((s): s is LocalSession => snapshotObject(s) && typeof s.sessionId === "string")
    .filter((s) => s.sessionId !== session.sessionId || s.runtime !== undefined);
  writeJsonAtomic(paths.sessions, { ...value, generation: readLivenessSnapshot(paths)?.generation, sessions: [...sessions, { ...session, state: "unknown" }] });
}

// The name sessions.json records for a local session id, if any.
export function localSessionName(paths: NodePaths, sessionId: string): string | undefined {
  return readLocalSessions(paths).find((s) => s.sessionId === sessionId)?.name;
}

const CARRY_LIMIT = 128;
const carryFaults = new Map<string, string>();

// The ids and names wake.sessions states literally. "*" names no session, and a node's list may contain it.
// readPolicy drops a wake section it cannot parse, so that case is told apart from an explicit enabled: false here.
function wakeLiterals(paths: NodePaths): string[] {
  const file = readConfig(paths.config)?.policyFile ?? paths.policy;
  const policy = readPolicy(file);
  if (!policy) throw new Error("the policy file is unreadable or malformed");
  if (policy.wake) return policy.wake.sessions.filter(s => s !== "*");
  const section = readJson<{ wake?: { enabled?: unknown } | null }>(file)?.wake;
  if (section !== undefined && section?.enabled !== false) throw new Error("the policy's wake section is malformed");
  return [];
}
// Sessions something on this node still points at: a listener file, an inbox record, a wake-name binding, the wake list.
// Local files only, and every failed read throws, so that the caller carries all rows instead of dropping one.
function protectedRefs(paths: NodePaths, records?: () => InboxRecord[]): Set<string> {
  const refs = new Set<string>();
  try { for (const file of fs.readdirSync(listenerDir(paths))) refs.add(file.split(".")[0]); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const record of records?.() ?? listInbox(paths.inbox)) refs.add(record.toSession);
  const view = readBindingView(paths);
  for (const binding of view.bindings) refs.add(binding.sessionId);
  for (const ref of wakeLiterals(paths)) refs.add(ref);
  // No file and no witness is a node without bindings; any other unavailable view is lost history.
  if (view.status !== "healthy" && (fs.statSync(labelsFile(paths), { throwIfNoEntry: false }) || readJson<{ labelBindingEpoch?: unknown }>(paths.sessions)?.labelBindingEpoch !== undefined)) {
    throw new Error("session-labels.json is unavailable");
  }
  return refs;
}
// lastSeen moves only when a session is listed. The ledger's observedAt cannot rank these rows: judgeSession
// gives every unknown row the round's time, so all of them tie.
function lastSeenTimes(paths: NodePaths): Map<string, number> {
  const known = readJson<{ sessions?: unknown }>(knownSessionsFile(paths))?.sessions;
  if (!Array.isArray(known)) throw new Error("known-sessions.json is unavailable");
  return new Map((known as KnownSession[]).map(s => {
    const at = Date.parse(s.lastSeen);
    if (typeof s.sessionId !== "string" || typeof s.runtime !== "string" || Number.isNaN(at)) throw new Error("known-sessions.json has a malformed entry");
    return [targetKey(s), at];
  }));
}
// At most CARRY_LIMIT rows, or every protected row if those alone exceed it, in the order of the file.
function boundedCarry(paths: NodePaths, lacking: SessionInfo[], records: (() => InboxRecord[]) | undefined, log: (line: string) => void): SessionInfo[] {
  if (lacking.length <= CARRY_LIMIT) return lacking;
  try {
    const refs = protectedRefs(paths, records);
    const seen = lastSeenTimes(paths);
    const lastSeen = (s: SessionInfo): number => seen.get(targetKey(s)) ?? 0;
    const kept = new Set(lacking.filter(s => refs.has(s.sessionId) || s.name !== undefined && refs.has(s.name)));
    const newest = lacking.filter(s => !kept.has(s)).sort((a, b) => lastSeen(b) - lastSeen(a) || targetKey(a).localeCompare(targetKey(b)));
    for (const s of newest.slice(0, Math.max(0, CARRY_LIMIT - kept.size))) kept.add(s);
    carryFaults.delete(paths.dir);
    return lacking.filter(s => kept.has(s));
  } catch (error) {
    const fault = String(error);
    if (carryFaults.get(paths.dir) !== fault) log(`kherep-node: carry bound skipped, keeping all ${lacking.length} unlisted rows: ${fault}`);
    carryFaults.set(paths.dir, fault);
    return lacking;
  }
}
// Wraps the session listing so that every successful one is written to
// sessions.json; the delivery hook reads names from there instead of running
// claude on every prompt. The same successful listing refuses inbox messages
// whose session has ended (refuseUndeliverable); a failed one decides nothing.
// records: the daemon's inbox index (issue #589), one stat per record instead of a
// read; each refusal is still judged on the file it rewrites. Without it the files are read.
const discoveries = new Map<string, number>();
// Ordinary periodic wrappers use only this owner's confirmed connection map.
const codexActivities = new Map<string, CodexActivity>();
export interface SessionDiscovery { sequence:number; stamp:string|null }
export function beginSessionDiscovery(paths:NodePaths):SessionDiscovery {
  const sequence=(discoveries.get(paths.dir)??0)+1;
  discoveries.set(paths.dir,sequence);
  return {sequence,stamp:policyStamp(paths)};
}
export type RecordedSessions = ((signal?: AbortSignal, pending?: CodexActivityStamp) => Promise<SessionInfo[]>) & {
  raw(signal?: AbortSignal): Promise<SessionInfo[]>;
  begin(): SessionDiscovery;
  record(listed: SessionInfo[], discovery: SessionDiscovery, signal?: AbortSignal, pending?: CodexActivityStamp): Promise<SessionInfo[]>;
};
export function recordingSessions(paths: NodePaths, list: (signal?: AbortSignal) => Promise<SessionInfo[]>, log: (line: string) => void,
  now: () => number = Date.now, undeliverableAfterMs: number = UNDELIVERABLE_AFTER_MS,
  records?: () => InboxRecord[], authority?: AdmissionAuthority, discovery?:SessionDiscovery, codexActivity?: CodexActivity): RecordedSessions {
  if (codexActivity) codexActivities.set(paths.dir, codexActivity);
  const record = async (signal?: AbortSignal, pending?: CodexActivityStamp): Promise<SessionInfo[]> => {
    const {sequence,stamp}=discovery??beginSessionDiscovery(paths);
    revokeAuthority(authority);
    const listed = await list(signal);
    signal?.throwIfAborted();
    if(discoveries.get(paths.dir)!==sequence) throw new Error("superseded session listing");
    const observedAt = now();
    const observation = listingObservation(listed);
    const prior = readLocalSessions(paths);
    const previousSnapshot = readLivenessSnapshot(paths);
    // Unsupported/partial metadata cannot remove a previously addressable row.
    const rows: SessionInfo[] = uniqueSourceRows(listed);
    const supplied = observation?.status === "value" && observationReason(observation, observedAt) === null ? observation.value : [];
    const unseen = unlistedRuntimes(listed);
    // Carry prior identities into classification. Visibility is decided only
    // after the lifecycle ledger has accepted/rejected the supplied events.
    const listedRows = rows.length;
    for (const s of prior) if (s.runtime && !rows.some(r => targetKey(r) === targetKey({ runtime: s.runtime!, sessionId: s.sessionId }))) {
      rows.push({ ...s, runtime: s.runtime, state: "unknown" });
    }
    rows.push(...boundedCarry(paths, rows.splice(listedRows), records, log));
    const evidence: SessionEvidence[] = rows.flatMap(s => {
      const matches = supplied.filter(e => targetKey(e) === targetKey(s));
      return matches.length ? matches.map(e => ({ ...e })) : [{ runtime: s.runtime, sessionId: s.sessionId,
        app: { status: "unknown" as const, observedAt: listed.some(r => targetKey(r) === targetKey(s)) ? observation?.observedAt ?? observedAt
            : previousSnapshot?.sessions.find(v => targetKey(v) === targetKey(s))?.observedAt ?? observedAt, complete: false as const,
          source: "unsupported" as const, reasonCode: observation?.status === "unknown" ? observation.reasonCode : "unsupported" as const } }];
    });
    for (const e of supplied) if (!rows.some(v => targetKey(v) === targetKey(e))) evidence.push({ ...e });
    markUnseen(rows, unseen);
    mergeClaudeHooks(paths, rows, evidence, observedAt);
    mergeCodexHooks(paths, listed, evidence, observedAt, codexActivity ?? codexActivities.get(paths.dir), pending);
    let sessions: SessionInfo[];
    try {
    const trusted = observationBelongs(authority, observation);
    const safeEvidence = trusted ? evidence : evidence.map(({ lifecycle: _untrusted, ...e }) => e);
    const snapshot = publishLiveness(paths, safeEvidence, observedAt, listed);
    sessions = rows.filter(s => snapshot.sessions.some(v => targetKey(v) === targetKey(s)) || snapshot.tombstones.some(v => targetKey(v) === targetKey(s))).flatMap(s => {
      const verdict = sessionVerdict(paths, s, observedAt);
      const rawPresent = listed.some(r => targetKey(r) === targetKey(s));
      const completeRuntime = observation && observationReason(observation, observedAt) === null
        && !unseen.includes("*") && !unseen.includes(s.runtime);
      // Preserve the old complete-absence closed fallback eligibility, while
      // UNKNOWN and partial identities remain addressable. Terminal visibility
      // always follows the accepted ledger verdict, never raw lifecycle input.
      const omittedClosed = !rawPresent && completeRuntime && verdict.state === "closed";
      const events = supplied.filter(e => targetKey(e) === targetKey(s)).flatMap(e => e.lifecycle ? [e.lifecycle] : []);
      const lifecycleAccepted = events.every(e => trusted && e.status === "value" && e.source === "native-lifecycle"
        && observationReason(e, observedAt) === null && snapshot.tombstones.some(t => targetKey(t) === targetKey(s)
          && t.generation === e.value.generation && t.state === e.value.state));
      const { canonicalIdentity, ...display } = s;
      const proof = rawPresent && lifecycleAccepted && !unseen.includes("*") && !unseen.includes(s.runtime) && currentIdentity(canonicalIdentity, s, observedAt)
        && !["closed", "archived", "deleted"].includes(verdict.state)
        && !["identity", "malformed", "conflict", "capped", "failed", "aborted"].includes(verdict.reasonCode)
        && !snapshot.capped ? { ...canonicalIdentity, lifecycleGeneration: verdict.lifecycleGeneration ?? 0 } : undefined;
      return directoryVisibility(verdict) && !omittedClosed ? [{ ...display, state: verdict.state, ...(proof ? { canonicalIdentity: proof } : {}) }] : [];
    });
    // Keep the original completeness markers on the normalized population.
    markUnseen(sessions, snapshot.capped ? [...new Set([...unlistedRuntimes(listed), "*"])] : unlistedRuntimes(listed));
      const claudeListingComplete = !snapshot.capped && !unseen.includes("*") && !unseen.includes("claude-code");
      recordLocalLabels(paths, sessions, observedAt, claudeListingComplete, stamp, snapshot.generation, {snapshot,listed,evidence:safeEvidence});
      writeLocalSessions(paths, sessions, observedAt, snapshot.generation);
      signal?.throwIfAborted();
      commitAuthority(authority, paths, observation, snapshot, observedAt);
      attachIdentitySnapshot(sessions, snapshot.generation);
    } catch (error) {
      faultAuthority(authority);
      log("kherep-node: session publication failed; autonomous admission faulted for this daemon run");
      throw new Error("session publication failed");
    }
    try {
      rememberSessions(paths, listed, observedAt, unlistedRuntimes(listed));
    } catch (error) {
      log(`kherep-node: could not write known-sessions.json: ${String(error)}`);
    }
    try {
      const refused = refuseUndeliverable(paths.inbox, sessions, observedAt, undeliverableAfterMs, records?.(), ref => terminalReference(paths, ref, undefined, now()), ref => closedReference(paths, ref, now(), authority));
      if (refused.length > 0) log(`kherep-node: refused ${refused.length} message(s) for sessions that are not running`);
    } catch (error) {
      log(`kherep-node: could not check the inbox for ended sessions: ${String(error)}`);
    }
    return sessions;
  };
  return Object.assign(record, {
    raw: list,
    begin: () => beginSessionDiscovery(paths),
    record: (listed: SessionInfo[], token: SessionDiscovery, signal?: AbortSignal, pending?: CodexActivityStamp) =>
      recordingSessions(paths, async () => listed, log, now, undeliverableAfterMs, records, authority, token, codexActivity)(signal, pending),
  });
}


export interface ClaudeHookObservation { sessionId: string; observedAt: number }
const claudeHooks = new Map<string, Map<string, ClaudeHookObservation>>();
export function connectionClaudeHooks(paths: NodePaths): Map<string, ClaudeHookObservation> {
  const observations = new Map<string, ClaudeHookObservation>();
  claudeHooks.set(paths.dir, observations);
  return observations;
}
function mergeClaudeHooks(paths: NodePaths, listed: SessionInfo[], evidence: SessionEvidence[], now: number): void {
  const observations = claudeHooks.get(paths.dir);
  if (!observations) return;
  for (const [id, hook] of observations) {
    if (hook.observedAt > now || now - hook.observedAt > DISPLAY_TTL_MS) { observations.delete(id); continue; }
    if (unlistedRuntimes(listed).includes("*")) continue;
    const matches = listed.filter(r => r.sessionId === id);
    if (matches.length > 1 || matches.some(r => r.runtime !== "claude-code" || r.kind && !["interactive", "session", "fork"].includes(r.kind))) continue;
    const inputs = evidence.filter(e => e.sessionId === id);
    if (inputs.length > 1) continue;
    const e = inputs[0];
    if (e && (e.runtime !== "claude-code" || [e.app, e.holder, e.hook].some(o => o && ["identity", "conflict", "capped", "malformed"].includes(o.reasonCode)))) continue;
    if (e) e.hook = { status: "value", value: true, source: "hook", complete: true, reasonCode: "observed", observedAt: hook.observedAt };
    else evidence.push({ runtime: "claude-code", sessionId: id, hook: {
      status: "value", value: true, source: "hook", complete: true, reasonCode: "observed", observedAt: hook.observedAt } });
    if (!matches.length) listed.push({ runtime: "claude-code", sessionId: id, state: "unknown", kind: "interactive" });
  }
}


// One owner per daemon. First-seen entries are never evicted or renewed;
// active evidence belongs only to the current authenticated connection.
export class CodexActivity {
  private connectedAt = Infinity;
  private readonly seen = new Map<string, { stamp: CodexActivityStamp; binding: string; usable: boolean; staged: boolean }>();
  private readonly active = new Map<string, CodexActivityStamp>();
  private readonly latest = new Map<string, { observedAt: number; key: string }>();
  connect(now: number): void { this.disconnect();this.connectedAt = now; }
  disconnect(): void {
    this.connectedAt = Infinity;this.active.clear();
    for (const entry of this.seen.values()) entry.usable = false;
  }
  private key(stamp: CodexActivityStamp): string {
    return JSON.stringify([stamp.intent.sessionId, stamp.intent.assignment!.turnId, stamp.intent.callId]);
  }
  private prune(now: number): void {
    for (const [id, stamp] of this.active) if (stamp.observedAt + CODEX_ACTIVITY_EVIDENCE_MS <= now) this.active.delete(id);
  }
  reserve(stamp: CodexActivityStamp, now: number): boolean {
    this.prune(now);
    if (!isCodexActivityStamp(stamp) || stamp.observedAt <= this.connectedAt || stamp.observedAt > now
      || now >= stamp.observedAt + CODEX_ACTIVITY_INGRESS_MS) return false;
    const { sessionId } = stamp.intent;
    const key = this.key(stamp), binding = JSON.stringify(stamp), prior = this.seen.get(key);
    const latest = this.latest.get(sessionId);
    if (latest && latest.observedAt > stamp.observedAt) return false;
    if (prior) return prior.usable && prior.binding === binding && latest?.key === key;
    const pendingSessions = new Set([...this.seen.values()].filter(e => e.usable
      && e.stamp.observedAt + CODEX_ACTIVITY_EVIDENCE_MS > now).map(e => e.stamp.intent.sessionId));
    if (this.seen.size >= 4096 || !pendingSessions.has(sessionId) && pendingSessions.size >= 128) return false;
    this.seen.set(key, { stamp: structuredClone(stamp), binding, usable: true, staged: false });
    this.latest.set(sessionId, { observedAt: stamp.observedAt, key });
    return true;
  }
  stage(stamp: CodexActivityStamp, now: number): boolean {
    const entry = this.seen.get(this.key(stamp));
    if (!entry?.usable || entry.binding !== JSON.stringify(stamp) || stamp.observedAt <= this.connectedAt
      || stamp.observedAt > now || stamp.observedAt + CODEX_ACTIVITY_INGRESS_MS <= now
      || this.latest.get(stamp.intent.sessionId)?.key !== this.key(stamp)) return false;
    entry.staged = true;return true;
  }
  hasRequest(requestId: string): boolean {
    return [...this.seen.values()].some(entry => entry.stamp.intent.requestId === requestId);
  }
  reject(requestId: string): void {
    for (const entry of this.seen.values()) if (entry.stamp.intent.requestId === requestId) entry.usable = false;
    for (const [id, stamp] of this.active) if (stamp.intent.requestId === requestId) this.active.delete(id);
  }
  confirm(stamp: CodexActivityStamp, now: number): boolean {
    const entry = this.seen.get(this.key(stamp));
    if (!entry?.usable || !entry.staged || entry.binding !== JSON.stringify(stamp) || stamp.observedAt <= this.connectedAt
      || stamp.observedAt > now || stamp.observedAt + CODEX_ACTIVITY_EVIDENCE_MS <= now
      || this.latest.get(stamp.intent.sessionId)?.key !== this.key(stamp)) return false;
    this.prune(now);this.active.set(stamp.intent.sessionId, entry.stamp);return true;
  }
  observations(now: number, pending?: CodexActivityStamp): CodexActivityStamp[] {
    this.prune(now);
    const stamps = new Map(this.active);
    if (pending) {
      const entry = this.seen.get(this.key(pending));
      if (!entry?.usable || !entry.staged || entry.binding !== JSON.stringify(pending) || pending.observedAt <= this.connectedAt
        || pending.observedAt > now || pending.observedAt + CODEX_ACTIVITY_INGRESS_MS <= now
        || this.latest.get(pending.intent.sessionId)?.key !== this.key(pending)) throw new Error("Codex activity unavailable");
      stamps.set(pending.intent.sessionId, pending);
    }
    return [...stamps.values()];
  }
}
function mergeCodexHooks(paths: NodePaths, listed: SessionInfo[], evidence: SessionEvidence[], now: number,
  owner?: CodexActivity, pending?: CodexActivityStamp): void {
  if (!owner) { if (pending) throw new Error("Codex activity unavailable");return; }
  const unseen = unlistedRuntimes(listed);
  for (const stamp of owner.observations(now, pending)) {
    const id = stamp.intent.sessionId;
    const matches = listed.filter(row => row.sessionId === id);
    const inputs = evidence.filter(e => e.sessionId === id);
    const eligible = listed.length <= 512 && !unseen.includes("*") && !unseen.includes("codex")
      && matches.length === 1 && matches[0].runtime === "codex" && matches[0].kind === "codex"
      && !["closed", "archived", "deleted"].includes(matches[0].state)
      && !["closed", "archived", "deleted"].includes(sessionVerdict(paths, { runtime: "codex", sessionId: id }, now).state)
      && inputs.length === 1 && inputs[0].runtime === "codex"
      && !Object.values(inputs[0]).some(o => o === null || typeof o === "object"
        && ["identity", "conflict", "capped", "malformed", "failed", "aborted", "incomplete", "future"]
          .includes(String(observationReason(o as Observation<unknown>, now))));
    if (!eligible) { if (stamp === pending) throw new Error("Codex activity population unavailable");continue; }
    inputs[0].hook = { status: "value", value: true, source: "hook", complete: true, reasonCode: "observed", observedAt: stamp.observedAt };
  }
}
