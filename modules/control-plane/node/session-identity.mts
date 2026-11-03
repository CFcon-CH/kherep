import type { SessionInfo } from "../protocol.mts";
import { currentIdentity, fullSessionId, type CanonicalIdentityV1, type IdentitySnapshotV1 } from "../protocol-session-identity.mts";
const snapshots = new WeakMap<SessionInfo[], IdentitySnapshotV1>();
export function identityFromClaudeListing(row: SessionInfo, now: number): CanonicalIdentityV1 | undefined {
  return row.runtime === "claude-code" && fullSessionId(row.sessionId) && Number.isFinite(now) && now >= 0
    ? { version: 1, source: "claude-list", runtime: "claude-code", sessionId: row.sessionId, observedAt: now, lifecycleGeneration: 0 } : undefined;
}
export function identityFromCodexRecord(record: { runtime?: unknown; sessionId?: unknown; lastSeen?: unknown }, filename: string, now: number): CanonicalIdentityV1 | undefined {
  if (record.runtime !== "codex" || !fullSessionId(record.sessionId) || filename !== `${record.sessionId}.json` || typeof record.lastSeen !== "string") return;
  const proof: CanonicalIdentityV1 = { version: 1, source: "codex-hook", runtime: "codex", sessionId: record.sessionId,
    observedAt: Date.parse(record.lastSeen), lifecycleGeneration: 0 };
  return currentIdentity(proof, { sessionId: record.sessionId, runtime: "codex" }, now) ? proof : undefined;
}
export function attachIdentitySnapshot(rows: SessionInfo[], generation: number): void {
  snapshots.set(rows, { version: 1, generation });
}
export const identitySnapshotOf = (rows: SessionInfo[]): IdentitySnapshotV1 | undefined => snapshots.get(rows);
export function uniqueSourceRows(rows: SessionInfo[]): SessionInfo[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.sessionId, (counts.get(row.sessionId) ?? 0) + 1);
  return rows.map(({ canonicalIdentity, ...row }) => counts.get(row.sessionId) === 1 && canonicalIdentity ? { ...row, canonicalIdentity } : row);
}
