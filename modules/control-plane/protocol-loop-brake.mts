// Worker-issued admission only. Nodes never submit this as send authority.
export const MESSAGING_LOOP_BRAKE_CAPABILITY = "messaging.loop-brake.v1";
export const LOOP_STRIKES = 3;
export const LOOP_RING = 8;
export const LOOP_SEGMENT = 256;
export const LOOP_PAIRS = 4096;
export const LOOP_IDLE_MS = 24 * 60 * 60_000;
export interface LoopAdmissionV1 { version: 1; threadId: string; depth: number; generation: number; ordinal: number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const natural = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
export function isLoopAdmissionV1(value: unknown): value is LoopAdmissionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 5 && v.version === 1 && typeof v.threadId === "string" && UUID.test(v.threadId)
    && natural(v.depth) && natural(v.generation) && natural(v.ordinal) && v.ordinal >= 1 && v.ordinal <= LOOP_SEGMENT;
}
export type LoopHoldCode = "ack-or-repeat" | "segment-limit";
export const loopHeldReason = (code: LoopHoldCode, id: string): string => `loop-held: ${code}; hold=${id}; operator release required`;
export const LOOP_LINEAGE = "loop-lineage-unavailable";
export const LOOP_STALE = "loop-context-changed";
export const LOOP_COMPATIBILITY = "loop-compatibility: legacy reply limit";

// Only Worker-defined loop diagnostics, never arbitrary persisted peer/node reasons.
export function safeLoopReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if ([LOOP_LINEAGE, LOOP_STALE, LOOP_COMPATIBILITY, "loop-capacity", "loop-crypto-unavailable", "loop-state-unavailable", "loop-resolution-required"].includes(value)) return value;
  const match = /^loop-held: (ack-or-repeat|segment-limit); hold=([^;]+); operator release required$/.exec(value);
  return match && UUID.test(match[2]) ? value : undefined;
}
