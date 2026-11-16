import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decision as acceptanceDecision } from "./acceptance-policy.mts";

const SELECTED_WORKSPACE = "__KHEREP_SELECTED_WORKSPACE__";

interface StopInput {
  turn_id?: unknown;
  session_id?: unknown;
  stop_hook_active?: unknown;
  last_assistant_message?: unknown;
  assistant_message?: unknown;
  cwd?: unknown;
}

interface Continuation {
  decision: "block";
  reason: string;
}

export function observationPrompt(workspace = SELECTED_WORKSPACE, platform = process.platform): string {
  void workspace; void platform;
  return [
  "Before the final response, dispatch the codex-obs agent for this completed user turn using agent_type codex-obs (its recorded installed name), the exact model and model_reasoning_effort from its installed agent TOML, and fork_turns none.",
  "Give it only a bounded, sanitized summary; never pass raw sessions, credentials, customer-private material, or private infrastructure.",
  "Mark each finding at the start of its own line as measured: `<command>` -> <deciding output excerpt>, or relayed: <source>.",
  "A finding about repository code starts with code after measured: and names each repository as <name>@<full commit sha> before the command, each followed by -- and the repo-relative paths the finding rests on.",
    "The observer owns extraction and publication through mcp__kherep_observations__publish_observations only, using the supplied session/turn IDs and named node.",
    "Require one strict OBS-RESULT receipt, or a bounded OBS-ATTEMPT worker report when no canonical receipt exists, as defined in the worker contract. Preserve canonical receipts and all created IDs even when isError is true; isError alone does not prove an outer refusal.",
    "The adapter validates candidates, literal canonical authority bound to the resolved space, placement, the approved links against their related_candidates receipt, labels and trusted author readback, and writes only the links codex-obs approved after judging each candidate on topic.",
    "Independently validate the handback and read canonical created targets. Report failed receipts and non-adapter attempts in the same turn; attempted calls without a receipt leave publication and IDs UNKNOWN. Never silently publish or repair.",
    "A malformed-handback correction allows NO further publication, retry, tool call or replacement page. Empty findings cause zero I/O.",
  "Follow orchestra/ROUTING.md. If codex-obs was already dispatched for this turn, do not dispatch it again; an observation run never dispatches another observation run.",
  "Check the agent result, then complete the user response.",
  ].join(" ");
}

// Issue #731 PR-B. A promotion the result side left for this session: consumed
// before the reason is emitted, so it continues the turn at most once, whatever
// stop_hook_active says. The lib is the Claude hook lib beside this file at the
// install target, else in the checkout; without it there is no promotion.
type StatePolicy = typeof import("../../claude/hooks/lib/obs-handback-state.mts");
const require = createRequire(import.meta.url);
export const HOME = path.dirname(import.meta.dirname);
export function promotion(input: StopInput, home: string, dir = import.meta.dirname): string | null {
  const local = path.join(dir, "lib", "obs-handback-state.mts");
  try {
    const lib = require(fs.existsSync(local) ? local : path.resolve(dir, "..", "..", "claude", "hooks", "lib", "obs-handback-state.mts")) as StatePolicy;
    return lib.pendingPromotion(home, input.session_id);
  } catch {
    return null;
  }
}

export function decision(value: unknown, env: NodeJS.ProcessEnv = process.env, home = HOME): Continuation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as StopInput;
  const pending = promotion(input, home);
  const result = observationDecision(input, env);
  if (!pending) return result;
  return { decision: "block", reason: result ? `${result.reason}\n\n${pending}` : pending };
}

function observationDecision(input: StopInput, env: NodeJS.ProcessEnv): Continuation | null {
  const prompt = observationPrompt();
  const receipt = acceptanceDecision(input, env);
  if (receipt) {
    return { decision: "block", reason: receipt.stopReason + (input.stop_hook_active === false
      && typeof input.turn_id === "string" && input.turn_id.trim() ? ` ${prompt}` : "") };
  }
  if (input.stop_hook_active !== false || typeof input.turn_id !== "string" || !input.turn_id.trim()) return null;
  return { decision: "block", reason: prompt };
}

async function main(): Promise<void> {
  let input: unknown;
  try { input = JSON.parse((await (await import("./stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8")); } catch { return; }
  const result = decision(input);
  if (result) process.stdout.write(JSON.stringify(result));
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

if (isMainModule()) await main();
