#!/usr/bin/env node
// PreToolUse guard (issue #325): keeps the main checkout of a workspace
// repository on its default branch. Sessions share that checkout, so a branch
// switch there moves every other session's working tree; branch work belongs in
// a linked worktree. Blocks checkout/switch to another ref, a SHA, -b/-B/-c/-C,
// --orphan and --detach in the main checkout (git-dir equals common-dir). File
// checkouts, other verbs, linked worktrees and anything outside the workspace
// pass. lib/main-checkout.mts holds the token walk and the git queries.
//
// The git post-checkout hook is the runtime-independent layer; it can only warn,
// because git runs it after HEAD has moved. Codex reaches this guard through
// codex-hook-adapter.mts, which turns the exit 2 into a JSON deny.
import process from "node:process";
import { checkoutIntents, judge, MARKER } from "./lib/main-checkout.mts";

// The fields this hook reads from a PreToolUse payload.
interface ToolPayload {
  tool_name?: unknown;
  tool_input?: { command?: unknown } | null;
  cwd?: unknown;
}

function read(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    stream.on("data", (chunk) => (data += chunk));
    stream.on("end", () => resolve(data));
  });
}

await (async () => {
  let payload: ToolPayload | null = null;
  try { payload = JSON.parse(await read(process.stdin)) as ToolPayload | null; } catch { process.exit(0); }
  if (!payload || !["Bash", "PowerShell"].includes(payload.tool_name as string)) process.exit(0);
  const command = payload.tool_input?.command;
  if (typeof command !== "string") process.exit(0);
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const violations: string[] = [];
  for (const intent of checkoutIntents(command, cwd)) {
    const verdict = judge(intent);
    if (verdict.action === "warn") process.stderr.write(`${verdict.message}\n`);
    if (verdict.action === "block") violations.push(verdict.message);
  }
  if (!violations.length) process.exit(0);
  process.stderr.write(
    `main-checkout-guard blocked this command:\n  - ${violations.join("\n  - ")}\n\n` +
      "Other sessions share the main checkout. Do branch work in a linked worktree instead: " +
      "git worktree add <path> -b <branch>\n" +
      `If the user explicitly approved switching the main checkout, re-run the same command with a visible ${MARKER} ` +
      "prefix (PowerShell: $env:KHEREP_MAIN_CHECKOUT='switch'; <command>). A persistent environment variable is intentionally ignored.\n"
  );
  process.exit(2);
})();
