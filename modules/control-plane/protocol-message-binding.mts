import { isMessageId, isSessionRef } from "./protocol-messages.mts";

export const SELECTED_BINDING_CAPABILITY = "messaging.selected-binding.v1";
export const BINDING_TTL_MS = 5_000;
export const BINDING_PENDING_LIMIT = 32;
export const RESOLUTION_REQUIRED = "loop-resolution-required";
export type SelectionRole = "from" | "to";
export interface SelectedOwner { sessionId: string; runtime: string | null }
export interface BoundOwner extends SelectedOwner { lifecycleGeneration: number | null }
export interface MessageSelection { role: SelectionRole; ref: string; expected?: SelectedOwner }
export interface ResolveRequest {
  version: 1; requestId: string; messageId: string; purpose: "admit" | "egress";
  selections: MessageSelection[]; expiresAt: number;
}
export type ResolutionCode = "MISSING" | "AMBIGUOUS" | "UNREADABLE" | "INVALID" | "CONFLICT" | "STALE";
export type SelectedResult = { role: SelectionRole; code: ResolutionCode }
  | { role: SelectionRole; code: "BOUND"; match: "exact" | "alias"; owner: SelectedOwner;
    selectionStamp: string; localGeneration: number | null; lifecycleGeneration: number | null; leaseId: string };
export interface ResolveResponse { version: 1; requestId: string; messageId: string; results: SelectedResult[] }
export interface MessageBinding { version: 1; mode: "exact"; from: BoundOwner; to: BoundOwner }
export interface DeliveryBinding extends MessageBinding { leaseId: string; localGeneration: number | null }

const object = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const only = (x: Record<string, unknown>, keys: string[]): boolean => Object.keys(x).every(k => keys.includes(k));
const generation = (x: unknown): x is number | null => x === null || typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const role = (x: unknown): x is SelectionRole => x === "from" || x === "to";
export const isSelectedOwner = (x: unknown): x is SelectedOwner => object(x) && only(x, ["sessionId", "runtime"])
  && isSessionRef(x.sessionId) && (x.runtime === null || isSessionRef(x.runtime));
export const isBoundOwner = (x: unknown): x is BoundOwner => object(x)
  && only(x, ["sessionId", "runtime", "lifecycleGeneration"])
  && isSelectedOwner({ sessionId: x.sessionId, runtime: x.runtime }) && generation(x.lifecycleGeneration);
export function isMessageBinding(x: unknown): x is MessageBinding {
  return object(x) && only(x, ["version", "mode", "from", "to"]) && x.version === 1 && x.mode === "exact"
    && isBoundOwner(x.from) && isBoundOwner(x.to);
}
export function stableBinding(x: DeliveryBinding): MessageBinding {
  return { version: 1, mode: "exact", from: { ...x.from }, to: { ...x.to } };
}
export function isDeliveryBinding(x: unknown): x is DeliveryBinding {
  if (!object(x) || !only(x, ["version", "mode", "from", "to", "leaseId", "localGeneration"]) || !isMessageId(x.leaseId) || !generation(x.localGeneration)) return false;
  const { leaseId: _lease, localGeneration: _generation, ...stable } = x;
  return isMessageBinding(stable);
}
export function isResolveRequest(x: unknown): x is ResolveRequest {
  return object(x) && only(x, ["version", "requestId", "messageId", "purpose", "selections", "expiresAt"])
    && x.version === 1 && isMessageId(x.requestId) && isMessageId(x.messageId) && (x.purpose === "admit" || x.purpose === "egress")
    && typeof x.expiresAt === "number" && Number.isSafeInteger(x.expiresAt) && x.expiresAt >= 0
    && Array.isArray(x.selections) && x.selections.length >= 1 && x.selections.length <= 2
    && x.selections.every(s => object(s) && only(s, ["role", "ref", "expected"]) && role(s.role) && isSessionRef(s.ref)
      && (s.expected === undefined || isSelectedOwner(s.expected)))
    && new Set(x.selections.map(s => s.role)).size === x.selections.length;
}
export function isSelectedResult(x: unknown): x is SelectedResult {
  if (!object(x) || !role(x.role)) return false;
  if (x.code !== "BOUND") return only(x, ["role", "code"])
    && ["MISSING", "AMBIGUOUS", "UNREADABLE", "INVALID", "CONFLICT", "STALE"].includes(String(x.code));
  return only(x, ["role", "code", "match", "owner", "selectionStamp", "localGeneration", "lifecycleGeneration", "leaseId"])
    && (x.match === "exact" || x.match === "alias") && isSelectedOwner(x.owner) && isMessageId(x.selectionStamp)
    && isMessageId(x.leaseId) && generation(x.lifecycleGeneration) && generation(x.localGeneration);
}
export function isResolveResponse(x: unknown): x is ResolveResponse {
  return object(x) && only(x, ["version", "requestId", "messageId", "results"]) && x.version === 1
    && isMessageId(x.requestId) && isMessageId(x.messageId) && Array.isArray(x.results)
    && x.results.length >= 1 && x.results.length <= 2 && x.results.every(isSelectedResult)
    && new Set(x.results.map(r => r.role)).size === x.results.length;
}
