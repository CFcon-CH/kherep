// Issue #507, part 3. The Codex hook adapter in its PreToolUse phases: every guard
// that cannot run, or runs past its budget, is a deny that names the file; one
// integer clock from the adapter's start bounds stdin and every guard item. Guards
// are synthetic files in a mkdtemp; the adapter runs from the checkout, so it never
// re-checks hook integrity (hook-adapter-recheck.test.mts covers that).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import * as adapter from "./hook-adapter.mts";
import { renderHooks } from "../lib/parity-config.mts";

const ADAPTER = path.join(import.meta.dirname, "hook-adapter.mts");
const SHELL = { tool_name: "shell_command", tool_input: { command: "git status" } };
const IGNORES_TERM = "process.on('SIGTERM', () => {});";
const runAdaptedHook = (...args: Parameters<typeof adapter.runAdaptedHook>) => adapter.runAdaptedHook(...args);

// A guard that may log to LOG; `input` is its stdin.
function fixture(t: TestContext, body: string): { guard: string; log: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-fail-closed-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const guard = path.join(dir, "fixture-guard.mts");
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(guard, ["import fs from 'node:fs';", `const LOG = ${JSON.stringify(log)};`,
    "const input = fs.readFileSync(0, 'utf8');", body].join("\n"));
  return { guard, log, dir };
}

