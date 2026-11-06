#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { markListenerIdle, mayContinue } from "./autonomy.mts";
import { nodePaths, readConfig } from "./config.mts";
import { isCodexSessionId } from "./codex-sessions.mts";
import { reconcileNativeQueues } from "./codex-native-reconcile.mts";
import { CODEX_FORK_ENV, deliverForCodex } from "./deliver-codex.mts";
import {
  contextOutput, deliveryContext, RECORD_LOCK_BUDGET_MS, retryOffered, sessionInbox, type HookDeps,
} from "./deliver-core.mts";
import { midTurnOutput, withMidTurnLock } from "./deliver-midturn.mts";
import { localSessionName } from "./exchange.mts";
import { withRecordLockBudget } from "./inbox-record-lock.mts";
import { appendRenameHint, renameOwner } from "./rename-notices.mts";
import { nodeWakeBudget } from "./policy.mts";
import { claimWake } from "./wake-pending.mts";

// Claude Code hook that hands inbox messages to their session (issue #31,
// step 3a). Contract, from https://code.claude.com/docs/en/hooks (fetched
// 2026-09-25):
// - Input: JSON on stdin with the common fields session_id and hook_event_name
//   ("Common input fields"); Stop adds stop_hook_active ("Stop input").
//   permission_mode is the current permission mode, "bypassPermissions" among
//   them ("Common input fields"); it gates Stop continuations (autonomy.mts).
// - UserPromptSubmit: exit 0 with {"hookSpecificOutput": {"hookEventName":
//   "UserPromptSubmit", "additionalContext": "..."}} adds the string to
//   Claude's context alongside the prompt ("UserPromptSubmit decision control").
// - Stop: hookSpecificOutput.additionalContext is "non-error feedback for
//   Claude. The conversation continues so Claude can act on it", under the
//   same loop protections as decision "block" ("Stop decision control").
// - Exit 0 without output means no decision; stderr of an exit-0 hook goes to
//   the debug log only ("Exit code 0").
// - additionalContext is capped at 10,000 characters; longer text is moved to
//   a file ("JSON output"). The 8 KB budget below stays under that cap.
// - PostToolUse: hookSpecificOutput.additionalContext is "added to Claude's
//   context alongside the tool result" (fetched 2026-10-12); it carries peer
//   messages into a running turn, see deliver-midturn.mts (issue #388).
// - Stop "Does not run if the stoppage occurred due to a user interrupt. API
//   errors fire StopFailure instead" ("Stop").
// - StopFailure "Runs instead of Stop when the turn ends due to an API error";
//   Claude Code ignores its output and exit code ("StopFailure").
// The hook never reads the UserPromptSubmit `prompt` field: a woken turn is
// recognised by the wake listener's marker (wake-pending.mts claimWake, issue #417).
// The offer-and-confirm delivery itself lives in deliver-core.mts; with
// --runtime codex the same entry point serves Codex (deliver-codex.mts).

export { MAX_CONTEXT_BYTES, MAX_MESSAGES_PER_CALL, MAX_OFFERS, REOFFER_AFTER_MS, type HookDeps } from "./deliver-core.mts";

export type HookRuntime = "claude" | "codex";

