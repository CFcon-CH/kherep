// Issue #965. The shell dispatcher run from the checkout, where no shell guard sits beside it:
// input that is no JSON object is one deny, and every missing guard blocks the call by name.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const DISPATCHER = path.join(import.meta.dirname, "shell-checks.mts");
const run = (input: string) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", DISPATCHER],
  { input, encoding: "utf8", windowsHide: true, timeout: 30_000 });
const reason = (stdout: string): string => (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason;

test("stdin that is no JSON object is denied as invalid input", () => {
  for (const input of ["{not json", "[]", "null", "7"]) {
    const result = run(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(reason(result.stdout), "Shell checks received invalid input; this tool call is blocked.", input);
  }
});

test("without its guards beside it the dispatcher blocks with the first missing guard", () => {
  const result = run(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "shell_command", tool_input: { command: "git status" } }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(reason(result.stdout), "commit-guard.mts could not complete; this tool call is blocked.");
});
