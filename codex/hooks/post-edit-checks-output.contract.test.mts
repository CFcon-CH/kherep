import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { copyAdapter } from "./hook-adapter.fixture.mts";
import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";

const HERE = import.meta.dirname;
const SOURCE = path.join(HERE, "post-edit-checks.mts");
const SHARED = path.resolve(HERE, "../../claude/hooks");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "post-edit-checks-"));
const INSTALLED = path.join(TEMP, "installed hooks ; literal");
const REPO = path.join(TEMP, "repo");
const MANIFEST = path.join(REPO, "manifest.yml");
const LARGE = path.join(REPO, "large.ts");
const GERMAN = path.join(REPO, "hinweis.md");
const WATCHERS = ["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge"];
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

function materialize(destination = INSTALLED): string {
  assert.ok(fs.existsSync(SOURCE), "the fixed post-edit dispatcher must exist");
  fs.mkdirSync(path.join(destination, "lib"), { recursive: true });
  for (const dependency of [
    "post-edit-checks.mts", "post-edit-tool-calls.mts", "research-exec-parser.mts",
  ]) {
    fs.copyFileSync(path.join(HERE, dependency), path.join(destination, dependency));
  }
  copyAdapter(destination);
  for (const watcher of WATCHERS) {
    fs.copyFileSync(path.join(SHARED, `${watcher}.mts`), path.join(destination, `${watcher}.mts`));
    if (watcher === "manifest-watch" && destination === INSTALLED) {
      declareCopy(path.join(SHARED, `${watcher}.mts`), path.join(destination, `${watcher}.mts`));
    }
  }
  for (const library of ["workspace-scope.mts", "trusted-executable.mts"]) {
    const original = path.join(SHARED, "lib", library), copy = path.join(destination, "lib", library);
    fs.copyFileSync(original, copy);
    if (library === "trusted-executable.mts" && destination === INSTALLED) declareCopy(original, copy);
  }
  return path.join(destination, "post-edit-checks.mts");
}

function git(args: string[]): void {
  const result = spawnSync("git", args, { cwd: REPO, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

function run(payload: Record<string, unknown>, hook: string) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, KHEREP_WORKSPACE: REPO },
  });
}

fs.mkdirSync(REPO, { recursive: true });
git(["init", "-q"]);
git(["config", "user.name", "Synthetic"]);
git(["config", "user.email", "synthetic@example.invalid"]);
fs.mkdirSync(path.join(REPO, ".git", "no-hooks"), { recursive: true });
git(["config", "core.hooksPath", ".git/no-hooks"]);
fs.writeFileSync(MANIFEST, "permissions:\n  scopes:\n    - read:jira-work\n");
fs.writeFileSync(LARGE, "export const value = 1;\n");
fs.writeFileSync(GERMAN, "Das ist ein Hinweis.\n");
git(["add", "."]);
git(["commit", "-q", "-m", "seed fixture"]);
fs.writeFileSync(MANIFEST, "permissions:\n  scopes:\n    - read:jira-work\n    - write:jira-work\n");
fs.writeFileSync(LARGE, "// line\n".repeat(251));
fs.writeFileSync(GERMAN, "Das ist fuer die naechste Pruefung.\n");

test("aggregates simultaneous real watcher findings into one PostToolUse JSON document", () => {
  const hook = materialize();
  const patch = [
    "*** Begin Patch",
    `*** Update File: ${MANIFEST}`,
    `*** Update File: ${LARGE}`,
    `*** Update File: ${GERMAN}`,
    "+Das ist fuer die naechste Pruefung.",
    "*** End Patch",
  ].join("\n");
  const result = run({
    hook_event_name: "PostToolUse",
    session_id: `post-edit-contract-${process.pid}-${Date.now()}`,
    cwd: REPO,
    tool_name: "apply_patch",
    tool_input: patch,
  }, hook);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
    systemMessage: string;
  };
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
  for (const marker of ["[manifest-watch]", "[loc-watch]", "[umlaut-translit-watch]", "[simplify-watch]"]) {
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes(marker), `literal watcher marker missing: ${marker}`);
  }
  assert.match(parsed.systemMessage, /Umlaut-Transliteration/);
  assert.equal(result.stdout.trim().split("\n").length, 1, "exactly one JSON document");
});

test("keeps a successful no-op silent", () => {
  const result = run({
    hook_event_name: "PostToolUse",
    session_id: "post-edit-noop",
    tool_name: "Write",
    tool_input: { file_path: path.join(REPO, "README.md"), content: "Hello\n" },
  }, materialize());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("the four real watchers reject normalized Bash, even with paths and text that would trigger an edit", () => {
  materialize();
  for (const watcher of WATCHERS) {
    const result = run({ tool_name: "Bash", session_id: "synthetic-bash-noop", tool_input: {
      file_path: watcher === "manifest-watch" ? MANIFEST : watcher === "umlaut-translit-watch" ? GERMAN : LARGE,
      new_string: "Das ist fuer die naechste Pruefung.", command: "synthetic",
    } }, path.join(INSTALLED, `${watcher}.mts`));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "", `${watcher} must remain a Bash no-op for the dispatcher optimization`);
  }
});

test("does not hide a child failure as an all-green result", () => {
  const hooks = path.join(TEMP, "synthetic-hooks");
  const hook = materialize(hooks);
  for (const name of WATCHERS) {
    const body = name === "loc-watch"
      ? "process.stderr.write('synthetic watcher failure\\n'); process.exit(7);"
      : "process.stdin.resume();";
    fs.writeFileSync(path.join(hooks, `${name}.mts`), body);
  }
  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: LARGE, new_string: "changed" },
  }, hook);
  assert.equal(result.status, 7);
  assert.match(result.stderr, /synthetic watcher failure/);
});

test("treats malformed watcher JSON as a visible dispatcher failure", () => {
  const hooks = path.join(TEMP, "malformed-hooks");
  const hook = materialize(hooks);
  for (const name of WATCHERS) {
    const body = name === "manifest-watch"
      ? "process.stdin.resume(); process.stdout.write('{malformed');"
      : "process.stdin.resume();";
    fs.writeFileSync(path.join(hooks, `${name}.mts`), body);
  }
  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: LARGE, new_string: "changed" },
  }, hook);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /malformed structured output/);
});
