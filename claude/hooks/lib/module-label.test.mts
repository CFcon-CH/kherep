// Issue #833. The token walk, the rule lookup and the verdict of module-label-guard.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { judge, labelIntents, MARKER, ruleFor, type LabelIntent, type Rule } from "./module-label.mts";

const CWD = "/work/repo";
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-module-label-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const only = (command: string): LabelIntent => {
  const intents = labelIntents(command, CWD);
  assert.equal(intents.length, 1, command);
  return intents[0]!;
};

for (const [command, labels] of [
  ["gh issue create -t x", []],
  ["gh issue create --label a,b", ["a", "b"]],
  ['gh issue create --label "a, b,,"', ["a", "b"]],
  ["gh issue create -l a -l b", ["a", "b"]],
  ["gh issue create -lcp:intercom", ["cp:intercom"]],
  ["gh issue create -l=cp:intercom", ["cp:intercom"]],
  ['gh issue create --label="cp:doctor"', ["cp:doctor"]],
  ["gh pr create --fill --label cp:worker", ["cp:worker"]],
  ["gh issue create -t x \\\n  --label cp:worker", ["cp:worker"]],
  ["gh issue create -t x `\n  --label cp:worker", ["cp:worker"]],
  ['gh issue create --body "--label cp:intercom"', []],
  ["gh issue create --title --label", []],
  ["gh issue create --template bug.md", []],
  ["gh issue create --body-file - <<EOF\n--label cp:intercom\nEOF", []],
  ["gh issue create -- --label cp:intercom", []],
] as [string, string[]][]) {
  test(`labels of ${JSON.stringify(command)}`, () => {
    assert.deepEqual(only(command).labels, labels);
  });
}

test("the verb and the directory come from the segment", () => {
  assert.equal(only("gh pr create --fill").verb, "pr");
  assert.equal(only("cd sub && gh issue create").dir, `${CWD}/sub`);
  assert.equal(only("bash -c 'gh issue create -t x'").verb, "issue");
});

test("--web and --help are recognised, and a body or title naming them is data", () => {
  for (const command of ["gh issue create --web", "gh pr create -w", "gh issue create -wl x"]) assert.equal(only(command).web, true, command);
  for (const command of ["gh issue create --web=false", 'gh issue create --body "--web"', "gh issue create -t -w"]) assert.equal(only(command).web, false, command);
  for (const command of ["gh issue create --help", "gh pr create -h"]) assert.equal(only(command).help, true, command);
  assert.equal(only("gh issue create -t -h").help, false);
});

test("--repo in every spelling is read", () => {
  for (const command of ["gh issue create -R other/repo", "gh issue create --repo other/repo", "gh pr create --repo=other/repo", "gh issue create -Rother/repo"]) {
    assert.equal(only(command).repo, "other/repo", command);
  }
  assert.equal(only("gh issue create").repo, undefined);
});

test("only the create verbs of gh are intents; a message or an echo is data", () => {
  for (const command of ['git commit -m "gh pr create"', "echo gh issue create", "gh issue list", "gh pr view 1",
    "gh api repos/o/r/issues", "cat <<EOF\ngh issue create\nEOF", "other issue create"]) {
    assert.deepEqual(labelIntents(command, CWD), [], command);
  }
});

test("the visible marker removes the intent; the PowerShell spelling covers the rest of the line", () => {
  assert.equal(MARKER, "KHEREP_MODULE_LABEL=none");
  assert.deepEqual(labelIntents(`${MARKER} gh issue create -t x`, CWD), []);
  assert.deepEqual(labelIntents("$env:KHEREP_MODULE_LABEL='none'; gh issue create -t x", CWD), []);
  assert.equal(labelIntents(`${MARKER} gh issue list; gh issue create -t x`, CWD).length, 1);
});

// The lead's decision on #833: every spelling that reaches the create form (gh 2.100.0, measured).
for (const [command, verb, labels, repo] of [
  ["gh issue new -t x", "issue", [], undefined],
  ["gh pr new --fill -lcp:worker", "pr", ["cp:worker"], undefined],
  ["gh issue -R other/repo create", "issue", [], "other/repo"],
  ["gh -R other/repo issue create --label a", "issue", ["a"], "other/repo"],
  ["gh --repo=other/repo pr new", "pr", [], "other/repo"],
  ["gh issue --repo other/repo new", "issue", [], "other/repo"],
  ["env gh issue create", "issue", [], undefined],
  ["/usr/bin/env FOO=1 -u BAR gh pr create --label a", "pr", ["a"], undefined],
  ["command gh issue new", "issue", [], undefined],
  ["command -p gh issue create", "issue", [], undefined],
  ["env command /usr/local/bin/gh issue create", "issue", [], undefined],
  ["GH_REPO=other/repo gh issue create", "issue", [], "other/repo"],
  ["env GH_REPO=other/repo gh issue create", "issue", [], "other/repo"],
  ["GH_REPO=loser/repo gh issue create -R other/repo", "issue", [], "other/repo"],
] as [string, "issue" | "pr", string[], string | undefined][]) {
  test(`the create form of ${JSON.stringify(command)}`, () => {
    const intent = only(command);
    assert.deepEqual([intent.verb, intent.labels, intent.repo], [verb, labels, repo]);
  });
}

