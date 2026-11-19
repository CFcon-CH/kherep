// Issue #965: dispatcher refusals the other guard-dispatch suites do not reach. A guard in a
// directory that does not exist is missing; a guard below a regular file fails its stat with
// the error code only; a guard printing another event's output is no PreToolUse decision; an
// agent_id longer than 64 characters journals nothing. Synthetic guards in a temporary home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { dispatcherFixture, type DispatcherFixture } from "./guard-dispatch-fixture.mts";

const BLOCKED = "the tool call is blocked until hook integrity restores it";
const PAYLOAD = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "true" } };
const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(): DispatcherFixture {
  const fx = dispatcherFixture("guard-dispatch-refusals-");
  roots.push(fx.root);
  return fx;
}

function dispatch(fx: DispatcherFixture, guards: string[], payload: object = PAYLOAD): Record<string, unknown> {
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", fx.dispatch, ...guards],
    { input: JSON.stringify(payload), encoding: "utf8", windowsHide: true, timeout: 40_000 });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout ? (JSON.parse(run.stdout) as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput : {};
}
const failed = (label: string, why: string): string => `[guard-dispatch] ${label} cannot run (${why}); ${BLOCKED}`;

test("a guard in a directory that does not exist is missing, named by its place in hooks/", () => {
  const fx = fixture();
  const output = dispatch(fx, [path.join(fx.hooks, "gone", "guard.mts")]);
  assert.equal(output.permissionDecision, "deny");
  assert.equal(output.permissionDecisionReason, failed("gone/guard.mts", "missing"));
});

test("a guard below a regular file fails its stat with the error code only", () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.hooks, "plain.mts"), "process.exit(0);\n");
  const output = dispatch(fx, [path.join(fx.hooks, "plain.mts", "guard.mts")]);
  assert.equal(output.permissionDecision, "deny");
  // POSIX stat below a regular file fails with ENOTDIR; Windows answers ENOENT, which the
  // dispatcher reports as missing. Both deny the call.
  const reason = process.platform === "win32" ? "missing" : "stat failed: ENOTDIR";
  assert.equal(output.permissionDecisionReason, failed("plain.mts/guard.mts", reason));
});

test("a guard printing another event's hook output is no PreToolUse decision", () => {
  const fx = fixture();
  const other = JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "note" } });
  fs.writeFileSync(path.join(fx.hooks, "other.mts"), `process.stdout.write(${JSON.stringify(other)});\n`);
  const output = dispatch(fx, [path.join(fx.hooks, "other.mts")]);
  assert.equal(output.permissionDecisionReason, failed("other.mts", "stdout is not a PreToolUse decision"));
});

test("a deny for an agent_id of 65 characters is not journalled; one of 64 characters is", () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.hooks, "deny.mts"), "process.stderr.write(\"[deny-guard] no\\n\");\nprocess.exit(2);\n");
  const journal = path.join(fx.root, ".cache", "denied-calls");
  const long = dispatch(fx, [path.join(fx.hooks, "deny.mts")], { ...PAYLOAD, agent_id: "a".repeat(65) });
  assert.equal(long.permissionDecision, "deny");
  assert.equal(fs.existsSync(journal), false, "nothing journalled for an over-long agent_id");
  dispatch(fx, [path.join(fx.hooks, "deny.mts")], { ...PAYLOAD, agent_id: "a".repeat(64) });
  // The fixture carries no lib/denial-journal.mts, so a journalled call leaves its failure marker.
  assert.deepEqual(fs.readdirSync(journal), [`${"a".repeat(64)}.failed`]);
});
