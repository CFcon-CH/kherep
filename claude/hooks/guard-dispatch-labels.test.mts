// Issue #564. The dispatcher names a guard by its path inside hooks/ (sub/x.mts), else by its
// file name, and itself as guard-dispatch.mts; no reason, notice or stderr line it builds
// carries an absolute path (POSIX, drive, UNC, home-relative), a `..` escape or raw error
// text. Synthetic guards only: a real guard's own exit-2 text is not the dispatcher's.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { faultEnv, fired } from "./fault-preload.fixture.mts";
import { dispatcherFixture, type DispatcherFixture } from "./guard-dispatch-fixture.mts";
import { ABSOLUTE_PATH } from "./lib/denial-journal.mts";

const ESCAPE = /(^|[\s(])\.\.[\\/]/;
const RAW = /injected|Error:|errno|syscall|no such file|cannot be empty|Received/;
const BLOCKED = "the tool call is blocked until hook integrity restores it";
const PAYLOAD = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "true" } });
const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(prefix: string, heartbeat = true, editsRecheck = false): DispatcherFixture {
  const fx = dispatcherFixture(prefix, { heartbeat, editsRecheck });
  roots.push(fx.root);
  fs.writeFileSync(path.join(fx.hooks, "allow.mts"), "process.exit(0);\n");
  return fx;
}

interface Run { reason: string; context: string; stdout: string; stderr: string }
function dispatch(fx: DispatcherFixture, guards: string[], input = PAYLOAD, env = process.env): Run {
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", fx.dispatch, ...guards],
    { input, encoding: "utf8", env, windowsHide: true, timeout: 40_000 });
  assert.equal(run.status, 0, run.stderr);
  const output = run.stdout ? (JSON.parse(run.stdout) as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput : {};
  return { reason: String(output.permissionDecisionReason ?? ""), context: String(output.additionalContext ?? ""), stdout: run.stdout, stderr: run.stderr };
}

// No absolute path of any form, no root, no tmpdir, no `..` escape in what the dispatcher printed. A guard's own
// stderr passes through (Node names a syntax-broken guard by its URL), so stderr is checked wherever a guard wrote none.
function assertClean(run: Run, root: string, guardStderr = false): void {
  for (const text of [run.reason, run.context, run.stdout, guardStderr ? "" : run.stderr]) {
    assert.doesNotMatch(text, ABSOLUTE_PATH, text);
    assert.doesNotMatch(text, ESCAPE, text);
    assert.ok(!text.includes(root) && !text.includes(os.tmpdir()), text);
  }
}

const failed = (label: string, why: string): string => `[guard-dispatch] ${label} cannot run (${why}); ${BLOCKED}`;

test("a guard in a sub-directory of hooks/ is named by its path inside it", () => {
  const fx = fixture("guard-dispatch-labels-sub-");
  fs.mkdirSync(path.join(fx.hooks, "sub"));
  fs.writeFileSync(path.join(fx.hooks, "sub", "empty.mts"), "");
  fs.writeFileSync(path.join(fx.hooks, "sub", "exit1.mts"), "process.exit(1);\n");
  const empty = dispatch(fx, [path.join(fx.hooks, "sub", "empty.mts")]);
  assert.equal(empty.reason, failed("sub/empty.mts", "empty, 0 bytes"));
  const exit1 = dispatch(fx, [path.join(fx.hooks, "allow.mts"), path.join(fx.hooks, "sub", "exit1.mts")]);
  assert.equal(exit1.reason, failed("sub/exit1.mts", "exit code 1"));
  for (const run of [empty, exit1]) assertClean(run, fx.root);
});

