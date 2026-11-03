import { isNodeId } from "./protocol.mts";

// An enrolled sender node's assertion, minted only by the authenticated Worker
// node path. It is neither a Worker receipt timestamp nor session authentication.
export interface SenderOrigin { nodeId: string; sentAt: string }
export const MESSAGE_ADMISSION_MS = 86_400_000;
export type OriginCode = "origin-missing" | "origin-invalid" | "origin-future" | "origin-expired" | "origin-unbound";
export type OriginCheck = { ok: true; sentAtMs: number; deadlineMs: number } | { ok: false; code: OriginCode };

export function senderTime(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isSafeInteger(ms) && ms >= 0 && Number.isSafeInteger(ms + MESSAGE_ADMISSION_MS)
    && new Date(ms).toISOString() === value ? ms : null;
}

export function isSenderOrigin(value: unknown): value is SenderOrigin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const origin = value as Record<string, unknown>;
  return Object.keys(origin).length === 2 && Object.hasOwn(origin, "nodeId") && Object.hasOwn(origin, "sentAt")
    && isNodeId(origin.nodeId) && senderTime(origin.sentAt) !== null;
}

export function checkOrigin(origin: unknown, sourceNode: string, now: number): OriginCheck {
  if (origin === undefined || origin === null) return { ok: false, code: "origin-missing" };
  if (!isSenderOrigin(origin) || !Number.isSafeInteger(now) || now < 0) return { ok: false, code: "origin-invalid" };
  if (origin.nodeId !== sourceNode) return { ok: false, code: "origin-unbound" };
  const sentAtMs = senderTime(origin.sentAt)!;
  if (sentAtMs > now) return { ok: false, code: "origin-future" };
  const deadlineMs = sentAtMs + MESSAGE_ADMISSION_MS;
  return now < deadlineMs ? { ok: true, sentAtMs, deadlineMs } : { ok: false, code: "origin-expired" };
}
