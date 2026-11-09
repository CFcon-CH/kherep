import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  decision,
  type StopDecision,
  type StopInput,
} from "./observation-turn-completion.mts";

// Some Node releases the engines range admits, 24.1.0 among them, print this
// warning when a child loads a .mts file. Only this exact pair of lines is
// dropped; any other stderr still fails the assertion.
const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was "
  + "created\\)\\r?\\n", "gm");
const withoutTypeStrippingWarning = (stderr: string | Buffer): string =>
  String(stderr).replace(TYPE_STRIPPING_WARNING, "");

const hookPath = fileURLToPath(new URL("./observation-turn-completion.mts", import.meta.url));

function runCli(input: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [hookPath], {
    encoding: "utf8",
    input,
  });
}

test("blocks an exact false lifecycle state with one bounded observation instruction", () => {
  const input: StopInput = { stop_hook_active: false };
  const workspace = path.join("C:", "workspace with spaces ' and $(throw 'expanded')", "Kherep");
  const broker = path.join(workspace, "tools", "atl-confluence.mts");
  const brokerLiteral = `'${broker.replaceAll("'", "''")}'`;
  const result: StopDecision | null = decision(input, workspace);

  assert.ok(result);
  assert.deepEqual(Object.keys(result).sort(), ["decision", "reason"]);
  assert.equal(result.decision, "block");
  assert.match(result.reason, /dispatch exactly one `codex-obs`/i);
  assert.match(result.reason, /fork_turns:\s*"none"/i);
  assert.match(
    result.reason,
    /pass only the completed turn, relevant tool evidence, and compact task state/i,
  );
  assert.match(result.reason, /one strict OBS-RESULT receipt/i);
  assert.match(result.reason, /mcp__kherep_observations__publish_observations/);
  assert.match(result.reason, /literal canonical authority/);
  assert.match(result.reason, /Independently validate the handback/);
  assert.match(result.reason, /NO further publication/);
  assert.doesNotMatch(result.reason, /__KHEREP_SELECTED_WORKSPACE__/);
  assert.doesNotMatch(result.reason, /D:\/Workspaces/i);
  assert.match(result.reason, /Empty findings cause zero I\/O/i);
  assert.doesNotMatch(result.reason, /trusted Maestro main thread.*node/i);
  assert.match(result.reason, /never dispatch a second pass/i);
  assert.doesNotMatch(result.reason, /transcript_path/i);
});

test("does not block an active Stop hook", () => {
  assert.equal(decision({ stop_hook_active: true }), null);
});

test("fails open when the lifecycle flag is missing or malformed", () => {
  for (const stop_hook_active of [undefined, null, "true", "false", 0, 1, {}, []]) {
    assert.equal(decision({ stop_hook_active }), null);
  }
});

test("CLI emits only the decision JSON for an exact false lifecycle state", () => {
  const result = runCli(JSON.stringify({ stop_hook_active: false }));
  const expected = decision({ stop_hook_active: false });

  assert.equal(result.status, 0);
  assert.equal(withoutTypeStrippingWarning(result.stderr), "");
  assert.equal(result.stdout, JSON.stringify(expected));
  assert.deepEqual(JSON.parse(result.stdout), expected);
});

test("CLI emits nothing for true, missing, malformed, and invalid JSON inputs", () => {
  const inputs = [
    JSON.stringify({ stop_hook_active: true }),
    JSON.stringify({}),
    JSON.stringify({ stop_hook_active: "true" }),
    JSON.stringify({ stop_hook_active: null }),
    "{bad json",
  ];

  for (const input of inputs) {
    const result = runCli(input);
    assert.equal(result.status, 0);
    assert.equal(withoutTypeStrippingWarning(result.stderr), "");
    assert.equal(result.stdout, "");
  }
});
