// Issue #506. pr-commit-policy.mts runs the versioned commit-msg hook over
// every commit of a pull request range, the way the required `commit-policy`
// CI job does. Each case builds a throwaway repository; git runs with an empty
// core.hooksPath, because a developer host binds the real hook through
// core.hooksPath and would otherwise refuse the fixture's bad commit.
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

const script = path.join(import.meta.dirname, "pr-commit-policy.mts");
// The host's own Kherep variables must not leak into a case.
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KHEREP_")));
const slash = (p: string) => p.replace(/\\/g, "/");

interface Fixture { repo: string; root: string; git: (...args: string[]) => string; commit: (message: string) => string }

function fixture(t: TestContext): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-pr-policy-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hooks = path.join(root, "no-hooks");
  const repo = path.join(root, "repo");
  fs.mkdirSync(hooks);
  fs.mkdirSync(repo);
  const git = (...args: string[]): string => {
    const result = spawnSync("git", ["-c", `core.hooksPath=${slash(hooks)}`, "-c", "user.name=Synthetic",
      "-c", "user.email=synthetic@example.com", ...args], { cwd: repo, encoding: "utf8", env: hostEnv });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  let n = 0;
  const commit = (message: string): string => {
    fs.writeFileSync(path.join(repo, "a.txt"), `${++n}\n`);
    git("add", "a.txt");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  commit("Add the base file");
  return { repo, root, git, commit };
}

function run(f: Fixture, ...args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [script, ...args], { cwd: f.repo, encoding: "utf8", env: hostEnv });
}

test("clean and attributed commits both pass the complete range", (t) => {
  const f = fixture(t);
  const base = f.git("rev-parse", "HEAD");
  const clean = f.commit("Add a clean change");
  const bad = f.commit("Add an attributed change\n\nCo-authored-by: Example <example@example.com>");
  const result = run(f, base, bad);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^ok   ${clean} Add a clean change$`, "m"));
  assert.match(result.stdout, new RegExp(`^ok   ${bad} Add an attributed change$`, "m"));
  assert.match(result.stdout, /commit-policy: 2 commits passed/);
});

test("the strict canary survives repo opt-out and caller pattern without leaking into real commits", (t) => {
  const f = fixture(t);
  f.git("config", "--local", "kherep.workItemRequired", "false");
  const base = f.git("rev-parse", "HEAD");
  const head = f.commit("Key-free attributed change\n\nCo-authored-by: Codex <codex@example.com>");
  const result = spawnSync(process.execPath, [script, base, head], {
    cwd: f.repo, encoding: "utf8", env: { ...hostEnv, KHEREP_WORK_ITEM_REQUIRED: "0", KHEREP_WORK_ITEM_PATTERN: ".*" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^commit-policy: 1 commit passed$/m);
  const required = spawnSync(process.execPath, [script, base, head], {
    cwd: f.repo, encoding: "utf8", env: { ...hostEnv, KHEREP_WORK_ITEM_REQUIRED: "1", KHEREP_WORK_ITEM_PATTERN: "ABC-[0-9]+" },
  });
  assert.equal(required.status, 1, required.stdout + required.stderr);
  assert.match(required.stdout, /work-item key/);
  const valid = f.commit("ABC-12 Attributed change\n\nCo-authored-by: Example <dev@example.com>");
  const configuredPattern = spawnSync(process.execPath, [script, head, valid], {
    cwd: f.repo, encoding: "utf8", env: { ...hostEnv, KHEREP_WORK_ITEM_REQUIRED: "1", KHEREP_WORK_ITEM_PATTERN: "ABC-[0-9]+" },
  });
  assert.equal(configuredPattern.status, 0, configuredPattern.stdout + configuredPattern.stderr);
  assert.match(configuredPattern.stdout, /^commit-policy: 1 commit passed$/m);
});

test("a range of clean commits passes", (t) => {
  const f = fixture(t);
  const base = f.git("rev-parse", "HEAD");
  const first = f.commit("Add the first change");
  const second = f.commit("Add the second change");
  const result = run(f, base, second);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^ok   ${first} `, "m"));
  assert.match(result.stdout, new RegExp(`^ok   ${second} `, "m"));
  assert.match(result.stdout, /^commit-policy: 2 commits passed$/m);
});

