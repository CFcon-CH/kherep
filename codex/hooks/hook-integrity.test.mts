// Issue #275. The pure parts of the Codex hook-integrity hook: which commands
// it reads, which files it keeps, where each installed file comes from, and
// which checkout it restores from. The installed hook end to end is in
// codex/hook-integrity-install.test.mts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";

import { checkoutOf, hookCommandParts, lib, loadLibs, wiredHookFiles } from "./hook-integrity.mts";
import { ALWAYS_CHECK, sourceOf } from "./hook-integrity-sources.mts";

const REPO = path.resolve(import.meta.dirname, "..", "..").replace(/\\/g, "/");

before(async () => {
  assert.equal(await loadLibs(), null, "the libs load from the checkout's claude/hooks/lib");
});

test("loads every lib it uses as functions", () => {
  for (const fn of ["isWithinPath", "joinPathLike", "normalizePathLike", "checkoutFor", "isCheckout", "writeExact", "hookInventory", "syntaxVerdict",
    "takeRunLock", "invalidateHeartbeat", "writeHeartbeat", "classify", "repairPasses", "finalPass"]) {
    assert.equal(typeof Reflect.get(lib, fn), "function", fn);
  }
});

// Issue #507, part 3: run.lock and the heartbeat come before every lib a restore does not
// need, and the shared pass loop is one of the steps; the adapter's computed lib is checked.
test("loads the lock lib fourth and the shared pass loop last; the adapter's re-check lib is always checked", () => {
  const source = fs.readFileSync(path.join(REPO, "codex", "hooks", "hook-integrity.mts"), "utf8");
  const steps = [...source.matchAll(/\["([a-z-]+\.mts)", \[/g)].map((match) => match[1]);
  assert.deepEqual(steps, ["workspace-scope.mts", "orchestra-checkout.mts", "restore-write.mts", "integrity-heartbeat.mts",
    "hook-inventory.mts", "hook-syntax.mts", "integrity-verdict.mts", "integrity-passes.mts"]);
  assert.match(source, /^const RESTORE_LIBS = 4;$/m);
  assert.ok(ALWAYS_CHECK.includes("./lib/guard-recheck.mts"));
  const adapter = fs.readFileSync(path.join(REPO, "codex", "hooks", "hook-adapter.mts"), "utf8");
  assert.match(adapter, /"lib", "guard-recheck\.mts"/);
});

test("reads the double-quoted parts of every command in every hooks table, and nothing else", () => {
  const config = [
    "[mcp_servers.x]", 'command = "\\"/home/u/.codex/hooks/not-a-hook.mts\\""', "",
    "[[hooks.PreToolUse]]", 'matcher = "Bash"', "",
    "[[hooks.PreToolUse.hooks]]", 'type = "command"',
    'command = "\\"C:\\\\Program Files\\\\node.exe\\" \\"C:\\\\Users\\\\a b\\\\.codex\\\\hooks\\\\kherep-maestro\\\\codex-hook-adapter.mts\\" \\"pre\\""',
    'commandWindows = "& \\"C:\\\\other.mts\\""', "timeout = 10", "",
    "[[hooks.Stop.hooks]]", `command = '"node" "/home/u/.codex/hooks/literal.js"'`,
  ].join("\n");
  assert.deepEqual(hookCommandParts(config), [
    "C:\\Program Files\\node.exe", "C:\\Users\\a b\\.codex\\hooks\\kherep-maestro\\codex-hook-adapter.mts", "pre",
    "node", "/home/u/.codex/hooks/literal.js",
  ]);
  assert.deepEqual(hookCommandParts("[[hooks.Stop.hooks]]\ncommand = \"\\\"/x.mts\\\" \\uZZZZ\"\n"), [], "an undecodable string is skipped");
});

test("keeps only .mts and .js files under the hooks directory, once each", () => {
  const hooksDir = "C:/Users/a b/.codex/hooks";
  const files = wiredHookFiles([
    "C:\\Program Files\\node.exe", "C:\\Users\\a b\\.codex\\hooks\\kherep-maestro\\commit-guard.mts",
    "c:/users/a b/.codex/hooks/kherep-maestro/commit-guard.mts", "C:/Users/a b/.codex/hooks/x.js",
    "C:/Users/a b/.codex/hooks/run.sh", "C:/elsewhere/hooks/y.mts", "pre",
  ], hooksDir);
  assert.deepEqual(files.map(({ rel }) => rel), ["kherep-maestro/commit-guard.mts", "x.js"]);
});

test("maps every installed file to its versioned source, and the rendered ones to a hint", () => {
  const map: [string, string][] = [
    ["kherep-maestro/lib/git-commit-match.mts", "claude/hooks/lib/git-commit-match.mts"],
    ["kherep-maestro/commit-guard.mts", "claude/hooks/commit-guard.mts"],
    ["kherep-maestro/codex-hook-adapter.mts", "codex/hooks/hook-adapter.mts"],
    ["kherep-maestro/hook-adapter.mts", "codex/hooks/hook-adapter.mts"],
    ["kherep-maestro/codex-hook-integrity.mts", "codex/hooks/hook-integrity.mts"],
    ["kherep-maestro/research-common.mts", "codex/hooks/research-common.mts"],
    ["kherep-maestro/post-edit-tool-calls.mts", "codex/hooks/post-edit-tool-calls.mts"],
    ["kherep-maestro/acceptance-policy.mts", "codex/hooks/acceptance-policy.mts"],
    ["kherep-maestro/obs-candidate-policy.mts", "modules/atl-jira-brokers/observation-candidate.mts"],
    ["kherep-maestro/obs-result-policy.mts", "modules/atl-jira-brokers/observation-result.mts"],
    ["kherep-maestro/codex-obs-result-check.mts", "codex/hooks/obs-result-check.mts"],
    ["kherep-maestro-context.mts", "codex/hooks/kherep-maestro-context.mts"],
  ];
  for (const [rel, from] of map) assert.deepEqual(sourceOf(rel), { from }, rel);
  for (const rel of ["kherep-maestro/codex-observation-stop.mts", "kherep-maestro/codex-observation-turn-completion.mts"]) {
    assert.match(String((sourceOf(rel) as { hint?: string }).hint), /run codex\/install\.mts/, rel);
  }
  assert.ok("hint" in sourceOf("operator-hook.mts"), "a file Kherep did not install has no source");
  for (const specifier of ALWAYS_CHECK) {
    const from = (sourceOf(`kherep-maestro/${specifier.slice(2)}`) as { from: string }).from;
    assert.ok(fs.existsSync(path.join(REPO, from)), `${specifier} has a source in claude/hooks/lib`);
  }
  // The guard really loads them through a computed require: the names stand in its source.
  const guard = fs.readFileSync(path.join(REPO, "codex", "hooks", "privacy-boundary-guard.mts"), "utf8");
  for (const name of ["workspace-scope.mts", "private-path-policy.mts"]) assert.match(guard, new RegExp(`libRoot, "${name}"`));
  const dispatchGuard = fs.readFileSync(path.join(REPO, "codex", "hooks", "dispatch-contract-guard.mts"), "utf8");
  for (const name of ["obs-brief-policy", "worker-brief-policy"]) {
    assert.match(dispatchGuard, new RegExp(`hookLib<\\w+>\\("${name}\\.mts"\\)`), name);
    assert.ok(ALWAYS_CHECK.includes(`./lib/${name}.mts`), name);
  }
});

test("resolves the checkout from the deliver-hook command first, else gives up without one", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-integrity-unit-"));
  try {
    const env = { CLAUDE_HOME: empty, KHEREP_WORKSPACE: empty };
    const deliver = `${REPO}/modules/control-plane/node/deliver-hook.mts`;
    assert.equal(checkoutOf(["node", deliver, "--runtime", "codex"], { cwd: empty }, env), REPO);
    assert.equal(checkoutOf(["node", `${empty}/gone/modules/control-plane/node/deliver-hook.mts`], { cwd: empty }, env), "");
    assert.equal(checkoutOf([], { cwd: empty }, env), "");
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

// Issue #503. The stable commands name no checkout; the pointer the installer
// wrote under <CODEX_HOME>/orchestra names it, and an unusable pointer falls
// back to the existing chain.
test("resolves the checkout from the control-plane pointer first, then the existing chain", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-integrity-pointer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "codex");
  const pointer = (value: unknown) => {
    fs.mkdirSync(path.join(home, "orchestra"), { recursive: true });
    fs.writeFileSync(path.join(home, "orchestra", "control-plane-source.json"), JSON.stringify(value));
  };
  const env = { CLAUDE_HOME: root, KHEREP_WORKSPACE: root };
  const stable = ["node", `${home}/hooks/kherep-maestro/codex-control-plane-hook.mts`, "deliver", "--runtime", "codex"];
  assert.equal(checkoutOf(stable, { cwd: root }, env, home), "", "no pointer, no deliver path");
  pointer({ version: 1, root: REPO, kind: "checkout", verified: true });
  assert.equal(checkoutOf(stable, { cwd: root }, env, home), REPO);
  pointer({ version: 1, root: path.join(root, "deleted"), kind: "checkout", verified: true });
  assert.equal(checkoutOf(stable, { cwd: root }, env, home), "", "a pointer to a deleted dir falls back");
  assert.equal(checkoutOf(["node", `${REPO}/modules/control-plane/node/deliver-hook.mts`], { cwd: root }, env, home), REPO,
    "an older deliver path is the next stage");
  assert.deepEqual(sourceOf("kherep-maestro/codex-control-plane-hook.mts"), { from: "codex/hooks/control-plane-hook.mts" });
});

// A pointer becomes a restore source only after the entry point's own schema check.
test("accepts exactly the pointers the entry point accepts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-integrity-schema-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { readPointer } = await import("./control-plane-hook.mts");
  const file = path.join(root, "orchestra", "control-plane-source.json");
  fs.mkdirSync(path.dirname(file));
  const env = { CLAUDE_HOME: root, KHEREP_WORKSPACE: root };
  const valid = { version: 1, root: REPO, kind: "checkout", verified: true };
  const cases: unknown[] = [valid, { ...valid, kind: "pin", commit: "0123456789abcdef0123456789abcdef01234567" },
    { ...valid, version: 2 }, { ...valid, root: "." }, { ...valid, root: path.relative(process.cwd(), REPO) || "." },
    { version: 1, root: REPO }, { ...valid, kind: "other" }, { ...valid, verified: "yes" }, { ...valid, commit: "abc" }, [valid], null];
  for (const value of cases) {
    fs.writeFileSync(file, JSON.stringify(value));
    const accepted = "pointer" in readPointer(file);
    assert.equal(checkoutOf([], { cwd: root }, env, root), accepted ? REPO : "", JSON.stringify(value));
  }
  assert.equal(cases.filter((value) => { fs.writeFileSync(file, JSON.stringify(value)); return "pointer" in readPointer(file); }).length, 2);
});

test("maps a wired path under a symlinked spelling of the home onto the real hooks dir", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-integrity-alias-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, "real-home");
  fs.mkdirSync(path.join(real, "hooks", "kherep-maestro"), { recursive: true });
  fs.writeFileSync(path.join(real, "hooks", "kherep-maestro", "commit-guard.mts"), "export {};\n");
  const alias = path.join(root, "alias-home");
  try { fs.symlinkSync(real, alias, "junction"); } catch (error) { t.skip(`no directory link here (${(error as NodeJS.ErrnoException).code})`); return; }
  const hooksDir = `${lib.normalizePathLike(fs.realpathSync(real))}/hooks`;
  const wired = wiredHookFiles([path.join(alias, "hooks", "kherep-maestro", "commit-guard.mts")], hooksDir);
  assert.deepEqual(wired.map((entry) => entry.rel), ["kherep-maestro/commit-guard.mts"]);
  assert.ok(wired[0].file.startsWith(hooksDir), wired[0].file);
  // A path outside the home stays outside, link or not.
  assert.deepEqual(wiredHookFiles([path.join(root, "elsewhere.mts")], hooksDir), []);
});

// Issue #906: a command value starts at its first non-blank, or the line has none.
test("command values are read after the blanks around =, and a line break after the value hides it", () => {
  const H = "[[hooks.Stop.hooks]]\n";
  assert.deepEqual(hookCommandParts(`${H}command   =\t"node \\"/h/a.mts\\""`), ["/h/a.mts"]);
  assert.deepEqual(hookCommandParts(`${H}  command="node \\"/h/a.mts\\" \\"/h/b.mts\\""`), ["/h/a.mts", "/h/b.mts"]);
  assert.deepEqual(hookCommandParts(`${H}command = 'node "/h/c.mts"'`), ["/h/c.mts"]);
  for (const line of ["command =", "command =   ", 'command = "node \\"/h/a.mts\\""\u2028x']) assert.deepEqual(hookCommandParts(H + line), [], line);
  const started = performance.now();
  assert.deepEqual(hookCommandParts(`${H}command =${" ".repeat(50_000)}x\ry`), []);
  assert.ok(performance.now() - started < 200, "linear on a long blank run");
});
