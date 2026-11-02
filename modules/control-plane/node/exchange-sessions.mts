import { commitAuthority, faultAuthority, observationBelongs, revokeAuthority, type AdmissionAuthority } from "./session-authority.mts";
import { listingObservation } from "./liveness-pass.mts";
import { closedReference, publishLiveness, readLivenessSnapshot, sessionVerdict, terminalReference } from "./session-lifecycle.mts";
import { directoryVisibility, observationReason, targetKey } from "./session-liveness.mts";
import type { SessionEvidence } from "./session-liveness.mts";
import type { SessionInfo } from "../protocol.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { readJson, refuseUndeliverable, UNDELIVERABLE_AFTER_MS, writeJsonAtomic, type InboxRecord } from "./inbox.mts";
import { markUnseen, rememberSessions, unlistedRuntimes } from "./known-sessions.mts";

// sessions.json, the node's sessions from the last successful listing, and the
// listing wrapper that records it (moved here from exchange.mts, issue #487).

export interface LocalSession { sessionId: string; name?: string; runtime?: string; state?: string }

export function writeLocalSessions(paths: NodePaths, sessions: SessionInfo[], now: number = Date.now(), generation = readLivenessSnapshot(paths)?.generation): void {
  ensureDir(paths.dir);
  const local: LocalSession[] = sessions.map((s) => ({ sessionId: s.sessionId, ...(s.name ? { name: s.name } : {}),
    runtime: s.runtime, state: s.state }));
  writeJsonAtomic(paths.sessions, { generation, sessions: local, unseen: [...unlistedRuntimes(sessions)], updatedAt: new Date(now).toISOString() });
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
export function addLocalSession(paths: NodePaths, session: LocalSession): void {
  const value = readJson<{ sessions?: unknown; updatedAt?: string }>(paths.sessions);
  const sessions = readLocalSessions(paths).filter((s) => s.sessionId !== session.sessionId || s.runtime !== session.runtime);
  const verdict = session.runtime ? sessionVerdict(paths, { runtime: session.runtime, sessionId: session.sessionId }, Date.now()) : undefined;
  const added = verdict && !directoryVisibility(verdict) ? [] : [{ ...session, state: verdict?.state ?? "unknown" }];
  writeJsonAtomic(paths.sessions, { ...value, generation: readLivenessSnapshot(paths)?.generation, sessions: [...sessions, ...added] });
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
export function recordingSessions(paths: NodePaths, list: (signal?: AbortSignal) => Promise<SessionInfo[]>, log: (line: string) => void,
  now: () => number = Date.now, undeliverableAfterMs: number = UNDELIVERABLE_AFTER_MS,
  records?: () => InboxRecord[], authority?: AdmissionAuthority): (signal?: AbortSignal) => Promise<SessionInfo[]> {
  return async (signal) => {
    revokeAuthority(authority);
    const listed = await list(signal);
    signal?.throwIfAborted();
    const observedAt = now();
    const observation = listingObservation(listed);
    const prior = readLocalSessions(paths);
    const previousSnapshot = readLivenessSnapshot(paths);
    // Unsupported/partial metadata cannot remove a previously addressable row.
    const rows: SessionInfo[] = [...listed];
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
      return directoryVisibility(verdict) && !omittedClosed ? [{ ...s, state: verdict.state }] : [];
    });
    // Keep the original completeness markers on the normalized population.
    markUnseen(sessions, snapshot.capped ? [...new Set([...unlistedRuntimes(listed), "*"])] : unlistedRuntimes(listed));
      writeLocalSessions(paths, sessions, observedAt, snapshot.generation);
      signal?.throwIfAborted();
      commitAuthority(authority, paths, observation, snapshot, observedAt);
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
