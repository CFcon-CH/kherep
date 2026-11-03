import { isSessionList, type SessionInfo } from "../../protocol.mts";
import type { MessageAddress } from "../../protocol-messages.mts";
import { currentIdentity, isCanonicalIdentity, isIdentitySnapshot, type CanonicalIdentityV1, type IdentitySnapshotV1 } from "../../protocol-session-identity.mts";
type Row = Record<string, SqlStorageValue>;
export type CanonicalReference = { address: MessageAddress; match: "exact" | "alias"; runtime: string; unknown: boolean; generation: number | null;
  proof: CanonicalIdentityV1 | null; eligible: boolean; code: "ATTESTED" | "LEGACY_KNOWN" | "UNPROVEN" | "TERMINAL" | "RUNTIME_MISMATCH" | "INVALID_PROOF" }
  | { address: null; eligible: false; code: "MISSING" | "AMBIGUOUS" };
export class RegistrySessionIdentity {
  constructor(sql: SqlStorage) { this.sql = sql; sql.exec("CREATE INDEX IF NOT EXISTS sessions_loop_name ON sessions(node_id, name)"); }
  private readonly sql: SqlStorage;
  // Validate before dedup or any mutation. Exact serialized content is the replay
  // digest: collision-free equality, with no dependency on an asynchronous signer.
  accept(nodeId: string, rows: SessionInfo[], header?: IdentitySnapshotV1): boolean {
    if (!isSessionList(rows)) throw new Error("identity-population-invalid");
    if (new Set(rows.map(r => r.sessionId)).size !== rows.length) throw new Error("identity-duplicate");
    if (header !== undefined && !isIdentitySnapshot(header)) throw new Error("identity-snapshot-invalid");
    for (const row of rows) if (row.canonicalIdentity !== undefined && (!header || !isCanonicalIdentity(row.canonicalIdentity)
      || row.canonicalIdentity.sessionId !== row.sessionId || row.canonicalIdentity.runtime !== row.runtime)) throw new Error("identity-proof-invalid");
    if (!header) return true; // Legacy snapshot clears receipts, keeps watermark.
    const digest = JSON.stringify([...rows].sort((a,b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
      .map(r => [r.sessionId, r.runtime, r.state, r.startedAt ?? null, r.name ?? null, r.cwd ?? null, r.kind ?? null, r.label ?? null, r.title ?? null,
        r.canonicalIdentity ? [r.canonicalIdentity.version, r.canonicalIdentity.source, r.canonicalIdentity.runtime, r.canonicalIdentity.sessionId,
          r.canonicalIdentity.observedAt, r.canonicalIdentity.lifecycleGeneration] : null]));
    const n = this.sql.exec("SELECT identity_generation, identity_digest FROM nodes WHERE id = ? AND revoked_at IS NULL", nodeId).toArray()[0];
    if (!n) throw new Error("identity-node-invalid");
    if (n.identity_generation !== null && header.generation < Number(n.identity_generation)) throw new Error("identity-generation-rollback");
    if (header.generation === n.identity_generation) {
      if (digest !== n.identity_digest) throw new Error("identity-generation-conflict");
      return false;
    }
    this.sql.exec("UPDATE nodes SET identity_generation = ?, identity_digest = ? WHERE id = ?", header.generation, digest, nodeId);
    return true;
  }
  resolveCanonicalReference(endpoint: MessageAddress, now: number): CanonicalReference {
    const columns = "session_id, runtime, state, canonical_identity";
    const exact = this.sql.exec(`SELECT ${columns} FROM sessions WHERE node_id = ? AND session_id = ? LIMIT 2`, endpoint.nodeId, endpoint.session).toArray();
    const rows = exact.length ? exact : this.sql.exec(`SELECT ${columns} FROM sessions WHERE node_id = ? AND name = ? LIMIT 2`, endpoint.nodeId, endpoint.session).toArray();
    if (rows.length !== 1) return { address: null, eligible: false, code: rows.length ? "AMBIGUOUS" : "MISSING" };
    return { ...this.classify(endpoint.nodeId, rows[0], now), match: exact.length ? "exact" : "alias" } as CanonicalReference;
  }
  private classify(nodeId: string, row: Row, now: number): CanonicalReference {
    const base = { match: "exact" as const, address: { nodeId, session: String(row.session_id) }, runtime: String(row.runtime), unknown: row.state === "unknown", generation: null, proof: null };
    if (["closed", "archived", "deleted"].includes(String(row.state))) return { ...base, eligible: false, code: "TERMINAL" };
    if (row.canonical_identity === null) return { ...base, eligible: !base.unknown, code: base.unknown ? "UNPROVEN" : "LEGACY_KNOWN" };
    let proof: unknown;
    try { proof = JSON.parse(String(row.canonical_identity)); } catch { return { ...base, eligible: false, code: "INVALID_PROOF" }; }
    if (!currentIdentity(proof, { sessionId: base.address.session, runtime: base.runtime }, now)) return { ...base, eligible: false, code: "INVALID_PROOF" };
    const n = this.sql.exec("SELECT identity_generation FROM nodes WHERE id = ? AND revoked_at IS NULL", nodeId).toArray()[0];
    const runtime = proof.runtime === "claude-code" ? "claude" : "codex";
    const registered = this.sql.exec("SELECT kind FROM runtimes WHERE node_id = ? AND name = ?", nodeId, runtime).toArray()[0];
    if (!n || n.identity_generation === null || registered?.kind !== "cli") return { ...base, eligible: false, code: "RUNTIME_MISMATCH" };
    return { ...base, proof, generation: Number(n.identity_generation), eligible: true, code: "ATTESTED" };
  }
}