test("every way a guard or the dispatcher fails names a label, never a path", () => {
  const fx = fixture("guard-dispatch-labels-matrix-");
  const guards: Record<string, string> = {
    "empty.mts": "", "syntax.mts": "export const x = ;\n", "exit1.mts": "process.exit(1);\n", "garbage.mts": "process.stdout.write(\"x\");\n",
    "unsupported.mts": "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: \"PreToolUse\", extra: 1 } }));\n",
    "quiet.mts": "process.exit(2);\n", "hang.mts": "setInterval(() => {}, 1000);\n",
    ...(process.platform === "win32" ? {} : { "signal.mts": "process.kill(process.pid, \"SIGKILL\");\n" }),
  };
  for (const [name, body] of Object.entries(guards)) fs.writeFileSync(path.join(fx.hooks, name), body);
  fs.mkdirSync(path.join(fx.hooks, "a-directory.mts"));
  const outside = path.join(fx.root, "outside.mts");
  fs.writeFileSync(outside, "process.exit(0);\n");
  const cases: [string[], string, RegExp][] = [
    ...Object.keys(guards).filter((name) => name !== "quiet.mts").map((name): [string[], string, RegExp] =>
      [[path.join(fx.hooks, name)], name, /./]),
    [[path.join(fx.hooks, "missing.mts")], "missing.mts", /\(missing\)/],
    [[path.join(fx.hooks, "a-directory.mts")], "a-directory.mts", /\(not a regular file\)/],
    [[outside], "outside.mts", /\(outside the hooks directory\)/],
    [[fx.dispatch], "guard-dispatch.mts", /\(it is the dispatcher itself\)/],
    [[], "guard-dispatch.mts", /\(no guard given\)/],
  ];
  try {
    fs.symlinkSync(outside, path.join(fx.hooks, "linked.mts"), "file");
    cases.push([[path.join(fx.hooks, "linked.mts")], "linked.mts", /\(outside the hooks directory\)/]);
  } catch { /* no file symlinks here: guard-dispatch.test.mts skips that case too */ }
  for (const [args, label, why] of cases) {
    const run = dispatch(fx, args);
    assert.ok(run.reason.startsWith(`[guard-dispatch] ${label} cannot run (`), run.reason);
    assert.match(run.reason, why);
    assertClean(run, fx.root, label === "syntax.mts");
  }
  for (const input of ["{not json", "[1]"]) {
    const run = dispatch(fx, [path.join(fx.hooks, "allow.mts")], input);
    assert.equal(run.reason, failed("guard-dispatch.mts", "stdin is not a JSON object"));
    assertClean(run, fx.root);
  }
  const quiet = dispatch(fx, [path.join(fx.hooks, "quiet.mts")]);
  assert.equal(quiet.reason, "quiet.mts blocked this tool call without giving a reason");
  assertClean(quiet, fx.root);
});

test("a stdin stream error is named by its code: stdin read failed (EIO)", () => {
  const fx = fixture("guard-dispatch-labels-stdin-");
  const mark = path.join(fx.root, "fault-fired");
  const run = dispatch(fx, [path.join(fx.hooks, "allow.mts")], PAYLOAD, faultEnv("stdin-error", "guard-dispatch.mts", mark));
  assert.deepEqual(fired(mark), ["stdin-error"]);
  assert.equal(run.reason, failed("guard-dispatch.mts", "stdin read failed (EIO)"));
  assert.doesNotMatch(run.stdout + run.stderr, RAW);
  assertClean(run, fx.root);
});

test("a syntax-broken lib/guard-recheck.mts is named by its error code, no message", () => {
  const fx = fixture("guard-dispatch-labels-lib-", false, true);
  fs.writeFileSync(path.join(fx.hooks, "lib", "guard-recheck.mts"), "export const = ;\n");
  const run = dispatch(fx, [path.join(fx.hooks, "allow.mts")]);
  // Node error code first, the class name only where an engine has no code.
  assert.match(run.context, /^hook integrity re-check unavailable \(lib\/guard-recheck\.mts cannot be loaded \((ERR_INVALID_TYPESCRIPT_SYNTAX|SyntaxError)\)\)$/);
  assertClean(run, fx.root);
});

test("a syntax-broken live-hook-integrity.mts is named by its label in the re-check notice", () => {
  const fx = fixture("guard-dispatch-labels-writer-", false);
  fs.writeFileSync(path.join(fx.hooks, "live-hook-integrity.mts"), "const = ;\n");
  const run = dispatch(fx, [path.join(fx.hooks, "allow.mts")]);
  assert.equal(run.context, "hook integrity re-check (no heartbeat, last OK none):\n  - live-hook-integrity.mts exited with code 1");
  assertClean(run, fx.root);
});
