#!/usr/bin/env node
/**
 * orchestra-default.mts  -  SessionStart hook
 *
 * Defaults every session that operates in the configured Kherep workspace into
 * Kherep Maestro
 * mode and injects the compact, load-bearing contract once. Detailed policy
 * stays in ROUTING.md so every prompt is not flooded with duplicated rules.
 *
 * Fail-safe: any error exits 0 silently, never blocks session start.
 */
import fs from "node:fs";
import path from "node:path";
import { describeAgents, loadModelPolicy } from "./lib/model-policy.mts";
import { isKherepScope, type ScopePayload } from "./lib/workspace-scope.mts";

// Issue #737. Defaults from the resolved model policy, never a pin; an invalid
// policy is named, because dispatch-contract-guard then denies every dispatch.
function modelPolicyLine(): string {
  try {
    return `Agent model defaults (kherep/model-policy.json, overridden by kherep/model-policy.user.json): ${describeAgents(loadModelPolicy())}; ` +
      `any dispatchable model of that policy may be chosen instead. `;
  } catch (error) {
    return `The model policy is invalid, so every Agent/Task call is denied until it is fixed: ${error instanceof Error ? error.message : "unknown error"}. `;
  }
}

function main(): void {
  let input = "";
  try {
    input = fs.readFileSync(0, "utf8");
  } catch {
    return;
  }
  let data: ScopePayload | null = {};
  try {
    data = JSON.parse(input || "{}") as ScopePayload | null;
  } catch {
    return;
  }

  // Other projects keep stock Claude Code behavior. Transcript directory
  // slugs are intentionally not used: they differ between Windows and macOS.
  if (!isKherepScope(data)) return;

  const routingPath = path.join(
    process.env.USERPROFILE || process.env.HOME || "",
    ".claude",
    "teams",
    "kherep",
    "ROUTING.md"
  );

  const msg =
    `KHEREP ORCHESTRA ACTIVE. Read ${routingPath} before substantive work.\n` +
    `First substantial reply banner: [Maestro on | routing loaded | evidence-first].\n` +
    `Ground current state before answering; live evidence outranks memory. Delegate only for material benefit. ` +
    `Every Agent/Task call sets an explicit model. ` + modelPolicyLine() +
    `Privacy routes only through the direct local-inference runner; win-agent/mac-agent remain Claude wrappers and are non-private only. ` +
    `Behavior-changing builds use Agent by default and require objective verification plus an Evidence/Accept receipt. ` +
    `Trivial conversational turns skip orchestration ceremony.`;

  const out = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: msg,
    },
  };
  process.stdout.write(JSON.stringify(out));
}

try {
  main();
} catch {
  // never break session start
}
process.exit(0);
