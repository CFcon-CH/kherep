#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  brainSearchCommand, codexConfigPath, RESEARCH_OPT_OUT, workspaceFor, type EnvLike,
} from "./research-common.mts";
import { readLatestTurn, researchFacts, type Exists } from "./research-transcript.mts";

interface StopInput {
  cwd?: unknown;
  transcript_path?: unknown;
  turn_id?: unknown;
  stop_hook_active?: unknown;
  last_assistant_message?: unknown;
}
export interface Continuation { decision: "block"; reason: string }

export function researchReason(
  workspace: string,
  configPath: string,
  missingBrain = true,
  missingGraph = true,
): string {
  const brain = `look up the Central Brain with ${brainSearchCommand(workspace, configPath)}`;
  const graph = "query codebase-memory through an MCP graph tool";
  let missing: string;
  let action: string;
  if (missingBrain && missingGraph) {
    missing = "Central Brain and code-graph research attempts";
    action = `${brain} and ${graph}`;
  } else if (missingBrain) {
    missing = "a Central Brain research attempt";
    action = brain;
  } else {
    missing = "a code-graph research attempt";
    action = graph;
  }
  return [
    `Evidence first (ROUTING.md): missing ${missing}.`,
    `Before ending, ${action}.`,
    "Search terms follow the privacy classification; private content never goes to Atlassian.",
    "A tool call records an attempted lookup only; inspect its result before relying on it.",
    "If research is not relevant, end the final response with [research: none - <reason>].",
  ].join(" ");
}

export function decision(
  value: unknown,
  env: EnvLike = process.env,
  exists?: Exists,
  configPath: string = codexConfigPath(env),
): Continuation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as StopInput;
  if (input.stop_hook_active !== false) return null;
  const workspace = workspaceFor(input, env);
  if (!workspace || typeof input.transcript_path !== "string" || !input.transcript_path) return null;
  if (!path.isAbsolute(input.transcript_path)) return null;
  const transcript = path.resolve(input.transcript_path);
  const normalizedTranscript = transcript.replace(/\\/g, "/").toLowerCase();
  if (/(?:^|\/)\.claude(?:-mem)?(?:\/|$)/.test(normalizedTranscript)) return null;
  const turnId = typeof input.turn_id === "string" && input.turn_id.trim() ? input.turn_id.trim() : undefined;
  const turn = readLatestTurn(transcript, turnId);
  if (!turn) return null;
  const facts = researchFacts(turn, String(input.cwd || ""), exists);
  if (!facts.substantial) return null;
  const final = typeof input.last_assistant_message === "string"
    ? input.last_assistant_message : turn.finalAssistantText;
  if (RESEARCH_OPT_OUT.test(final)) return null;
  if (facts.brain && (!facts.codeWork || facts.codeGraph)) return null;
  return { decision: "block", reason: researchReason(workspace, configPath, !facts.brain, facts.codeWork && !facts.codeGraph) };
}

async function main(): Promise<void> {
  try {
    const result = decision(JSON.parse((await (await import("./stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8") || "{}"));
    if (result) process.stdout.write(JSON.stringify(result));
  } catch {
    // Unreadable or unstable inputs are undecidable and fail open.
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch { return false; }
}

if (isMainModule()) await main();
