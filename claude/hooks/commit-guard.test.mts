#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { commitsViaGit } from "./lib/git-commit-match.mts";
const hook = path.join(import.meta.dirname, "commit-guard.mts");
function run(command: string, env: Record<string, string> = {}, cwd = "/work/repo", timeout?: number, tool = "Bash"): number | null {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_name: tool, cwd, tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, KHEREP_WORKSPACE: "/work", KHEREP_WORK_ITEM_REQUIRED: "", ...env },
    timeout,
  }).status;
}
assert.equal(run('git commit -m "plain subject"'), 0);
assert.equal(run('git commit -m "plain subject"', { KHEREP_WORK_ITEM_REQUIRED: "1" }), 2);
assert.equal(run('git commit -m "plain subject"', { KHEREP_WORK_ITEM_REQUIRED: "1", KHEREP_WORKSPACE: "/work///" }, "/work/repo///"), 2);
assert.equal(run('git commit -m "plain subject"', { KHEREP_WORK_ITEM_REQUIRED: "1", KHEREP_WORKSPACE: "/work///" }, "/work-copy///"), 0);
assert.equal(run('git commit -m "ABC-12 valid subject"', { KHEREP_WORK_ITEM_REQUIRED: "1" }), 0);
assert.equal(run('KHEREP_WORK_ITEM=none git commit -m "exception"', { KHEREP_WORK_ITEM_REQUIRED: "1" }), 0);
assert.equal(run('git commit -m "plain subject"', { KHEREP_WORK_ITEM_REQUIRED: "1" }, "/elsewhere/repo"), 0);
assert.equal(run('git commit -m "TASK_12 valid subject"', { KHEREP_WORK_ITEM_REQUIRED: "1", KHEREP_WORK_ITEM_PATTERN: "TASK_\\d+" }), 0);
assert.equal(run('git commit -m "subject"', { KHEREP_WORK_ITEM_REQUIRED: "1", KHEREP_WORK_ITEM_PATTERN: "[" }), 2);
assert.equal(run('git commit -m "x Co-Authored-By: bot"'), 0);
assert.equal(run('git commit -m "plain subject\n\nCo-authored-by: Codex <codex@openai.com>"', { KHEREP_WORK_ITEM_REQUIRED: "1" }), 2);
assert.equal(run('git commit -m "ABC-12 valid subject\n\nCo-authored-by: Example <dev@example.com>"', { KHEREP_WORK_ITEM_REQUIRED: "1" }), 0);
assert.equal(run('git commit -m "em — dash\n\nCo-authored-by: Example <dev@example.com>"'), 2);
assert.equal(run('git commit -m "em — dash"'), 2);
assert.equal(run('git commit -m "plain subject\n\nCo-authored-by: Codex <codex@openai.com>"', {}, "/work/repo", undefined, "PowerShell"), 0);
assert.equal(run('git commit -m "plain subject\n\nCo-authored-by: Example <dev@example.com>"', { KHEREP_WORK_ITEM_REQUIRED: "1" }, "/work/repo", undefined, "PowerShell"), 2);
assert.equal(run('git commit -m "em — dash\n\nCo-authored-by: Example <dev@example.com>"', {}, "/work/repo", undefined, "PowerShell"), 2);
// Per-repository opt-out (kherep.workItemRequired=false). The guard's only key
// source is KHEREP_WORK_ITEM_REQUIRED in its environment, and a non-empty value
// wins over the repository value in the commit-msg hook too, so the guard's
// verdict matches the hook in an opted-out repository without reading it.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-guard-optout-")));
const repo = path.join(root, "repo");
fs.mkdirSync(repo);
assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
assert.equal(spawnSync("git", ["config", "--local", "kherep.workItemRequired", "false"], { cwd: repo }).status, 0);
const ws = { KHEREP_WORKSPACE: root };
assert.equal(run('git commit -m "plain subject"', { ...ws, KHEREP_WORK_ITEM_REQUIRED: "" }, repo), 0);
assert.equal(run('git commit -m "plain subject"', { ...ws, KHEREP_WORK_ITEM_REQUIRED: "1" }, repo), 2);
assert.equal(run('git commit -m "x Co-Authored-By: bot"', { ...ws, KHEREP_WORK_ITEM_REQUIRED: "" }, repo), 0);
fs.rmSync(root, { recursive: true, force: true });

