// The Windows test route (issue #832), end to end: what a finished run concludes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { prepareBase, removeTree } from "./test-route-base.mts";
import { git, gitRepo, hasGit, HEADER, KNOWN, onCommits, readReceipt, route, tempDir } from "./test-route-fixture.mts";

const needsGit = { skip: !hasGit };
const passes = (...names: string[]) => `${HEADER}${names.map((name) => `test(${JSON.stringify(name)}, () => {});`).join("\n")}\n`;
const held = () => { throw Object.assign(new Error("held"), { code: "EPERM" }); };

test("E1 a failure on both commits is known, and nothing is missing", needsGit, (t) => {
  const { run, out, receipt } = onCommits(t, gitRepo(t, {}, { "t/a.test.mts": `${KNOWN}// two\n` }));
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /fixture no-new-failures known=1 fixed=0 gone=0/);
  assert.match(run.stdout, /known failure: known symlink/);
  assert.match(run.stdout, /VERDICT no-new-failures/);
  assert.doesNotMatch(run.stdout, /missing=/);
  assert.deepEqual([receipt.suites.fixture.known, receipt.suites.fixture.new, receipt.suites.fixture.missing], [["known symlink"], [], []]);
  assert.equal(receipt.suites.fixture.proof.ceiling, 1);
  for (const file of ["candidate-fixture.tap", "base-fixture.tap", "candidate-fixture.log"]) assert.ok(fs.existsSync(path.join(out, file)), file);
});

test("E2 a test that fails only on the candidate is new, with exit 1", needsGit, (t) => {
  const red = `${KNOWN}test("fresh red", () => { throw new Error("y"); });\n`;
  const { run, receipt } = onCommits(t, gitRepo(t, {}, { "t/a.test.mts": red }));
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /new failure: fresh red \(t\/a\.test\.mts\)/);
  assert.deepEqual([receipt.suites.fixture.new, receipt.suites.fixture.known, receipt.verdict], [["fresh red"], ["known symlink"], "new-failures"]);
});

test("E3 a deleted test file is missing, with its names on stdout and in the receipt", needsGit, (t) => {
  const { run, receipt } = onCommits(t, gitRepo(t, { "t/b.test.mts": passes("only in b") }, { "t/b.test.mts": null }));
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stdout, /missing: only in b/);
  assert.match(run.stdout, /VERDICT no-verdict .*missing=1/);
  assert.deepEqual(receipt.suites.fixture.missing, ["only in b"]);
});

test("B1 a known failure does not cancel a deleted or skipped base pass of the same name", needsGit, (t) => {
  const twin = passes("known symlink");
  const skipped = `${HEADER}test("known symlink", { skip: true }, () => {});\n`;
  for (const candidate of [null, skipped]) {
    const { run, receipt } = onCommits(t, gitRepo(t, { "t/b.test.mts": twin }, { "t/b.test.mts": candidate }));
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.deepEqual([receipt.suites.fixture.missing, receipt.suites.fixture.known], [["known symlink"], ["known symlink"]]);
  }
});

test("B1b a known failure that moves to another file stays known, with exit 0", needsGit, (t) => {
  const failing = `${HEADER}test("known symlink", () => { throw new Error("x"); });\n`;
  const { run, receipt } = onCommits(t, gitRepo(t, {}, { "t/a.test.mts": passes("passes"), "t/b.test.mts": failing }));
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual([receipt.suites.fixture.known, receipt.suites.fixture.missing], [["known symlink"], []]);
});

test("E3b a test file that exits early leaves the rest missing", needsGit, (t) => {
  const early = `${HEADER}test("one", () => {});\ntest("two", () => process.exit(0));\ntest("three", () => {});\n`;
  const { run, receipt } = onCommits(t, gitRepo(t, { "t/a.test.mts": passes("one", "two", "three") }, { "t/a.test.mts": early }));
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stdout, /missing=\d/);
  // Node 26.10 reports nothing of a file that exits (the whole file is one passing record), so `one` can be missing as well.
  for (const name of ["two", "three"]) assert.ok(receipt.suites.fixture.missing.includes(name), name);
});

test("E3c tests skipped on the candidate are missing", needsGit, (t) => {
  const skipped = `${HEADER}test("one", { skip: true }, () => {});\ntest("two", { skip: true }, () => {});\n`;
  const { run } = onCommits(t, gitRepo(t, { "t/a.test.mts": passes("one", "two") }, { "t/a.test.mts": skipped }));
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stdout, /missing=2/);
});

