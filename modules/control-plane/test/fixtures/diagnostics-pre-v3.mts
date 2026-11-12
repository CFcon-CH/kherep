// Archived real validator: kherep@4bfe1c268fbb9385ccebe77dc37bc1632b44fbc2, modules/control-plane/protocol-diagnostics.mts (the deployed
// Worker at 22dbfa55 carries the same list). What a peer without messaging.diagnostics.v3 accepts: a node drops a whole message.status
// frame it rejects, a Worker answers "invalid message.status body" and keeps nothing of it.
const DIAGNOSTIC_STAGES = ["target-progress", "upstream-egress", "send-admission", "duplicate", "mcp-claim"] as const;
export const BLOCKER_CODES = ["task-concurrency", "task-starts-daily", "runtime-pending", "turn-spacing", "budget-lock-unavailable",
  "hint-capture-failed", "hint-invalidated", "hint-lock-busy", "hint-storage-failed", "target-not-idle", "task-active", "process-still-running",
  "node-offline", "registration-pending", "binding-capability-missing", "stored-binding-missing", "resolution-unavailable", "resolution-timeout",
  "resolution-capacity", "identity-changed", "acceptance-unconfirmed",
  "resolution-missing", "resolution-ambiguous", "resolution-stale", "resolution-invalid", "resolution-unreadable", "resolution-clock"] as const;
const IDENTITY_DIMENSIONS = ["owner", "reference-match", "runtime", "lifecycle", "proof-kind", "eligibility", "capability", "connection", "lineage", "selected-proof"] as const;
const OBSERVED_STATES = ["running", "reachable-probable", "idle-loaded", "closed", "archived", "deleted", "unknown"] as const;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export function isMessageDiagnostic(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = ["version", "kind", "stage", "observedAt", "observedState", ...(v.kind === "blocker" ? ["code"] : ["dimensions"])];
  if (!Object.keys(v).every(k => keys.includes(k)) || v.version !== 1 || !(DIAGNOSTIC_STAGES as readonly unknown[]).includes(v.stage)
    || typeof v.observedAt !== "string" || !Number.isFinite(Date.parse(v.observedAt)) || new Date(v.observedAt).toISOString() !== v.observedAt
    || v.observedState !== undefined && !(OBSERVED_STATES as readonly unknown[]).includes(v.observedState)) return false;
  if (v.kind === "blocker") return (BLOCKER_CODES as readonly unknown[]).includes(v.code);
  return v.kind === "identity-change" && Array.isArray(v.dimensions) && v.dimensions.length > 0 && v.dimensions.length <= IDENTITY_DIMENSIONS.length
    && v.dimensions.every((d, i, all) => (IDENTITY_DIMENSIONS as readonly unknown[]).includes(d) && (i === 0 || compare(all[i - 1] as string, d as string) < 0));
}
