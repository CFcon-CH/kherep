#!/usr/bin/env node
import { resolveWakeSelection } from "./wake-bindings.mts";
import { readBindingView } from "./session-labels.mts";
import fs from "node:fs";
import path from "node:path";

import {
  armedIdle, audit, bypassesPermissions, isPlainSessionId, listenerDir, listenerLock, modeFile, parentWatch, recordScope, rememberedMode,
  rememberMode, takeTurn, wakeAudit, type ListenerLock, type ListenerScope, type WakeGrant,
} from "./autonomy.mts";
import { ensureDir, nodePaths, readConfig, type NodePaths } from "./config.mts";
import { REOFFER_AFTER_MS } from "./deliver-core.mts";
import { isMainModule } from "./deliver-hook.mts";
import { localSessionName } from "./exchange.mts";
import { headlessMode, type RunMode } from "./headless-mode.mts";
import { getMessage, readJson, writeJsonAtomic } from "./inbox.mts";
import { launchMode, type LaunchVerdict } from "./launch-mode.mts";
import { armedSince, armingMark, nextOrder, orderOf, reclaimLock } from "./listener-order.mts";
import { releaseOwn } from "./listener-sweep.mts";
import { loadPolicy, readPolicy, wakeBudget } from "./policy.mts";
import { mappingPending, taskForSession, type TaskRecord } from "./task-records.mts";
import { transcriptMode } from "./transcript-mode.mts";
import { atReplyLimit, markWoken, pending, rememberWoken } from "./wake-pending.mts";
import { auditGranted, unlistedGrants } from "./wake-reply.mts";

// Wakes an idle Claude Code session when a peer message arrives (issue #31).
// Installed with "asyncRewake": true on SessionStart, UserPromptSubmit and
// Stop, with the same number as "timeout" and as --timeout. Contract, from
// https://code.claude.com/docs/en/hooks (fetched 2026-10-21):
// - asyncRewake "runs in the background and wakes Claude on exit code 2. The
//   hook's stderr, or stdout if stderr is empty, is shown to Claude as a
//   system reminder" ("Command hook fields").
// - "an asyncRewake hook that exits with code 2 wakes Claude immediately even
//   when the session is idle" ("Limitations"), and "Claude Code still enforces
//   timeout on a hook you run with asyncRewake" ("Configure an async hook").
// - "Each execution creates a separate background process" ("Limitations"),
//   so each arming takes over a per-session lock and the listener it
//   replaces, recognising a foreign token, stands down by itself.
// - UserPromptSubmit hooks default to a 30 s timeout ("UserPromptSubmit"), so
//   that entry states its timeout explicitly.
// Measured on Claude Code 2.1.273 (macOS, 2026-09-25): the woken turn fires
// UserPromptSubmit with the wake text as prompt, so the delivery hook offers
// the messages at its start (its Stop is the fallback). At the timeout Claude
// Code kills the listener without waking the session, which would leave it
// deaf, so the listener wakes it itself shortly before, and that turn re-arms.
// Arming at UserPromptSubmit too keeps a listener after a turn that ends
// without Stop (StopFailure, user interrupt). SessionStart "Runs when Claude
// Code starts a new session or resumes an existing session", with source
// startup, resume, clear, compact or fork (fetched 2026-09-27). Arming there
// keeps an idle session wakeable after its process restarts (issue #97); the
// session counts as idle, except after compact, which can run inside a turn.
// Its input carries no permission_mode (measured on Claude Code 2.1.258), so
// it arms only with a stored mode other than bypassPermissions (the last
// prompt or Stop reported it, else the session transcript: transcript-mode.mts,
// issue #101), a session listed by id or name, not through "*", and settings
// and launch flags that point to no bypass (launch-mode.mts); otherwise it
// refuses, fail closed. There it also wakes once for messages that arrived
// while no listener ran (wake-pending.mts). Waking is opt-in
// (policy.mts wake section) and budgeted with Stop continuations
// (autonomy.mts). The texts are fixed and carry no peer content.
// A wake leaves listeners/<session_id>.woke.json for the woken turn (wake-pending.mts markWoken, issue #417).
// "In non-interactive mode with the -p flag, Claude Code kills any async hook
// still running at teardown" ("Run hooks in the background", fetched
// 2026-10-05), yet on Claude Code 2.1.289 (Windows, 2026-10-05) a claude -p run
// hung until the listener's timeout. A headless session can never be woken: its
// listener arms as any other, so the arming order holds (listener-order.mts),
// learns the run mode before its first poll (headless-mode.mts, kept per Claude
// Code process in run-modes/, issue #245) and then removes its own files and
// exits 0 (issue #235).