test("E4 a candidate run killed midway is no verdict, and a stale TAP file does not stand in for it", needsGit, (t) => {
  const stale = "ok 1 - passes\n  ---\n  type: 'test'\n  ...\nok 2 - other\n  ---\n  type: 'test'\n  ...\n1..2\n# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n";
  const out = path.join(tempDir(t), "out");
  fs.mkdirSync(out);
  const tap = path.join(out, "candidate-fixture.tap");
  fs.writeFileSync(tap, stale);
  fs.chmodSync(tap, 0o444); // Node truncates a writable destination itself, so only this shows the route's removal
  const repo = gitRepo(t, {}, { "t/a.test.mts": `process.kill(process.ppid, "SIGKILL");\n` });
  const run = route(["--candidate", repo, "--base", "HEAD~1", "--no-typecheck", "--suites", "fixture", "--out", out]);
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stdout, /candidate fixture did not finish/);
  assert.equal(readReceipt(out).verdict, "no-verdict");
  assert.notEqual(fs.existsSync(tap) ? fs.readFileSync(tap, "utf8") : null, stale);
});

test("E7 --base clones that commit, installs nothing in the candidate, and removes the clone", needsGit, (t) => {
  const repo = gitRepo(t, {}, { "t/a.test.mts": `${KNOWN}// two\n` });
  const { run, out, receipt } = onCommits(t, repo);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const [head, parent] = [git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "HEAD~1")];
  assert.deepEqual([receipt.base.sha, receipt.base.install, receipt.base.cleanup], [parent, "ok", "removed"]);
  assert.deepEqual([receipt.candidate.sha, receipt.candidate.shaAfter, receipt.candidate.changedBefore, receipt.candidate.changedAfter], [head, head, 0, 0]);
  assert.match(run.stdout, new RegExp(`VERDICT no-new-failures candidate=${head.slice(0, 8)} base=${parent.slice(0, 8)} `));
  assert.equal(fs.existsSync(path.dirname(receipt.base.path)), false);
  assert.ok(fs.existsSync(path.join(out, "base-npm-ci.log")));
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1);
});

test("W1 the route leaves the candidate's index bytes alone, also when a tracked file has a new mtime", needsGit, (t) => {
  const repo = gitRepo(t, {}, { "t/a.test.mts": `${KNOWN}// two\n` });
  const touched = new Date(Date.now() - 3_600_000);
  fs.utimesSync(path.join(repo, "t", "a.test.mts"), touched, touched); // a plain git status would refresh the index now
  const index = path.join(repo, ".git", "index");
  const before = fs.readFileSync(index);
  const { run } = onCommits(t, repo);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.ok(fs.readFileSync(index).equals(before), "the route rewrote the candidate's index");
});

test("W2 a base test that pushes to origin creates no ref in the candidate", needsGit, (t) => {
  const push = `${KNOWN}import { spawnSync } from "node:child_process";\nspawnSync("git", ["push", "-q", "origin", "HEAD:refs/heads/x"]);\n`;
  const repo = gitRepo(t, { "t/a.test.mts": push }, { "t/a.test.mts": `${push}// two\n` });
  const { run } = onCommits(t, repo);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(git(repo, "for-each-ref", "refs/heads/x"), "");
});

test("E7b a failed base install is no verdict for every suite, bootstrap included", needsGit, (t) => {
  const repo = gitRepo(t, { "package-lock.json": null });
  const { run, out, receipt } = onCommits(t, repo, ["--suites", "bootstrap"]);
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stdout, /base install failed/);
  assert.deepEqual([receipt.base.install, receipt.base.cleanup, receipt.suites.bootstrap.status], ["failed", "removed", "no-verdict"]);
  assert.equal(fs.existsSync(path.join(out, "base-bootstrap.tap")), false);
  assert.equal(fs.existsSync(receipt.base.path), false);
});

// A real package for npm ci: the link is what `npm ci` creates in the tree it runs in.
const LOCAL_DEP = {
  "package.json": JSON.stringify({ name: "fx", dependencies: { dep: "file:dep" }, scripts: { "test:fixture": 'node --test "t/*.test.mts"' } }),
  "package-lock.json": JSON.stringify({ name: "fx", lockfileVersion: 3, requires: true, packages: { "": { name: "fx", dependencies: { dep: "file:dep" } }, dep: { version: "1.0.0" }, "node_modules/dep": { resolved: "dep", link: true } } }),
  "dep/package.json": JSON.stringify({ name: "dep", version: "1.0.0" }),
};

test("E7c npm ci runs in the base clone, never in the candidate", needsGit, (t) => {
  const repo = gitRepo(t, LOCAL_DEP, { "t/a.test.mts": `${KNOWN}// two\n` });
  const { run, receipt } = onCommits(t, repo);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(receipt.base.install, "ok");
  assert.equal(fs.existsSync(path.join(repo, "node_modules", "dep")), false);
  assert.equal(receipt.candidate.changedAfter, 0);
});

test("E12 a describe block that throws while it is defined is a new failure", needsGit, (t) => {
  const broken = `${KNOWN}import { describe } from "node:test";\ndescribe("broken block", () => { throw new Error("z"); });\n`;
  const { run, receipt } = onCommits(t, gitRepo(t, {}, { "t/a.test.mts": broken }));
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.deepEqual(receipt.suites.fixture.new, ["broken block"]);
});

