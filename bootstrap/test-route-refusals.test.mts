// The Windows test route (issue #832), end to end: what it refuses before a test runs, and the
// environment it gives its children.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { git, gitRepo, hasGit, HEADER, KNOWN, onCommits, readReceipt, route, tempDir } from "./test-route-fixture.mts";

const needsGit = { skip: !hasGit };
const script = (body: string) => JSON.stringify({ name: "fx", scripts: { "test:fixture": body } });

function refused(t: Parameters<typeof gitRepo>[0], repo: string, extra: string[], pattern: RegExp, env: Record<string, string> = {}) {
  const { run, out, receipt } = onCommits(t, repo, extra, env);
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stdout + run.stderr, pattern);
  return { run, out, receipt };
}

test("E5 a base equal to the candidate is refused before any run", needsGit, (t) => {
  const { out } = refused(t, gitRepo(t), ["--base", "HEAD"], /base equals the candidate/);
  assert.equal(fs.readdirSync(out).some((name) => name.endsWith(".tap")), false);
});

test("Q2 a base that is not an ancestor of the candidate is refused", needsGit, (t) => {
  const repo = gitRepo(t);
  git(repo, "branch", "side", "HEAD~1");
  git(repo, "checkout", "-q", "side");
  git(repo, "commit", "-q", "--no-verify", "--allow-empty", "-m", "side");
  git(repo, "checkout", "-q", "main");
  refused(t, repo, ["--base", "side"], /not an ancestor/);
});

test("E6 every Codex marker refuses before anything runs", needsGit, (t) => {
  const repo = gitRepo(t);
  for (const marker of ["CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_THREAD_ID"]) {
    const { run, out } = onCommits(t, repo, [], { [marker]: "1" });
    assert.equal(run.status, 2, marker);
    assert.match(run.stdout, /inside a Codex sandbox/);
    assert.ok(run.stdout.includes(marker), marker);
    assert.equal(fs.existsSync(out), false, marker);
  }
});

test("E8 a work dir inside the candidate is refused, by path and through a junction", needsGit, (t) => {
  const repo = gitRepo(t);
  refused(t, repo, ["--work-dir", path.join(repo, "x")], /work dir inside/);
  assert.equal(fs.existsSync(path.join(repo, "x")), false);
  if (process.platform !== "win32") return;
  const link = path.join(tempDir(t), "link");
  fs.symlinkSync(repo, link, "junction");
  refused(t, repo, ["--work-dir", path.join(link, "x")], /work dir inside/);
  assert.equal(fs.existsSync(path.join(repo, "x")), false);
});

test("E8b a work dir inside a configured home is refused", needsGit, (t) => {
  const repo = gitRepo(t);
  for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "KHEREP_CONFIG_DIR"]) {
    const home = tempDir(t);
    refused(t, repo, ["--work-dir", path.join(home, "x")], /work dir inside/, { [key]: home });
    assert.equal(fs.existsSync(path.join(home, "x")), false, key);
  }
});

test("E8c an output dir inside the candidate is refused", needsGit, (t) => {
  const repo = gitRepo(t);
  refused(t, repo, ["--out", path.join(repo, "o")], /out dir inside/);
  assert.equal(fs.existsSync(path.join(repo, "o")), false);
});

test("E9 usage errors: no node suite, a removed flag, an unknown suite, no base", needsGit, (t) => {
  const repo = gitRepo(t);
  for (const suites of ["typecheck", "", ","]) refused(t, repo, ["--suites", suites], /--suites must name/);
  for (const flag of [["--min-ratio", "0.5"], ["--no-install"], ["--base-tree", "x"]]) refused(t, repo, flag, /Unknown option/);
  refused(t, repo, ["--suites", "nope"], /test:nope/);
  const run = route(["--candidate", repo, "--no-typecheck", "--suites", "fixture"]);
  assert.equal(run.status, 2);
  assert.match(run.stdout, /--base/);
});

