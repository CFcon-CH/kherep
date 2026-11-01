import fs from "node:fs";
import { closedFallbackGeneration } from "./session-lifecycle.mts";

import { isSessionRef, OPERATOR_NODE_ID, type MessageProgressCode } from "../protocol-messages.mts";
import { DELEGATED_PERMISSION_MODES, type PermissionMode, type TaskRuntime } from "../protocol-tasks.mts";
import { bypassesPermissions, rememberedMode, takeTurn, wakeAudit } from "./autonomy.mts";
import { stillRuns } from "./codex-process.mts";
import { CODEX_RUNTIME, isCodexSessionId, readCodexSession } from "./codex-sessions.mts";
import { resumeClaude, resumeCodex, skipBusy, startIntercom } from "./closed-resume.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { attachDelivery } from "./delivery-identity.mts";
import { progressRecords } from "./delivery-progress.mts";
import { readLocalSessions } from "./exchange.mts";
import { listInbox, markClosedAttempt, markRefused, MAX_REPLY_DEPTH, readJson, type InboxRecord } from "./inbox.mts";
import { RecordLockBusy } from "./inbox-record-lock.mts";
import { closedSession, findKnown, trackSession } from "./known-sessions.mts";
import { acceptsMessage, wakeBudget } from "./policy.mts";
import { notReadyNow } from "./runtime-readiness.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { CLAUDE_RUNTIME } from "./sessions.mts";
import { overLimit } from "./task-admission.mts";
import { intercomFor, isActive, listTasks, readTask, writeTask, type TaskRecord } from "./task-records.mts";
import { resolveCwd } from "./task-prompt.mts";
import { killSwitch } from "./wake-hook.mts";

// Delivery to a session that is no longer running (issue #102, operator
// decision 2026-09-27; issue #105). Opt-in per node with
// messaging.resumeClosed. Run by the daemon after each session listing: an
// accepted message for a known session of this node (known-sessions.json,
// codex-sessions/ or a task record) that a listing taken after its arrival did
// not show, and that is closed by its miss streak (issue #389,
// known-sessions.mts: CLOSED_AFTER_MISSES successful listings without it over
// at least CLOSED_MIN_AGE_MS), goes to an intercom session of its sender, never
// to the closed session itself, whose resume would reload its whole
// conversation. A reply takes the same path as any other message:
// - the newest intercom session this node started for the same sender session
//   (task record local intercom, requestedBy <sender node>/<sender session>)
//   gets it: a running one through its delivery hook and wake (task grant,
//   taskGrants), an ended one is resumed in the background (closed-resume.mts);
// - otherwise a new intercom session starts, as `msg send --new` does.
// The guards are those of --new and the wake, fail closed: the kill switch,
// sessions enabled with the runtime listed, delegate.accept and the accept
// rules, reply depth, never bypassPermissions, maxConcurrent and the budget of
// autonomous turns of the session that runs. A message causes one attempt at
// most (closedAttempt); a refusal is audited once and the message waits as
// before (inbox.mts refuseUndeliverable).

// A listing older than this decides nothing: a failed one is not an empty node.
export const LISTING_FRESH_MS = 3 * 60_000;

type Outcome = "reused" | "new" | "refused";

// Refusals are audited once per message and reason, not at every round.
const noted = new Set<string>();
function audit(paths: NodePaths, now: number, sessionId: string, records: InboxRecord[], outcome: Outcome, reason?: string,
  taskId?: string): void {
  const fresh = outcome === "refused" ? records.filter((r) => !noted.has(`${r.messageId} ${reason}`)) : records;
  if (fresh.length === 0) return;
  if (outcome === "refused") for (const r of fresh) noted.add(`${r.messageId} ${reason}`);
  ensureDir(paths.dir);
  fs.appendFileSync(wakeAudit(paths), `${JSON.stringify({ ts: new Date(now).toISOString(), sessionId,
    messageIds: fresh.map((r) => r.messageId), action: "closed-session", outcome, ...(reason ? { reason } : {}),
    ...(taskId ? { taskId } : {}) })}\n`, { mode: 0o600 });
}