test("E13 a candidate tree that changes during the run is no verdict", needsGit, (t) => {
  const writer = `${KNOWN}import fs from "node:fs";\nfs.writeFileSync("extra.txt", "x");\n`;
  const { run, receipt } = onCommits(t, gitRepo(t, {}, { "t/a.test.mts": writer }));
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stdout, /candidate changed during the run/);
  assert.match(run.stdout, /VERDICT no-verdict .*identity=changed/);
  assert.equal(receipt.candidate.changedAfter, 1);
});

test("E13b a candidate HEAD that moves during the run is no verdict", needsGit, (t) => {
  const mover = `${KNOWN}import { spawnSync } from "node:child_process";\nspawnSync("git", ["-c", "user.name=fx", "-c", "user.email=fx@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "--allow-empty", "-m", "moved"]);\n`;
  const { run, receipt } = onCommits(t, gitRepo(t, {}, { "t/a.test.mts": mover }));
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stdout, /VERDICT no-verdict .*identity=changed/);
  assert.notEqual(receipt.candidate.sha, receipt.candidate.shaAfter);
});

// A stand-in for tsc, installed in both trees: it prints tsc-errors.txt. The base gets it through
// npm ci, which replaces a node_modules of the commit, the candidate from this fixture.
const FAKE_TSC = `const text = require("node:fs").readFileSync("tsc-errors.txt", "utf8");\nprocess.stdout.write(text);\nprocess.exit(text ? 2 : 0);\n`;
const FAKE_TYPESCRIPT = {
  "package.json": JSON.stringify({ name: "fx", dependencies: { typescript: "file:ts" }, scripts: { "test:fixture": 'node --test "t/*.test.mts"' } }),
  "package-lock.json": JSON.stringify({ name: "fx", lockfileVersion: 3, requires: true, packages: { "": { name: "fx", dependencies: { typescript: "file:ts" } }, ts: { version: "1.0.0" }, "node_modules/typescript": { resolved: "ts", link: true } } }),
  "ts/package.json": JSON.stringify({ name: "typescript", version: "1.0.0" }),
  "ts/bin/tsc": FAKE_TSC,
};
const ERROR_A = "a.mts(1,2): error TS2322: x\n", ERROR_B = "b.mts(3,4): error TS1005: y\n";

function typecheckRun(t: Parameters<typeof gitRepo>[0], baseErrors: string, candidateErrors: string) {
  const repo = gitRepo(t, { ...FAKE_TYPESCRIPT, "tsc-errors.txt": baseErrors }, { "tsc-errors.txt": candidateErrors });
  fs.mkdirSync(path.join(repo, "node_modules", "typescript", "bin"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "typescript", "bin", "tsc"), FAKE_TSC);
  const out = path.join(tempDir(t), "out");
  return { run: route(["--candidate", repo, "--base", "HEAD~1", "--suites", "fixture", "--out", out]), receipt: readReceipt(out) };
}

test("E14 errors on a clean base are new, by error identity", needsGit, (t) => {
  const { run, receipt } = typecheckRun(t, "", ERROR_A + ERROR_B);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.deepEqual(receipt.suites.typecheck.new, ["a.mts TS2322 x", "b.mts TS1005 y", "tsc"]);
});

test("E14b a base with type errors has no pass and is over the ceiling, so more errors are no verdict", needsGit, (t) => {
  const { run, receipt } = typecheckRun(t, ERROR_A, ERROR_A + ERROR_B);
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.deepEqual([receipt.suites.typecheck.new, receipt.suites.typecheck.known], [["b.mts TS1005 y"], ["a.mts TS2322 x", "tsc"]]);
  assert.match(receipt.suites.typecheck.reasons.join("\n"), /no test passed on the base/);
});

test("E16 a suite past --suite-timeout is killed and gives no verdict", needsGit, (t) => {
  const slow = `${KNOWN}test("slow", async () => { await new Promise((done) => setTimeout(done, 8000)); });\n`;
  const { run } = onCommits(t, gitRepo(t, {}, { "t/a.test.mts": slow }), ["--suite-timeout", "0.05"]);
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stdout, /candidate fixture did not finish/);
});

test("E17 a base tree that cannot be removed or read is a leftover, not an exception", (t) => {
  const dir = tempDir(t);
  assert.equal(removeTree(dir, held), "leftover");
  assert.equal(removeTree(dir), "removed");
  assert.equal(fs.existsSync(dir), false);
  assert.equal(removeTree(dir, () => {}, held), "leftover");
});

test("E17b a held base tree does not throw out of remove()", needsGit, (t) => {
  const repo = gitRepo(t);
  const out = tempDir(t), parent = tempDir(t);
  const tree = prepareBase({
    candidate: repo, ref: "HEAD~1", sha: git(repo, "rev-parse", "HEAD~1"), workDir: parent, git: "git",
    env: process.env, out, timeoutMs: 60_000, rm: held,
  });
  tree.remove();
  assert.equal(tree.cleanup, "leftover");
});
