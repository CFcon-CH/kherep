// Fixed metadata only. Never place operands, identifiers or proof values here.
export const MESSAGING_DIAGNOSTICS_CAPABILITY = "messaging.diagnostics.v1";
// Issue #706: a node that validates RESOLUTION_DETAIL_CODES advertises this next to v1. A v1 node drops a whole
// message.status frame with an unknown code, so the Worker hands it resolution-unavailable. The row keeps the code.
export const MESSAGING_DIAGNOSTICS_V2_CAPABILITY = "messaging.diagnostics.v2";
// Issue #883: a peer that validates target-not-loaded advertises this. Any other peer gets target-not-idle, the code it knew
// for the same wait: a previous node drops the whole frame and a previous Worker refuses the whole message.status.
export const MESSAGING_DIAGNOSTICS_V3_CAPABILITY = "messaging.diagnostics.v3";
export const DIAGNOSTIC_STAGES = ["target-progress", "upstream-egress", "send-admission", "duplicate", "mcp-claim"] as const;
const RESOLUTION_DETAIL_CODES = ["resolution-missing", "resolution-ambiguous", "resolution-stale", "resolution-invalid", "resolution-unreadable", "resolution-clock"] as const;
export const BLOCKER_CODES = ["task-concurrency", "task-starts-daily", "runtime-pending", "turn-spacing", "budget-lock-unavailable",
  "hint-capture-failed", "hint-invalidated", "hint-lock-busy", "hint-storage-failed", "target-not-idle", "task-active", "process-still-running",
  "node-offline", "registration-pending", "binding-capability-missing", "stored-binding-missing", "resolution-unavailable", "resolution-timeout",
  "resolution-capacity", "identity-changed", "acceptance-unconfirmed", ...RESOLUTION_DETAIL_CODES, "target-not-loaded"] as const;
export const IDENTITY_DIMENSIONS = ["owner", "reference-match", "runtime", "lifecycle", "proof-kind", "eligibility", "capability", "connection", "lineage", "selected-proof"] as const;
export type BlockerCode = typeof BLOCKER_CODES[number];
export type IdentityDimension = typeof IDENTITY_DIMENSIONS[number];
export type DiagnosticStage = typeof DIAGNOSTIC_STAGES[number];
export const OBSERVED_STATES = ["running", "reachable-probable", "idle-loaded", "closed", "archived", "deleted", "unknown"] as const;
type Common = { version: 1; stage: DiagnosticStage; observedAt: string; observedState?: typeof OBSERVED_STATES[number] };
export type MessageDiagnostic = Common & ({ kind: "blocker"; code: BlockerCode } | { kind: "identity-change"; dimensions: IdentityDimension[] });
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const sortedDimensions = (dimensions: readonly IdentityDimension[]): IdentityDimension[] => [...new Set(dimensions)].sort(compare);
export function isMessageDiagnostic(value: unknown): value is MessageDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = ["version", "kind", "stage", "observedAt", "observedState", ...(v.kind === "blocker" ? ["code"] : ["dimensions"])];
  if (!Object.keys(v).every(k => keys.includes(k)) || v.version !== 1 || !(DIAGNOSTIC_STAGES as readonly unknown[]).includes(v.stage)
    || typeof v.observedAt !== "string" || !Number.isFinite(Date.parse(v.observedAt)) || new Date(v.observedAt).toISOString() !== v.observedAt
    || v.observedState !== undefined && !(OBSERVED_STATES as readonly unknown[]).includes(v.observedState)) return false;
  if (v.kind === "blocker") return (BLOCKER_CODES as readonly unknown[]).includes(v.code);
  return v.kind === "identity-change" && Array.isArray(v.dimensions) && v.dimensions.length > 0 && v.dimensions.length <= IDENTITY_DIMENSIONS.length
    && v.dimensions.every((d, i, all) => (IDENTITY_DIMENSIONS as readonly unknown[]).includes(d) && (i === 0 || compare(all[i - 1], d) < 0));
}
export const blockerDiagnostic = (code: BlockerCode, now: number, stage: DiagnosticStage = "target-progress",
  observedState?: Common["observedState"]): MessageDiagnostic => ({ version: 1, kind: "blocker", stage, code, observedAt: new Date(now).toISOString(),
    ...(observedState === undefined ? {} : { observedState }) });