const reasonOf = (stdout: string): string => {
  const output = (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  assert.equal(output.permissionDecision, "deny", stdout);
  return String(output.permissionDecisionReason);
};

const runAdapter = (args: string[], input: string = JSON.stringify(SHELL)) => spawnSync(process.execPath, [ADAPTER, ...args],
  { input, encoding: "utf8", windowsHide: true, timeout: 12_000, killSignal: "SIGKILL" });

test("T1.1 a guard that ignores SIGTERM is killed at its cap and denied as timed out", (t) => {
  const { guard } = fixture(t, `${IGNORES_TERM} setTimeout(() => process.exit(0), 2000);`);
  const begin = Date.now();
  const result = runAdaptedHook(guard, "pre", SHELL, 300, { deadline: Date.now() + 8_500 });
  assert.ok(Date.now() - begin < 1000, `took ${Date.now() - begin} ms`);
  assert.equal(result.status, 0);
  assert.equal(reasonOf(result.stdout), "[hook-adapter] fixture-guard.mts cannot run (timed out after 0.3 s); the tool call is blocked until hook integrity restores it");
  assert.equal(result.broken, true);
});

test("T1.2 the adapter as a process answers within its 8.5 s clock with a guard that ignores SIGTERM", (t) => {
  const { guard } = fixture(t, `${IGNORES_TERM} setTimeout(() => {}, 20_000);`);
  const begin = Date.now();
  const run = runAdapter([guard, "pre"]);
  assert.equal(run.error, undefined, "the adapter ended by itself");
  assert.equal(run.status, 0, run.stderr);
  assert.ok(Date.now() - begin < 9_500, `took ${Date.now() - begin} ms`);
  assert.match(reasonOf(run.stdout), /fixture-guard\.mts cannot run \(timed out after 5\.0 s\)/);
});

test("T1.3 one budget across three items: the third is denied, the total stays inside the cap", (t) => {
  // Items one and two take 1 s each, item three never ends. Without one budget the run
  // would take about 1 + 1 + 5 s; with it the cap ends item three. The 1 s items leave
  // headroom for slow process starts under load, so "one\ntwo\n" is not timing-bound.
  const { guard, log } = fixture(t, `${IGNORES_TERM} const command = JSON.parse(input).tool_input.command;`
    + ` if (command !== 'three') setTimeout(() => { fs.appendFileSync(LOG, command + '\\n'); process.exit(0); }, 1000);`
    + " else setInterval(() => {}, 1000);");
  const source = ["one", "two", "three"].map((name) => `tools.shell_command({command:'${name}'})`).join("; ");
  const begin = Date.now();
  const result = runAdaptedHook(guard, "pre", { tool_name: "functions.exec", tool_input: source }, 5_000, { deadline: Date.now() + 8_500 });
  // The bound sits between the budgeted end (about 5 s) and the unbudgeted one (about 7 s).
  // Windows CI needed up to about 1 s for the kill and teardown after the cap (#952).
  assert.ok(Date.now() - begin < 6_500, `took ${Date.now() - begin} ms`);
  assert.match(reasonOf(result.stdout), /cannot run \((?:timed out after \d\.\d s|budget exhausted before item 3 of 3 \(\d+ ms used\))\)/);
  assert.equal(fs.readFileSync(log, "utf8"), "one\ntwo\n");
});

test("T1.4 a budget below the spawn cost spawns nothing and is no broken file", (t) => {
  const { guard, log } = fixture(t, "fs.appendFileSync(LOG, 'ran\\n');");
  const result = runAdaptedHook(guard, "pre", SHELL, 50, { deadline: Date.now() + 8_500 });
  assert.match(reasonOf(result.stdout), /fixture-guard\.mts cannot run \(budget exhausted before item 1 of 1 \(\d+ ms used\)\)/);
  assert.equal(fs.existsSync(log), false, "nothing was spawned");
  assert.equal(result.broken, false);
});

test("T1.5 a grandchild that holds the guard's pipe: denied as timed out at the cap", { skip: process.platform === "win32" }, (t) => {
  const { guard } = fixture(t, "import { spawn } from 'node:child_process';\n"
    + "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();\n"
    + "setTimeout(() => process.exit(0), 100);");
  const begin = Date.now();
  const result = runAdaptedHook(guard, "pre", SHELL, 500, { deadline: Date.now() + 8_500 });
  assert.ok(Date.now() - begin < 1500, `took ${Date.now() - begin} ms`);
  assert.match(reasonOf(result.stdout), /cannot run \(timed out after 0\.5 s\)/);
});

test("T1.6 stdin that stays open is a deny before the deadline", { timeout: 20_000 }, async (t) => {
  const { guard } = fixture(t, "process.exit(0);");
  const child = spawn(process.execPath, [ADAPTER, guard, "pre"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  const begin = Date.now();
  const killer = setTimeout(() => child.kill("SIGKILL"), 12_000);
  const code = await new Promise<number | null>((resolve) => child.on("exit", (exit) => resolve(exit)));
  clearTimeout(killer);
  child.stdin.destroy();
  assert.equal(code, 0, "the adapter ended by itself");
  assert.ok(Date.now() - begin < 9_500, `took ${Date.now() - begin} ms`);
  assert.match(reasonOf(out), /hook-adapter\.mts cannot run \(stdin not closed within \d+ ms\)/);
});

test("T1.8 a fractional deadline or cap reaches spawnSync as an integer: the healthy guard runs and allows", (t) => {
  const { guard, log } = fixture(t, "fs.appendFileSync(LOG, 'ran\\n');");
  const first = runAdaptedHook(guard, "pre", SHELL, 5_000, { deadline: Date.now() + 4_500.375 });
  assert.equal(first.status, 0);
  assert.equal(first.stdout, "");
  const second = runAdaptedHook(guard, "pre", SHELL, 300.5);
  assert.equal(second.status, 0);
  assert.equal(second.stdout, "");
  assert.equal(fs.readFileSync(log, "utf8"), "ran\nran\n");
});

test("T1.9 a spawn that throws synchronously is a deny naming the error code, not a broken file", (t) => {
  const { guard } = fixture(t, "");
  const result = runAdaptedHook(guard, "pre", SHELL, 5_000, {
    spawn: () => { throw Object.assign(new RangeError("x"), { code: "ERR_OUT_OF_RANGE" }); },
  });
  assert.equal(result.status, 0);
  assert.match(reasonOf(result.stdout), /fixture-guard\.mts cannot run \(spawn threw \(ERR_OUT_OF_RANGE\)\)/);
  assert.doesNotMatch(reasonOf(result.stdout), /: x\)/, "the code only, never the message (issue #564)");
  assert.equal(result.broken, false);
});

test("T1.10 every budget is an integer, also for a fractional clock", () => {
  const budgetFor = (adapter as unknown as Record<string, (c: number, h: number, n: number) => number>).budgetFor;
  assert.equal(budgetFor(Infinity, 9500.375, 5000), 4500);
  assert.equal(budgetFor(5300.5, Infinity, 5000), 300);
  assert.ok(Number.isInteger(budgetFor(1792492922259.592 + 8500, 1792492922259.592 + 5000.25, 1792492922259)));
});

test("passes every argument after the phase to the guard unchanged", (t) => {
  const { guard, log } = fixture(t, "fs.appendFileSync(LOG, JSON.stringify(process.argv.slice(2)));");
  const run = runAdapter([guard, "pre", "--runtime", "codex"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(log, "utf8"), '["--runtime","codex"]');
});

test("a guard that printed and then exited 1 in pre-privacy is a deny that keeps its stderr", (t) => {
  const note = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "note" } });
  const { guard } = fixture(t, `process.stdout.write(${JSON.stringify(note)}); process.stderr.write('guard crashed\\n'); process.exit(1);`);
  const run = runAdapter([guard, "pre-privacy"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(reasonOf(run.stdout), /fixture-guard\.mts cannot run \(exit code 1\)/);
  assert.match(run.stderr, /guard crashed/);
});

test("a printed ask is a deny: Codex has no ask", (t) => {
  const ask = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "sure?" } });
  const { guard } = fixture(t, `process.stdout.write(${JSON.stringify(ask)});`);
  const run = runAdapter([guard, "pre"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(reasonOf(run.stdout), "fixture-guard.mts asked for confirmation; Codex has no ask, so the call is denied");
});

test("a guard that is missing, empty, no regular file, exits 1, prints no decision, is killed or floods stdout is a deny", (t) => {
  const cases: [string, string, RegExp][] = [
    ["exit 1", "process.exit(1);", /cannot run \(exit code 1\)/],
    ["plain stdout", "process.stdout.write('hello');", /cannot run \(stdout is not a PreToolUse decision\)/],
    ["unknown field", "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', extra: 1 } }));",
      /cannot run \(stdout is not a PreToolUse decision \(unsupported field extra\)\)/],
    ["over 1 MiB", "process.stdout.write('x'.repeat(2 * 1024 * 1024));", /cannot run \(output exceeded the 1 MiB buffer\)/],
    ...(process.platform === "win32" ? [] : [["killed", "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000);", /cannot run \(killed by SIGTERM\)/] as [string, string, RegExp]]),
  ];
  for (const [label, body, reason] of cases) {
    const { guard } = fixture(t, body);
    const run = runAdapter([guard, "pre"]);
    assert.equal(run.status, 0, `${label}: ${run.stderr}`);
    assert.match(reasonOf(run.stdout), reason, label);
  }
  const { dir } = fixture(t, "");
  const empty = path.join(dir, "empty.mts");
  fs.writeFileSync(empty, "");
  for (const [file, why] of [[path.join(dir, "missing.mts"), "missing"], [empty, "empty, 0 bytes"], [dir, "not a regular file"]]) {
    const run = runAdapter([file, "pre-privacy"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(reasonOf(run.stdout), `[hook-adapter] ${path.basename(file)} cannot run (${why}); the tool call is blocked until hook integrity restores it`);
    assert.ok(!reasonOf(run.stdout).includes(os.tmpdir()), "named by its file name, not its path (issue #564)");
  }
});

test("no guard, a relative guard path or stdin that is no JSON object is a deny naming the adapter", (t) => {
  const { guard } = fixture(t, "");
  for (const [args, input, why] of [[[], "{}", "no guard given"], [["guard.mts", "pre"], "{}", "guard path is not absolute"],
    [[guard, "pre"], "not json", "stdin is not a JSON object"], [[guard, "pre"], "[]", "stdin is not a JSON object"]] as [string[], string, string][]) {
    const run = runAdapter(args, input);
    assert.equal(run.status, 0, run.stderr);
    assert.match(reasonOf(run.stdout), new RegExp(`hook-adapter\\.mts cannot run \\(${why}\\)`), why);
  }
});

// Issue #507, part 4: the three former direct guards are adapter entries too.
test("HOOK_TIMEOUT_MS equals the timeout of all five rendered PreToolUse adapter entries", () => {
  const source = fs.readFileSync(ADAPTER, "utf8");
  const pinned = Number(/^const HOOK_TIMEOUT_MS = ([\d_]+);/m.exec(source)?.[1]?.replaceAll("_", ""));
  const config = renderHooks({ contextHook: "/synthetic/context.mts", hookDir: "/synthetic/hooks", node: "node" } as Parameters<typeof renderHooks>[0]);
  const entries = config.split(/^\[\[hooks\.PreToolUse\.hooks\]\]$/m).slice(1)
    .filter((block) => /^command = .*codex-hook-adapter\.mts[^\n]*\\" \\"pre(?:-privacy)?\\"/m.test(block));
  assert.equal(entries.length, 5, "both privacy groups and the Atlassian, dispatch-contract and Playwright guards");
  for (const block of entries) assert.equal(Number(/^timeout = (\d+)$/m.exec(block)?.[1]) * 1000, pinned);
});

// Issue #538: the messaging intent entry has its own clock, pinned against its rendered timeout.
test("INTENT_HOOK_TIMEOUT_MS equals the timeout of the rendered pre-intent entry", () => {
  const source = fs.readFileSync(ADAPTER, "utf8");
  const pinned = Number(/^const INTENT_HOOK_TIMEOUT_MS = ([\d_]+);/m.exec(source)?.[1]?.replaceAll("_", ""));
  const config = renderHooks({ contextHook: "/synthetic/context.mts", hookDir: "/synthetic/hooks", node: "node",
    messagingClient: { enabled: true, bridge: "/synthetic/bridge.mts", intentHook: "/synthetic/mcp-intent-hook.mts", configRoot: "/synthetic/root" },
  } as Parameters<typeof renderHooks>[0]);
  const entries = config.split(/^\[\[hooks\.PreToolUse\.hooks\]\]$/m).slice(1)
    .filter((block) => /^command = .*codex-hook-adapter\.mts[^\n]*\\" \\"pre-intent\\"/m.test(block));
  assert.equal(entries.length, 1, "the messaging intent entry");
  assert.equal(Number(/^timeout = (\d+)$/m.exec(entries[0]!)?.[1]) * 1000, pinned);
});
