import { MESSAGING_LOOP_BRAKE_CAPABILITY } from "../protocol-loop-brake.mts";
import fs from "node:fs";

import { isNodeId, isPhase1Command, isSessionCommand, PHASE1_COMMANDS, type NodeCommand, type Phase1Command } from "../protocol.mts";
import { CLAUDE_MCP_CAPABILITY, REMOTE_MCP_CAPABILITY, type McpRuntime } from "../protocol-mcp.mts";
import {
  isSessionRef, MESSAGING_ACK_CAPABILITY, MESSAGING_CAPABILITY, MESSAGING_PROGRESS_V2_CAPABILITY, OPERATOR_NODE_ID,
} from "../protocol-messages.mts";
import { TASK_CONTROL_CAPABILITY, TASK_CONTROL_REPORT_CAPABILITY } from "../protocol-task-control.mts";
import {
  DELEGATE_ACCEPT_CAPABILITY, DELEGATE_REQUEST_CAPABILITY, RUNTIME_READY_CAPABILITIES, SESSIONS_CAPABILITY, type TaskRuntime,
} from "../protocol-tasks.mts";
import { readConfig, type NodePaths } from "./config.mts";
import { parseSessionsPolicy, type SessionsPolicy } from "./session-policy.mts";

// Local allowlist (issue #5, design section 4). The node refuses any command
// outside this list even when it arrives authenticated from the control plane.
// The effective set is the intersection with the Phase 1 commands, so a policy
// file can narrow what runs here but never widen it.
//
// The optional messaging section (issue #31) lists which senders may leave a
// message for which local session. Without a rule nothing is accepted, also
// in a file without the section (fail closed). DEFAULT_POLICY, which onboarding
// writes into a new file, carries the explicit rule for every sender (issue #390).
export interface AcceptRule { session: string; from: string[] }
// codexApp (issue #82): also wake the current Codex desktop app session (codex-app.mts).
// replies (issue #253): a reply to a message a session sent may wake it (wake-reply.mts).
// nativeQueue (issue #429): the exact-owner native Codex Queue pointer producer (codex-queue-producer.mts), off unless true.
// budget (issue #259): the per-session autonomous-turn budget (autonomy.mts), as written.
// Its defaults (operator decision of 2026-10-12, issue #390) live here, not in
// autonomy.mts, because this file is staged into the messaging client without
// autonomy.mts (claude-mcp-client.mts CLAUDE_CLIENT_GRAPH).
// enabled is kept in the parsed section so that a parsed policy written back
// as JSON is a valid policy file again (onboard.mts writes DEFAULT_POLICY).
export interface TurnBudget { perHour: number; perDay: number; spacingMs: number }
export const DEFAULT_TURN_BUDGET: TurnBudget = { perHour: 20, perDay: 100, spacingMs: 30_000 };
export interface WakeBudget { perHour?: number; perDay?: number; spacingSeconds?: number }
export interface WakePolicy {
  enabled: true; sessions: string[]; codexApp?: boolean; replies?: boolean; nativeQueue?: boolean; budget?: WakeBudget;
  codexFork?: CodexForkPolicy;
}
// codexFork (issue #408): the idle reply proxy (codex-fork-admission.mts), off unless present and valid.
export interface CodexForkPolicy { enabled: true; sessions: string[]; platforms: string[]; idleAfterSeconds: number; maxAnswerBytes: number }
// resumeClosed (issue #102): a message for a known session of this node that
// is no longer running resumes it, or starts an intercom session instead
// (closed-delivery.mts). Only the boolean true enables it.
export interface NodePolicy {
  version: 1;
  allowedCommands: Phase1Command[];
  messaging?: { accept: AcceptRule[]; resumeClosed?: true };
  wake?: WakePolicy;
  sessions?: SessionsPolicy;
  remoteMcp?: { enabled: true; claudeCode?: true };
}

// Issue #390: a policy file without a wake section wakes every session; an
// explicit section, including a disabling one, is honoured as written. Waking
// acts only on messages the messaging section accepted. The accept rule for
// every sender is never implied: it is written into a new file by onboarding
// (DEFAULT_POLICY) and applies to a missing file, so it is a visible choice.
const defaultWake = (): WakePolicy => ({ enabled: true, sessions: ["*"], codexApp: true, replies: true });

