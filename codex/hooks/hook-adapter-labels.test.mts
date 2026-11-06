// Issue #564. The Codex hook adapter and the shell dispatcher name a file by its path inside
// <CODEX_HOME>/hooks (kherep-maestro/<name>.mts, as hook integrity does), from the checkout by its
// path inside codex/hooks, else by its file name; an error by its code or class name. No deny,
// notice or stderr line they build carries an absolute path, a `..` escape or an error message.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { faultEnv, fired } from "../../claude/hooks/fault-preload.fixture.mts";
import { ABSOLUTE_PATH } from "../../claude/hooks/lib/denial-journal.mts";
import { copyAdapter } from "./hook-adapter.fixture.mts";
import { runAdaptedHook } from "./hook-adapter.mts";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const ADAPTER = path.join(import.meta.dirname, "hook-adapter.mts");
const ESCAPE = /(^|[\s(])\.\.[\\/]/;
const BLOCKED = "the tool call is blocked until hook integrity restores it";
const PAYLOAD = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "shell_command", tool_input: { command: "git status" } });
const SHELL = JSON.parse(PAYLOAD);

// Nothing the adapter printed names a path; roots are the directories that must not appear.
function assertClean(text: string, ...roots: string[]): void {
  assert.doesNotMatch(text, ABSOLUTE_PATH, text);
  assert.doesNotMatch(text, ESCAPE, text);
  for (const root of [...roots, os.tmpdir()]) assert.ok(!text.includes(root), text);
}

const reasonOf = (stdout: string): string => String((JSON.parse(stdout) as { hookSpecificOutput: { permissionDecisionReason?: string } })
  .hookSpecificOutput.permissionDecisionReason);

function run(args: string[], input = PAYLOAD, env = process.env): { stdout: string; stderr: string; reason: string } {
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", ...args], { input, encoding: "utf8", env, windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout, stderr: result.stderr, reason: result.stdout ? reasonOf(result.stdout) : "" };
}

// The installed layout <root>/hooks/kherep-maestro without codex-hook-integrity.mts or a heartbeat;
// linked: the same tree reached through a directory symlink (junction on Windows), else undefined.
function installed(t: TestContext, linked = false): { root: string; dir: string; via: string } | undefined {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-adapter-labels-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "hooks", "kherep-maestro");
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  copyAdapter(dir, "codex-hook-adapter.mts");
  copyAdapter(dir); // the shell dispatcher imports ./hook-adapter.mts
  fs.copyFileSync(path.join(import.meta.dirname, "shell-checks.mts"), path.join(dir, "codex-shell-checks.mts"));
  fs.copyFileSync(path.join(REPO, "claude", "hooks", "lib", "guard-recheck.mts"), path.join(dir, "lib", "guard-recheck.mts"));
  const guards = { "commit-guard.mts": "process.exit(1);\n", "deploy-guard.mts": "process.exit(0);\n",
    "main-checkout-guard.mts": "process.exit(0);\n", "module-label-guard.mts": "process.exit(0);\n", "empty.mts": "", "quiet.mts": "process.exit(2);\n" };
  for (const [name, body] of Object.entries(guards)) fs.writeFileSync(path.join(dir, name), body);
  if (!linked) return { root, dir, via: dir };
  const link = path.join(fs.realpathSync(os.tmpdir()), `kherep-adapter-labels-link-${process.pid}-${path.basename(root)}`);
  try { fs.symlinkSync(root, link, process.platform === "win32" ? "junction" : "dir"); } catch { return undefined; }
  t.after(() => fs.rmSync(link, { force: true }));
  return { root: link, dir, via: path.join(link, "hooks", "kherep-maestro") };
}

test("installed: a guard, a silent exit 2, the adapter itself and the integrity lines are named inside hooks/", (t) => {
  const box = installed(t)!;
  const empty = run([path.join(box.dir, "codex-hook-adapter.mts"), path.join(box.dir, "empty.mts"), "pre"]);
  assert.equal(empty.reason, `[hook-adapter] kherep-maestro/empty.mts cannot run (empty, 0 bytes); ${BLOCKED}`);
  assert.ok(empty.stderr.includes("kherep-maestro/codex-shell-checks.mts cannot be trusted (no proven record)\n"), empty.stderr);
  assert.ok(empty.stderr.includes("  - kherep-maestro/codex-hook-integrity.mts cannot run (missing)"), empty.stderr);
  const quiet = run([path.join(box.dir, "codex-hook-adapter.mts"), path.join(box.dir, "quiet.mts"), "pre"]);
  assert.equal(quiet.reason, "kherep-maestro/quiet.mts blocked this tool call without giving a reason.");
  const self = run([path.join(box.dir, "codex-hook-adapter.mts")], "{}");
  assert.equal(self.reason, `[hook-adapter] kherep-maestro/codex-hook-adapter.mts cannot run (no guard given); ${BLOCKED}`);
  for (const result of [empty, quiet, self]) assertClean(result.stdout + result.stderr, box.root);
});

