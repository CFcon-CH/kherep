// OP-1426. The commit-msg hook reads the installed policy file next to itself,
// so the work-item rule binds every runtime (PowerShell, Codex, IDE, terminal)
// and not only a process that happens to carry the KHEREP_* variables. A
// present environment variable still wins over the file.
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

// Some Node releases the engines range admits, 24.1.0 among them, print this
// warning when a child loads a .mts file. Only this exact pair of lines is
// dropped; any other stderr still fails the assertion.
const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was "
  + "created\\)\\r?\\n", "gm");
const withoutTypeStrippingWarning = (stderr: string | Buffer): string =>
  String(stderr).replace(TYPE_STRIPPING_WARNING, "");

const hookSource = path.resolve(import.meta.dirname, "..", "claude", "kherep", "githooks", "commit-msg");
const fwd = (value: string): string => value.replace(/\\/g, "/");

// Every KHEREP_* variable of the calling process is removed: the point of the
// file is that it enforces without them.
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KHEREP_")));
  return { ...base, ...extra };
}

interface Fixture { hooks: string; policy: string; workspace: string; repo: string; root: string }

// Spaces in both the hooks directory and the workspace: the live Windows homes
// and workspaces are not guaranteed to be free of them.
function fixture(t: TestContext): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-commit-policy-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hooks = path.join(root, "home dir", ".claude", "kherep", "githooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.copyFileSync(hookSource, path.join(hooks, "commit-msg"));
  fs.chmodSync(path.join(hooks, "commit-msg"), 0o755);
  const workspace = path.join(root, "Work Space");
  const repo = path.join(workspace, "repo");
  fs.mkdirSync(repo, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
  return { hooks, policy: path.join(hooks, "commit-policy"), workspace, repo, root };
}

function writePolicy(f: Fixture, lines: string[], eol = "\n"): void {
  fs.writeFileSync(f.policy, lines.join(eol) + eol);
}

function runHook(f: Fixture, subject: string, extra: Record<string, string> = {}): SpawnSyncReturns<string> {
  const message = path.join(f.repo, "COMMIT_EDITMSG");
  fs.writeFileSync(message, `${subject}\n`);
  return spawnSync("sh", [fwd(path.join(f.hooks, "commit-msg")), fwd(message)], {
    cwd: f.repo, encoding: "utf8", env: cleanEnv(extra),
  });
}

test("policy file alone enforces the work-item rule without any KHEREP_* variable", (t) => {
  const f = fixture(t);
  writePolicy(f, ["# managed", `workspace=${fwd(f.workspace)}`, "work_item_required=1"]);
  const rejected = runHook(f, "fix: missing work item");
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /requires the subject to start with the configured work-item key/);
  assert.equal(runHook(f, "ABC-12 fix: valid subject").status, 0);
});

test("policy file with CRLF line endings parses like LF", (t) => {
  const f = fixture(t);
  writePolicy(f, [`workspace=${fwd(f.workspace)}`, "work_item_required=1"], "\r\n");
  assert.equal(runHook(f, "fix: missing work item").status, 1);
  assert.equal(runHook(f, "ABC-12 fix: valid subject").status, 0);
});

test("policy file pattern applies, environment pattern overrides it", (t) => {
  const f = fixture(t);
  writePolicy(f, [`workspace=${fwd(f.workspace)}`, "work_item_required=1", "work_item_pattern=OP-[0-9]+"]);
  assert.equal(runHook(f, "ABC-12 fix: wrong project").status, 1);
  assert.equal(runHook(f, "OP-7 fix: right project").status, 0);
  assert.equal(runHook(f, "ABC-12 fix: env pattern", { KHEREP_WORK_ITEM_PATTERN: "ABC-[0-9]+" }).status, 0);
});