export const DEFAULT_POLICY: NodePolicy = { version: 1, allowedCommands: [...PHASE1_COMMANDS],
  messaging: { accept: [{ session: "*", from: ["*"] }] }, wake: defaultWake() };

function denyAll(): NodePolicy {
  return { version: 1, allowedCommands: [] };
}

// A missing file means the default policy. An unreadable or malformed file
// fails closed: nothing is allowed until the operator fixes it.
export function loadPolicy(file: string): NodePolicy {
  return readPolicy(file) ?? denyAll();
}

// The policy, or null for an unreadable or malformed file; a running wake
// listener keeps its last good policy then (wake-hook.mts, issue #213).
// required refuses a missing file as well, for stable-policy admission windows.
export function readPolicy(file: string, required = false): NodePolicy | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) return DEFAULT_POLICY;
    return null;
  }
  try {
    const value = JSON.parse(text) as { version?: unknown; allowedCommands?: unknown; messaging?: unknown; wake?: unknown;
      sessions?: unknown; remoteMcp?: unknown };
    if (value.version !== 1 || !Array.isArray(value.allowedCommands)) return null;
    const accept = parseAcceptRules(value.messaging);
    const wake = value.wake === undefined ? defaultWake() : parseWake(value.wake);
    const sessions = parseSessionsPolicy(value.sessions);
    const remoteMcpValue = value.remoteMcp as { enabled?: unknown; claudeCode?: unknown } | null;
    const remoteMcp = typeof remoteMcpValue === "object" && remoteMcpValue !== null && remoteMcpValue.enabled === true
      ? { enabled: true as const, ...(remoteMcpValue.claudeCode === true ? { claudeCode: true as const } : {}) } : null;
    const resumeClosed = (value.messaging as { resumeClosed?: unknown } | undefined)?.resumeClosed === true;
    return { version: 1, allowedCommands: value.allowedCommands.filter(isPhase1Command),
      ...(accept ? { messaging: { accept, ...(resumeClosed ? { resumeClosed: true as const } : {}) } } : {}),
      ...(wake ? { wake } : {}), ...(sessions ? { sessions } : {}), ...(remoteMcp ? { remoteMcp } : {}) };
  } catch {
    return null;
  }
}

// Session commands run only when the sessions section enables them.
export function isAllowed(policy: NodePolicy, command: unknown): command is NodeCommand {
  if (isSessionCommand(command)) return policy.sessions?.enabled === true;
  return isPhase1Command(command) && policy.allowedCommands.includes(command);
}

const isSender = (value: unknown): boolean => value === "*" || value === OPERATOR_NODE_ID || isNodeId(value);

// A malformed messaging section disables messaging as a whole (fail closed);
// the command allowlist is unaffected.
function parseAcceptRules(section: unknown): AcceptRule[] | null {
  if (typeof section !== "object" || section === null) return null;
  const accept = (section as { accept?: unknown }).accept;
  if (!Array.isArray(accept)) return null;
  const rules: AcceptRule[] = [];
  for (const rule of accept) {
    const { session, from } = (rule ?? {}) as { session?: unknown; from?: unknown };
    if (!isSessionRef(session) || !Array.isArray(from) || from.length === 0 || !from.every(isSender)) return null;
    rules.push({ session, from: [...from] as string[] });
  }
  return rules.length > 0 ? rules : null;
}

export function messagingEnabled(policy: NodePolicy): boolean {
  return (policy.messaging?.accept.length ?? 0) > 0;
}

export function mcpRuntimeEnabled(policy: NodePolicy, runtime: unknown): runtime is McpRuntime {
  if (policy.remoteMcp?.enabled !== true) return false;
  if (runtime === "codex") return true;
  return runtime === "claude-code" && policy.remoteMcp.claudeCode === true;
}

