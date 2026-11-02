import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { audit } from "./autonomy.mts";
import { RELAY_MAX_AGE_MS, relayMessageEligible, relayRefusal, type ForkRefusal, type RelayGuardDeps } from "./codex-fork-admission.mts";
import { advanceForkAttempt, forkAttempts, readForkAttempt, type ForkAttempt } from "./codex-fork-attempts.mts";
import type { CodexDeps } from "./codex-process.mts";
import type { NodePaths } from "./config.mts";
import { DIRECTORY_INTERVAL_MS, getOutbox, getSent, writeOutbox, type OutboxRecord, type ProxySend } from "./exchange.mts";
import { getMessage } from "./inbox.mts";
import { claimProxied, getProxied, removeProxied, setUnconfirmed, setUnresolved, type ProxiedRecord } from "./inbox-proxied.mts";
import type { NodePolicy } from "./policy.mts";

// The relay of a completed Codex fork answer (issue #408, PR 4, design r3
// sections 2.2 to 2.5 with the r3 review corrections): one outbox record per
// completed attempt, a labelled proxy answer to the original's sender with
// proxyOf and depth + 1, never inReplyTo, so the original is never marked
// replied. There is no stored release: the sweep writes the record only when
// relayRefusal passes, and the exchange's send gate runs the same guards at
// every send. The owner reading or answering first withdraws, before any send
// guard is consulted, exactly when nothing can have left this node and as
// unconfirmed otherwise; a held record is cleaned up after RELAY_MAX_AGE_MS
// without a Worker status, and the outcome is then unresolved, not "never
// sent". Every step is a synchronous file operation; no turn, no helper.
// That bookkeeping (reconcileRelay) is also driven by the sidecars alone, in
// every poll and whatever wake.codexFork says: codex-fork-relay-pass.mts.

export interface RelayDeps {
  paths: NodePaths; policy: NodePolicy; now?: () => number; platform?: string;
  codex?: Pick<CodexDeps, "beforeOutbox" | "postToolHook">; workerCapabilities?: () => readonly string[] | null;
}
// What an attempt waits for: nothing; policy, enrollment, kill switch,
// fingerprint or capability (every DIRECTORY_INTERVAL_MS); the Worker, the
// owner's inbox or session state (every poll).
type Pending = "none" | "blocked" | "external";
const RANK: Record<Pending, number> = { none: 0, blocked: 1, external: 2 };

// Per owner: the next time the sweep is due (absent: at once). Provenance of
// this process, never authorization: written (this process wrote the record)
// and sentOnce (this process sent it at least once).
const due = new Map<string, number>();
const written = new Set<string>();
const sentOnce = new Set<string>();
const heldLog = new Map<string, string>();
// Per relay id: the guard code the send gate last logged a hold for.
const sendHeld = new Map<string, string>();
// The pass's memo (codex-fork-relay-pass.mts), cleared with the rest: message
// ids that need no further bookkeeping, and failures logged once.
export const relayPassMemo = { settled: new Set<string>(), stopped: new Set<string>() };
// The owner's session state changes with hook events: re-checked every poll.
const OWNER_CODES: readonly ForkRefusal[] = ["not-recorded", "task-session", "permission-mode", "permission-mode-unknown",
  "post-tool-hook-missing", "fork-not-idle"];

export function resetRelayState(): void {
  due.clear(); written.clear(); sentOnce.clear(); heldLog.clear(); sendHeld.clear(); relayPassMemo.settled.clear(); relayPassMemo.stopped.clear();
}
export function markRelayDue(owner: string): void { due.delete(owner); }

// All three ids are validated UUIDs, so the header holds no peer or model text.
export function proxyText(owner: string, forkId: string, messageId: string, answer: string): string {
  return `Kherep proxy answer: an ephemeral fork of session ${owner} (fork ${forkId}) answered message ${messageId} while the owner `
    + `was idle. The owner has not read your message yet.\n\n${answer}`;
}

const guards = (deps: RelayDeps): RelayGuardDeps => ({ paths: deps.paths, platform: deps.platform,
  postToolHook: deps.codex?.postToolHook, workerCapabilities: deps.workerCapabilities });
const iso = (now: number): string => new Date(now).toISOString();
const claimOf = (a: ForkAttempt, relayMessageId: string, now: number) => ({ relayMessageId, forkId: a.forkId!, attemptId: a.attemptId, at: iso(now) });
const matches = (claim: ProxiedRecord | null, a: ForkAttempt, relay: string): claim is ProxiedRecord =>
  claim?.relayMessageId === relay && claim.attemptId === a.attemptId && claim.forkId === a.forkId;

function held(owner: string, code: string, log: (line: string) => void): void {
  if (heldLog.get(owner) !== code) log(`kherep-node: Codex fork relay held: ${code}`);
  heldLog.set(owner, code);
}