test("installed: a syntax-broken codex-hook-integrity.mts is named by its label in the re-check lines", (t) => {
  const box = installed(t)!;
  fs.writeFileSync(path.join(box.dir, "codex-hook-integrity.mts"), "const = ;\n");
  const result = run([path.join(box.dir, "codex-hook-adapter.mts"), path.join(box.dir, "empty.mts"), "pre"]);
  assert.ok(result.stderr.includes("  - kherep-maestro/codex-hook-integrity.mts exited with code 1"), result.stderr);
  assertClean(result.stdout + result.stderr, box.root);
});

test("a symlinked Codex home: the adapter and the shell dispatcher give the same label", (t) => {
  const box = installed(t, true);
  if (!box) return t.skip("cannot create a directory symlink here");
  const expected = `[hook-adapter] kherep-maestro/commit-guard.mts cannot run (exit code 1); ${BLOCKED}`;
  const adapter = run([path.join(box.via, "codex-hook-adapter.mts"), path.join(box.via, "commit-guard.mts"), "pre"]);
  const shell = run([path.join(box.via, "codex-shell-checks.mts")]);
  assert.equal(adapter.reason, expected);
  assert.equal(shell.reason, expected);
  for (const result of [adapter, shell]) assertClean(result.stdout + result.stderr, box.root, path.dirname(path.dirname(box.dir)));
});

test("from the checkout: the adapter's own deny names hook-adapter.mts, a stdin error by its code", (t) => {
  const mark = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-adapter-labels-mark-"))), "fault-fired");
  t.after(() => fs.rmSync(path.dirname(mark), { recursive: true, force: true }));
  const self = run([ADAPTER], "{}");
  assert.equal(self.reason, `[hook-adapter] hook-adapter.mts cannot run (no guard given); ${BLOCKED}`);
  const stdin = run([ADAPTER, path.join(os.tmpdir(), "never-run.mts"), "pre"], PAYLOAD, faultEnv("stdin-error", "hook-adapter.mts", mark));
  assert.deepEqual(fired(mark), ["stdin-error"]);
  assert.equal(stdin.reason, `[hook-adapter] hook-adapter.mts cannot run (stdin read failed (EIO)); ${BLOCKED}`);
  for (const result of [self, stdin]) assertClean(result.stdout + result.stderr, REPO);
});

test("in process: every guard failure and every spawn throw names the file and a code only", (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-adapter-labels-guards-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, body: string): string => { fs.writeFileSync(path.join(dir, name), body); return path.join(dir, name); };
  const ask = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "sure?" } });
  const cases: [string, RegExp, number?][] = [
    [path.join(dir, "missing.mts"), /^\[hook-adapter\] missing\.mts cannot run \(missing\)/],
    [write("empty.mts", ""), /^\[hook-adapter\] empty\.mts cannot run \(empty, 0 bytes\)/],
    [dir, new RegExp(`^\\[hook-adapter\\] ${path.basename(dir)} cannot run \\(not a regular file\\)`)],
    [write("exit1.mts", "process.exit(1);\n"), /^\[hook-adapter\] exit1\.mts cannot run \(exit code 1\)/],
    [write("hang.mts", "setInterval(() => {}, 1000);\n"), /^\[hook-adapter\] hang\.mts cannot run \(timed out after 0\.3 s\)/, 300],
    [write("ask.mts", `process.stdout.write(${JSON.stringify(ask)});\n`), /^ask\.mts asked for confirmation; Codex has no ask, so the call is denied$/],
  ];
  for (const [guard, expected, timeout] of cases) {
    const reason = reasonOf(runAdaptedHook(guard, "pre", SHELL, timeout ?? 5_000).stdout);
    assert.match(reason, expected);
    assertClean(reason, dir);
  }
  const guard = write("thrown.mts", "process.exit(0);\n");
  const throws: [unknown, string, string][] = [
    [Object.assign(new Error(`${dir}/secret failed`), { code: "ERR_X" }), "pre", "spawn threw (ERR_X)"],
    [new RangeError(`${dir}/secret is out of range`), "pre", "spawn threw (RangeError)"],
    [`${dir}/a thrown string`, "pre", "spawn threw (unknown)"],
    [new RangeError(`${dir}/secret`), "pre-intent", "spawn threw (RangeError)"],
  ];
  for (const [error, phase, why] of throws) {
    const reason = reasonOf(runAdaptedHook(guard, phase, SHELL, 5_000, { spawn: () => { throw error; } }).stdout);
    assert.ok(reason.startsWith(`[hook-adapter] thrown.mts cannot run (${why}); `), reason);
    assertClean(reason, dir);
  }
});
