#!/usr/bin/env node
/**
 * research-stop.mts  -  Stop hook (evidence-first enforcement, OP-1440)
 *
 * ROUTING.md "Evidence first": a relevant directive is researched before it is
 * answered - the Central Brain always, the code graph as well when the turn
 * changed code in a repository. research-first.mts asks for that on every
 * prompt; this hook sends a substantial turn back ONCE with a fixed instruction
 * when it shows neither the research nor the visible classification
 * [research: none - <reason>]. Pure-regex over the local transcript plus local
 * existence checks for .git, NO model call, NO network.
 *
 * Silent (the turn may end) when any holds:
 *   1. stop_hook_active is not exactly false - a continuation is never
 *      re-blocked, so there is no loop, with this hook or with
 *      observation-stop.mts, which uses the same guard
 *   2. cwd is outside the configured Kherep workspace
 *   3. the transcript is missing, unreadable or empty
 *   4. the ending turn is trivial - the predicate observation-stop.mts uses
 *   5. the ending turn opts out with [research: none - <reason>]; the reason is
 *      required, the dash may be a hyphen, en dash or em dash
 *   6. the ending turn made a Brain lookup and, if it changed files inside a git
 *      repository, also queried the code graph
 *
 * Besides the built-in lookups, a Skill named in the optional operator file
 * <claude-home>/kherep/research-sources.json, {"brainSkills": ["<skill>", ...]},
 * counts as a Brain lookup. A missing, unreadable or malformed file adds nothing.
 *
 * PRIVACY. The reason is fixed text plus the configured workspace and the
 * installed space key, exactly what research-first.mts prints. Nothing from the
 * transcript or the payload reaches stdout. Any error fails open.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { brainSearchCommand, RESEARCH_OPT_OUT, researchFacts, type Exists } from "./lib/research-evidence.mts";
import {
  endingTurn,
  lastAssistantText,
  readTranscript,
  startsTurn,
  turnIsSubstantial,
  type TranscriptEntry,
} from "./lib/turn-substance.mts";
import { workspaceForPayload, type EnvLike } from "./lib/workspace-scope.mts";

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

// The broker command is resolved exactly as research-first.mts resolves it, so
// the model never composes a path (issue #13).
export function researchReason(workspace: string, configPath?: string): string {
  return [
    "Evidence first (ROUTING.md, Evidence first): this turn was substantial and shows no research.",
    `Before ending, look up the Central Brain with ${brainSearchCommand(workspace, configPath)}`,
    "and, when this turn changed code in a repository, query the code graph through the codebase-memory MCP tools (mcp__codebase-memory-mcp__*).",
    "Search terms follow the privacy classification; private content never goes to Atlassian.",
    "Compare what you found with your answer and name the page id of any Brain page it contradicts.",
    "If research is not relevant to this directive, end the turn with [research: none - <reason>] instead.",
  ].join(" ");
}

// The hook lives in <claude-home>/hooks, the operator file in <claude-home>/kherep.
const DEFAULT_SOURCES = path.join(import.meta.dirname, "..", "kherep", "research-sources.json");

// The operator's extra lookup skills. Anything but {"brainSkills": [...]} adds
// nothing; non-string or empty entries are skipped. Never throws.
export function brainSkillsFrom(sourcesPath: string = DEFAULT_SOURCES): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(sourcesPath, "utf8")) as { brainSkills?: unknown } | null;
    const skills = parsed?.brainSkills;
    if (!Array.isArray(skills)) return new Set();
    const names = skills.filter((s): s is string => typeof s === "string").map((s) => s.trim());
    return new Set(names.filter((s) => s !== ""));
  } catch {
    return new Set();
  }
}

function optedOut(turn: TranscriptEntry[], payload: StopPayload): boolean {
  const last = payload.last_assistant_message;
  if (typeof last === "string" && RESEARCH_OPT_OUT.test(last)) return true;
  return RESEARCH_OPT_OUT.test(lastAssistantText(turn));
}

export function decision(
  value: unknown,
  env: EnvLike = process.env,
  exists?: Exists,
  sourcesPath: string = DEFAULT_SOURCES,
  configPath?: string,
): Continuation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as StopPayload;
  if (payload.stop_hook_active !== false) return null;
  const workspace = workspaceForPayload(payload, env);
  if (!workspace) return null;
  if (typeof payload.transcript_path !== "string" || !payload.transcript_path) return null;

  const all = readTranscript(payload.transcript_path);
  if (!all) return null;
  const entries = all.filter((entry) => Boolean(entry) && typeof entry === "object" && entry.isSidechain !== true);
  if (!entries.length) return null;

  const turn = endingTurn(entries, startsTurn);
  if (!turnIsSubstantial(turn)) return null;
  if (optedOut(turn, payload)) return null;
  const facts = researchFacts(turn, payload.cwd, exists, brainSkillsFrom(sourcesPath));
  if (facts.brain && (!facts.codeWork || facts.codeGraph)) return null;
  return { decision: "block", reason: researchReason(workspace, configPath) };
}

async function main(): Promise<void> {
  try {
    const result = decision(JSON.parse((await (await import("./lib/stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8")));
    if (result) process.stdout.write(JSON.stringify(result));
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

if (isMainModule()) await main();