export { listenerDir, wakeAudit };
export { WAKE_BACKLOG_AFTER_MS, WAKE_GRACE_MS } from "./wake-pending.mts";
export const WAKE_POLL_MS = 2_000;
// Pause between finding a waiting message and re-reading its state, so an
// offer made meanwhile by a delivery hook is seen.
export const WAKE_SETTLE_MS = 250;
// The default timeout; the listener re-arms WAKE_REARM_EARLY_MS before it.
// Longer than the rolling 24-hour budget window, still a finite hook lifetime.
export const WAKE_TIMEOUT_S = 90_000;
const WAKE_REARM_EARLY_MS = 60_000;
export const WAKE_MAX_WAIT_MS = WAKE_TIMEOUT_S * 1000 - WAKE_REARM_EARLY_MS;

export const wakeText = (count: number): string =>
  `Kherep: ${count} new message(s) from other agent sessions arrived. They are delivered in this turn.`;
export const STUCK_TEXT = "Kherep: a message offered in an earlier turn may not have been read. It is offered again in this turn.";
export const REARM_TEXT = "Kherep: message listener re-armed.";

export interface WakeDeps {
  paths: NodePaths; now?: () => number; sleep?: (ms: number) => Promise<void>; pid?: number; maxWaitMs?: number;
  parentAlive?: () => boolean; token?: () => string; launchMode?: (cwd: unknown) => Promise<LaunchVerdict>;
  transcriptMode?: (transcriptPath: unknown) => string | undefined; runMode?: () => Promise<RunMode>;
}

export const killSwitch = (paths: NodePaths): string => path.join(paths.dir, "wake.disabled");

// The wait before the self re-arm for the hook's arguments: --timeout
// <seconds>, the number its settings entry carries as timeout. Without the flag
// the default; a value too small for the re-arm margin is null.
export function wakeMaxWaitMs(argv: string[]): number | null {
  const at = argv.indexOf("--timeout");
  if (at < 0) return WAKE_MAX_WAIT_MS;
  const seconds = Number(argv[at + 1]);
  return Number.isInteger(seconds) && seconds * 1000 > 2 * WAKE_REARM_EARLY_MS ? seconds * 1000 - WAKE_REARM_EARLY_MS : null;
}

type WakeResult = { code: 0 } | { code: 2; text: string };

