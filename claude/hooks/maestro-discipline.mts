#!/usr/bin/env node
/**
 * maestro-discipline.mts  -  UserPromptSubmit hook
 *
 * Re-injects compact Maestro discipline checklist into the model context on
 * every user prompt within the configured Kherep workspace. SessionStart fires
 * once and the model drifts mid-session. This hook re-pins ROUTING.md duties
 * each turn so Standing Order #7 (confirmation banner), Knowledge-First (MCP
 * before WebSearch), and tier-inversion stay in front of the model.
 *
 * Fail-safe: any error exits 0 silently, never blocks the prompt.
 */
import { isKherepScope, type ScopePayload } from "./lib/workspace-scope.mts";

async function main(): Promise<void> {
  let input = "";
  try {
    input = (await (await import("./lib/stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8");
  } catch {
    return;
  }
  let data: ScopePayload | null = {};
  try {
    data = JSON.parse(input || "{}") as ScopePayload | null;
  } catch {
    return;
  }

  if (!isKherepScope(data)) return;

  const msg =
    `MAESTRO TURN CHECK (ROUTING.md is authoritative):\n` +
    `1. Current live evidence outranks notes and checkpoints. Verify version/tool/state claims; unresolved load-bearing facts are UNKNOWN.\n` +
    `2. Classify privacy before any tool call. Privacy files use the direct local-inference runner only; never Agent wrappers, Claude Read/Grep/Edit, Codex, cloud MCP, or Workflow, and never read the private artifact back.\n` +
    `3. Delegate only when it adds parallelism, specialization, context isolation, or an independent lens. Behavior-changing builds use Agent, not Workflow by default.\n` +
    `4. Every Agent/Task call needs a canonical explicit model; the hard guard enforces owned pins. Design -> build -> review -> deploy are separate phases.\n` +
    `5. Before "done", verify objectively and synthesize a receipt with Evidence; build receipts also need Accept C1-C4. Never relay raw worker output or invent continuity.\n` +
    `6. Match the audience language and do not suggest Kherep-internal infrastructure for unrelated external questions. Trivial conversation skips orchestration ceremony.`;

  const out = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: msg,
    },
  };
  process.stdout.write(JSON.stringify(out));
}

try {
  await main();
} catch {
  // never break the prompt submit
}
process.exit(0);
