import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SELECTED_WORKSPACE = "__KHEREP_SELECTED_WORKSPACE__";

export interface StopInput {
  stop_hook_active?: unknown;
}

export interface StopDecision {
  decision: "block";
  reason: string;
}

export function renderObservationInstruction(workspace: string): string {
  void workspace;
  return [
    "Dispatch exactly one `codex-obs` with `fork_turns: \"none\"`.",
    "Pass only the completed turn, relevant tool evidence, and compact task state.",
    "Mark each finding at the start of its own line as measured: `<command>` -> <deciding output excerpt>, or relayed: <source>.",
    "A finding about repository code starts with code after measured: and names each repository as <name>@<full commit sha> before the command, each followed by -- and the repo-relative paths the finding rests on.",
    "Luna owns extraction and publication through mcp__kherep_observations__publish_observations only, using the supplied session/turn IDs and named node.",
    "Require one strict OBS-RESULT receipt, or a bounded OBS-ATTEMPT worker report when no canonical receipt exists, as defined in the worker contract. Preserve canonical receipts and all created IDs even when isError is true; isError alone does not prove an outer refusal.",
    "The adapter validates candidates, literal canonical authority bound to the resolved space, placement, related lookup, labels, trusted author readback and targeted stitch.",
    "Independently validate the handback and read canonical created targets. Report failed receipts and non-adapter attempts in the same turn; attempted calls without a receipt leave publication and IDs UNKNOWN. Never silently publish or repair.",
    "A malformed-handback correction allows NO further publication, retry, tool call or replacement page. Empty findings cause zero I/O.",
    "Never dispatch a second pass.",
  ].join(" ");
}

export function decision(input: StopInput, workspace = SELECTED_WORKSPACE): StopDecision | null {
  if (input?.stop_hook_active !== false) return null;
  return { decision: "block", reason: renderObservationInstruction(workspace) };
}

function main(): void {
  let input: StopInput;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8")) as StopInput;
  } catch {
    return;
  }

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
