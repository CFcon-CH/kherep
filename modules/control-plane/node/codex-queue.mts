import { blockerDiagnostic } from "../protocol-diagnostics.mts";
import { automaticReplyDecision } from "./reply-admission.mts";
import fs from "node:fs";

import { bypassesPermissions, isPlainSessionId, type AutonomyAction, type WakeGrant } from "./autonomy.mts";
import { codexHome, currentCodexApp } from "./codex-app.mts";
import { captureBusyHint, publishAdmittedBusyHint } from "./codex-busy-publish.mts";
import { readBusyAdmission, saveBusyAdmission, type BusyAdmission } from "./codex-busy-admission.mts";
import { busyPolicyFingerprint } from "./codex-busy-policy.mts";
import { daemonSocket, loadedThreads, probesSettled, tuiMarker, tuiReachability } from "./codex-daemon.mts";
import { codexInboxRound, type CodexInboxSelector } from "./codex-queue-inbox.mts";
import { codexSessionRefs, listCodexSessions, readCodexSession } from "./codex-sessions.mts";
import { note, pruneNoted } from "./codex-wake.mts";
export { guardQueue, QUEUE_TIMEOUT_MS, queueArgs } from "./codex-queue-run.mts";
import { inboxOf, progressRecords } from "./delivery-progress.mts";
import { REOFFER_AFTER_MS } from "./deliver-core.mts";
import { getMessageProgress, type InboxRecord } from "./inbox.mts";
import { explicitlyListed, wakeAllowed } from "./policy.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { listTasks } from "./task-records.mts";
import { killSwitch } from "./wake-hook.mts";
import { nativeQueueIdle, scheduleNativeQueue, scheduleNativeReconciliation } from "./codex-queue-producer.mts";
import { forkReplyIdle, scheduleForkReply } from "./codex-fork-reply.mts";
import { relayPending } from "./codex-fork-relay.mts";
import { relayBookkeeping } from "./codex-fork-relay-pass.mts";

// Admit a compact CP hint for the authorized original Codex owner. The
// synchronous original-owner hook consumes it at a supported tool boundary;
// native Queue adds only a fixed pointer, never resumes or replaces the owner.
// Admission and metadata claims never offer or confirm persistent Inbox content.
// CP hint admission never spends the shared turn budget. The independent
// native producer reserves it only for an original-owner Queue attempt.
// Keep the public poll/lane interface for existing intake-window callers.
// One fast recovery per retained message, then the ordinary reoffer interval.
export const BUSY_HINT_RECOVERY_MS = 60_000;
let lane: Promise<void> = Promise.resolve();
const inFlight = new Set<string>();

// Resolves once every hint publication started so far has settled (tests, shutdown).
export async function codexQueueIdle(): Promise<void> {
  for (let current = lane; ; current = lane) {
    await current;
    await probesSettled();
    await nativeQueueIdle();
    await forkReplyIdle();
    if (current === lane) return;
  }
}

// Decides synchronously and hands each wake to the lane; returns at once.
export function pollCodexQueue(deps: RunnerDeps, log: (line: string) => void = () => {}): void {
  const now = deps.now?.() ?? Date.now();
  pruneNoted(deps.paths);
  // Issue #408, PR 4 (WX443-1, WX443-2): relay bookkeeping before, and independent of, the candidates and the flag.
  try { relayBookkeeping(deps, log); } catch (error) {
    log(`kherep-node: Codex fork relay bookkeeping failed: ${String((error as Error).message ?? error)}`);
  }
  const tasks = new Set(listTasks(deps.paths).flatMap((t) => (t.sessionId ? [t.sessionId] : [])));
  let live: string[];
  try {
    live = listCodexSessions(deps.paths, now).map((s) => s.sessionId);
  } catch (error) {
    log(`kherep-node: could not list Codex sessions: ${String((error as Error).message ?? error)}`);
    return;
  }
  const candidates = live.filter((id) => !tasks.has(id) && isPlainSessionId(id));
  if (candidates.length === 0) return;
  let selectInbox: CodexInboxSelector;
  try {
    selectInbox = codexInboxRound(deps.paths, inboxOf(deps));
  } catch (error) {
    log(`kherep-node: could not scan Codex Inbox: ${String((error as Error).message ?? error)}`);
    return;
  }
  const home = deps.codex?.home ?? codexHome();
  const probe = deps.codex?.loadedThreads ?? (() => loadedThreads(daemonSocket(home), { platform: deps.codex?.platform }));
  const reachable = tuiReachability(home, probe, now);
  // wake.codexApp: the one app session it grants, looked up at most once per
  // round and only when a message waits for a session not listed by full id.
  let app: string | null | undefined;
  const appSession = (): string | null => {
    if (app !== undefined) return app;
    app = null;
    if (!deps.policy.wake?.codexApp) return app;
    try {
      app = currentCodexApp(deps.paths, candidates, home, reachable);
    } catch (error) {
      log(`kherep-node: could not find the current Codex app session: ${String((error as Error).message ?? error)}`);
    }
    return app;
  };
  for (const sessionId of candidates) {
    try {
      scheduleNativeReconciliation(deps, sessionId, log);
      // Issue #408, PR 4: before the inbox filter, so a withdrawal runs when nothing waits.
      relayPending(deps, sessionId, log);
      queueFor(deps, sessionId, live, selectInbox, now, log, appSession, home, reachable);
    } catch (error) {
      log(`kherep-node: could not wake Codex session ${sessionId}: ${String((error as Error).message ?? error)}`);
    }
  }
}