// Resolves to 2 with a fixed text when it wakes the session, otherwise 0.
export async function runWake(input: unknown, deps: WakeDeps): Promise<WakeResult> {
  const quiet = { code: 0 } as const;
  const { session_id: sessionId, hook_event_name: event, permission_mode: given, source, cwd, transcript_path: transcript } =
    (input ?? {}) as Record<string, unknown>;
  if (!isPlainSessionId(sessionId) || (event !== "Stop" && event !== "UserPromptSubmit" && event !== "SessionStart")) return quiet;
  const { paths } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!fs.existsSync(paths.config)) return quiet;
  if (fs.existsSync(killSwitch(paths))) {
    audit(paths, now(), sessionId, [], "disabled");
    return quiet;
  }
  // No wake section, or a malformed one, and no task grant: this node does not
  // wake the session. Task grant (item 5): a session this node started for a
  // task may be woken by messages of that task, listed or not; the budget and
  // the permission mode below still apply.
  // A session this node is starting or resuming may arm before the node has
  // mapped its id (a copy after a resume gets a new one, issue #109): while a
  // task record in the same directory waits for its mapping, the listener
  // waits too and looks the grant up again at each poll. The grant itself
  // only ever comes from the session id the node recorded. With wake.replies an
  // unlisted session stays armed for replies to its own messages and messages
  // of tasks it requested (wake-reply.mts).
  const policyFile = readConfig(paths.config)?.policyFile ?? paths.policy;
  let policy = loadPolicy(policyFile);
  const grantFor = (): TaskRecord | undefined => policy.sessions?.enabled ? taskForSession(paths, sessionId) ?? undefined : undefined;
  const mapping = (): boolean => policy.sessions?.enabled === true && mappingPending(paths, cwd, now());
  let grant = grantFor();
  if (!policy.wake && !grant && !mapping()) return quiet;
  const refsOf = (): string[] => {
    const name = localSessionName(paths, sessionId);
    return name === undefined ? [sessionId] : [sessionId, name];
  };
  let refs = refsOf();
  const binding=()=>({target:{runtime:"claude-code",sessionId},view:readBindingView(paths,now()),now:now()});
  const replies = (): boolean => policy.wake?.replies === true;
  let listed = resolveWakeSelection(policy.wake?.sessions ?? [], binding()).allowed;
  let wasListed = listed || replies();
  // Audited once, when the listener gives up; without a wake section quietly,
  // as before, unless the section was withdrawn from a listed or reply-scoped session (issue #213).
  const unlisted = (): WakeResult => {
    if (policy.wake || wasListed) audit(paths, now(), sessionId, [], "not-allowlisted");
    return quiet;
  };
  if (!listed && !grant && !replies() && !mapping()) return unlisted();
  const starting = event === "SessionStart";
  let mode = given ?? (starting ? rememberedMode(paths, sessionId) : undefined);
  if (starting && mode === undefined) mode = (deps.transcriptMode ?? transcriptMode)(transcript);
  const hadMode = fs.existsSync(modeFile(paths, sessionId));
  rememberMode(paths, sessionId, mode);
  if (bypassesPermissions(mode)) {
    audit(paths, now(), sessionId, [], "permission-mode");
    return quiet;
  }
  const lockFile = listenerLock(paths, sessionId);
  const armedAt = now();
  const mark = armingMark(paths, sessionId);
  if (starting && given === undefined) {
    // No permission_mode in the input: every source must rule bypass out.
    const bindingVersion=readBindingView(paths,now()).version;
    const launch = mode !== undefined && resolveWakeSelection(policy.wake?.sessions ?? [], binding()).explicit ? await (deps.launchMode ?? launchMode)(cwd) : "unknown";
    if (bindingVersion!==readBindingView(paths,now()).version || launch !== "ok") {
      audit(paths, now(), sessionId, [], launch === "bypass" ? "permission-mode" : "permission-mode-unknown");
      return quiet;
    }
    // A prompt or Stop armed during the check: its listener is the newer one.
    if (armedSince(paths, sessionId, mark)) {
      audit(paths, now(), sessionId, [], "superseded");
      return quiet;
    }
  }
  const mine: ListenerLock = { token: deps.token?.() ?? crypto.randomUUID(), pid: deps.pid ?? process.pid, startedAt: armedAt,
    order: nextOrder(paths, sessionId, armedAt), event, ...(starting && typeof source === "string" ? { source } : {}) };
  ensureDir(listenerDir(paths));
  const scope = (): ListenerScope => ({ token: mine.token, listed, ...(grant ? { taskId: grant.taskId } : {}),
    ...(replies() ? { replies: true as const } : {}), order: mine.order });
  // Before the lock, so a lock with this token always has its scope.
  recordScope(paths, sessionId, scope());
  writeJsonAtomic(lockFile, mine);
  // A check that fails decides nothing. A newer listener keeps its files and the mode.
  const runMode = deps.runMode ?? (() => headlessMode({ cache: { dir: path.join(paths.dir, "run-modes"), sessionId } }));
  if (await runMode().catch(() => "unknown") === "headless") {
    if (releaseOwn(paths, sessionId, mine.token, now()) && !hadMode) fs.rmSync(modeFile(paths, sessionId), { force: true });
    audit(paths, now(), sessionId, [], "headless");
    return quiet;
  }
  const deadline = mine.startedAt + (deps.maxWaitMs ?? WAKE_MAX_WAIT_MS);
  const expiresAt = deadline + WAKE_REARM_EARLY_MS - WAKE_POLL_MS;
  const parentAlive = deps.parentAlive ?? parentWatch();
  const release = (): void => fs.rmSync(lockFile, { force: true });
  const limited = new Set<string>();
  let unreadable = false;
  let budgetAudited = false;
  let last = mine;
  for (;;) {
    await sleep(Math.min(WAKE_POLL_MS, Math.max(0, expiresAt - now())));
    // The daemon's sweep may hold the lock aside for a moment (issue #225).
    const held = readJson<ListenerLock>(lockFile) ?? reclaimLock(paths, sessionId, last);
    if (!held) { audit(paths, now(), sessionId, [], "superseded"); return quiet; }
    // Identity is the token, never the pid, and a replaced listener only ends itself.
    if (held.token !== mine.token) {
      // An older listener filled a gap (a sweep held this lock aside): take lock and scope back (listener-order.mts).
      if (orderOf(held) < orderOf(mine)) {
        recordScope(paths, sessionId, scope());
        writeJsonAtomic(lockFile, last);
        continue;
      }
      audit(paths, now(), sessionId, [], "superseded");
      return quiet;
    }
    last = held;
    if (now() >= expiresAt) {
      release();
      audit(paths, now(), sessionId, [], "listener-timeout");
      return quiet;
    }
    if (!parentAlive()) {
      release();
      audit(paths, now(), sessionId, [], "parent-gone");
      return quiet;
    }
    // Read at every poll, so a policy change reaches a running listener (issue
    // #213). An unreadable file keeps the last good policy, audited once;
    // SessionStart's explicit listing is checked only when arming.
    const current = readPolicy(policyFile);
    if (current === null && !unreadable) audit(paths, now(), sessionId, [], "policy-unreadable");
    unreadable = current === null;
    policy = current ?? policy;
    if (policy.sessions?.enabled !== true) grant = undefined;
    refs=refsOf();
    listed = resolveWakeSelection(policy.wake?.sessions ?? [], binding()).allowed;
    wasListed ||= listed || replies();
    if (!listed && !grant) {
      grant = grantFor();
      if (grant) refs = refsOf();
      else if (!replies()) {
        if (now() >= deadline || !mapping()) {
          release();
          return unlisted();
        }
        continue;
      }
    }
    recordScope(paths, sessionId, scope());
    // Armed at UserPromptSubmit or compaction, the session is busy until
    // StopFailure marks the listener idle or the turn cannot still run; a turn
    // that ends with Stop replaces this listener.
    const idle = armedIdle(held) || held.idleAt !== undefined || now() >= mine.startedAt + REOFFER_AFTER_MS;
    const granted = listed ? undefined : unlistedGrants(paths, policy, refs, grant, now());
    const found = idle ? pending(paths, refs, sessionId, mine, now(), granted?.grants) : { fresh: [], backlog: [], stuck: [] };
    const deep = [...found.fresh, ...found.backlog].filter((r) => atReplyLimit(r) && !limited.has(r.messageId));
    if (deep.length > 0) {
      audit(paths, now(), sessionId, deep.map((r) => r.messageId), "depth-limit");
      for (const r of deep) limited.add(r.messageId);
    }
    const below = (records: typeof found.fresh): string[] => records.filter((r) => !atReplyLimit(r)).map((r) => r.messageId);
    let fresh = below(found.fresh);
    let backlog = below(found.backlog);
    let stuck = found.stuck;
    if (fresh.length + backlog.length + stuck.length > 0) {
      // A delivery hook may be offering them right now; wake only for what still waits.
      const version=readBindingView(paths,now()).version;
      await sleep(WAKE_SETTLE_MS);
      if(version!==readBindingView(paths,now()).version || current && readPolicy(policyFile) && JSON.stringify(readPolicy(policyFile))!==JSON.stringify(policy)) continue;
      const still = (state: string) => (id: string): boolean => getMessage(paths.inbox, id)?.state === state;
      fresh = fresh.filter(still("accepted"));
      backlog = backlog.filter(still("accepted"));
      stuck = stuck.filter(still("offered"));
    }
    const messages = fresh.length + backlog.length;
    let due: "wake" | "rearm";
    if (messages + stuck.length > 0) due = "wake";
    else if (now() >= deadline) due = "rearm";
    else continue;
    const budget = takeTurn(paths, sessionId, now(), wakeBudget(policy));
    // Too soon after the last autonomous turn, or the budget was locked: try again at the next poll.
    if (budget !== "ok") {
      if (budget === "exhausted" && !budgetAudited) {
        audit(paths, now(), sessionId, [...fresh, ...backlog, ...stuck], "budget");
        budgetAudited = true;
      }
      // Transient contention or spacing may clear within the existing rearm
      // margin. Exhaustion also retains the owner lock until a real exit.
      continue;
    }
    budgetAudited = false;
    release();
    if (due === "rearm") {
      audit(paths, now(), sessionId, [], "rearm");
      return { code: 2, text: REARM_TEXT };
    }
    if (backlog.length + stuck.length > 0) rememberWoken(paths, sessionId, [...backlog, ...stuck]);
    const kinds: ReadonlyMap<string, WakeGrant> = granted?.kinds ?? new Map();
    auditGranted(paths, now(), sessionId, stuck, "stuck-offer", kinds);
    auditGranted(paths, now(), sessionId, backlog, "backlog", kinds);
    auditGranted(paths, now(), sessionId, fresh, "wake", kinds);
    try {
      markWoken(paths, sessionId, mine.token, [...fresh, ...backlog, ...stuck], now());
    } catch {
      // the woken turn's offers then read "prompt"; the wake itself goes ahead
    }
    return { code: 2, text: messages > 0 ? wakeText(messages) : STUCK_TEXT };
  }
}

if (isMainModule(import.meta.url)) {
  let stdin = "";
  try {
    stdin = fs.readFileSync(0, "utf8");
  } catch {
    // no input: nothing to listen for
  }
  const maxWaitMs = wakeMaxWaitMs(process.argv.slice(2));
  // Any failure, malformed input or --timeout included, ends quietly with exit 0.
  Promise.resolve().then(() => maxWaitMs === null ? { code: 0 } as const
    : runWake(JSON.parse(stdin || "null"), { paths: nodePaths(), maxWaitMs })).then((result) => {
    if (result.code === 2) process.stderr.write(`${result.text}\n`);
    process.exitCode = result.code;
  }, () => { process.exitCode = 0; });
}