// What this node advertises in register: its allowed commands, plus
// messaging.v1 only when at least one accept rule exists, always
// messaging.ack.v1 (every node acknowledges the final statuses of the
// messages it sent, issue #308) and messaging.progress.v2 (it reads every
// progress code, issue #396), and the session capabilities its sessions
// section enables. ready: the runtimes whose last readiness probe passed
// (issue #197), advertised only while enabled.
export function advertisedCapabilities(policy: NodePolicy, ready: readonly TaskRuntime[] = []): string[] {
  const s = policy.sessions;
  return [...policy.allowedCommands, ...(messagingEnabled(policy) ? [MESSAGING_CAPABILITY] : []), MESSAGING_ACK_CAPABILITY,
    MESSAGING_PROGRESS_V2_CAPABILITY, MESSAGING_LOOP_BRAKE_CAPABILITY, ...(s?.enabled ? [SESSIONS_CAPABILITY] : []), ...(s?.delegate.accept ? [DELEGATE_ACCEPT_CAPABILITY] : []),
    ...(s?.delegate.request ? [DELEGATE_REQUEST_CAPABILITY] : []),
    ...(s?.ownTaskControl && s.runtimes.length > 0 ? [TASK_CONTROL_CAPABILITY, TASK_CONTROL_REPORT_CAPABILITY] : []),
    ...(mcpRuntimeEnabled(policy, "codex") ? [REMOTE_MCP_CAPABILITY] : []),
    ...(mcpRuntimeEnabled(policy, "claude-code") ? [CLAUDE_MCP_CAPABILITY] : []),
    ...(s?.enabled ? ready.filter((r) => s.runtimes.includes(r)).map((r) => RUNTIME_READY_CAPABILITIES[r]) : [])];
}

// session "*" matches any local session, from "*" any sender. Otherwise both
// match exactly: the session reference the sender addressed, or the id or
// current name of the local session it names (sessions: the last local
// listing), and the sender node id or "operator".
export function acceptsMessage(policy: NodePolicy, toSession: string, fromNodeId: string,
  sessions: { sessionId: string; name?: string }[] = []): boolean {
  const local = sessions.find((s) => s.sessionId === toSession || s.name === toSession);
  const refs = local ? [toSession, local.sessionId, ...(local.name ? [local.name] : [])] : [toSession];
  return (policy.messaging?.accept ?? []).some((rule) =>
    (rule.session === "*" || refs.includes(rule.session)) && (rule.from.includes("*") || rule.from.includes(fromNodeId)));
}

// The optional wake section (issue #31): waking idle sessions is on by default
// (operator decision 2026-10-12, issue #390: an absent section is defaultWake)
// and an operator opts out explicitly. A present section with anything but
// enabled true and a non-empty list of session ids or names disables it (fail
// closed); "*" matches every session. codexApp and
// replies must be booleans when present; with either true the list may be
// empty or absent. nativeQueue must be a boolean when present and grants
// nothing (issue #429). A budget that parseBudget rejects disables it as well.
// A codexFork section that parseCodexFork rejects is left out (issue #408).
function parseWake(section: unknown): WakePolicy | null {
  if (typeof section !== "object" || section === null) return null;
  const { enabled, sessions, codexApp, replies, nativeQueue, budget: rawBudget, codexFork: rawFork } = section as { enabled?: unknown;
    sessions?: unknown; codexApp?: unknown; replies?: unknown; nativeQueue?: unknown; budget?: unknown; codexFork?: unknown };
  if (enabled !== true || [codexApp, replies, nativeQueue].some((flag) => flag !== undefined && typeof flag !== "boolean")) return null;
  const budget = rawBudget === undefined ? undefined : parseBudget(rawBudget);
  if (budget === null) return null;
  const granted = codexApp === true || replies === true;
  const list = sessions === undefined && granted ? [] : sessions;
  if (!Array.isArray(list) || !list.every(isSessionRef) || (list.length === 0 && !granted)) return null;
  const codexFork = parseCodexFork(rawFork);
  return { enabled: true, sessions: [...list] as string[], ...(codexApp ? { codexApp: true } : {}), ...(replies ? { replies: true } : {}),
    ...(nativeQueue ? { nativeQueue: true } : {}), ...(budget ? { budget } : {}), ...(codexFork ? { codexFork } : {}) };
}

// Decision D4 (2026-10-16, issue #408): full Codex thread ids only; no "*" and no
// names, because a fork reads the whole history of the chat. Matched without
// case and kept in lowercase, the form of a Codex thread id, so that admission
// compares exactly.
const FORK_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Decision D5: darwin only until the Windows measurements (design section 3.2, PR 5).
const FORK_PLATFORMS = ["darwin"];
const FORK_NUMBERS = { idleAfterSeconds: { min: 30, max: 3600, fallback: 90 }, maxAnswerBytes: { min: 256, max: 8192, fallback: 4096 } };
const FORK_KEYS = ["enabled", "sessions", "platforms", ...Object.keys(FORK_NUMBERS)];

