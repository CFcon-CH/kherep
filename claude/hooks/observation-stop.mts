#!/usr/bin/env node
/**
 * observation-stop.mts  -  Stop hook (session observation enforcement)
 *
 * ROUTING.md "Session observations": after a completed turn the Maestro
 * dispatches claude-obs with an explicit model. Nothing enforced that on Claude,
 * so it was skipped. This hook sends a substantial turn back ONCE with a fixed
 * instruction when that turn neither dispatched claude-obs nor opted out with
 * [obs: none – <reason>]. Pure-regex over the local transcript, NO model call.
 *
 * Silent (the turn may end) when any holds:
 *   1. stop_hook_active is not exactly false - a continuation is never
 *      re-blocked, so there is no loop, and a payload without the marker is
 *      undecidable
 *   2. cwd is outside the configured Kherep workspace
 *   3. the transcript is missing, unreadable or empty
 *   4. the ending turn is trivial - the same predicate as maestro-banner-gate
 *   5. the ending turn already carries an Agent/Task dispatch of claude-obs
 *   6. the last assistant text of the ending turn opts out with [obs: none ...]
 *
 * PRIVACY. The reason is fixed per install: only the model policy files, never
 * the transcript or the payload, shape it (issue #737). Nothing from those
 * - user text, assistant text, paths, the session id - reaches stdout, so this
 * hook cannot carry content into the next model call or into the observation
 * brief. What the brief may contain is the Maestro's decision, bounded by the
 * instruction below.
 *
 * STRAY BODY FILES (issue #280). Independently of the decision, the hook reads
 * the top level of cwd and of the git root containing it, once each, for names
 * starting with a drive letter + U+F03A: what MSYS makes of a "C:\..." or "D:\..." path written from
 * Bash, as claude-obs did with its page bodies on Windows. It reports a count
 * and one shortened example as systemMessage, which is shown to the user and
 * not sent to the model. It never deletes or moves a file.
 *
 * Counterpart of the Codex runtime's codex/hooks/observation-stop.mts, which
 * judges a turn id; this one judges the Claude Code transcript, because Claude
 * decides "substantial" and "already dispatched" from it. Any error fails open.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  contentBlocks,
  endingTurn,
  lastAssistantText,
  readTranscript,
  startsTurn,
  turnIsSubstantial,
  type ContentBlock,
  type TranscriptEntry,
} from "./lib/turn-substance.mts";
import { dispatchModelFor, loadModelPolicy, type ResolvedPolicy } from "./lib/model-policy.mts";
import { isKherepScope, type EnvLike } from "./lib/workspace-scope.mts";

export interface StopPayload {
  cwd?: unknown;
  transcript_path?: unknown;
  stop_hook_active?: unknown;
  last_assistant_message?: unknown;
  [key: string]: unknown;
}

export interface Continuation {
  decision: "block";
  reason: string;
}

const OBSERVATION_AGENT = "claude-obs";
const DISPATCH_TOOLS = new Set(["Agent", "Task"]);
const OPT_OUT = /\[\s*obs\s*:\s*none\b/i;

// Issue #737. The model named is claude-obs's resolved default, not a pin: the
// user may override it in kherep/model-policy.user.json, and the installed agent
// frontmatter carries the resolved effort.
export function observationReason(policy: ResolvedPolicy | null): string {
  const model = policy ? dispatchModelFor(policy, OBSERVATION_AGENT) : null;
  const call = model
    ? `Before ending, call the Agent tool with subagent_type "claude-obs" and model "${model}", its model policy default; run_in_background true is fine.`
    : "Before ending, call the Agent tool with subagent_type \"claude-obs\" and an explicit dispatchable model of the model policy; run_in_background true is fine.";
  return [
  "Session observation (ROUTING.md, Session observations): this turn was substantial and did not dispatch the observation agent.",
  call,
  "Give it a short, sanitized brief of THIS turn's findings only: no customer names, no credentials, no hosts, no private file content, no raw transcript.",
  "Mark each finding at the start of its own line as measured: `<command>` -> <deciding output excerpt>, or relayed: <source>.",
  "A finding about repository code starts with code after measured: and names each repository as <name>@<full commit sha> before the command, each followed by -- and the repo-relative paths the finding rests on.",
  "An empty result is valid.",
  "If the turn produced nothing new, or nothing can be shared safely, dispatch nothing and end the turn with [obs: none – <reason>] instead.",
  "An observation run never dispatches another.",
  ].join(" ");
}

function installedPolicy(): ResolvedPolicy | null {
  try { return loadModelPolicy(); } catch { return null; }
}

export const OBSERVATION_REASON = observationReason(installedPolicy());

function isAssistant(entry: TranscriptEntry): boolean {
  return Boolean(entry && entry.message && entry.message.role === "assistant");
}

function isObservationDispatch(block: ContentBlock): boolean {
  if (!block || block.type !== "tool_use" || !DISPATCH_TOOLS.has(block.name as string)) return false;
  const agent = block.input && block.input.subagent_type;
  return typeof agent === "string" && agent.trim() === OBSERVATION_AGENT;
}

function dispatchedObservation(turn: TranscriptEntry[]): boolean {
  return turn.some((entry) => isAssistant(entry) && contentBlocks(entry.message).some(isObservationDispatch));
}

// The payload's copy of the final message counts too: the runtime can hand it
// over before the transcript line for it is flushed.
function optedOut(turn: TranscriptEntry[], payload: StopPayload): boolean {
  if (typeof payload.last_assistant_message === "string" && OPT_OUT.test(payload.last_assistant_message)) {
    return true;
  }
  return OPT_OUT.test(lastAssistantText(turn));
}

export function decision(value: unknown, env: EnvLike = process.env): Continuation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as StopPayload;
  if (payload.stop_hook_active !== false) return null;
  if (!isKherepScope(payload, env)) return null;
  if (typeof payload.transcript_path !== "string" || !payload.transcript_path) return null;

  const all = readTranscript(payload.transcript_path);
  if (!all) return null;
  const entries = all.filter((entry) => Boolean(entry) && typeof entry === "object" && entry.isSidechain !== true);
  if (!entries.length) return null;

  const turn = endingTurn(entries, startsTurn);
  if (!turnIsSubstantial(turn)) return null;
  if (dispatchedObservation(turn)) return null;
  if (optedOut(turn, payload)) return null;
  return { decision: "block", reason: OBSERVATION_REASON };
}

// Any drive letter: the workspace itself can sit on D:.
const STRAY_NAME = /^[A-Za-z]\uf03a/;

function gitRoot(start: string): string {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return "";
  }
}

function strayNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => STRAY_NAME.test(name));
  } catch {
    return [];
  }
}

export function strayWarning(value: unknown, env: EnvLike = process.env): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as StopPayload;
  if (typeof payload.cwd !== "string" || !isKherepScope(payload, env)) return null;
  const cwd = path.resolve(payload.cwd);
  const dirs = [...new Set([cwd, gitRoot(cwd)].filter(Boolean))];
  const found = dirs.flatMap((dir) => strayNames(dir).map((name) => `${path.basename(dir)}/${name[0]}<U+F03A>...${name.slice(-20)}`));
  if (!found.length) return null;
  return `Kherep: ${found.length} stray file(s) named <drive><U+F03A>..., a Windows path written from Bash (likely an observation page body), e.g. ${found[0]}. Left in place; move them out and never commit them.`;
}

function main(): void {
  try {
    const payload: unknown = JSON.parse(fs.readFileSync(0, "utf8"));
    const result = decision(payload);
    const warning = strayWarning(payload);
    const output = warning ? { ...result, systemMessage: warning } : result;
    if (output) process.stdout.write(JSON.stringify(output));
  } catch {
    // Fail open: a hook that cannot decide says nothing and lets the turn end.
  }
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) main();