test("E10 Git for Windows comes first on the test process's PATH", { skip: !hasGit || process.platform !== "win32" }, (t) => {
  const probe = `import fs from "node:fs";\nimport { test } from "node:test";\nfs.writeFileSync("first.txt", process.env.Path.split(";")[0]);\ntest("passes", () => {});\n`;
  const repo = gitRepo(t, { ".gitignore": "node_modules/\nfirst.txt\n", "t/a.test.mts": probe }, { "t/a.test.mts": `${probe}// two\n` });
  const { run } = onCommits(t, repo);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /bash [^\n]*Git\/bin/);
  assert.match(fs.readFileSync(path.join(repo, "first.txt"), "utf8"), /Git[\\/]bin$/);
});

test("E11 a dirty candidate is refused, whatever status.showUntrackedFiles says", needsGit, (t) => {
  const repo = gitRepo(t);
  fs.writeFileSync(path.join(repo, "t", "extra.test.mts"), `${HEADER}test("only here", () => {});\n`);
  const pattern = /candidate has 1 changed or untracked file/;
  const { out } = refused(t, repo, [], pattern);
  assert.equal(fs.existsSync(path.join(out, "candidate-fixture.tap")), false);
  git(repo, "config", "status.showUntrackedFiles", "no");
  refused(t, repo, [], pattern);
});

test("a candidate that is no git checkout, or has no node_modules, is refused", needsGit, (t) => {
  const plain = tempDir(t);
  fs.mkdirSync(path.join(plain, "node_modules"));
  const run = route(["--candidate", plain, "--base", "HEAD~1", "--no-typecheck", "--suites", "fixture", "--out", path.join(tempDir(t), "out")]);
  assert.equal(run.status, 2);
  assert.match(run.stdout, /not a git checkout/);
  const repo = gitRepo(t);
  fs.rmSync(path.join(repo, "node_modules"), { recursive: true });
  const { out } = refused(t, repo, [], /no node_modules/);
  assert.equal(fs.existsSync(path.join(out, "candidate-fixture.tap")), false);
  assert.equal(fs.existsSync(path.join(repo, "node_modules")), false);
});

test("R1 a suite defined differently on the base is refused with both scripts", needsGit, (t) => {
  const both = script('node --test "t/*.test.mts" "u/*.test.mts"'), narrow = script('node --test "t/*.test.mts"');
  const repo = gitRepo(t, { "package.json": both, "u/b.test.mts": KNOWN }, { "package.json": narrow });
  const { run } = refused(t, repo, [], /suite fixture: definition differs/);
  assert.ok(run.stdout.includes('"t/*.test.mts" "u/*.test.mts"'), run.stdout);
  assert.equal(run.stdout.includes("candidate fixture tests="), false);
});

test("R1 a pattern that selects no file in a tree is refused", needsGit, (t) => {
  const typo = script('node --test "t/*.test.mts" "typo/*.test.mts"');
  refused(t, gitRepo(t, { "package.json": typo }), [], /pattern typo\/\*\.test\.mts selects no file in candidate/);
  const added = script('node --test "t/*.test.mts" "u/*.test.mts"');
  refused(t, gitRepo(t, { "package.json": added }, { "u/b.test.mts": KNOWN }), [], /pattern u\/\*\.test\.mts selects no file in base/);
});

test("E15 an exported GIT_DIR reaches no child", needsGit, (t) => {
  const repo = gitRepo(t, {}, { "t/a.test.mts": `${KNOWN}// two\n` });
  const head = git(repo, "rev-parse", "HEAD"), branch = git(repo, "symbolic-ref", "HEAD");
  const { run } = onCommits(t, repo, [], { GIT_DIR: path.join(repo, ".git") });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual([git(repo, "rev-parse", "HEAD"), git(repo, "symbolic-ref", "HEAD"), git(repo, "status", "--porcelain")], [head, branch, ""]);
});

test("B2 NODE_OPTIONS reaches no child: a name pattern cannot hide a regression", needsGit, (t) => {
  const green = `${HEADER}test("keep", () => {});\ntest("regress", () => {});\n`;
  const red = `${HEADER}test("keep", () => {});\ntest("regress", () => { throw new Error("y"); });\n`;
  const { run, receipt } = onCommits(t, gitRepo(t, { "t/a.test.mts": green }, { "t/a.test.mts": red }), [], { NODE_OPTIONS: "--test-name-pattern=keep" });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.deepEqual(receipt.suites.fixture.new, ["regress"]);
});

