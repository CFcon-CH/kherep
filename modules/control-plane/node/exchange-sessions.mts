import { policyStamp, recordLocalLabels } from "./session-labels.mts";
import { attachIdentitySnapshot, uniqueSourceRows } from "./session-identity.mts";
import { currentIdentity } from "../protocol-session-identity.mts";
import { commitAuthority, faultAuthority, observationBelongs, revokeAuthority, type AdmissionAuthority } from "./session-authority.mts";
import { listingObservation } from "./liveness-pass.mts";
import { closedReference, publishLiveness, readLivenessSnapshot, sessionVerdict, terminalReference } from "./session-lifecycle.mts";
import { directoryVisibility, observationReason, targetKey } from "./session-liveness.mts";
import type { SessionEvidence } from "./session-liveness.mts";
import type { SessionInfo } from "../protocol.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { readJson, refuseUndeliverable, UNDELIVERABLE_AFTER_MS, writeJsonAtomic, type InboxRecord } from "./inbox.mts";
import { markUnseen, rememberSessions, unlistedRuntimes } from "./known-sessions.mts";
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

// Wraps the session listing so that every successful one is written to
// sessions.json; the delivery hook reads names from there instead of running
// claude on every prompt. The same successful listing refuses inbox messages
// whose session has ended (refuseUndeliverable); a failed one decides nothing.
// records: the daemon's inbox index (issue #589), one stat per record instead of a
// read; each refusal is still judged on the file it rewrites. Without it the files are read.
const discoveries = new Map<string, number>();
export interface SessionDiscovery { sequence:number; stamp:string|null }
export function beginSessionDiscovery(paths:NodePaths):SessionDiscovery {
  const sequence=(discoveries.get(paths.dir)??0)+1;
  discoveries.set(paths.dir,sequence);
  return {sequence,stamp:policyStamp(paths)};
}
export function recordingSessions(paths: NodePaths, list: (signal?: AbortSignal) => Promise<SessionInfo[]>, log: (line: string) => void,
  now: () => number = Date.now, undeliverableAfterMs: number = UNDELIVERABLE_AFTER_MS,
  records?: () => InboxRecord[], authority?: AdmissionAuthority, discovery?:SessionDiscovery): (signal?: AbortSignal) => Promise<SessionInfo[]> {
  return async (signal) => {
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
    for (const s of prior) if (s.runtime && !rows.some(r => targetKey(r) === targetKey({ runtime: s.runtime!, sessionId: s.sessionId }))) {
      rows.push({ ...s, runtime: s.runtime, state: "unknown" });
    }
    const evidence: SessionEvidence[] = rows.flatMap(s => {
      const matches = supplied.filter(e => targetKey(e) === targetKey(s));
      return matches.length ? matches : [{ runtime: s.runtime, sessionId: s.sessionId,
        app: { status: "unknown" as const, observedAt: listed.some(r => targetKey(r) === targetKey(s)) ? observation?.observedAt ?? observedAt
            : previousSnapshot?.sessions.find(v => targetKey(v) === targetKey(s))?.observedAt ?? observedAt, complete: false as const,
          source: "unsupported" as const, reasonCode: observation?.status === "unknown" ? observation.reasonCode : "unsupported" as const } }];
    });
    for (const e of supplied) if (!rows.some(v => targetKey(v) === targetKey(e))) evidence.push(e);
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
}