test("a single clean commit is counted in the singular", (t) => {
  const f = fixture(t);
  const base = f.git("rev-parse", "HEAD");
  const head = f.commit("Add the only change");
  const result = run(f, base, head);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^commit-policy: 1 commit passed$/m);
});

test("a caller's KHEREP_WORK_ITEM=none does not reach the hook", (t) => {
  const f = fixture(t);
  const base = f.git("rev-parse", "HEAD");
  const head = f.commit("Add a change without a key");
  const result = spawnSync(process.execPath, [script, base, head], {
    cwd: f.repo, encoding: "utf8",
    env: { ...hostEnv, KHEREP_WORK_ITEM_REQUIRED: "1", KHEREP_WORK_ITEM: "none" },
  });

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /requires the subject to start with the configured work-item key/);
});

test("an unknown base object is not readable, never a pass", (t) => {
  const f = fixture(t);
  const head = f.commit("Add a change");
  const result = run(f, "0".repeat(40), head);

  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /commit-policy: could not read range: /);
});

test("a missing argument is not readable", (t) => {
  const f = fixture(t);
  const result = run(f, f.git("rev-parse", "HEAD"));

  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /could not read range/);
});

test("an emptied hook fails the canary instead of passing every commit", (t) => {
  const f = fixture(t);
  const base = f.git("rev-parse", "HEAD");
  const head = f.commit("Add a change\n\nCo-authored-by: Example <example@example.com>");
  const empty = path.join(f.root, "empty-hook");
  fs.writeFileSync(empty, "");
  const result = run(f, "--hook", slash(empty), base, head);

  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /hook did not reject the canary/);
});

test("a hook that does not exist is not readable", (t) => {
  const f = fixture(t);
  const base = f.git("rev-parse", "HEAD");
  const result = run(f, "--hook", slash(path.join(f.root, "missing-hook")), base, base);

  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /could not read range: hook/);
});

test("an empty range passes with nothing to check", (t) => {
  const f = fixture(t);
  const base = f.git("rev-parse", "HEAD");
  const result = run(f, base, base);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /commit-policy: 0 commits in [0-9a-f]{40}\.\.[0-9a-f]{40}, nothing to check/);
});

test("a merge commit in the range is checked and marked", (t) => {
  const f = fixture(t);
  const base = f.git("rev-parse", "HEAD");
  f.git("switch", "-q", "-c", "side");
  const side = f.commit("Add a side change");
  f.git("switch", "-q", "main");
  fs.writeFileSync(path.join(f.repo, "b.txt"), "main\n");
  f.git("add", "b.txt");
  f.git("commit", "-q", "-m", "Add a main change");
  f.git("merge", "-q", "--no-ff", "-m", "Merge branch side", "side");
  const merge = f.git("rev-parse", "HEAD");
  const result = run(f, base, merge);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^ok   ${side} `, "m"));
  assert.match(result.stdout, new RegExp(`^ok   ${merge} \\(merge\\) Merge branch side$`, "m"));
});

test("a shallow clone is not readable", (t) => {
  const f = fixture(t);
  f.commit("Add a second change");
  const head = f.commit("Add a third change");
  const shallow = path.join(f.root, "shallow");
  const clone = spawnSync("git", ["clone", "-q", "--depth", "1", `file://${slash(f.repo)}`, shallow], { encoding: "utf8", env: hostEnv });
  assert.equal(clone.status, 0, clone.stderr);
  const result = spawnSync(process.execPath, [script, head, head], { cwd: shallow, encoding: "utf8", env: hostEnv });

  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /could not read range: shallow/);
});
