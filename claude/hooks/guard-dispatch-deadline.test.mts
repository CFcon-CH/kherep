// Issue #507, part 2, slow (about 25 s, the cases run in parallel). Stdin, the
// guards and the re-check share one deadline 5 s before Claude Code's 30 s hook
// timeout, so a decided deny is printed before the cancel would discard it
// (review addendum item 4). Same fixture as guard-dispatch-recheck.test.mts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";

import { dispatcherFixture } from "./guard-dispatch-fixture.mts";

const PAYLOAD = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } });
const HANG = "setInterval(() => {}, 1000);\n";
// The exact warning Node versions print for a .mts; the dispatcher drops only this one.
const STRIP = "(node:1) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\\n"
  + "(Use `node --trace-warnings ...` to show where the warning was created)\\n";
const roots: string[] = [];
after(() => { for (const root of roots) try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

interface Run { status: number | null; stdout: string; stderr: string; ms: number; killed: boolean }

// Runs the dispatcher with a fresh heartbeat; kills it at 35 s, past Claude Code's cancel.
function run(integrity: string, guards: Record<string, string>, closeStdin = true, lib?: string): Promise<Run> {
  const { root, hooks, dispatch } = dispatcherFixture("guard-dispatch-deadline-", { editsRecheck: lib !== undefined });
  roots.push(root);
  if (lib) fs.writeFileSync(path.join(hooks, "lib", "guard-recheck.mts"), lib);
  fs.writeFileSync(path.join(hooks, "live-hook-integrity.mts"), integrity);
  for (const [name, source] of Object.entries(guards)) fs.writeFileSync(path.join(hooks, name), source);
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", dispatch,
      ...Object.keys(guards).map((name) => path.join(hooks, name))], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const cancel = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, 35_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => { clearTimeout(cancel); resolve({ status, stdout, stderr, ms: Date.now() - start, killed }); });
    if (closeStdin) child.stdin.end(PAYLOAD);
    else child.stdin.write(PAYLOAD);
  });
}

const output = (result: Run) => {
  assert.equal(result.killed, false, `still running at 35 s; stdout ${result.stdout}`);
  assert.equal(result.status, 0, result.stderr);
  return (JSON.parse(result.stdout) as { hookSpecificOutput: Record<string, string> }).hookSpecificOutput;
};

describe("one shared deadline", { concurrency: true }, () => {
  test("guard hangs to its 10 s cap, then the re-check hangs: it gets what is left, the deny is printed", async () => {
    const result = await run(HANG, { "hang.mts": HANG });
    const printed = output(result);
    assert.equal(printed.permissionDecision, "deny");
    assert.match(printed.permissionDecisionReason!, /hang\.mts cannot run \(timed out after 10 s\)/);
    const budget = Number(/timed out after (\d+) ms; outcome UNKNOWN \(a heartbeat may have been written\)/.exec(printed.additionalContext ?? "")?.[1]);
    assert.ok(budget >= 12_000 && budget <= 15_500, `re-check budget ${budget} ms; context ${printed.additionalContext}`);
    assert.ok(result.ms >= 24_000 && result.ms <= 27_000, `took ${result.ms} ms`);
  });

  test("stdin held open: a deny naming the dispatcher before the cancel", async () => {
    const result = await run(HANG, { "allow.mts": "process.exit(0);\n" }, false);
    const printed = output(result);
    assert.equal(printed.permissionDecision, "deny");
    assert.match(printed.permissionDecisionReason!, /guard-dispatch\.mts cannot run \(stdin not closed within \d+ ms\)/);
    assert.ok(result.ms >= 24_000 && result.ms <= 27_000, `took ${result.ms} ms`);
  });

  test("the lib's re-check never settles and holds an interval: the deny is printed at the deadline", async () => {
    const lib = "export function recheckAfter() { setInterval(() => {}, 1000); return new Promise(() => {}); }\n";
    const result = await run(HANG, { "empty.mts": "" }, true, lib);
    const printed = output(result);
    assert.equal(printed.permissionDecision, "deny");
    assert.match(printed.permissionDecisionReason!, /empty\.mts cannot run \(empty, 0 bytes\)/);
    assert.equal(printed.additionalContext, "hook integrity re-check unavailable (no result before the hook deadline)");
    assert.ok(result.ms >= 24_000 && result.ms <= 27_000, `took ${result.ms} ms`);
  });

  test("a guard killed at its cap: its stderr is forwarded without the type-stripping warning", async () => {
    const guard = `process.stderr.write("${STRIP}own diagnostic\\n");\n${HANG}`;
    const result = await run("console.log('all 1 files OK (0 restored), heartbeat refreshed');\n", { "noisy-hang.mts": guard });
    assert.equal(output(result).permissionDecision, "deny");
    assert.match(result.stderr, /own diagnostic/);
    assert.doesNotMatch(result.stderr, /Type Stripping/);
  });
});
