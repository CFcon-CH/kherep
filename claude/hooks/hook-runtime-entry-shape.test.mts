// Issue #965: the refusals of kherep/hook-runtime/entry.mts that the other entry suites do not reach.
// A call without mode or main is usage; a PreToolUse main whose stdout is JSON of the wrong shape is
// denied with the reason naming what is wrong; a reader main killed by a signal ends with exit 1; and a
// journalled deny keeps no tool_use_id or tool_name that is not a string. Synthetic temporary homes only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { cleanup, entry, runtimeHome } from "./hook-runtime-fixture.mts";
import { journalPaths } from "./lib/denial-journal.mts";

after(cleanup);
const reasonOf = (stdout: string): string => JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason;
const USAGE = "[hook-entry] usage: entry.mts <pretool|reader|writer> <main> [args...]";

test("a call without a known mode or without a main is usage: a deny for pretool, exit 1 otherwise", () => {
  const home = runtimeHome("entry-shape-");
  const run = (...argv: string[]) => spawnSync(process.execPath, [path.join(home.runtime, "entry.mts"), ...argv],
    { input: "{}", encoding: "utf8", windowsHide: true });
  const pretool = run("pretool");
  assert.deepEqual([pretool.status, reasonOf(pretool.stdout), pretool.stderr], [0, USAGE, ""]);
  for (const argv of [["reader"], ["writer"], [], ["sideways", path.join(home.hooks, "main.mts")]]) {
    const other = run(...argv);
    assert.deepEqual([other.status, other.stdout, other.stderr], [1, "", `${USAGE}\n`], JSON.stringify(argv));
  }
});

const output = (fields: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...fields }, ...extra });

for (const [label, stdout, why] of [
  ["null", "null", "stdout is not a PreToolUse decision"],
  ["an array", "[]", "stdout is not a PreToolUse decision"],
  ["another event", JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "deny" } }), "stdout is not a PreToolUse decision"],
  ["a field beside hookSpecificOutput", output({ permissionDecision: "deny" }, { decision: "block" }), "stdout is not a PreToolUse decision"],
  ["neither decision nor context", output({}), "stdout is not a PreToolUse decision"],
  ["an unknown decision", output({ permissionDecision: "maybe" }), "stdout has an invalid permissionDecision"],
  ["a reason without a decision", output({ permissionDecisionReason: "why", additionalContext: "note" }), "stdout has an invalid permissionDecisionReason"],
  ["a reason that is no string", output({ permissionDecision: "deny", permissionDecisionReason: 7 }), "stdout has an invalid permissionDecisionReason"],
  ["an empty context", output({ permissionDecision: "allow", additionalContext: "" }), "stdout has an invalid additionalContext"],
] as const) {
  test(`a PreToolUse main printing ${label} is denied with that reason`, () => {
    const home = runtimeHome("entry-shape-");
    const main = path.join(home.hooks, "main.mts");
    fs.writeFileSync(main, `process.stdout.write(${JSON.stringify(stdout)});\n`);
    const run = entry("pretool", main);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(reasonOf(run.stdout), `[hook-entry] main.mts cannot run (${why}); the tool call is blocked until hook integrity restores it`);
  });
}

test("a context-only PreToolUse result passes through unchanged", () => {
  const home = runtimeHome("entry-shape-");
  const main = path.join(home.hooks, "main.mts");
  const note = output({ additionalContext: "note" });
  fs.writeFileSync(main, `process.stdout.write(${JSON.stringify(note)});\n`);
  assert.deepEqual([entry("pretool", main).status, entry("pretool", main).stdout], [0, note]);
});

test("a reader main killed by a signal ends with exit 1 and its own output", () => {
  const home = runtimeHome("entry-shape-");
  const main = path.join(home.hooks, "main.mts");
  fs.writeFileSync(main, "process.stdout.write(\"partial\", () => process.kill(process.pid, \"SIGKILL\"));\n");
  const run = entry("reader", main);
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, "partial");
});

test("a journalled deny records a tool_use_id or tool_name that is no string as null", () => {
  const home = runtimeHome("entry-shape-");
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: 7, tool_use_id: ["x"], agent_id: "agent-s1" });
  const run = entry("pretool", path.join(home.hooks, "absent.mts"), [], input);
  assert.equal(run.status, 0, run.stderr);
  const line = JSON.parse(fs.readFileSync(journalPaths(home.root, "agent-s1").journal, "utf8").trim());
  assert.deepEqual([line.kind, line.id, line.tool, line.reason], ["entry-deny", null, null, reasonOf(run.stdout)]);
});