// Withdrawal with its provenance (steps 6 and 8, review R3-WX2): exact only
// when no frame can have left this node, otherwise the record stays as the
// base of a late Worker status and the sidecar says unconfirmed.
function withdraw(deps: RelayDeps, a: ForkAttempt, relay: string, now: number): Pending {
  const { paths } = deps;
  const sidecar = getProxied(paths.inbox, a.messageId);
  const own = sidecar === null || sidecar.relayMessageId === relay;
  const record = getOutbox(paths, relay) !== null;
  if (!sentOnce.has(relay) && !sidecar?.unconfirmedAt && (!record || written.has(relay))) {
    fs.rmSync(path.join(paths.outbox, `${relay}.json`), { force: true });
    sendHeld.delete(relay);
    if (own) removeProxied(paths.inbox, a.messageId);
    return "none";
  }
  if (own) setUnconfirmed(paths.inbox, a.messageId, claimOf(a, relay, now), iso(now));
  return "external";
}

// Step 8: the owner was first. Allowed only while relayedAt is unset.
function supersede(deps: RelayDeps, owner: string, a: ForkAttempt, now: number): Pending {
  advanceForkAttempt(deps.paths, owner, a.messageId, "completed", "superseded", {}, now);
  // With the section absent the attempt's state is the trail, never an audit line.
  if (deps.policy.wake?.codexFork !== undefined) audit(deps.paths, now, owner, [a.messageId], "fork-superseded");
  return a.relayMessageId ? withdraw(deps, a, a.relayMessageId, now) : "none";
}

// Step 9 (D19): a held record past the bound without any status is removed.
// What may have left this node stays an unresolved outcome in the sidecar; a
// missing sidecar is not created, another relay's is left alone, and a record
// that is not this attempt's relay is never removed.
function cleanup(deps: RelayDeps, owner: string, a: ForkAttempt, relay: string, record: OutboxRecord, now: number): boolean {
  if (record.proxyOf !== a.messageId || record.fromSession !== owner) return true;
  if (!(now - Date.parse(record.createdAt) > RELAY_MAX_AGE_MS)) return false;
  const { paths } = deps;
  const sidecar = getProxied(paths.inbox, a.messageId);
  fs.rmSync(path.join(paths.outbox, `${relay}.json`), { force: true });
  sendHeld.delete(relay);
  if (sidecar === null || sidecar.relayMessageId !== relay) return true;
  if (sentOnce.has(relay) || sidecar.unconfirmedAt || !written.has(relay)) {
    setUnconfirmed(paths.inbox, a.messageId, claimOf(a, relay, now), iso(now));
    setUnresolved(paths.inbox, a.messageId, iso(now));
  } else removeProxied(paths.inbox, a.messageId);
  return true;
}

// Steps 1, 4, 5 and 6 for an attempt every guard passed in this synchronous section.
function relayAttempt(deps: RelayDeps, owner: string, attempt: ForkAttempt, now: number, log: (line: string) => void): Pending {
  const { paths } = deps;
  const a = attempt.relayMessageId ? attempt
    : advanceForkAttempt(paths, owner, attempt.messageId, "completed", "completed", { relayMessageId: crypto.randomUUID() }, now);
  const relay = a.relayMessageId!;
  const claim = claimProxied(paths.inbox, a.messageId, claimOf(a, relay, now)).record;
  if (!matches(claim, a, relay)) {
    held(owner, "sidecar-mismatch", log);
    return "blocked";
  }
  const record = getMessage(paths.inbox, a.messageId)!;
  if (!getOutbox(paths, relay)) {
    // to is the inbox record's sender, never model output.
    writeOutbox(paths, { messageId: relay, fromSession: owner, fromSessionId: owner, to: { nodeId: record.from.nodeId, session: record.from.session },
      text: proxyText(owner, a.forkId!, a.messageId, a.answer!), proxyOf: a.messageId, depth: (record.depth ?? 0) + 1, ...(record.loop ? { guarded: true as const } : {}), createdAt: iso(now) });
    written.add(relay);
  }
  deps.codex?.beforeOutbox?.();
  if (!relayMessageEligible(paths, owner, a.messageId)) return supersede(deps, owner, a, now);
  heldLog.delete(owner);
  return "external";
}

// A superseded attempt whose record may have left: wait for a late status, then
// clean up, also when the sidecar is missing or names another relay (WX443-2).
function heldBookkeeping(deps: RelayDeps, owner: string, a: ForkAttempt, relay: string, now: number): Pending {
  const sidecar = getProxied(deps.paths.inbox, a.messageId);
  if ((matches(sidecar, a, relay) && sidecar.unresolvedAt) || getSent(deps.paths, relay)) return "none";
  const record = getOutbox(deps.paths, relay);
  return !record || cleanup(deps, owner, a, relay, record, now) ? "none" : "external";
}

const relayable = (a: ForkAttempt): boolean => a.state === "completed" && a.answer !== undefined && a.forkId !== undefined
  && a.relayedAt === undefined;