function queueFor(deps: RunnerDeps, sessionId: string, live: string[], selectInbox: CodexInboxSelector,
  now: number, log: (line: string) => void, appSession: () => string | null,
  home: string, reachable: (sessionId: string) => boolean): void {
  const { paths, policy } = deps;
  // A name another live session shares addresses neither: the message waits
  // for its sender to use the full id (codex-<8> names, issue #66).
  const { refs, ambiguous } = codexSessionRefs(paths, sessionId, now, live);
  const shared = selectInbox(ambiguous).filter((r) => r.state === "accepted");
  if (shared.length > 0) {
    progressRecords(paths, shared, "waiting", "ambiguous-target", now);
    note(paths, now, sessionId, shared.map((r) => r.messageId), "ambiguous-name");
  }
  const mine = selectInbox(refs, { sessionId, runtime: "codex" });
  if (inFlight.has(sessionId)) return;
  progressRecords(paths, mine.filter((record) => record.state === "offered"
    && getMessageProgress(paths.inbox, record.messageId)?.phase !== "failed"),
    "waiting", "awaiting-turn-confirmation", now);
  const waiting = mine.filter((r) => r.state === "accepted");
  if (waiting.length === 0) return;
  const fresh = waiting;
  const previous = readBusyAdmission(paths, sessionId);
  if (previous && (previous.ticket.policyFingerprint !== busyPolicyFingerprint(policy)
    || now >= previous.ticket.expiresAt)) {
    previous.invalidated = true;
    try { saveBusyAdmission(paths, previous); } catch { /* the process retains invalidation */ }
  }
  const ids = (records: InboxRecord[]): string[] => records.map((r) => r.messageId);
  if (!policy.wake) {
    progressRecords(paths, fresh, "waiting", "wake-disabled", now);
    return;
  }
  if (fs.existsSync(killSwitch(paths))) {
    progressRecords(paths, fresh, "waiting", "wake-disabled", now);
    return note(paths, now, sessionId, ids(fresh), "disabled");
  }
  // Authorization by the full thread id only: names can be shared. Otherwise
  // wake.codexApp may grant this one session; every guard below still applies.
  const listed = wakeAllowed(policy, [sessionId]);
  const grant: WakeGrant | undefined = !listed && appSession() === sessionId ? "codexApp" : undefined;
  if (!listed && !grant) {
    progressRecords(paths, fresh, "waiting", "wake-not-authorized", now);
    return note(paths, now, sessionId, ids(fresh), "not-allowlisted");
  }
  const decide = (records: InboxRecord[], action: AutonomyAction): void => note(paths, now, sessionId, ids(records), action, grant);
  const mode = readCodexSession(paths, sessionId)?.permissionMode;
  if (bypassesPermissions(mode)) {
    progressRecords(paths, fresh, "waiting", "permission-restricted", now);
    return decide(fresh, "permission-mode");
  }
  if (mode === undefined && !explicitlyListed(policy, [sessionId])) {
    progressRecords(paths, fresh, "waiting", "permission-restricted", now);
    return decide(fresh, "permission-mode-unknown");
  }
  const deep = fresh.filter((r) => !automaticReplyDecision(r).allowed);
  if (deep.length > 0) {
    progressRecords(paths, deep, "waiting", "reply-limit", now);
    decide(deep, "depth-limit");
  }
  const due = fresh.filter((r) => automaticReplyDecision(r).allowed);
  if (due.length === 0) return;
  const tuiReachable = reachable(sessionId);
  // Full policy authorization does not require the owner's loaded-thread
  // probe. The automatic app grant must still wait while a marked TUI's
  // classification is unresolved, before admission or attempt bookkeeping.
  if (grant === "codexApp" && fs.existsSync(tuiMarker(home, sessionId)) && !tuiReachable) {
    progressRecords(paths, due, "waiting", "awaiting-user-turn", now);
    return decide(due, "awaiting-user-turn");
  }
  scheduleNativeQueue(deps, sessionId, due.filter((record) => record.toSession === sessionId)
    .map((record) => record.messageId), grant, log);
  // Issue #408: off unless wake.codexFork is present; it needs the same wake
  // authorization and, on top, the owner's full id in codexFork.sessions.
  scheduleForkReply(deps, sessionId, due.filter((record) => record.toSession === sessionId).map((record) => record.messageId), log);
  const valid = previous && !previous.invalidated && previous.ticket.admittedAt <= now && now < previous.ticket.expiresAt
    && previous.ticket.policyFingerprint === busyPolicyFingerprint(policy);
  const recovery = new Map((previous?.recovery ?? (previous?.publishedAt === undefined ? [] : previous.messageIds.map(messageId =>
    ({ messageId, firstPublishedAt: previous.publishedAt!, lastPublishedAt: previous.publishedAt!, fastRecovered: false })))).map(item => [item.messageId, item]));
  const hintDue = due.filter(record => {
    const item = recovery.get(record.messageId);
    return !item || !item.fastRecovered && now - item.firstPublishedAt >= BUSY_HINT_RECOVERY_MS
      || now - item.lastPublishedAt >= REOFFER_AFTER_MS;
  });
  const pending = valid && hintDue.length === 0;
  if (pending) {
    progressRecords(paths, due, "waiting", "awaiting-user-turn", now);
    return;
  }
  // Failed publication retries the same authorized generation. Policy/TTL drift
  // requires fresh admission; native queue history cannot authorize a retry.
  let admission: BusyAdmission;
  if (valid && previous.publishedAt === undefined
    && due.some((record) => previous.ticket.messages.some((message) => message.messageId === record.messageId))) {
    admission = previous;
  } else {
    if (tuiReachable) decide(due, "tui-reachable");
    const ticket = captureBusyHint(deps, sessionId, valid ? hintDue : due, now);
    if (!ticket) {
      progressRecords(paths, due, "waiting", "retry-pending", now);
      progressRecords(paths, (valid ? hintDue : due).slice(0, 8), "waiting", "retry-pending", now, undefined, blockerDiagnostic("hint-capture-failed", now));
      return;
    }
    admission = { ticket, messageIds: ids(due), recovery: due.flatMap(record => recovery.has(record.messageId) ? [recovery.get(record.messageId)!] : []) };
  }
  try { saveBusyAdmission(paths, admission); } catch {
    log("kherep-node: Codex CP admission persistence failed; inbox remains accepted");
  }
  inFlight.add(sessionId);
  lane = lane.then(() => {
    const result = publishAdmittedBusyHint(deps, admission.ticket);
    if (result === "invalid") {
      admission = { ...admission, invalidated: true };
      try { saveBusyAdmission(paths, admission); } catch { /* the process retains invalidation */ }
    }
    const published = result === "published" || result === "unchanged";
    if (published) {
      const publishedAt = deps.now?.() ?? Date.now();
      const publishedIds = new Set(admission.ticket.messages.map(message => message.messageId));
      admission = { ...admission, publishedAt, recovery: due.flatMap(record => {
        const previous = recovery.get(record.messageId);
        if (!publishedIds.has(record.messageId)) return previous ? [previous] : [];
        return [{ messageId: record.messageId, firstPublishedAt: previous?.firstPublishedAt ?? publishedAt, lastPublishedAt: publishedAt,
          fastRecovered: previous ? previous.fastRecovered || publishedAt - previous.firstPublishedAt >= BUSY_HINT_RECOVERY_MS : false }];
      }) };
      try { saveBusyAdmission(paths, admission); } catch {
        log("kherep-node: Codex CP publication bookkeeping failed; inbox remains accepted");
      }
    }
    progressRecords(paths, due, "waiting", published ? "awaiting-user-turn" : "retry-pending", deps.now?.() ?? Date.now());
    if (!published) {
      const checked = new Set(admission.ticket.messages.map(message => message.messageId));
      progressRecords(paths, due.filter(record => checked.has(record.messageId)).slice(0, 8), "waiting", "retry-pending", deps.now?.() ?? Date.now(), undefined,
        blockerDiagnostic(result === "invalid" ? "hint-invalidated" : result === "busy" ? "hint-lock-busy" : "hint-storage-failed", deps.now?.() ?? Date.now()));
    }
    if (published) decide(due, "wake");
    else if (result !== "invalid") log("kherep-node: Codex CP hint publication pending; inbox remains accepted");
  }).catch((error: unknown) => {
    // Audit/persistence failure must not poison the serial lane.
    log(`kherep-node: Codex CP hint bookkeeping for ${sessionId} failed: ${String((error as Error).message ?? error)}`);
  }).finally(() => { inFlight.delete(sessionId); });
}
