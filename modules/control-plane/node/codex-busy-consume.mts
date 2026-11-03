import { messageOwnerMatches } from "./message-owner.mts";
import { automaticReplyDecision } from "./reply-admission.mts";
import fs from "node:fs";

import { bypassesPermissions, listenerDir } from "./autonomy.mts";
import { postToolOriginalOwner } from "./codex-hook-owner.mts";
import { busyPolicyFingerprint, busyWakeDisabled } from "./codex-busy-policy.mts";
import { claimBusyHint } from "./codex-busy-ticket.mts";
import { readCodexSession, refreshCodexEvent } from "./codex-sessions.mts";
import { contextOutput, type HookDeps } from "./deliver-core.mts";
import { getMessage } from "./inbox.mts";
import { explicitlyListed, readPolicy } from "./policy.mts";

// Issue #408: set in the environment of a Codex fork helper and inherited by its
// hook children (codex-fork-process.mts); the Codex hooks then do nothing.
export const CODEX_FORK_ENV = "KHEREP_CODEX_FORK";

const HINT = "Kherep: New peer messages are waiting. Check this session's inbox and report any relevant update.";

// A metadata hint in the current original-owner turn. No discovery, offers,
// receipts, session ranking updates or extra turn budget at a tool boundary;
// the only other write is the owner record's last event.
// Nothing inside a fork helper (KHEREP_CODEX_FORK=1, issue #408).
export function consumeBusyHint(input: unknown, deps: HookDeps): string {
  if (process.env[CODEX_FORK_ENV] === "1") return "";
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const payload = input as Record<string, unknown>, owner = payload.session_id;
  if (typeof owner !== "string" || !postToolOriginalOwner(payload, owner)) return "";
  try {
    if (!fs.existsSync(deps.paths.config)) return "";
    // Idle evidence (issue #408), whatever the wake policy says. A failed
    // refresh leaves the hint path below unchanged.
    try {
      refreshCodexEvent(deps.paths, owner, "PostToolUse", deps.now?.() ?? Date.now());
    } catch {
      // the record keeps its previous event
    }
    if (busyWakeDisabled(deps.paths)) return "";
    const policy = readPolicy(deps.paths.policy, true);
    if (!policy?.wake) return "";
    // A current Hook mode wins over the recorded mode. An explicitly unknown
    // Hook mode cannot borrow a previous normal mode to gain an automatic grant.
    const rawMode = Object.hasOwn(payload, "permission_mode") ? payload.permission_mode
      : readCodexSession(deps.paths, owner)?.permissionMode;
    const mode = typeof rawMode === "string" ? rawMode : undefined;
    if (bypassesPermissions(mode) || (mode === undefined && !explicitlyListed(policy, [owner]))) return "";
    const now = deps.now?.() ?? Date.now();
    const result = claimBusyHint(listenerDir(deps.paths), owner, busyPolicyFingerprint(policy), now, (ticket) => {
      let count = 0;
      for (const admitted of ticket.messages) {
        const record = getMessage(deps.paths.inbox, admitted.messageId);
            if (record?.messageId === admitted.messageId && record.toSession === admitted.toSession && record.state === "accepted"
          && messageOwnerMatches(record, { sessionId: owner, runtime: "codex" }, [admitted.toSession]) && automaticReplyDecision(record).allowed) count++;
      }
      return count;
    });
    return result.status === "hint" ? contextOutput("PostToolUse", HINT) : "";
  } catch {
    // Metadata/read/claim failure leaves the persistent CP Inbox intact.
    return "";
  }
}