// Issue #271: the hook used this regex to find `git ... commit`; it backtracks
// exponentially. It stays here only as the reference the linear matcher must
// equal, on inputs short enough for it to finish.
const OLD = /\bgit\b(?:\s+(?:-[cC]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+commit\b/;

// Adversarial inputs from the issue, through the hook. With the old regex the
// first needs hours, so the spawn timeout turns a regression into a failure
// instead of a hang. The second must still be denied.
const adversarialNoCommit = `git ${"-C -- ".repeat(40)}`;
const adversarialDeny = `${"--x ".repeat(40)}status; git commit -m "x"`;
assert.equal(run(adversarialNoCommit, {}, "/work/repo", 10_000), 0);
assert.equal(run(adversarialDeny, { KHEREP_WORK_ITEM_REQUIRED: "1" }, "/work/repo", 10_000), 2);
for (const input of [adversarialNoCommit, adversarialDeny, `git ${"-C -- ".repeat(2000)}`]) {
  const start = performance.now();
  commitsViaGit(input);
  assert.ok(performance.now() - start < 1000, `matcher took too long on ${input.length} characters`);
}
assert.equal(commitsViaGit(adversarialNoCommit), false);
assert.equal(commitsViaGit(adversarialDeny), true);

// Named edge cases, each checked against the old regex as well.
const edges: Array<[string, boolean]> = [
  ["git -C commit", true],
  ["git -C dir commit", true],
  ["git -c user.name=x commit", true],
  ["git commit-x", true],
  ["git commit;", true],
  ["git commit&&ls", true],
  ["git commits", false],
  ["git commit_x", false],
  ["git -C", false],
  ["git - commit", false],
  ["git --x= commit", false],
  ["git --x=1 commit", true],
  ["git -- commit", true],
  ["git\ncommit", true],
  ["git\tcommit", true],
  ["git commit", true],
  ["/usr/bin/git commit", true],
  ["git-foo commit", false],
  ["xgit commit", false],
  ["gitcommit", false],
  ["git status; git commit", true],
  ["git status commit", false],
  ["echo git", false],
];
for (const [input, expected] of edges) {
  assert.equal(commitsViaGit(input), expected, JSON.stringify(input));
  assert.equal(OLD.test(input), expected, `old regex disagrees on ${JSON.stringify(input)}`);
}

// Differential test: a seeded generator (mulberry32) builds short token
// sequences; the matcher must agree with the old regex on every one.
let seed = 271;
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
const ALPHABET = ["git", "/usr/bin/git", ".git", "xgit", "git-foo", "commit", "commits", "commit-x", "commit;",
  "commit_", "-C", "-c", "--", "-", "--x", "--x=1", "--x=", "-x", "-x=a=b", "status", "x", ";", "&&", "x;git"];
const SEPARATORS = [" ", " ", " ", "  ", "\n", "\t", "\r\n", " ", ""];
const DIFFERENTIAL_CASES = 20_000;
const differences: string[] = [];
let matches = 0;
for (let index = 0; index < DIFFERENTIAL_CASES; index++) {
  const length = 1 + Math.floor(random() * 8);
  let input = random() < 0.2 ? pick(SEPARATORS) : "";
  for (let token = 0; token < length; token++) input += (token ? pick(SEPARATORS) : "") + pick(ALPHABET);
  if (random() < 0.2) input += pick(SEPARATORS);
  const expected = OLD.test(input);
  if (expected) matches++;
  if (commitsViaGit(input) !== expected) differences.push(JSON.stringify(input));
}
assert.deepEqual(differences, [], `matcher and old regex differ on ${differences.length} inputs`);
assert.ok(matches > 1000 && matches < DIFFERENTIAL_CASES - 1000, `differential set is lopsided: ${matches} matches`);
console.log(`commit-guard: pass, ${edges.length} edge cases, `
  + `${DIFFERENTIAL_CASES} differential cases (${matches} matches), 0 differences`);