test("environment overrides the file in both directions", (t) => {
  const f = fixture(t);
  writePolicy(f, [`workspace=${fwd(f.workspace)}`, "work_item_required=1"]);
  assert.equal(runHook(f, "fix: env off", { KHEREP_WORK_ITEM_REQUIRED: "0" }).status, 0);
  const elsewhere = path.join(f.root, "elsewhere");
  fs.mkdirSync(elsewhere);
  assert.equal(runHook(f, "fix: env workspace", { KHEREP_WORKSPACE: fwd(elsewhere) }).status, 0);

  writePolicy(f, [`workspace=${fwd(f.workspace)}`, "work_item_required=0"]);
  assert.equal(runHook(f, "fix: file off").status, 0);
  assert.equal(runHook(f, "fix: env on", { KHEREP_WORK_ITEM_REQUIRED: "1" }).status, 1);
});

test("exemptions still apply when the file enforces", (t) => {
  const f = fixture(t);
  writePolicy(f, [`workspace=${fwd(f.workspace)}`, "work_item_required=1"]);
  assert.equal(runHook(f, "fix: escape", { KHEREP_WORK_ITEM: "none" }).status, 0);
  for (const subject of ["Merge branch 'x'", "Revert \"y\"", "fixup! z", "squash! z", "amend! z"]) {
    assert.equal(runHook(f, subject).status, 0, subject);
  }
});

test("missing policy file keeps the environment-only behaviour", (t) => {
  const f = fixture(t);
  const result = runHook(f, "fix: nothing configured");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(withoutTypeStrippingWarning(result.stderr), "");
  const withEnv = runHook(f, "fix: env only", { KHEREP_WORKSPACE: fwd(f.workspace), KHEREP_WORK_ITEM_REQUIRED: "1" });
  assert.equal(withEnv.status, 1);
});

test("a malformed policy file is ignored with a warning and never blocks commits", (t) => {
  const f = fixture(t);
  for (const lines of [
    [`workspace=${fwd(f.workspace)}`, "work_item_required=yes"],
    [`workspace=${fwd(f.workspace)}`, "work_item_required=1", "unknown_key=1"],
    [`workspace=${fwd(f.workspace)}`, "work_item_required=1", "no separator"],
  ]) {
    writePolicy(f, lines);
    const result = runHook(f, "fix: malformed");
    assert.equal(result.status, 0, `${lines.join("|")}: ${result.stderr}`);
    assert.match(result.stderr, /ignored a malformed policy file/);
  }
  // An environment that is present still applies when the file is ignored.
  const withEnv = runHook(f, "fix: env", { KHEREP_WORKSPACE: fwd(f.workspace), KHEREP_WORK_ITEM_REQUIRED: "1" });
  assert.equal(withEnv.status, 1);
});

test("a real git commit without KHEREP_* is rejected without a key and accepted with one", (t) => {
  const f = fixture(t);
  writePolicy(f, [`workspace=${fwd(f.workspace)}`, "work_item_required=1"]);
  const git = (...args: string[]): SpawnSyncReturns<string> => spawnSync("git", [
    "-c", `core.hooksPath=${fwd(f.hooks)}`, "-c", "user.name=Example", "-c", "user.email=dev@example.com", ...args,
  ], { cwd: f.repo, encoding: "utf8", env: cleanEnv() });
  fs.writeFileSync(path.join(f.repo, "a.txt"), "a\n");
  assert.equal(git("add", "a.txt").status, 0);
  const rejected = git("commit", "-q", "-m", "fix: no key");
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /work-item key/);
  const accepted = git("commit", "-q", "-m", "ABC-1 fix: with key");
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(git("log", "--format=%s").stdout.trim(), "ABC-1 fix: with key");
});

// Per-repository opt-out: `git config --local kherep.workItemRequired false`.
// Precedence: a non-empty KHEREP_WORK_ITEM_REQUIRED, then the repository-local
// config, then the policy file. Only a valid Git boolean false opts out.
function setRepoConfig(f: Fixture, value: string): void {
  assert.equal(spawnSync("git", ["config", "--local", "kherep.workItemRequired", value], { cwd: f.repo }).status, 0);
}