// The closed session a reference names, from what this node recorded about it.
interface Target { sessionId: string; runtime: TaskRuntime; cwd?: string; mode?: string; task?: TaskRecord }
function resolveTarget(paths: NodePaths, ref: string): Target | null {
  const task = listTasks(paths).find((t) => t.sessionId !== undefined && (t.sessionId === ref || t.name === ref));
  const known = findKnown(paths, task?.sessionId ?? ref);
  const sessionId = task?.sessionId ?? known?.sessionId ?? (isCodexSessionId(ref) ? ref : undefined);
  if (!sessionId) return null;
  const codex = readCodexSession(paths, sessionId);
  const runtime: TaskRuntime | undefined = task ? task.runtime ?? "claude"
    : known?.runtime === CLAUDE_RUNTIME ? "claude" : known?.runtime === CODEX_RUNTIME || codex ? "codex" : undefined;
  if (!runtime) return null;
  const cwd = task?.cwd ?? known?.cwd ?? codex?.cwd;
  const mode = task?.permissionMode ?? codex?.permissionMode ?? rememberedMode(paths, sessionId);
  return { sessionId, runtime, ...(cwd ? { cwd } : {}), ...(mode ? { mode } : {}), ...(task ? { task } : {}) };
}

export async function deliverToClosed(deps: RunnerDeps, log: (line: string) => void = () => {}): Promise<void> {
  const { paths, policy } = deps;
  if (policy.messaging?.resumeClosed !== true) return;
  const now = deps.now?.() ?? Date.now();
  const listedAt = Date.parse(readJson<{ updatedAt?: string }>(paths.sessions)?.updatedAt ?? "");
  if (!(now - listedAt <= LISTING_FRESH_MS)) return;
  const live = new Set(readLocalSessions(paths).flatMap((s) => (s.name ? [s.sessionId, s.name] : [s.sessionId])));
  const waiting = listInbox(paths.inbox).filter((r) => r.state === "accepted" && r.closedAttempt === undefined
    && !live.has(r.toSession) && Date.parse(r.receivedAt) < listedAt);
  // One burst per session and sender. An unknown session is left to the
  // refusal after UNDELIVERABLE_AFTER_MS.
  const bursts = new Map<string, { target: Target; records: InboxRecord[] }>();
  for (const record of waiting) {
    const target = resolveTarget(paths, record.toSession);
    if (!target || live.has(target.sessionId)) continue;
    // #706: retain the baseline miss/age veto and require fresh exact closure.
    // Unknown targets keep their tracking/progress, without enabling fallback.
    if (closedFallbackGeneration(paths, { runtime: target.runtime === "codex" ? "codex" : "claude-code", sessionId: target.sessionId }, now, undefined, deps.livenessAuthority) === null
      || !closedSession(paths, target.sessionId, now)) {
      trackSession(paths, { sessionId: target.sessionId, runtime: target.runtime === "codex" ? CODEX_RUNTIME : CLAUDE_RUNTIME,
        ...(target.cwd ? { cwd: target.cwd } : {}) }, now);
      progressRecords(paths, [record], "waiting", "awaiting-user-turn", now);
      continue;
    }
    const key = `${target.sessionId} ${record.from.nodeId}/${record.from.session}`;
    const burst = bursts.get(key) ?? { target, records: [] };
    burst.records.push(record);
    bursts.set(key, burst);
  }
  // A session gets one run per round; the bursts of other senders wait for the next.
  const handled = new Set<string>();
  for (const { target, records } of bursts.values()) {
    if (handled.has(target.sessionId)) continue;
    try {
      if (await deliver(deps, target, records, now)) handled.add(target.sessionId);
    } catch (error) {
      log(`kherep-node: could not deliver to closed session ${target.sessionId}: ${String((error as Error).message ?? error)}`);
    }
  }
}

// A delegated permission mode the policy allows.
const delegated = (deps: RunnerDeps, mode: unknown): mode is PermissionMode =>
  DELEGATED_PERMISSION_MODES.includes(mode as PermissionMode) && deps.policy.sessions!.permissionModes.includes(mode as PermissionMode);

const runs = async (deps: RunnerDeps, task: TaskRecord): Promise<boolean> =>
  isActive(task) || stillRuns(deps.codex ?? {}, task.pid, task.pidStart);

