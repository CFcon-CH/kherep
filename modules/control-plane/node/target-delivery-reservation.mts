import { canonical, hash, integer, keys, object, parseTargetGroup, targetGroupFingerprint, uuid, type TargetDeliveryGroup } from "./target-delivery-state.mts";
export type TargetPhase = "reserved" | "debited" | "ready" | "submitting" | "submitted" | "uncertain" | "cancelled-before-submit";
export interface TargetHandle {
  owner: string; groupId: string; generation: string; groupFingerprint: string; reservationId: string; attemptToken: string;
}
export interface TargetDebit { budgetId: string; chargedAt: number }
export interface TargetReservation {
  version: 2; owner: string; handle: TargetHandle; group: TargetDeliveryGroup; phase: TargetPhase; budget: TargetDebit | null; queueId: string | null;
}
export interface TargetReference extends TargetHandle, TargetDebit { version: 1 }
export function parseTargetHandle(x: unknown): TargetHandle {
  if (!object(x) || !keys(x, ["owner", "groupId", "generation", "groupFingerprint", "reservationId", "attemptToken"])
    || !uuid(x.owner) || !uuid(x.groupId) || !uuid(x.generation) || !hash(x.groupFingerprint) || !uuid(x.reservationId) || !uuid(x.attemptToken)) throw Error("invalid target handle");
  return { ...x } as unknown as TargetHandle;
}
export function parseTargetReference(x: unknown): TargetReference {
  if (!object(x) || !keys(x, ["version", "owner", "groupId", "generation", "groupFingerprint", "reservationId", "attemptToken", "budgetId", "chargedAt"])
    || x.version !== 1 || !uuid(x.budgetId) || !integer(x.chargedAt)) throw Error("invalid target attempt reference");
  const { version: _version, budgetId: _budget, chargedAt: _time, ...handle } = x; parseTargetHandle(handle);
  return { ...x } as unknown as TargetReference;
}
export function parseTargetReservation(x: unknown): TargetReservation {
  if (!object(x) || !keys(x, ["version", "owner", "handle", "group", "phase", "budget", "queueId"]) || x.version !== 2) throw Error("invalid target reservation");
  const group = parseTargetGroup(x.group), handle = parseTargetHandle(x.handle);
  if (x.owner !== group.originalId || handle.owner !== x.owner || handle.groupId !== group.groupId || handle.generation !== group.generation
    || handle.groupFingerprint !== targetGroupFingerprint(group) || typeof x.phase !== "string" || !["reserved", "debited", "ready", "submitting", "submitted", "uncertain", "cancelled-before-submit"].includes(x.phase)) throw Error("unbound target reservation");
  if (x.phase === "reserved" ? x.budget !== null : !object(x.budget) || !keys(x.budget, ["budgetId", "chargedAt"])
    || !uuid(x.budget.budgetId) || !integer(x.budget.chargedAt)) throw Error("invalid target debit receipt");
  if (x.phase === "submitted" ? !uuid(x.queueId) : x.queueId !== null) throw Error("invalid target submission receipt");
  return { version: 2, owner: group.originalId, handle, group, phase: x.phase as TargetPhase, budget: x.budget as TargetDebit | null, queueId: x.queueId as string | null };
}
export function targetReference(saved: TargetReservation): TargetReference {
  if (!saved.budget) throw Error("target budget not recorded");
  return { version: 1, ...saved.handle, ...saved.budget };
}
export function targetTransition(previous: TargetReservation, next: TargetReservation): void {
  const allowed: Record<TargetPhase, TargetPhase[]> = { reserved: ["debited"], debited: ["ready"], ready: ["submitting", "cancelled-before-submit"],
    submitting: ["submitted", "uncertain"], uncertain: ["submitted"], submitted: [], "cancelled-before-submit": [] };
  if (canonical(previous.handle) !== canonical(next.handle) || canonical(previous.group) !== canonical(next.group)
    || previous.budget !== null && canonical(previous.budget) !== canonical(next.budget)
    || !allowed[previous.phase].includes(next.phase)) throw Error("invalid target phase transition");
}
