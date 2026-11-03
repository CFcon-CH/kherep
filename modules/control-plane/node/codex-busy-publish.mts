import { messageOwnerMatches } from "./message-owner.mts";
import { automaticReplyDecision } from "./reply-admission.mts";
import crypto from "node:crypto";

import { bypassesPermissions, listenerDir } from "./autonomy.mts";
import { busyPolicyFingerprint, busyWakeDisabled } from "./codex-busy-policy.mts";
export { busyPolicyFingerprint } from "./codex-busy-policy.mts";
import { publishBusyHint, type BusyHintAdmission } from "./codex-busy-ticket.mts";
import { CODEX_ACTIVE_MS, codexSessionRefs, readCodexSession } from "./codex-sessions.mts";
import { getMessage, type InboxRecord } from "./inbox.mts";
import { readConfig } from "./config.mts";
import { listTasks } from "./task-records.mts";
import { explicitlyListed, readPolicy } from "./policy.mts";
import type { RunnerDeps } from "./session-runner.mts";

// Called only after the existing CP guards have admitted this
// owner. Copy addresses before the asynchronous publication lane; never retarget them.
export function captureBusyHint(deps: RunnerDeps, owner: string, due: InboxRecord[], now: number): BusyHintAdmission | null {
  try {
    return { owner, generation: crypto.randomUUID(), admittedAt: now, expiresAt: now + CODEX_ACTIVE_MS,
      policyFingerprint: busyPolicyFingerprint(deps.policy),
      messages: due.slice(0, 8).map(({ messageId, toSession }) => ({ messageId, toSession })) };
  } catch { return null; }
}

// An authorized CP admission is never an offer or receipt. Publication failure
// leaves persistent Inbox content accepted for the next original-owner intake.
export function publishAdmittedBusyHint(deps: RunnerDeps, ticket: BusyHintAdmission):
  ReturnType<typeof publishBusyHint> {
  try {
    const now = deps.now?.() ?? Date.now();
    const policy = readPolicy(deps.paths.policy, true);
    if (!readConfig(deps.paths.config) || listTasks(deps.paths).some((task) => task.sessionId === ticket.owner)) return "invalid";
    if (!policy || busyPolicyFingerprint(policy) !== ticket.policyFingerprint || busyWakeDisabled(deps.paths)) return "invalid";
    const mode = readCodexSession(deps.paths, ticket.owner)?.permissionMode;
    if (bypassesPermissions(mode) || (mode === undefined && !explicitlyListed(policy, [ticket.owner]))) return "invalid";
    const refs = new Set(ticket.messages.some((record) => record.toSession !== ticket.owner)
      ? codexSessionRefs(deps.paths, ticket.owner, now).refs : [ticket.owner]);
    const messages = ticket.messages.filter((admitted) => {
      const record = getMessage(deps.paths.inbox, admitted.messageId);
        return record?.messageId === admitted.messageId && record.state === "accepted"
        && record.toSession === admitted.toSession && messageOwnerMatches(record, { sessionId: ticket.owner, runtime: "codex" }, [...refs])
        && automaticReplyDecision(record).allowed;
    });
    if (messages.length === 0) return "invalid";
    return publishBusyHint(listenerDir(deps.paths), { ...ticket, messages }, now);
  } catch { return "failed"; }
}