// The real compiler through a stand-in, so that the fixture holds no link into this checkout.
const REAL_TSC = path.join(import.meta.dirname, "..", "node_modules", "typescript", "bin", "tsc");
const conf = (include: string[], options: object = {}) => JSON.stringify({
  compilerOptions: { target: "es2022", module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true, types: [], ...options }, include,
});
const WHOLE = conf(["src/**/*.mts"]);

interface TsconfigRun { lib?: string; extra?: string[]; prepare?: (repo: string) => void }

// By default the candidate brings a real type error.
function tsconfigRun(t: Parameters<typeof gitRepo>[0], base: string | null, candidate: string | null, { lib = `export const b: number = "two";\n`, extra = [], prepare }: TsconfigRun = {}) {
  const sources = { "src/ok.mts": "export const a: number = 1;\n", "src/lib.mts": "export const b: number = 2;\n" };
  const repo = gitRepo(t, { ...sources, "tsconfig.json": base }, { "tsconfig.json": candidate, "src/lib.mts": lib });
  fs.mkdirSync(path.join(repo, "node_modules", "typescript", "bin"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "typescript", "bin", "tsc"), `require(${JSON.stringify(REAL_TSC)});\n`);
  prepare?.(repo);
  const out = path.join(tempDir(t), "out");
  return { run: route(["--candidate", repo, "--base", "HEAD~1", "--suites", "fixture", "--out", out, ...extra]), out, receipt: readReceipt(out) };
}

test("B3 a tsconfig.json that differs from the base's is refused when the type check runs", needsGit, (t) => {
  for (const [label, base, candidate] of [
    ["include narrowed", WHOLE, conf(["src/ok.mts"])],
    ["noCheck set", WHOLE, conf(["src/**/*.mts"], { noCheck: true })],
    ["bytes only", WHOLE, `${WHOLE}\n`],
    ["removed", WHOLE, null],
    ["added", null, conf(["src/ok.mts"])],
  ] as const) {
    const { run, out, receipt } = tsconfigRun(t, base, candidate);
    assert.equal(run.status, 2, `${label}: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /VERDICT no-verdict: tsconfig\.json differs between the base and the candidate/, label);
    assert.equal(receipt.state, "refused", label);
    assert.equal(fs.existsSync(path.join(out, "candidate-typecheck.log")), false, label);
  }
});

test("B3b an identical tsconfig.json runs the type check, and without it the file is not compared", needsGit, (t) => {
  const clean = "export const b: number = 3;\n";
  const same = tsconfigRun(t, WHOLE, WHOLE, { lib: clean });
  assert.equal(same.run.status, 0, same.run.stdout + same.run.stderr);
  assert.equal(same.receipt.suites.typecheck.status, "no-new-failures");
  const unchecked = tsconfigRun(t, WHOLE, conf(["src/ok.mts"]), { lib: clean, extra: ["--no-typecheck"] });
  assert.equal(unchecked.run.status, 0, unchecked.run.stdout + unchecked.run.stderr);
});

test("B3c the line endings of a checkout do not count, only the committed bytes", needsGit, (t) => {
  const { run } = tsconfigRun(t, `${WHOLE}\n`, `${WHOLE}\n`, {
    lib: "export const b: number = 3;\n",
    prepare(repo) {
      git(repo, "config", "core.autocrlf", "true");
      fs.rmSync(path.join(repo, "tsconfig.json"));
      git(repo, "checkout", "--", "tsconfig.json");
      assert.equal(fs.readFileSync(path.join(repo, "tsconfig.json"), "utf8"), `${WHOLE}\r\n`);
      assert.equal(git(repo, "status", "--porcelain"), "");
    },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test("E18 a refused run does not leave an earlier receipt standing", needsGit, (t) => {
  const out = path.join(tempDir(t), "out");
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, "receipt.json"), JSON.stringify({ verdict: "no-new-failures", exitCode: 0 }));
  const run = route(["--candidate", gitRepo(t), "--base", "nope", "--no-typecheck", "--suites", "fixture", "--out", out]);
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.deepEqual([readReceipt(out).verdict, readReceipt(out).exitCode], ["no-verdict", 2]);
});
