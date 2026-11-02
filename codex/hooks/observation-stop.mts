import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decision as acceptanceDecision } from "./acceptance-policy.mts";

const SELECTED_WORKSPACE = "__KHEREP_SELECTED_WORKSPACE__";

interface StopInput {
  turn_id?: unknown;
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
  "Before the final response, dispatch the codex-obs agent for this completed user turn using agent_type codex-obs, the exact model from its installed agent TOML, reasoning_effort low, and fork_turns none.",
  "Give it only a bounded, sanitized summary; never pass raw sessions, credentials, customer-private material, or private infrastructure.",
  "Mark each finding at the start of its own line as measured: `<command>` -> <deciding output excerpt>, or relayed: <source>.",
  "A finding about repository code starts with code after measured: and names each repository as <name>@<full commit sha> before the command, each followed by -- and the repo-relative paths the finding rests on.",
    "Luna owns extraction and publication through mcp__kherep_observations__publish_observations only, using the supplied session/turn IDs and named node.",
    "Require one strict OBS-RESULT receipt, or a bounded OBS-ATTEMPT worker report when no canonical receipt exists, as defined in the worker contract. Preserve canonical receipts and all created IDs even when isError is true; isError alone does not prove an outer refusal.",
    "The adapter validates candidates, literal canonical authority bound to the resolved space, placement, related lookup, labels, trusted author readback and targeted stitch.",
    "Independently validate the handback and read canonical created targets. Report failed receipts and non-adapter attempts in the same turn; attempted calls without a receipt leave publication and IDs UNKNOWN. Never silently publish or repair.",
    "A malformed-handback correction allows NO further publication, retry, tool call or replacement page. Empty findings cause zero I/O.",
  "Follow orchestra/ROUTING.md. If codex-obs was already dispatched for this turn, do not dispatch it again; an observation run never dispatches another observation run.",
  "Check the agent result, then complete the user response.",
  ].join(" ");
}

export function decision(value: unknown, env: NodeJS.ProcessEnv = process.env): Continuation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as StopInput;
  const prompt = observationPrompt();
  const receipt = acceptanceDecision(input, env);
  if (receipt) {
    return { decision: "block", reason: receipt.stopReason + (input.stop_hook_active === false
      && typeof input.turn_id === "string" && input.turn_id.trim() ? ` ${prompt}` : "") };
  }
  if (input.stop_hook_active !== false || typeof input.turn_id !== "string" || !input.turn_id.trim()) return null;
  return { decision: "block", reason: prompt };
}

function main(): void {
  let input: unknown;
  try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch { return; }
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

if (isMainModule()) main();
