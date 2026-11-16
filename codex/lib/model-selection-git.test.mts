import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { GIT_REFUSAL, gitRunner, modelSelectionGit, ModelSelectionRefusal, workingTreeReader } from "./model-selection-git.mts";

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function repo(t: TestContext): { root: string; head: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-selection-git-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  write(path.join(root, "codex/parity/model-policy.toml"), "policy\n");
  write(path.join(root, "codex/agents/codex-obs.md"), "observer\n");
  write(path.join(root, "codex/agents/nested/skip.md"), "nested\n");
  write(path.join(root, "claude/agents/kherep-builder.md"), "builder\n");
  write(path.join(root, "docs/notes.md"), "notes\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  return { root, head: git(root, "rev-parse", "HEAD") };
}
const refusal = (code: string) => (error: unknown) => error instanceof ModelSelectionRefusal && error.code === code;

test("HEAD resolves only at the repository's own top level, and is cached", (t) => {
  const { root, head } = repo(t);
  const adapter = modelSelectionGit(root);
  assert.equal(adapter.head(), head);
  assert.equal(adapter.head(), head);
  assert.throws(() => modelSelectionGit(path.join(root, "codex")).head(), refusal(GIT_REFUSAL.headUnresolved));
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-selection-plain-"));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  assert.throws(() => modelSelectionGit(plain).head(), refusal(GIT_REFUSAL.headUnresolved));
  git(plain, "init", "-q");
  assert.throws(() => modelSelectionGit(plain).head(), refusal(GIT_REFUSAL.headUnresolved), "a repository without a commit has no HEAD");
  assert.throws(() => modelSelectionGit(path.join(plain, "missing")).head(), refusal(GIT_REFUSAL.headUnresolved));
});

test("an inherited GIT_DIR does not redirect which repository is read", (t) => {
  const { root, head } = repo(t);
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(os.tmpdir(), "kherep-no-such-git-dir");
  t.after(() => { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; });
  assert.equal(modelSelectionGit(root).head(), head);
});

test("B1 cleanliness covers codex/parity, claude/agents and codex/agents only", (t) => {
  const { root } = repo(t);
  const adapter = () => modelSelectionGit(root);
  adapter().assertClean();
  write(path.join(root, "docs/notes.md"), "unrelated edit\n");
  write(path.join(root, "docs/new.md"), "untracked elsewhere\n");
  adapter().assertClean();
  for (const [file, text] of [["codex/parity/model-policy.toml", "edited\n"], ["codex/parity/new/extra.json", "{}\n"],
    ["claude/agents/new-agent.md", "untracked\n"], ["codex/agents/codex-obs.md", "edited\n"]] as const) {
    const before = fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), "utf8") : undefined;
    write(path.join(root, file), text);
    assert.throws(() => adapter().assertClean(), refusal(GIT_REFUSAL.sourceDirty), file);
    if (before === undefined) fs.rmSync(path.join(root, file)); else write(path.join(root, file), before);
  }
  adapter().assertClean();
});

test("a pinned revision reads exact blobs and lists only direct files", (t) => {
  const { root, head } = repo(t);
  const reader = modelSelectionGit(root).at(head);
  write(path.join(root, "codex/parity/model-policy.toml"), "working tree edit\n");
  assert.equal(reader.read("codex/parity/model-policy.toml"), "policy\n");
  assert.deepEqual(reader.list("codex/agents"), ["codex-obs.md"]);
  assert.deepEqual(reader.list("codex/missing"), []);
  assert.throws(() => reader.read("codex/agents"), refusal(GIT_REFUSAL.sourceAbsent), "a tree is not a source file");
  assert.throws(() => reader.read("codex/agents/absent.md"), refusal(GIT_REFUSAL.sourceAbsent));
  for (const bad of ["../escape.md", "codex//x.md", "./codex/x.md", ""]) assert.throws(() => reader.read(bad), refusal(GIT_REFUSAL.sourceAbsent), bad);
  assert.throws(() => reader.list("../outside"), refusal(GIT_REFUSAL.sourceAbsent));
  for (const revision of ["0".repeat(40), "HEAD", head.slice(0, 12)]) {
    assert.throws(() => modelSelectionGit(root).at(revision), refusal(GIT_REFUSAL.revisionAbsent), revision);
  }
});

test("the working-tree reader shares the same path rules", (t) => {
  const { root } = repo(t);
  const reader = modelSelectionGit(root).workingTree();
  assert.equal(reader.read("codex/agents/codex-obs.md"), "observer\n");
  assert.deepEqual(reader.list("codex/agents"), ["codex-obs.md"]);
  assert.deepEqual(reader.list("codex/missing"), []);
  assert.throws(() => reader.read("codex/agents/absent.md"), refusal(GIT_REFUSAL.sourceAbsent));
  assert.throws(() => workingTreeReader(root).read("../escape"), refusal(GIT_REFUSAL.sourceAbsent));
});

test("a failing Git process is a refusal, never an empty clean answer", (t) => {
  const { root, head } = repo(t);
  const real = gitRunner(root);
  const failing = (fail: (args: readonly string[]) => boolean) => modelSelectionGit(root, (args) => fail(args) ? { status: null, stdout: Buffer.alloc(0) } : real(args));
  assert.throws(() => failing((args) => args[0] === "status").assertClean(), refusal(GIT_REFUSAL.headUnresolved));
  assert.throws(() => failing((args) => args[0] === "ls-tree").at(head).list("codex/agents"), refusal(GIT_REFUSAL.sourceAbsent));
  assert.throws(() => failing(() => true).head(), refusal(GIT_REFUSAL.headUnresolved));
  const vanished = modelSelectionGit(root, (args) => args[1] === "--show-toplevel" ? { status: 0, stdout: Buffer.from("/no/such/kherep-top\n") } : real(args));
  assert.throws(() => vanished.head(), refusal(GIT_REFUSAL.headUnresolved), "an unresolvable top level is no HEAD");
  const saved = process.env.PATH;
  process.env.PATH = path.join(root, "no-git-here");
  let missing: ReturnType<typeof gitRunner>;
  try { missing = gitRunner(root); } finally { process.env.PATH = saved; }
  assert.deepEqual(missing(["rev-parse", "HEAD"]).status, null, "a Git binary that cannot start is a failed read");
  assert.throws(() => modelSelectionGit(root, missing).head(), refusal(GIT_REFUSAL.headUnresolved));
  assert.equal(new ModelSelectionRefusal("code").message, "code");
  assert.equal(new ModelSelectionRefusal("code", "detail").message, "code (detail)");
});