test("a repository-local false value opts the repository out of the key rule", (t) => {
  const f = fixture(t);
  writePolicy(f, [`workspace=${fwd(f.workspace)}`, "work_item_required=1"]);
  assert.equal(runHook(f, "fix: no key before opt-out").status, 1);
  for (const value of ["0", "false", "No", "OFF"]) {
    setRepoConfig(f, value);
    const result = runHook(f, "fix: opted out");
    assert.equal(result.status, 0, `${value}: ${result.stderr}`);
  }
});

test("attribution is allowed without identity or trailer restrictions and preserves the key rule", (t) => {
  const f = fixture(t);
  writePolicy(f, [`workspace=${fwd(f.workspace)}`, "work_item_required=1"]);
  setRepoConfig(f, "false");
  for (const attribution of [
    "Co-authored-by: Example <dev@example.com>",
    "Co-authored-by: Codex <codex@example.com>",
    "Co-authored-by: Other AI <bot@example.com>\nCo-authored-by: Example <dev@example.com>",
    "Generated with [Claude Code]",
  ]) {
    const message = `fix: opted out\n\n${attribution}`;
    assert.equal(runHook(f, message).status, 0);
    assert.equal(runHook(f, message, { KHEREP_WORK_ITEM_REQUIRED: "1" }).status, 1);
    assert.equal(runHook(f, `ABC-12 ${message}`, { KHEREP_WORK_ITEM_REQUIRED: "1" }).status, 0);
  }
});

test("an invalid or true repository value does not opt out", (t) => {
  const f = fixture(t);
  writePolicy(f, [`workspace=${fwd(f.workspace)}`, "work_item_required=1"]);
  for (const value of ["maybe", "true", "1"]) {
    setRepoConfig(f, value);
    const result = runHook(f, "fix: no key");
    assert.equal(result.status, 1, `${value}: ${result.stderr}`);
    assert.match(result.stderr, /work-item key/);
  }
});

test("a non-empty environment value wins over the repository opt-out", (t) => {
  const f = fixture(t);
  writePolicy(f, [`workspace=${fwd(f.workspace)}`, "work_item_required=0"]);
  setRepoConfig(f, "false");
  assert.equal(runHook(f, "fix: env on", { KHEREP_WORK_ITEM_REQUIRED: "1" }).status, 1);
});

test("only the repository-local scope opts out, not a global value", (t) => {
  const f = fixture(t);
  writePolicy(f, [`workspace=${fwd(f.workspace)}`, "work_item_required=1"]);
  const globalConfig = path.join(f.root, "global.gitconfig");
  fs.writeFileSync(globalConfig, "[kherep]\n\tworkItemRequired = false\n");
  const result = runHook(f, "fix: global only", { GIT_CONFIG_GLOBAL: fwd(globalConfig) });
  assert.equal(result.status, 1, result.stderr);
});

test("a real git commit in an opted-out repository is accepted without a key", (t) => {
  const f = fixture(t);
  writePolicy(f, [`workspace=${fwd(f.workspace)}`, "work_item_required=1"]);
  setRepoConfig(f, "false");
  const git = (...args: string[]): SpawnSyncReturns<string> => spawnSync("git", [
    "-c", `core.hooksPath=${fwd(f.hooks)}`, "-c", "user.name=Example", "-c", "user.email=dev@example.com", ...args,
  ], { cwd: f.repo, encoding: "utf8", env: cleanEnv() });
  fs.writeFileSync(path.join(f.repo, "a.txt"), "a\n");
  assert.equal(git("add", "a.txt").status, 0);
  const accepted = git("commit", "-q", "-m", "fix: no key, opted out");
  assert.equal(accepted.status, 0, accepted.stderr);
  const trailer = git("commit", "-q", "--allow-empty", "-m", "fix: trailer\n\nCo-authored-by: Example <bot@example.com>");
  assert.equal(trailer.status, 0, trailer.stderr);
  assert.equal(git("log", "-1", "--format=%an|%ae|%cn|%ce").stdout.trim(),
    "Example|dev@example.com|Example|dev@example.com");
  assert.match(git("log", "-1", "--format=%B").stdout, /Co-authored-by: Example <bot@example.com>/);
});