// Only the known keys, enabled true, a non-empty list of full ids, platforms
// from FORK_PLATFORMS and integers within FORK_NUMBERS; anything else is null,
// which turns the fork reply off and leaves the rest of wake as written.
function parseCodexFork(value: unknown): CodexForkPolicy | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !FORK_KEYS.includes(key))) return null;
  const { enabled, sessions, platforms = FORK_PLATFORMS } = fields;
  if (enabled !== true || !Array.isArray(sessions) || sessions.length === 0
    || !sessions.every((id) => typeof id === "string" && FORK_SESSION.test(id))) return null;
  if (!Array.isArray(platforms) || platforms.length === 0 || !platforms.every((p) => FORK_PLATFORMS.includes(p))) return null;
  const number = (key: keyof typeof FORK_NUMBERS): number | null => {
    const { min, max, fallback } = FORK_NUMBERS[key];
    const n = fields[key] === undefined ? fallback : fields[key];
    return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  const idleAfterSeconds = number("idleAfterSeconds"), maxAnswerBytes = number("maxAnswerBytes");
  if (idleAfterSeconds === null || maxAnswerBytes === null) return null;
  return { enabled: true, sessions: [...new Set((sessions as string[]).map((id) => id.toLowerCase()))],
    platforms: [...new Set(platforms as string[])], idleAfterSeconds, maxAnswerBytes };
}

// Hard bounds (issue #259), so that a policy can loosen the budget but never remove it.
const BUDGET_BOUNDS: Record<keyof WakeBudget, [number, number]> = { perHour: [1, 60], perDay: [1, 500], spacingSeconds: [5, 3600] };

// Only the known keys, each an integer within its bounds, and an explicit
// perDay at least an explicit perHour; anything else is null. Without perDay
// the day allows at least perHour turns, so perHour alone never disables
// waking; perDay alone caps the day, also below the default hour (issue #390).
function parseBudget(value: unknown): WakeBudget | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const budget: WakeBudget = {};
  for (const [key, field] of Object.entries(value)) {
    const name = key as keyof WakeBudget;
    const bounds = Object.hasOwn(BUDGET_BOUNDS, name) ? BUDGET_BOUNDS[name] : null;
    if (!bounds || !Number.isInteger(field) || field < bounds[0] || field > bounds[1]) return null;
    budget[name] = field;
  }
  return budget.perDay === undefined || budget.perHour === undefined || budget.perDay >= budget.perHour ? budget : null;
}

const turnBudget = (budget: WakeBudget): TurnBudget => ({
  perHour: budget.perHour ?? DEFAULT_TURN_BUDGET.perHour,
  perDay: budget.perDay ?? Math.max(DEFAULT_TURN_BUDGET.perDay, budget.perHour ?? 0),
  spacingMs: budget.spacingSeconds === undefined ? DEFAULT_TURN_BUDGET.spacingMs : budget.spacingSeconds * 1000,
});

// The effective autonomous-turn budget: wake.budget, its missing fields and a
// missing or rejected wake section falling back to DEFAULT_TURN_BUDGET.
export const wakeBudget = (policy: NodePolicy): TurnBudget => turnBudget(policy.wake?.budget ?? {});

// For a hook process, which has no policy loaded: the node's policy file, read
// once when a Stop would continue the turn. A node.json that cannot be read
// leaves the defaults, as an unreadable policy does.
export function nodeWakeBudget(paths: NodePaths): TurnBudget {
  let file: string;
  try {
    file = readConfig(paths.config)?.policyFile ?? paths.policy;
  } catch {
    return DEFAULT_TURN_BUDGET;
  }
  return wakeBudget(loadPolicy(file));
}

// refs: the session id and its current name, if any.
export function wakeAllowed(policy: NodePolicy, refs: string[]): boolean {
  const sessions = policy.wake?.sessions ?? [];
  return sessions.includes("*") || refs.some((ref) => sessions.includes(ref));
}

// Listed by id or name, not only through "*".
export function explicitlyListed(policy: NodePolicy, refs: string[]): boolean {
  return refs.some((ref) => policy.wake?.sessions.includes(ref));
}
