import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { withoutTypeStrippingWarning } from "../lib/node-warning-fixture.mts";

const HOOK = path.join(import.meta.dirname, "cbm-reminder.mts");
const CONTEXT = [
  "Code discovery protocol:",
  "1. Prefer codebase-memory-mcp graph tools for structural code exploration.",
  "2. Use search_graph before trace_path or get_code_snippet.",
  "3. Use text search for literals, configs, scripts, and non-code files.",
].join("\n");

function run(input: string, script = HOOK, flags: string[] = []): string {
  const result = spawnSync(process.execPath, [...flags, script], { input, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(withoutTypeStrippingWarning(result.stderr, 1), "");
  return result.stdout;
}

for (const event of ["SessionStart", "SubagentStart"]) {
  test(`${event} emits the discovery protocol in its own event envelope`, () => {
    assert.deepEqual(JSON.parse(run(JSON.stringify({ hook_event_name: event }))), {
      hookSpecificOutput: { hookEventName: event, additionalContext: CONTEXT },
    });
  });
}

test("malformed, empty and unrelated events are silent", () => {
  for (const input of ["{broken", "", "{}", "[]", "42", '{"hook_event_name":false}', '{"hook_event_name":"PreToolUse"}']) {
    assert.equal(run(input), "", input);
  }
});

test("a symlinked entry emits the same reminder with either main-path mode", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbm-reminder-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const linked = path.join(root, "linked-hooks");
  try { fs.symlinkSync(import.meta.dirname, linked, "junction"); }
  catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Windows does not permit this test user to create a directory link");
      return;
    }
    throw error;
  }
  const input = JSON.stringify({ hook_event_name: "SubagentStart" });
  const expected = run(input);
  for (const flags of [[], ["--preserve-symlinks-main"]]) {
    assert.equal(run(input, path.join(linked, "cbm-reminder.mts"), flags), expected);
  }
});