export function compatibleDiagnostic<T extends { diagnostic?: MessageDiagnostic }>(body: T, capabilities: readonly string[] | null): T {
  const diagnostic = body.diagnostic;
  if (!diagnostic) return body;
  if (!capabilities?.includes(MESSAGING_DIAGNOSTICS_CAPABILITY)) {
    const { diagnostic: _diagnostic, ...legacy } = body;
    return legacy as T;
  }
  if (diagnostic.kind === "blocker" && diagnostic.code === "target-not-loaded" && !capabilities.includes(MESSAGING_DIAGNOSTICS_V3_CAPABILITY)) {
    return { ...body, diagnostic: { ...diagnostic, code: "target-not-idle" } };
  }
  return diagnostic.kind === "blocker" && (RESOLUTION_DETAIL_CODES as readonly BlockerCode[]).includes(diagnostic.code) && !capabilities.includes(MESSAGING_DIAGNOSTICS_V2_CAPABILITY)
    ? { ...body, diagnostic: { ...diagnostic, code: "resolution-unavailable" } } : body;
}
const WORDS: Record<BlockerCode, string> = {
  "task-concurrency": "target task limit reached", "task-starts-daily": "target daily task-start limit reached",
  "runtime-pending": "target runtime readiness is not confirmed", "turn-spacing": "target turn spacing has not elapsed",
  "budget-lock-unavailable": "target turn-budget lock is unavailable", "hint-capture-failed": "target hint capture failed",
  "hint-invalidated": "target hint admission was invalidated", "hint-lock-busy": "target hint lock is busy", "hint-storage-failed": "target hint storage failed",
  "target-not-idle": "target idle-loaded state was not established", "task-active": "target task is active", "process-still-running": "target process is still running",
  "node-offline": "target node is offline", "registration-pending": "target node registration is pending", "binding-capability-missing": "target binding capability is unavailable",
  "stored-binding-missing": "stored owner binding is unavailable", "resolution-unavailable": "target owner resolution is unavailable",
  "resolution-timeout": "target owner resolution timed out", "resolution-capacity": "target owner resolution capacity reached",
  "identity-changed": "identity changed", "acceptance-unconfirmed": "target acceptance is not confirmed",
  "resolution-missing": "target node does not list the session", "resolution-ambiguous": "target session reference matches several sessions",
  "resolution-stale": "target node answered that the resolution window has passed", "resolution-invalid": "target node session list failed validation",
  "resolution-unreadable": "target node session list is unreadable", "resolution-clock": "control-plane clocks disagree beyond the resolution window",
  "target-not-loaded": "the target session has no running Claude Code process; the message is delivered once the session is opened in the desktop app"
    + " or resumed, and a session allowed only through \"*\" needs a typed prompt, selecting it is not enough",
};
export function renderMessageDiagnostic(diagnostic: MessageDiagnostic | null | undefined, state: string): string {
  if (!isMessageDiagnostic(diagnostic)) return "Waiting; detailed cause unavailable.";
  const prefix = ["queued", "accepted", "offered"].includes(state) ? "Waiting:" : state === "refused" ? "Refused:" : "Last blocker:";
  const text = diagnostic.kind === "identity-change" ? `identity changed (${diagnostic.dimensions.join(", ")})`
    : diagnostic.code === "target-not-idle" && diagnostic.observedState === "unknown"
      ? "Target state is unknown; idle-loaded was not established" : WORDS[diagnostic.code];
  return `${prefix} ${text}. Observed ${diagnostic.observedAt}; stage ${diagnostic.stage}.`;
}
