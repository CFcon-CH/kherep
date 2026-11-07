import fs from "node:fs";
import {
  BINDING_PENDING_LIMIT, BINDING_TTL_MS, isResolveRequest, type BoundOwner, type DeliveryBinding,
  type MessageSelection, type ResolveRequest, type ResolveResponse, type SelectedResult,
} from "../protocol-message-binding.mts";
import { isSessionRef } from "../protocol-messages.mts";
import type { NodePaths } from "./config.mts";
import { livenessFile, readLivenessSnapshot } from "./session-lifecycle.mts";

interface LocalRow { sessionId: string; runtime?: string; name?: string; state?: string }
type Selection = { results: SelectedResult[]; stamps: string[] };
// The Worker's clock stamps expiresAt, so a node clock behind it sees more than the TTL left.
const CLOCK_ALLOWANCE_MS = 30_000;
function readPopulation(paths: NodePaths): { rows: LocalRow[]; generation: number | null } | "MISSING" | "INVALID" | "UNREADABLE" {
  try {
    const stat = fs.lstatSync(paths.sessions);
    if (!stat.isFile() || stat.size > 512 * 1024) return "INVALID";
    let value: { sessions?: unknown; generation?: unknown; unseen?: unknown };
    try { value = JSON.parse(fs.readFileSync(paths.sessions, "utf8")); } catch (e) { return e instanceof SyntaxError ? "INVALID" : "UNREADABLE"; }
    if (!value || typeof value !== "object" || !Array.isArray(value.sessions) || value.sessions.length > 1024
      || value.generation !== undefined && (!Number.isSafeInteger(value.generation) || Number(value.generation) < 0)
      || value.unseen !== undefined && (!Array.isArray(value.unseen) || value.unseen.length !== 0)) return "INVALID";
    const rows = value.sessions as LocalRow[];
    if (!rows.every(r => r && typeof r === "object" && isSessionRef(r.sessionId)
      && (r.runtime === undefined || isSessionRef(r.runtime)) && (r.name === undefined || isSessionRef(r.name)))
      || new Set(rows.map(r => r.sessionId)).size !== rows.length) return "INVALID";
    return { rows, generation: typeof value.generation === "number" ? value.generation : null };
  } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "MISSING" : "UNREADABLE"; }
}
// Selected projections only. No listing, native API, profile or process probe.
export function readSelectedLocalReferences(paths: NodePaths, selections: MessageSelection[]): Selection {
  const population = readPopulation(paths);
  let lifecyclePresent = false, lifecycleUnreadable = false;
  try {
    const stat = fs.lstatSync(livenessFile(paths)); lifecyclePresent = true;
    if (!stat.isFile() || stat.size > 512 * 1024) lifecycleUnreadable = true;
    else fs.readFileSync(livenessFile(paths), "utf8");
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") lifecycleUnreadable = true; }
  const lifecycle = readLivenessSnapshot(paths);
  const brokenLifecycle = lifecycleUnreadable || !lifecycle && lifecyclePresent || lifecycle?.capped;
  const stamps: string[] = [];
  const results = selections.map((s): SelectedResult => {
    if (typeof population === "string" || brokenLifecycle) {
      stamps.push(""); return { role: s.role, code: typeof population === "string" ? population : "INVALID" };
    }
    const exact = population.rows.filter(r => r.sessionId === s.ref);
    const matches = exact.length ? exact : population.rows.filter(r => r.name === s.ref);
    if (matches.length !== 1) { stamps.push(""); return { role: s.role, code: matches.length ? "AMBIGUOUS" : "MISSING" }; }
    const row = matches[0], owner = { sessionId: row.sessionId, runtime: row.runtime ?? null };
    if (s.expected && (s.expected.sessionId !== owner.sessionId || s.expected.runtime !== owner.runtime)) {
      stamps.push(""); return { role: s.role, code: "CONFLICT" };
    }
    const v = lifecycle?.sessions.find(v => v.sessionId === owner.sessionId && v.runtime === owner.runtime);
    const tomb = lifecycle?.tombstones.find(v => v.sessionId === owner.sessionId && v.runtime === owner.runtime);
    const lifecycleGeneration = v?.lifecycleGeneration ?? tomb?.generation ?? null;
    const localGeneration = population.generation;
    stamps.push(JSON.stringify([s, owner, row.name ?? null, row.state ?? null, localGeneration, lifecycleGeneration]));
    return { role: s.role, code: "BOUND", match: exact.length ? "exact" : "alias", owner,
      selectionStamp: crypto.randomUUID(), localGeneration, lifecycleGeneration, leaseId: crypto.randomUUID() };
  });
  return { results, stamps };
}
interface Lease { messageId: string; selection: MessageSelection; stamp: string; owner: BoundOwner; expiresAt: number; policy: string; localGeneration: number | null }
export class MessageReferenceResolver {
  private readonly leases = new Map<string, Lease>();
  constructor(privatePaths: NodePaths, now: () => number = Date.now) { this.paths = privatePaths; this.now = now; }
  private readonly paths: NodePaths;
  private readonly now: () => number;
  clear(): void { this.leases.clear(); }
  resolve(request: ResolveRequest, policy: string): ResolveResponse {
    const now = this.now();
    for (const [id, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(id);
    const fail = (): ResolveResponse => ({ version: 1, requestId: request.requestId, messageId: request.messageId,
      results: request.selections.map(s => ({ role: s.role, code: "STALE" })) });
    if (!isResolveRequest(request) || request.expiresAt <= now || request.expiresAt > now + BINDING_TTL_MS + CLOCK_ALLOWANCE_MS
      || this.leases.size + request.selections.length > BINDING_PENDING_LIMIT) return fail();
    const selected = readSelectedLocalReferences(this.paths, request.selections);
    selected.results.forEach((r, i) => {
      if (r.code !== "BOUND") return;
      // Source-only leases are never usable to accept a destination frame.
      if (r.role === "to") this.leases.set(r.leaseId, { messageId: request.messageId, selection: request.selections[i],
        stamp: selected.stamps[i], owner: { ...r.owner, lifecycleGeneration: r.lifecycleGeneration }, localGeneration: r.localGeneration,
        expiresAt: request.expiresAt, policy });
    });
    return { version: 1, requestId: request.requestId, messageId: request.messageId, results: selected.results };
  }
  validate(messageId: string, binding: DeliveryBinding, policy: string): boolean {
    const lease = this.leases.get(binding.leaseId);
    this.leases.delete(binding.leaseId);
    if (!lease || lease.messageId !== messageId || lease.expiresAt <= this.now() || lease.policy !== policy
      || binding.localGeneration !== lease.localGeneration || JSON.stringify(lease.owner) !== JSON.stringify(binding.to)) return false;
    const current = readSelectedLocalReferences(this.paths, [lease.selection]);
    return current.results[0]?.code === "BOUND" && current.stamps[0] === lease.stamp;
  }
}