test("a segment that is not a create stays untouched", () => {
  for (const command of ["gh issue list -R x", "gh pr view 1", 'git commit -m "gh issue new"', "gh issue list --label new",
    "gh issue view new", "gh -R x issue list", "gh issue -R create list", "gh api --method issue create", "echo gh issue new",
    "env gh issue list", "env FOO=1 git status", "env", "env -i", "command gh pr view 1", "command -v gh", "command -V gh",
    "command -v gh issue create", "command git commit -m x", "FOO=1 git status"]) {
    assert.deepEqual(labelIntents(command, CWD), [], command);
  }
});

test("env -C moves the directory, and the visible marker also counts after env", () => {
  assert.equal(only("env -C sub gh issue create").dir, `${CWD}/sub`);
  assert.equal(only("env --chdir=sub gh issue create").dir, `${CWD}/sub`);
  assert.deepEqual(labelIntents(`env ${MARKER} gh issue create`, CWD), []);
  assert.deepEqual(labelIntents(`${MARKER} command gh issue new`, CWD), []);
});

function repository(name: string, rule?: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, ".github"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git"), "gitdir: /elsewhere\n");
  if (rule !== undefined) fs.writeFileSync(path.join(dir, ".github", "module-labels.json"), rule);
  return dir;
}
const VALID = JSON.stringify({ version: 1, repository: "Example/Project", labels: ["area", "other"] });

test("ruleFor reads the file of the first directory holding .git, file or directory", () => {
  const dir = repository("linked", VALID);
  const sub = path.join(dir, "deep", "er");
  fs.mkdirSync(sub, { recursive: true });
  for (const from of [dir, sub, path.join(dir, "not", "there")]) {
    const rule = ruleFor(from);
    assert.equal(rule.kind, "rule", from);
    assert.deepEqual(rule.kind === "rule" && rule.labels, ["area", "other"]);
  }
  const plain = path.join(root, "plain");
  fs.mkdirSync(path.join(plain, ".git"), { recursive: true });
  fs.mkdirSync(path.join(plain, ".github"));
  fs.writeFileSync(path.join(plain, ".github", "module-labels.json"), VALID);
  assert.equal(ruleFor(plain).kind, "rule");
});

test("no file, no rule; an inner repository does not inherit the outer rule; no repository, no rule", () => {
  assert.equal(ruleFor(repository("absent")).kind, "none");
  const outer = repository("outer", VALID);
  const inner = path.join(outer, "inner");
  fs.mkdirSync(path.join(inner, ".git"), { recursive: true });
  assert.equal(ruleFor(inner).kind, "none");
  assert.equal(ruleFor(path.parse(root).root).kind, "none");
});

for (const [name, text, defect] of [
  ["bad-json", "{", /JSON/],
  ["version", JSON.stringify({ version: 2, repository: "a/b", labels: ["x"] }), /version/],
  ["empty", JSON.stringify({ version: 1, repository: "a/b", labels: [] }), /labels/],
  ["non-string", JSON.stringify({ version: 1, repository: "a/b", labels: [1] }), /labels/],
  ["blank", JSON.stringify({ version: 1, repository: "a/b", labels: [" "] }), /labels/],
  ["repository", JSON.stringify({ version: 1, labels: ["x"] }), /repository/],
  ["array", "[]", /object/],
] as [string, string, RegExp][]) {
  test(`an invalid file is a defect: ${name}`, () => {
    const rule = ruleFor(repository(`invalid-${name}`, text));
    assert.equal(rule.kind, "invalid");
    assert.match(rule.kind === "invalid" ? rule.defect : "", defect);
    assert.match(rule.kind === "invalid" ? rule.file : "", /\.github[\\/]module-labels\.json$/);
    assert.equal(ruleFor(path.join(root, `invalid-${name}`), "other/repo").kind, "invalid", "a defect is not hidden by --repo");
  });
}

test("an unreadable file is a defect", () => {
  const dir = repository("is-a-directory");
  fs.mkdirSync(path.join(dir, ".github", "module-labels.json"));
  assert.equal(ruleFor(dir).kind, "invalid");
});

test("--repo applies the rule only to the file's repository, case-insensitively", () => {
  const dir = repository("slug", VALID);
  for (const slug of ["Example/Project", "example/PROJECT", "github.com/example/project"]) assert.equal(ruleFor(dir, slug).kind, "rule", slug);
  assert.equal(ruleFor(dir, "other/repo").kind, "none");
});

const intent = (extra: Partial<LabelIntent> = {}): LabelIntent => ({ dir: CWD, verb: "issue", labels: [], web: false, help: false, ...extra });
const RULE: Rule = { kind: "rule", file: "/r/.github/module-labels.json", repository: "a/b", labels: ["area"] };

test("judge blocks without a listed label and names the file", () => {
  for (const labels of [[], ["bug"], ["AREA"]]) {
    const verdict = judge(intent({ labels }), RULE);
    assert.equal(verdict.action, "block", labels.join());
    assert.match(verdict.action === "block" ? verdict.message : "", /module-labels\.json/);
  }
});

test("judge passes one listed label among others, no rule, --web and --help", () => {
  assert.equal(judge(intent({ labels: ["bug", "area"] }), RULE).action, "pass");
  assert.equal(judge(intent(), { kind: "none" }).action, "pass");
  assert.equal(judge(intent({ web: true }), RULE).action, "pass");
  assert.equal(judge(intent({ help: true }), RULE).action, "pass");
});

test("judge refuses an invalid file, naming the file and the defect", () => {
  const verdict = judge(intent({ labels: ["area"] }), { kind: "invalid", file: "/r/x.json", defect: "version is not 1" });
  assert.equal(verdict.action, "block");
  assert.match(verdict.action === "block" ? verdict.message : "", /\/r\/x\.json.*version is not 1/);
});