function marked(deps: RunnerDeps, record: InboxRecord, now: number, toSession?: string): boolean {
  try { markClosedAttempt(deps.paths.inbox, record.messageId, now, toSession); return true; }
  catch (error) { if (!(error instanceof RecordLockBusy)) throw error; skipBusy(deps)(error); return false; }
}

// True when the burst was handed on or a run was started (or tried) for it.
async function deliver(deps: RunnerDeps, found: Target, all: InboxRecord[], now: number): Promise<boolean> {
  const { paths, policy } = deps;
  const sessionId = found.sessionId;
  const target = { runtime: found.runtime === "codex" ? "codex" : "claude-code", sessionId };
  const generation = closedFallbackGeneration(paths, target, now, undefined, deps.livenessAuthority);
  if (generation === null) return false;
  const stillEligible = () => closedFallbackGeneration(paths, target, deps.now?.() ?? Date.now(), generation, deps.livenessAuthority) !== null
    && closedSession(paths, sessionId, deps.now?.() ?? Date.now());
  // Issue #230: each refusal names its code. A policy refusal waits with the
  // code of its guard; only a launch that failed is fallback-failed.
  const refuse = (reason: string, code: MessageProgressCode, records: InboxRecord[] = all): false => {
    progressRecords(paths, records, code === "fallback-failed" ? "failed" : "waiting", code, now);
    audit(paths, now, sessionId, records, "refused", reason);
    return false;
  };
  const sessions = policy.sessions;
  if (fs.existsSync(killSwitch(paths))) return refuse("wake disabled by the kill switch", "wake-disabled");
  if (!sessions?.enabled) return refuse("sessions are not enabled on this node", "wake-disabled");
  if (!sessions.delegate.accept) return refuse("this node does not accept delegated tasks", "wake-not-authorized");
  const local = readLocalSessions(paths);
  const accepted = all.filter((r) => acceptsMessage(policy, r.toSession, r.from.nodeId, local));
  if (accepted.length < all.length) refuse("not accepted by node policy", "wake-not-authorized", all.filter((r) => !accepted.includes(r)));
  const deep = accepted.filter((r) => (r.depth ?? 0) >= MAX_REPLY_DEPTH);
  if (deep.length > 0) refuse("reply depth limit", "reply-limit", deep);
  let records = accepted.filter((r) => !deep.includes(r));
  if (records.length === 0) return false;
  if (bypassesPermissions(found.mode)) return refuse("permission mode bypassPermissions", "permission-restricted");
  // An intercom session answers with msg send, which cannot reach the operator API.
  if (records[0].from.nodeId === OPERATOR_NODE_ID) return refuse("an operator message goes to no intercom session", "wake-not-authorized");
  if (found.task?.operatorStoppedAt !== undefined) return refuse("session stopped by operator", "operator-stopped");
  // Running already: its hook takes the messages.
  if (listTasks(paths).some((t) => t.sessionId === sessionId && isActive(t))) {
    progressRecords(paths, records, "waiting", "target-busy", now);
    return false;
  }
  if (found.task && await runs(deps, found.task)) {
    progressRecords(paths, records, "waiting", "target-busy", now);
    return false;
  }
  if (!stillEligible()) return false;
  const intercom = intercomFor(paths, records[0]);
  if (intercom?.operatorStoppedAt !== undefined) return refuse("intercom session stopped by operator", "operator-stopped");
  const runtime = intercom ? intercom.runtime ?? "claude" : found.runtime;
  if (!sessions.runtimes.includes(runtime)) return refuse(`runtime ${runtime} is not enabled on this node`, "wake-disabled");
  if (intercom && await runs(deps, intercom)) {
    if (!stillEligible()) return false;
    // Its delivery hook, or the wake through its task grant, offers them.
    const linked = attachDelivery(paths, intercom, records.map((r) => r.messageId));
    if (linked !== intercom) writeTask(paths, linked, now);
    for (const r of records) markClosedAttempt(paths.inbox, r.messageId, now, intercom.sessionId ?? intercom.name);
    progressRecords(paths, records, "fallback", "fallback-running", now);
    audit(paths, now, sessionId, records, "reused", "intercom session running", intercom.taskId);
    return true;
  }
  // A new intercom session instead is checked by startTask (admitStart), runtime included.
  // Issue #639: an ended task's stored id keys its turn budget, so only a session reference is resumed.
  const reusable = isSessionRef(intercom?.sessionId) && delegated(deps, intercom.permissionMode) ? intercom : undefined;
  // Issue #197: a runtime that cannot run a turn gets no attempt; its messages
  // are refused with a fixed reason. A pending probe keeps them waiting.
  const blocked = notReadyNow(deps.readiness, reusable ? runtime : found.runtime);
  if (blocked === "pending") {
    progressRecords(paths, records, "waiting", "retry-pending", now);
    return false;
  }
  if (blocked) {
    for (const r of records) markRefused(paths.inbox, r.messageId, blocked);
    audit(paths, now, sessionId, records, "refused", blocked);
    return false;
  }
  // Refused before the attempt, a message is tried again next round, once the limit clears.
  const limit = overLimit(deps, now, reusable?.taskId);
  if (limit) return refuse(limit, "retry-pending");
  const cwd = resolveCwd(sessions, reusable?.cwd ?? found.cwd, deps.realpath);
  // Issue #396: the recorded cwd is unusable here; the policy authorized the sender.
  if (!cwd.ok) return refuse(cwd.reason, "cwd-refused");
  // What admitStart would refuse for a new intercom session, checked here so it reads as policy.
  const mode: PermissionMode = delegated(deps, sessions.defaultPermissionMode) ? sessions.defaultPermissionMode : "default";
  const startRefusal = (): [string, MessageProgressCode] | null => {
    if (!sessions.runtimes.includes(found.runtime)) return [`runtime ${found.runtime} is not enabled on this node`, "wake-disabled"];
    if (!sessions.permissionModes.includes(mode)) return [`permission mode ${mode} is not allowed on this node`, "permission-restricted"];
    return null;
  };
  const before = reusable ? null : startRefusal();
  if (before) return refuse(...before);
  if (!stillEligible()) return false;
  const budget = takeTurn(paths, reusable?.sessionId ?? sessionId, now, wakeBudget(policy));
  if (budget === "spacing" || budget === "locked") {
    progressRecords(paths, records, "waiting", "retry-pending", now);
    return false;
  }
  if (budget === "exhausted") return refuse("budget of autonomous turns exhausted", "budget-exhausted");
  // Issue #627: a record whose lock stays busy is left out of this round, unmarked.
  records = records.filter((r) => marked(deps, r, now, reusable?.sessionId));
  if (records.length === 0) return false;
  progressRecords(paths, records, "fallback", "fallback-starting", now);
  let why = intercom ? "its intercom session cannot be resumed" : undefined;
  if (reusable) {
    const resume = reusable.runtime === "codex" ? resumeCodex : resumeClaude;
    const failed = await resume(deps, reusable, cwd.cwd, records.length, now);
    if (failed === null) {
      const current = readTask(paths, reusable.taskId) ?? reusable;
      const linked = attachDelivery(paths, current, records.map((r) => r.messageId), skipBusy(deps));
      if (linked !== current) writeTask(paths, linked, now);
      progressRecords(paths, records, "fallback", "fallback-running", deps.now?.() ?? now);
      audit(paths, now, sessionId, records, "reused", "intercom session resumed", reusable.taskId);
      return true;
    }
    why = `intercom session not resumed: ${failed}`;
    // The attempt is marked and no round tries the message again, so a start
    // refused now is a failed delivery; the reason keeps the policy (overLimit:
    // maxStartsPerDay, which a resume does not count).
    const refused = startRefusal()?.[0] ?? overLimit(deps, now);
    if (refused) {
      refuse(`${why}; new start refused: ${refused}`, "fallback-failed");
      return true;
    }
  }
  if (!stillEligible()) return false;
  const started = await startIntercom(deps, { sessionId, runtime: found.runtime, cwd: cwd.cwd }, records, mode);
  if (started === null) {
    audit(paths, now, sessionId, records, "new", why);
  } else refuse(`${why ? `${why}; ` : ""}no intercom session: ${started}`, "fallback-failed");
  return true;
}
