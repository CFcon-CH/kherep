#!/usr/bin/env node
/**
 * clq-accept-gate.mts  -  Stop hook (Closed-Loop Quality enforcement)
 *
 * Section 8.8 Required Companion-Deliverable. Pure-regex, NO model call.
 *
 * Purpose: stop the Maestro from ending a dispatched turn without evidence,
 * and from reporting a build dispatch without the CLQ Accept verdict.
 *
 * Conservative by design - it blocks ONLY when ALL hold:
 *   1. cwd is within the configured Kherep workspace
 *   2. NOT already a stop-hook continuation (stop_hook_active guard -> no loop)
 *   3. the last assistant message carries a "Dispatched:" receipt
 *   4. every dispatch receipt has a non-placeholder "Evidence:" line
 *   5. a BUILD-phase receipt also has "Accept:" with a C1 token
 *
 * Pure conversation and turns without a dispatch receipt are never blocked.
 * Any hook error or missing input data fails open.
 */
import fs from "node:fs";
import { isKherepScope, type ScopePayload } from "./lib/workspace-scope.mts";

// The fields this hook reads from a Stop payload.
interface StopPayload extends ScopePayload {
  stop_hook_active?: unknown;
  transcript_path?: unknown;
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Pull the text of the last assistant message out of a transcript JSONL file.
function lastAssistantText(transcriptPath: unknown): string {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath as string, "utf8");
  } catch {
    return "";
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj: { message?: { role?: unknown; content?: unknown } } | null;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const msg = obj && obj.message;
    if (!msg || msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((b: { text?: unknown } | null) => (b && typeof b.text === "string" ? b.text : ""))
        .join("\n");
    }
    return "";
  }
  return "";
}

// Returns the missing contract field, or an empty string when the receipt is valid.
function missingField(text: string): string {
  if (!text) return "";
  // 3. receipt present
  if (!/^[^\S\n\r\u2028\u2029]*Dispatched:/m.test(text) && !/\bDispatched:\s*\d/.test(text)) {
    return "";
  }

  // Every dispatch result must be grounded. Placeholders are not evidence.
  const hasEvidence = /^[^\S\n\r\u2028\u2029]*Evidence:\s*(?!none\b|n\/?a\b|unknown\b)\S.+$/im.test(text);
  if (!hasEvidence) return "Evidence";

  // Build-phase agent / marker referenced.
  const buildMarker =
    /\bkherep-builder\b/.test(text) ||
    /\bcavecrew-builder\b/.test(text) ||
    /\bbuild-surgical\b/.test(text) ||
    /\bbuild-feature\b/.test(text);
  if (!buildMarker) return "";

  // A well-formed build Accept line must carry a C1 token.
  const hasAccept = /\bAccept:\s*C1\b/.test(text);
  return hasAccept ? "" : "Accept";
}

function main(): void {
  const input = readStdin();
  let data: StopPayload = {};
  try {
    data = JSON.parse(input || "{}") as StopPayload;
  } catch {
    return; // exit 0
  }

  // 2. loop guard - never re-block our own continuation
  if (data.stop_hook_active === true) return;

  // 1. Scope by normalized cwd/config, never by a host-specific transcript slug.
  if (!isKherepScope(data)) return;

  const text = lastAssistantText(data.transcript_path);
  const missing = missingField(text);
  if (!missing) return;

  const reason = missing === "Evidence"
    ? "Orchestra Evidence-Gate (ROUTING.md Section 9): Dieser Turn meldet einen Dispatch ohne belastbare 'Evidence:'-Zeile. Fuege file:line, Test-Count, Live-Check oder primaere MCP-Quelle hinzu; Memory oder ein Platzhalter ist kein Beleg."
    : "CLQ Accept-Gate (ROUTING.md Section 9): Dieser Turn meldet ein Build-Dispatch ohne die Pflicht-Zeile 'Accept: C1 ... | C2 ... | C3 ... | C4 ... | iters X/3'. Fuege Verdicts und Counts hinzu, keine rohen Logs.";

  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

try {
  main();
} catch {
  // fail-open: never trap the Maestro on a hook malfunction
}
process.exit(0);
