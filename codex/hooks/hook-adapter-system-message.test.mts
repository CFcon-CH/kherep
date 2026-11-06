// Issue #507, part 4. A guard's top-level systemMessage passes through the Codex
// hook adapter when it is a non-empty string (Codex documents it for PreToolUse),
// in the command form and in the exported runAdaptedHook the shell dispatcher uses;
// on a deny with a re-check notice the guard's line comes first. Any other extra
// field, or a systemMessage that is not a non-empty string, is still a deny.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { copyAdapter } from "./hook-adapter.fixture.mts";
import { runAdaptedHook } from "./hook-adapter.mts";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const ADAPTER = path.join(import.meta.dirname, "hook-adapter.mts");
const SHELL = { tool_name: "shell_command", tool_input: { command: "git status" } };
const DENY = { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "pinned to model x" };
const NOTICE = { hookEventName: "PreToolUse", additionalContext: "[dispatch-contract:OBS_BRIEF_REVISION] fixture" };

function dir(t: TestContext, prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
// A guard that prints `doc` and exits 0.
function guard(at: string, doc: unknown, name = "printing-guard.mts"): string {
  const file = path.join(at, name);
  fs.writeFileSync(file, `process.stdout.write(${JSON.stringify(JSON.stringify(doc))});\n`);
  return file;
}
const cli = (target: string) => spawnSync(process.execPath, [ADAPTER, target, "pre"],
  { input: JSON.stringify(SHELL), encoding: "utf8", windowsHide: true, timeout: 12_000 });

test("T5a a deny with systemMessage through the command form keeps the reason and carries the line", (t) => {
  const run = cli(guard(dir(t, "kherep-sysmsg-"), { hookSpecificOutput: DENY, systemMessage: "pinned to model x" }));
  assert.equal(run.status, 0, run.stderr);
  const doc = JSON.parse(run.stdout);
  assert.deepEqual(doc, { hookSpecificOutput: DENY, systemMessage: "pinned to model x" });
});

test("T5b a notice with systemMessage through the command form: no decision, both fields", (t) => {
  const run = cli(guard(dir(t, "kherep-sysmsg-"), { hookSpecificOutput: NOTICE, systemMessage: NOTICE.additionalContext }));
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { hookSpecificOutput: NOTICE, systemMessage: NOTICE.additionalContext });
});

test("T5c installed box, stale heartbeat: the guard's line comes before the integrity line", (t) => {
  const root = dir(t, "kherep-sysmsg-box-");
  const hooks = path.join(root, "hooks", "kherep-maestro");
  fs.mkdirSync(path.join(hooks, "lib"), { recursive: true });
  copyAdapter(hooks, "codex-hook-adapter.mts");
  fs.copyFileSync(path.join(REPO, "claude", "hooks", "lib", "guard-recheck.mts"), path.join(hooks, "lib", "guard-recheck.mts"));
  fs.writeFileSync(path.join(hooks, "codex-hook-integrity.mts"), "console.log('all 1 files OK (0 restored), heartbeat refreshed');\n");
  const target = guard(hooks, { hookSpecificOutput: DENY, systemMessage: "guard line" });
  const run = spawnSync(process.execPath, [path.join(hooks, "codex-hook-adapter.mts"), target, "pre"],
    { input: JSON.stringify(SHELL), encoding: "utf8", windowsHide: true, timeout: 12_000 });
  assert.equal(run.status, 0, run.stderr);
  const doc = JSON.parse(run.stdout) as { hookSpecificOutput: typeof DENY; systemMessage: string };
  assert.deepEqual(doc.hookSpecificOutput, DENY);
  assert.match(doc.systemMessage, /^guard line\nKherep hook integrity: /);
});

test("T5d an empty or non-string systemMessage, or another extra key, is still a broken deny", (t) => {
  const at = dir(t, "kherep-sysmsg-");
  for (const [doc, why] of [
    [{ hookSpecificOutput: DENY, systemMessage: "" }, "invalid field systemMessage"],
    [{ hookSpecificOutput: DENY, systemMessage: 7 }, "invalid field systemMessage"],
    [{ hookSpecificOutput: DENY, systemMessage: "x", updatedInput: {} }, "unsupported field updatedInput"],
    [{ hookSpecificOutput: NOTICE, continue: true }, "unsupported field continue"],
  ] as const) {
    const target = guard(at, doc);
    const result = runAdaptedHook(target, "pre", SHELL, 10_000);
    assert.equal(result.broken, true, JSON.stringify(doc));
    const out = JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes(`(${why})`), out.hookSpecificOutput.permissionDecisionReason);
  }
});

test("T5f the exported runAdaptedHook carries the guard's systemMessage for a deny and a notice", (t) => {
  const at = dir(t, "kherep-sysmsg-");
  for (const doc of [{ hookSpecificOutput: DENY, systemMessage: "deny line" }, { hookSpecificOutput: NOTICE, systemMessage: "notice line" }]) {
    const result = runAdaptedHook(guard(at, doc), "pre", SHELL, 10_000);
    assert.deepEqual([result.status, result.broken], [0, false]);
    assert.deepEqual(JSON.parse(result.stdout), doc);
  }
});

test("T5g the shell dispatcher returns a guard's deny with systemMessage unchanged", (t) => {
  const root = dir(t, "kherep-sysmsg-shell-");
  fs.copyFileSync(path.join(import.meta.dirname, "shell-checks.mts"), path.join(root, "shell-checks.mts"));
  copyAdapter(root);
  for (const name of ["deploy-guard.mts", "main-checkout-guard.mts", "module-label-guard.mts"]) fs.writeFileSync(path.join(root, name), "process.exit(0);\n");
  const doc = { hookSpecificOutput: { ...DENY, permissionDecisionReason: "commit says no" }, systemMessage: "commit line" };
  guard(root, doc, "commit-guard.mts");
  const run = spawnSync(process.execPath, [path.join(root, "shell-checks.mts")],
    { input: JSON.stringify(SHELL), encoding: "utf8", windowsHide: true, timeout: 20_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), doc);
});
