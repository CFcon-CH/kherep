import { budgetFile, debitGroup, verifyGroupDebit } from "./budget-store.mts";
import { readConfig, type NodePaths } from "./config.mts";
import { getMessage, type InboxRecord } from "./inbox.mts";
import { withTargetReservation } from "./codex-native-pending.mts";
import { recordTargetAttempts, settleTargetAttempts, targetAttemptsInState } from "./codex-native-attempts.mts";
import type { TurnBudget } from "./policy.mts";
import { targetMembersMatch, uuid } from "./target-delivery-state.mts";
import type { TargetHandle, TargetReservation } from "./target-delivery-reservation.mts";

const debitKey = (s: TargetReservation) => ({ groupId: s.handle.groupId, groupFingerprint: s.handle.groupFingerprint, reservationId: s.handle.reservationId });
function currentMembers(paths: NodePaths, s: TargetReservation, now: number): void {
  const config = readConfig(paths.config), records = s.group.members.map(m => getMessage(paths.inbox, m.messageId));
  if (!Number.isSafeInteger(now) || now < 0 || now >= s.group.deadlineMs || config?.nodeId !== s.group.nodeId
    || records.some(r => !r || !["accepted", "offered"].includes(r.state))
    || !targetMembersMatch(s.group, records as InboxRecord[], config.nodeId)) throw Error("target group membership or deadline changed");
}
function exactDebit(paths: NodePaths, s: TargetReservation): void {
  if (!s.budget || !verifyGroupDebit(budgetFile(paths, s.owner), debitKey(s), s.budget)) throw Error("target debit cannot be verified");
}

// Internal inactive core. Policy/lifecycle/native authority still belongs to
// the later cross-route/final-admission integration; these are no launch grants.
export function prepareTargetDelivery(paths: NodePaths, handle: TargetHandle, now: number, budget: TurnBudget): TargetReservation {
  return withTargetReservation(paths, handle, (initial, save) => {
    let saved = initial;
    if (!["reserved", "debited", "ready"].includes(saved.phase)) throw Error("target is not preparable");
    currentMembers(paths, saved, now);
    if (saved.phase === "reserved") {
      const receipt = debitGroup(budgetFile(paths, saved.owner), debitKey(saved), now, budget);
      if (receipt.status !== "debited" && receipt.status !== "already-debited") throw Error(`target budget ${receipt.status}`);
      saved = { ...saved, phase: "debited", budget: { budgetId: receipt.budgetId, chargedAt: receipt.debit.chargedAt } }; save(saved);
    }
    exactDebit(paths, saved);
    if (saved.phase === "debited") {
      recordTargetAttempts(paths, saved);
      saved = { ...saved, phase: "ready" }; save(saved);
    }
    if (!targetAttemptsInState(paths, saved, "attempted")) throw Error("target attempt history differs");
    return saved;
  });
}

// Durable CAS to submitting occurs only after the exact complete group, debit
// and every original per-message attempt are reread. No native transport here.
export function beginTargetSubmission(paths: NodePaths, handle: TargetHandle, now: number): TargetReservation {
  return withTargetReservation(paths, handle, (saved, save) => {
    if (saved.phase !== "ready" || saved.group.runtime !== "codex" || saved.group.producer?.route !== "local") throw Error("target submit unavailable");
    currentMembers(paths, saved, now); exactDebit(paths, saved);
    if (!targetAttemptsInState(paths, saved, "attempted")) throw Error("target attempts incomplete");
    const next = { ...saved, phase: "submitting" as const }; save(next); return next;
  });
}

// Timely submission may return or be ACKed after expiry. A late exact queue ID
// resolves the same attempt; it never reopens the native transport invocation.
export function finishTargetSubmission(paths: NodePaths, handle: TargetHandle, queueId?: string): TargetReservation {
  return withTargetReservation(paths, handle, (saved, save) => {
    if (queueId !== undefined && !uuid(queueId)) throw Error("invalid target submission result");
    if (saved.phase === "submitted" && saved.queueId === queueId && targetAttemptsInState(paths, saved, "submitted")) return saved;
    if (saved.phase !== "submitting" && saved.phase !== "uncertain") throw Error("target was not submitting");
    if (saved.phase === "uncertain" && queueId === undefined) return saved;
    settleTargetAttempts(paths, saved, queueId ? "submitted" : "uncertain", queueId);
    const next = { ...saved, phase: queueId ? "submitted" as const : "uncertain" as const, queueId: queueId ?? null }; save(next); return next;
  });
}
export function cancelTargetBeforeSubmit(paths: NodePaths, handle: TargetHandle): TargetReservation {
  return withTargetReservation(paths, handle, (saved, save) => {
    if (saved.phase !== "ready" || !targetAttemptsInState(paths, saved, "attempted")) throw Error("target no-submit proof unavailable");
    settleTargetAttempts(paths, saved, "cancelled-before-submit");
    const next = { ...saved, phase: "cancelled-before-submit" as const }; save(next); return next;
  });
}
