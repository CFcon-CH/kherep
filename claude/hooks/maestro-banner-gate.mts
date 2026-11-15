#!/usr/bin/env node
/**
 * maestro-banner-gate.mts  -  Stop hook (Orchestra visibility enforcement)
 *
 * ROUTING.md Section 1: "On the first substantial orchestra turn, emit once:
 * [Maestro on | routing loaded | evidence-first]". Without enforcement the
 * banner is a promise, not a signal - the Director cannot tell an orchestra
 * session from a stock one. Pure-regex, NO model call.
 *
 * Conservative by design - it blocks ONLY when ALL hold:
 *   1. cwd is within the configured Kherep workspace
 *   2. NOT already a stop-hook continuation (stop_hook_active guard -> no loop)
 *   3. NO assistant message in the whole transcript carries the banner
 *   4. the ending turn is substantial (known write/delegation tool, three
 *      tool calls of any kind, or >= 400 chars of assistant prose)
 *
 * Greetings, acknowledgements and one-line answers never trigger it, matching
 * the ROUTING.md carve-out for trivial turns. Once the banner exists anywhere
 * in the session the gate is permanently silent - it enforces "once", not
 * "every reply". Any hook error or missing input data fails open.
 */
import { isKherepScope, type ScopePayload } from "./lib/workspace-scope.mts";
// The turn boundary and the "substantial" predicate are shared with
// observation-stop.mts, so both Stop hooks judge the same turns.
import {
  endingTurn,
  isUserPrompt,
  readTranscript,
  textOf,
  turnIsSubstantial,
  type TranscriptEntry,
} from "./lib/turn-substance.mts";

// The fields this hook reads from a Stop payload.
interface StopPayload extends ScopePayload {
  stop_hook_active?: unknown;
  transcript_path?: unknown;
}

// The complete routing contract, with harmless spacing/casing tolerance.
const BANNER =
  /\[\s*maestro\s+on\s*\|\s*routing\s+loaded\s*\|\s*evidence-first\s*\]/i;

async function readStdin(): Promise<string> {
  try {
    return (await (await import("./lib/stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8");
  } catch {
    return "";
  }
}

function bannerSeen(entries: TranscriptEntry[]): boolean {
  return entries.some((e) => {
    const msg = e && e.message;
    return Boolean(msg) && msg!.role === "assistant" && BANNER.test(textOf(msg));
  });
}

async function main(): Promise<void> {
  const input = await readStdin();
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

  const entries = readTranscript(data.transcript_path as string);
  if (!entries || !entries.length) return; // 3./4. undecidable -> fail open

  if (bannerSeen(entries)) return;
  if (!turnIsSubstantial(endingTurn(entries, isUserPrompt))) return;

  const reason =
    "Orchestra Banner-Gate (ROUTING.md Section 1): Diese Session hat eine substantielle Antwort geliefert, " +
    "ohne das Banner [Maestro on | routing loaded | evidence-first] jemals zu senden. " +
    "Der Director kann so nicht erkennen, ob Orchestra-Routing aktiv ist. " +
    "Setze das Banner als erste Zeile der Antwort und nenne dazu die 1-2 Regeln, die auf DIESE Aufgabe wirklich greifen " +
    "(Antwort-Disziplin #4: das Banner allein ist kein Beleg). Danach bleibt der Gate fuer den Rest der Session still.";

  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

try {
  await main();
} catch {
  // fail-open: never trap the Maestro on a hook malfunction
}
process.exit(0);
