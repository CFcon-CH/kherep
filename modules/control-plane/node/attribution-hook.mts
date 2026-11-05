#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { findTrustedExecutable } from "../../../claude/hooks/lib/trusted-executable.mts";

import { commandSegments, gitSubcommand } from "../../../claude/hooks/lib/command-walk.mts";
import { isWithinWorkspace } from "../../../claude/hooks/lib/real-path-policy.mts";
import { normalizePayloads } from "../../../codex/hooks/hook-adapter.mts";
import { appendAttribution, isSessionId, repoSlug, writePendingMarker, type AttributionRecord } from "./attribution.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { hookRuntime, isMainModule, type HookRuntime } from "./deliver-hook.mts";

// Issue #325, PR-A. gh pr create never reaches a git hook, so this hook writes
// the pr-create record of the attribution log (attribution.mts) after the tool
// call: Claude Code runs it at PostToolUse for Bash and PowerShell, Codex with
// --runtime codex for its shell tools. For Codex it also runs at PreToolUse and
// leaves a pending marker on git push and gh pr create, because Codex exports
// no session variable to the git subprocess; the pre-push hook consumes it.
// Like deliver-hook.mts it runs from the checkout. Only repositories inside the
// workspace count, read the way main-checkout-guard reads it.
//
// The PR number comes from a /pull/<n> URL in the tool output, else from
// `gh pr view --json number,url` (5 s), else it stays null ("unresolved").
// Neither the command text nor the output is ever recorded.

export interface AttributionHookDeps {
  paths: NodePaths;
  env: NodeJS.ProcessEnv;
  now?: () => number;
  prView?: (dir: string) => { number: number; url: string } | null;
}

export interface AttributionIntent { kind: "push" | "pr-create"; dir: string }

export function attributionIntents(command: string, cwd: string): AttributionIntent[] {
  return commandSegments(command, cwd).flatMap((segment): AttributionIntent[] => {
    if (segment.name === "git") {
      const { verb, dir } = gitSubcommand(segment.args, segment.dir);
      return verb === "push" ? [{ kind: "push", dir }] : [];
    }
    const [group, verb] = segment.args;
    return segment.name === "gh" && group === "pr" && verb === "create" ? [{ kind: "pr-create", dir: segment.dir }] : [];
  });
}

function git(dir: string, args: string[]): string | null {
  const command = findTrustedExecutable("git");
  if (!command) return null;
  const result = spawnSync(command, ["-C", dir, ...args], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

// The toplevel of the repository <dir> is in, when that lies in the workspace.
function workspaceToplevel(dir: string, env: NodeJS.ProcessEnv): string | null {
  const toplevel = git(dir, ["rev-parse", "--show-toplevel"]);
  return toplevel && isWithinWorkspace(toplevel, env) ? toplevel : null;
}

const PR_URL = /https?:\/\/[^\s"'\\]+?\/([^/\s"'\\]+)\/([^/\s"'\\]+)\/pull\/(\d+)/;

function pullRequest(text: string): { pr: number; repo: string } | null {
  const match = PR_URL.exec(text);
  const pr = Number(match?.[3]);
  return match && Number.isSafeInteger(pr) ? { pr, repo: `${match[1]}/${match[2]}` } : null;
}

function ghPrView(dir: string): { number: number; url: string } | null {
  const command = findTrustedExecutable("gh", { cwd: dir });
  if (!command) return null;
  const result = spawnSync(command, ["pr", "view", "--json", "number,url"], { cwd: dir, encoding: "utf8", windowsHide: true,
    timeout: 5000 });
  if (result.status !== 0) return null;
  try {
    const value = JSON.parse(result.stdout) as { number?: unknown; url?: unknown } | null;
    return Number.isSafeInteger(value?.number) && typeof value?.url === "string" ? { number: value.number as number, url: value.url } : null;
  } catch {
    return null;
  }
}

function prCreateRecord(dir: string, toplevel: string, payload: Record<string, unknown>, runtime: HookRuntime,
  deps: AttributionHookDeps, now: number): AttributionRecord {
  const output = typeof payload.tool_response === "string" ? payload.tool_response : JSON.stringify(payload.tool_response ?? null);
  let found: { pr: number | null; repo: string | null; prSource: "stdout" | "gh" | "unresolved" } = { pr: null, repo: null,
    prSource: "unresolved" };
  const fromOutput = pullRequest(output);
  if (fromOutput) found = { ...fromOutput, prSource: "stdout" };
  else {
    const viewed = (deps.prView ?? ghPrView)(dir);
    if (viewed) found = { pr: viewed.number, repo: pullRequest(viewed.url)?.repo ?? null, prSource: "gh" };
  }
  const sessionId = isSessionId(payload.session_id) ? payload.session_id : null;
  return { v: 1, ts: new Date(now).toISOString(), kind: "pr-create", sessionId: sessionId ?? "unknown",
    runtime: sessionId ? runtime : "unknown", sessionSource: sessionId ? "hook" : "none",
    repo: found.repo ?? repoSlug(git(toplevel, ["remote", "get-url", "origin"]) ?? ""), toplevel,
    branch: git(toplevel, ["symbolic-ref", "--quiet", "--short", "HEAD"]), remoteRef: null,
    sha: git(toplevel, ["rev-parse", "--verify", "--quiet", "HEAD"]), pr: found.pr, prSource: found.prSource };
}

// The shell commands of one tool call. Codex payloads go through the hook
// adapter's normalisation, which also reads the commands out of functions.exec.
function shellCommands(payload: Record<string, unknown>, runtime: HookRuntime): string[] {
  let calls: { tool_input?: unknown }[];
  if (runtime === "codex") calls = normalizePayloads(payload, "pre").filter((item) => item.tool_name === "Bash");
  else calls = ["Bash", "PowerShell"].includes(payload.tool_name as string) ? [payload] : [];
  return calls.map((item) => (item.tool_input as { command?: unknown } | null)?.command)
    .filter((command): command is string => typeof command === "string");
}

export function handleAttributionHook(input: unknown, runtime: HookRuntime, deps: AttributionHookDeps): void {
  if (typeof input !== "object" || input === null) return;
  const payload = input as Record<string, unknown>;
  const event = payload.hook_event_name;
  if (event !== "PostToolUse" && !(event === "PreToolUse" && runtime === "codex")) return;
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const now = deps.now?.() ?? Date.now();
  for (const command of shellCommands(payload, runtime)) {
    for (const intent of attributionIntents(command, cwd)) {
      if (event === "PostToolUse" && intent.kind !== "pr-create") continue;
      const toplevel = workspaceToplevel(intent.dir, deps.env);
      if (!toplevel) continue;
      if (event === "PreToolUse") writePendingMarker(deps.paths, toplevel, payload.session_id, "codex", now);
      else appendAttribution(deps.paths, prCreateRecord(intent.dir, toplevel, payload, runtime, deps, now), now);
    }
  }
}

// Never fails the tool call: any error is one stderr line and exit 0.
if (isMainModule(import.meta.url)) {
  try {
    const runtime = hookRuntime(process.argv.slice(2));
    if (!runtime) throw new Error("unknown --runtime; expected codex");
    const stdin = fs.readFileSync(0, "utf8");
    if (stdin) handleAttributionHook(JSON.parse(stdin), runtime, { paths: nodePaths(), env: process.env });
  } catch (error) {
    process.stderr.write(`kherep attribution-hook: ${String((error as Error).message ?? error)}\n`);
  }
  process.exitCode = 0;
}
