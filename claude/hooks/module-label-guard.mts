#!/usr/bin/env node
// PreToolUse guard (issue #833): `gh issue create` and `gh pr create`, in every
// spelling lib/module-label.mts recognises, need a module label in a repository
// that committed .github/module-labels.json.
// lib/module-label.mts holds the token walk, the rule lookup and the verdict. A
// repository without that file has no rule, so a user's own repository is never
// refused. Codex reaches this guard through its shell dispatcher.
import process from "node:process";
import { judge, labelIntents, MARKER, ruleFor } from "./lib/module-label.mts";

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

let payload: ToolPayload | null = null;
try { payload = JSON.parse(await read(process.stdin)) as ToolPayload | null; } catch { process.exit(0); }
if (!payload || !["Bash", "PowerShell"].includes(payload.tool_name as string)) process.exit(0);
const command = payload.tool_input?.command;
if (typeof command !== "string") process.exit(0);
const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
const violations = labelIntents(command, cwd).flatMap((intent) => {
  const verdict = judge(intent, ruleFor(intent.dir, intent.repo));
  return verdict.action === "block" ? [verdict.message] : [];
});
if (violations.length) {
  process.stderr.write(
    `module-label-guard blocked this command:\n  - ${violations.join("\n  - ")}\n\n` +
      "CONTRIBUTING.md asks for at least one module label on every issue and pull request, so the work can be reported per module. " +
      "Add one with --label; a template's labels do not count. --web passes, because the browser form cannot be judged.\n" +
      "If no module label fits, or the command targets another repository through a GH_REPO this guard cannot see " +
      `(set by export or an earlier $env:GH_REPO, not in front of gh), re-run the same command with a visible ${MARKER} prefix ` +
      "(PowerShell: $env:KHEREP_MODULE_LABEL='none'; <command>). A persistent environment variable is intentionally ignored.\n",
  );
  process.exit(2);
}