// The hook's stdout for one input: empty when there is nothing to deliver.
// PostToolUse offers new arrivals inside the running turn (deliver-midturn.mts).
// StopFailure only flags this session's offered records for a new offer and
// tells a listener armed at UserPromptSubmit that the turn has ended.
export function deliverForHook(input: unknown, deps: HookDeps): string {
  if (typeof input !== "object" || input === null) return "";
  const fields = input as Record<string, unknown>;
  const { hook_event_name: event, session_id: sessionId, permission_mode: mode } = fields;
  if ((event !== "UserPromptSubmit" && event !== "Stop" && event !== "StopFailure" && event !== "PostToolUse")
    || typeof sessionId !== "string" || sessionId === "") return "";
  const name = localSessionName(deps.paths, sessionId);
  const refs = name === undefined ? [sessionId] : [sessionId, name];
  if (event === "PostToolUse") return midTurnOutput(fields, sessionId, refs, deps);
  const now = deps.now?.() ?? Date.now();
  if (event === "StopFailure") {
    withRecordLockBudget(RECORD_LOCK_BUDGET_MS, () => retryOffered(deps.paths, sessionInbox(deps.paths, refs, { sessionId, runtime: "claude-code" })));
    markListenerIdle(deps.paths, sessionId, now);
    return "";
  }
  // A Stop continuation is an autonomous turn: budget and permission mode gate it.
  // A prompt that claims the wake listener's marker opened a woken turn (issue #417).
  let gated: HookDeps = deps;
  if (event === "Stop") {
    gated = { ...deps, mayContinue: (ids) => mayContinue(deps.paths, sessionId, mode, ids, now, nodeWakeBudget(deps.paths)) };
  } else if (claimWake(deps.paths, sessionId, now)) {
    gated = { ...deps, offeredBy: "wake" };
  }
  let context = deliveryContext(event, refs, { ...gated, owner: { sessionId, runtime: "claude-code" } });
  const owner = event === "UserPromptSubmit" ? renameOwner(fields) : undefined;
  if (owner) {
    try { context = withMidTurnLock(deps.paths, owner, () => appendRenameHint(deps.paths, owner, context, deps.maxBytes)) ?? context; }
    catch { /* Optional display work cannot suppress ordinary prompt context. */ }
  }
  return contextOutput(event, context);
}

// The runtime a command line names: --runtime codex, otherwise Claude Code.
// Any other --runtime value is null, so a typo is reported, not guessed.
export function hookRuntime(argv: string[]): HookRuntime | null {
  const at = argv.indexOf("--runtime");
  if (at < 0) return "claude";
  return argv[at + 1] === "codex" ? "codex" : null;
}

// Never fails the hook: any error ends with exit 0, no stdout and one line on
// stderr, which Claude Code writes to its debug log.
export function runHook(stdin: string, deps: HookDeps, write: (text: string) => void, warn: (line: string) => void,
  runtime: HookRuntime = "claude"): void {
  try {
    const input: unknown = JSON.parse(stdin);
    const output = runtime === "codex" ? deliverForCodex(input, deps) : deliverForHook(input, deps);
    if (output) write(output);
  } catch (error) {
    warn(`kherep deliver-hook: ${String((error as Error).message ?? error)}`);
  }
}

// Confirm first, then await exact native pointer retirement before Stop returns.
// Legacy bindings remain outside the native attempt reconciliation namespace.
export async function runCodexHook(stdin: string, deps: HookDeps, write: (text: string) => void,
  warn: (line: string) => void,
  reconcile: (owner: string) => Promise<void> = (owner) => reconcileNativeQueues(deps.paths, owner)): Promise<void> {
  runHook(stdin, deps, write, warn, "codex");
  // A hook of a Codex fork helper reconciles nothing (issue #408).
  if (process.env[CODEX_FORK_ENV] === "1") return;
  try {
    const input: unknown = JSON.parse(stdin);
    if (typeof input !== "object" || input === null) return;
    const { hook_event_name: event, session_id: owner } = input as Record<string, unknown>;
    if (event === "Stop" && isCodexSessionId(owner) && readConfig(deps.paths.config)) await reconcile(owner);
  } catch {
    warn("kherep deliver-hook: native queue reconciliation pending");
  }
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
// url: the import.meta.url of the module asking.
export function isMainModule(url: string): boolean {
  const entry = process.argv[1] || "";
  try {
    return url === pathToFileURL(path.resolve(entry)).href || url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  let stdin = "";
  try {
    stdin = fs.readFileSync(0, "utf8");
  } catch (error) {
    process.stderr.write(`kherep deliver-hook: cannot read stdin: ${String(error)}\n`);
  }
  const runtime = hookRuntime(process.argv.slice(2));
  if (!runtime) process.stderr.write("kherep deliver-hook: unknown --runtime; expected codex\n");
  else if (stdin && runtime === "codex") await runCodexHook(stdin, { paths: nodePaths() },
    (text) => process.stdout.write(text), (line) => process.stderr.write(`${line}\n`));
  else if (stdin) runHook(stdin, { paths: nodePaths() }, (text) => process.stdout.write(text),
    (line) => process.stderr.write(`${line}\n`), runtime);
  process.exitCode = 0;
}