// What runs before any send guard (design r3 corrigendum, point 1), shared by
// the sweep and the pass: the outcome, or null while the attempt waits for a send.
export function reconcileRelay(deps: RelayDeps, owner: string, a: ForkAttempt, now: number, stale: () => void = () => {}): Pending | null {
  const { paths } = deps;
  const relay = a.relayMessageId;
  if (a.state === "superseded") return relay ? heldBookkeeping(deps, owner, a, relay, now) : "none";
  if (!relayable(a) || (relay && getSent(paths, relay))) return "none";
  const record = relay ? getOutbox(paths, relay) : null;
  // A record this process did not write: a previous daemon may have sent it.
  if (relay && record && !written.has(relay)) setUnconfirmed(paths.inbox, a.messageId, claimOf(a, relay, now), iso(now));
  // Review R3-WX1: the owner first withdraws before any send guard can block it.
  if (!relayMessageEligible(paths, owner, a.messageId)) return supersede(deps, owner, a, now);
  if (now - a.attemptedAt <= RELAY_MAX_AGE_MS) return null;
  stale();
  if (relay && record) return cleanup(deps, owner, a, relay, record, now) ? "none" : "blocked";
  const sidecar = getProxied(paths.inbox, a.messageId);
  if (relay && matches(sidecar, a, relay) && !sidecar.unconfirmedAt) removeProxied(paths.inbox, a.messageId);
  return "none";
}

function sweepOne(deps: RelayDeps, owner: string, a: ForkAttempt, now: number, log: (line: string) => void): Pending {
  const { paths } = deps;
  const relay = a.relayMessageId;
  const sent = relay && relayable(a) ? getSent(paths, relay) : null;
  if (sent) {
    // D18: relayedAt is the Worker's first answer recorded in sent/.
    advanceForkAttempt(paths, owner, a.messageId, "completed", "completed", { relayedAt: now }, now);
    audit(paths, now, owner, [a.messageId], "fork-relayed");
    log(`kherep-node: Codex fork relay answered by the control plane: ${sent.state}`);
    return "none";
  }
  const outcome = reconcileRelay(deps, owner, a, now, () => held(owner, "fork-relay-stale", log));
  if (outcome !== null) return outcome;
  const code = relayRefusal(guards(deps), owner, a, now);
  if (code === "message-not-eligible") return supersede(deps, owner, a, now);
  if (code) {
    held(owner, code, log);
    return (relay && getOutbox(paths, relay)) || OWNER_CODES.includes(code) ? "external" : "blocked";
  }
  return relayAttempt(deps, owner, a, now, log);
}

// The sweep of one owner (design r3 section 2.2), called by the poll loop for
// every candidate before its inbox filter, when due.
export function relayPending(deps: RelayDeps, owner: string, log: (line: string) => void): void {
  if (deps.policy.wake?.codexFork === undefined) return;
  const now = deps.now?.() ?? Date.now();
  if (now < (due.get(owner) ?? -Infinity)) return;
  let attempts: ForkAttempt[];
  try { attempts = forkAttempts(deps.paths, owner); } catch {
    due.set(owner, now + DIRECTORY_INTERVAL_MS);
    return;
  }
  let pending: Pending = "none";
  for (const a of attempts) {
    let result: Pending;
    try { result = sweepOne(deps, owner, a, now, log); } catch (error) {
      log(`kherep-node: Codex fork relay stopped; the answer stays stored: ${String((error as Error).message ?? error)}`);
      result = "blocked";
    }
    if (RANK[result] > RANK[pending]) pending = result;
  }
  due.set(owner, pending === "external" ? now : pending === "blocked" ? now + DIRECTORY_INTERVAL_MS : Infinity);
}

// The exchange's proxy send gate (design r3 section 2.5, review R3-2): the
// attempt, the matching sidecar claim and every relay guard at this send.
export function relaySendGate(deps: RelayDeps, log: (line: string) => void = () => {}): ProxySend {
  return {
    allow(record, now) {
      if (deps.policy.wake?.codexFork === undefined || !record.proxyOf || record.fromSession !== record.fromSessionId) return false;
      try {
        const a = readForkAttempt(deps.paths, record.fromSession, record.proxyOf);
        if (a?.state !== "completed" || a.answer === undefined || a.forkId === undefined || a.relayMessageId !== record.messageId) return false;
        const claim = getProxied(deps.paths.inbox, record.proxyOf);
        if (!matches(claim, a, record.messageId) || claim.unresolvedAt) return false;
        const code = relayRefusal(guards(deps), record.fromSession, a, now);
        if (code) {
          if (sendHeld.get(record.messageId) !== code) log(`kherep-node: Codex fork relay send held: ${code}`);
          sendHeld.set(record.messageId, code);
          return false;
        }
        sendHeld.delete(record.messageId);
        return true;
      } catch {
        return false;
      }
    },
    sent(messageId) { sentOnce.add(messageId); },
  };
}
