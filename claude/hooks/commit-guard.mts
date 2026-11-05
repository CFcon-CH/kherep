#!/usr/bin/env node
// Early commit-message feedback. The commit-msg hook is the enforcement boundary.
// The process import is the global process; nothing needs it since lib/hook-syntax.mts replaced `node --check` (#278).
import process from "node:process";
import { commitsViaGit } from "./lib/git-commit-match.mts";

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
function inlineMessage(command: string): string | null {
  const match = command.match(/(?:^|\s)(?:--message|-[A-Za-z]*m)(?:=|\s+)("(?:\\.|[^"\\])*"|'[^']*'|\S+)/);
  if (!match) return null;
  const value = match[1];
  return ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1) : value;
}
function normalized(value: unknown): string {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function targetPath(command: string, cwd: unknown): string {
  const match = command.match(/\bgit\b[^|;&]*?\s-C\s+("[^"]+"|'[^']+'|\S+)/);
  return normalized((match ? match[1] : (cwd as string) || "").replace(/^["']|["']$/g, ""));
}
function isWithin(candidate: string, root: string | undefined): boolean {
  const child = normalized(candidate);
  const parent = normalized(root);
  return Boolean(parent && (child === parent || child.startsWith(`${parent}/`)));
}
function subjectOf(message: string): string {
  return message.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}
await (async () => {
  let payload: ToolPayload | null = null;
  try { payload = JSON.parse(await read(process.stdin)) as ToolPayload | null; } catch { process.exit(0); }
  if (!payload || !["Bash", "PowerShell"].includes(payload.tool_name as string)) process.exit(0);
  const command = payload.tool_input && payload.tool_input.command;
  if (typeof command !== "string" || !commitsViaGit(command)) process.exit(0);
  const violations: string[] = [];
  if (/\u2014/.test(command)) violations.push("commit message contains an em dash (U+2014)");
  const policyEnabled = process.env.KHEREP_WORK_ITEM_REQUIRED === "1";
  const inScope = isWithin(targetPath(command, payload.cwd), process.env.KHEREP_WORKSPACE);
  const bypassed = /(?:^|\s)KHEREP_WORK_ITEM=none(?:\s|$)/.test(command);
  if (policyEnabled && inScope && !bypassed) {
    const message = inlineMessage(command);
    if (message !== null) {
      const patternText = process.env.KHEREP_WORK_ITEM_PATTERN || "[A-Z][A-Z0-9]{1,9}-\\d+";
      let pattern: RegExp | undefined;
      try { pattern = new RegExp(`^(?:${patternText})\\s+\\S`); }
      catch { violations.push("KHEREP_WORK_ITEM_PATTERN is invalid"); }
      if (pattern && !pattern.test(subjectOf(message))) violations.push("commit subject does not start with the configured work-item key and a space");
    }
  }
  if (!violations.length) process.exit(0);
  process.stderr.write(`commit-guard blocked this commit:\n  - ${violations.join("\n  - ")}\n`);
  process.exit(2);
})();
