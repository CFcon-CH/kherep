import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";


export interface HookData {
  hook_event_name?: unknown;
  cwd?: unknown;
  session_id?: unknown;
  turn_id?: unknown;
  prompt?: unknown;
  [key: string]: unknown;
}


export function normalize(value: unknown): string {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isKherepScope(
  data: HookData | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  workspace?: string,
): boolean {
  const cwd = normalize(data && data.cwd);
  if (!cwd) return false;

  const configuredValue = Object.hasOwn(env, "KHEREP_WORKSPACE") ? env.KHEREP_WORKSPACE : undefined;
  const configured = normalize(workspace ?? (configuredValue === undefined
    ? path.join(env.USERPROFILE || env.HOME || os.homedir(), "Kherep")
    : configuredValue));
  return Boolean(configured && (cwd === configured || cwd.startsWith(`${configured}/`)));
}

export function routingPath(): string {
  const codexHome =
    process.env.CODEX_HOME ||
    path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex");
  return path.join(codexHome, "orchestra", "ROUTING.md");
}

export function sessionContext(): string {
  return [
    "KHEREP CODEX ORCHESTRA ACTIVE.",
    `Read ${routingPath()} before substantive Kherep work.`,
    "First substantial assistant reply banner: [Maestro on | routing loaded | evidence-first].",
    "The banner alone proves nothing; name the concrete applied rule and completion evidence for non-trivial work.",
    "Root Maestro owns intent, routing, synthesis, and acceptance. Delegate only for material benefit.",
    "Live evidence outranks memory. Never invent cross-session continuity.",
    "Use the installed model policy: Astra for the main designer, SOL for builders and root, Terra or Luna for bounded support. Native agent defaults carry the resolved model and reasoning.",
    "Private material never enters Codex, cloud subagents, web, MCP, or connectors; use only an authorized direct local-inference path or stop.",
  ].join("\n");
}

export function turnContext(data: HookData = {}): string {
  const safeId = (value: unknown): value is string => typeof value === "string"
    && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(value);
  const identity = safeId(data.session_id) && safeId(data.turn_id)
    ? `Observation identity: ${JSON.stringify({ sessionId: data.session_id, turnId: data.turn_id })}\nCopy this JSON verbatim into the Luna brief: these are the dispatching MAIN turn IDs, not worker IDs.`
    : "Observation turn identity unavailable. Maestro: continue the user task and its tools; pass this unavailable-identity condition to codex-obs. The observation WORKER must return OBS-ATTEMPT: failed missing-turn-identity detail=none publication=not-attempted created=none with no WORKER tool calls.";
  return [
    "MAESTRO TURN CHECK:",
    identity,
    "Use current primary evidence; unresolved facts are UNKNOWN. Prior-session memory needs active context or current artifacts.",
    "Classify privacy before tools; private material is forbidden to Codex/cloud paths.",
    "Delegate only for parallelism, specialization, isolation or independent review; never overlap writes. Bound workers by objective, scope, constraints, evidence and return format; Maestro owns acceptance.",
    "Inspect the final diff; report C1 correctness, C2 verification, C3 safety and C4 scope integrity. Trivial conversation skips ceremony.",
    "Before final, dispatch codex-obs once: agent_type codex-obs, the exact model and model_reasoning_effort from its installed agent TOML, fork_turns none; bounded nonprivate summary with session/turn IDs; require a strict OBS-RESULT receipt or bounded OBS-ATTEMPT worker report from its contract when no canonical receipt exists.",
    "Luna extracts and publishes only through mcp__kherep_observations__publish_observations; its adapter enforces canonical authority and target checks. Independently validate the handback and read canonical created targets. Preserve canonical receipts and all IDs even with isError true; isError alone does not prove an outer refusal. Empty means zero I/O. Report failed receipts and non-adapter attempts in the same turn; attempted calls without a receipt leave publication and IDs UNKNOWN. Never silently publish or repair.",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let workspace: string | undefined;
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--workspace-b64" || !/^[A-Za-z0-9_-]+$/.test(args[1])) return;
    workspace = Buffer.from(args[1], "base64url").toString("utf8");
    if (Buffer.from(workspace, "utf8").toString("base64url") !== args[1]
      || !path.isAbsolute(workspace) || /[\0\r\n]/.test(workspace)) return;
  }
  let data: HookData;
  try {
    data = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return;
  }

  if (!isKherepScope(data, process.env, workspace)) return;

  if (data.hook_event_name === "SessionStart") {
    process.stdout.write(sessionContext());
    return;
  }

  if (data.hook_event_name === "UserPromptSubmit") {
    process.stdout.write(turnContext(data));
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

if (isMainModule()) {
  main().catch(() => {
    // Fail open so a reminder hook can never trap a Codex session.
  });
}
