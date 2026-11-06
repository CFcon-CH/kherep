// The Codex run guard (issue #550): checks over fixture TAP files, the CLI exit
// codes, `run` end to end in a temporary repository, and the shape of the real
// expectation. Fixtures are judged against fixtures/codex-run-guard/expected.json,
// never against codex-run-expected.json, so a legitimate list edit cannot turn
// these tests red. Every spawn captures stdio; nothing leaks into this runner.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { loadExpected, selectedFiles, testCodexPatterns } from "./codex-run-guard.mts";

const repo = path.resolve(import.meta.dirname, "../..");
const guard = path.join(import.meta.dirname, "codex-run-guard.mts");
const fixtures = path.join(import.meta.dirname, "fixtures", "codex-run-guard");
const fixtureExpected = path.join(fixtures, "expected.json");
const BEGIN = "codex-run-guard: observed skips (win32) begin";
const END = "codex-run-guard: observed skips (win32) end";
const HINT = 'codex-run-guard: a legitimate change updates codex/scripts/codex-run-expected.json "win32" in the same pull request:';

function cli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [guard, ...args], { encoding: "utf8", env });
}
function check(name: string, platform = "win32") {
  return cli(["check", path.join(fixtures, name), "--platform", platform, "--expected", fixtureExpected]);
}
function verdicts(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter((line) => /^codex-run-guard: C\d /.test(line)).map((line) => line.slice("codex-run-guard: ".length));
}
function observedBlock(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/);
  assert.equal(lines.filter((line) => line === BEGIN).length, 1, stdout);
  assert.equal(lines.filter((line) => line === END).length, 1, stdout);
  return JSON.parse(lines.slice(lines.indexOf(BEGIN) + 1, lines.indexOf(END)).join("\n"));
}
function tempRepo(t: TestContext, script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-run-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { "test:codex": script } }));
  return dir;
}
const skip = (name: string, reason: string | null) => JSON.stringify({ name, reason });

test("the real test:codex script parses strictly and every pattern selects a file here", () => {
  const patterns = testCodexPatterns(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.deepEqual(patterns, ["codex/*.test.mts", "codex/lib/*.test.mts", "codex/hooks/*.test.mts", "codex/scripts/*.test.mts"]);
  for (const pattern of patterns) assert.ok(selectedFiles(repo, pattern).length > 0, `${pattern} selects no file`);
});

test("any other test:codex form is refused instead of half honoured", () => {
  for (const script of ['node --test --test-reporter=tap "codex/*.test.mts"', "node --test codex/*.test.mts",
    'node --test "codex/**/*.test.mts"', 'node --test "../x/*.test.mts"', "node --test"]) {
    assert.throws(() => testCodexPatterns(JSON.stringify({ scripts: { "test:codex": script } })), /^Error: test:codex script form not understood: /, script);
  }
});

test("the baseline passes with one verdict line and no observed block", () => {
  const result = check("baseline.tap");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "codex-run-guard: win32 tests=5 skipped=3 todo=0 ok\n");
});

test("skip drift is red with a +/- diff, the observed block and the regeneration hint", () => {
  const extra = check("extra-skip.tap");
  assert.equal(extra.status, 1);
  assert.deepEqual(verdicts(extra.stdout), [`C3 extra skip ${skip("the Windows form of the intent entry parses and runs the adapter in pwsh", "pwsh is not on PATH")}`]);
  assert.deepEqual(observedBlock(extra.stdout), JSON.parse(cli(["print", path.join(fixtures, "extra-skip.tap")]).stdout));
  const lines = extra.stdout.split(/\r?\n/);
  const hint = lines.indexOf(HINT);
  assert.equal(hint, lines.indexOf(END) + 1, extra.stdout);
  assert.ok(lines[hint + 1].startsWith("codex-run-guard:   from the CI log: gh run view --job <job-id> --log | cut -f3- | sed -E 's/^[^ ]+ //',"), lines[hint + 1]);
  assert.match(lines[hint + 2], /^codex-run-guard: {3}only on a host that matches the win32 CI image \(.*\): node codex\/scripts\/codex-run-guard\.mts run --platform win32 --tap .*, then node codex\/scripts\/codex-run-guard\.mts print /);
  const missing = check("missing-skip.tap");
  assert.deepEqual(verdicts(missing.stdout), [`C3 missing skip ${skip("alpha posix only", null)}`]);
  assert.ok(observedBlock(missing.stdout));
  assert.ok(missing.stdout.includes(HINT), missing.stdout);
  assert.deepEqual(verdicts(check("reason-renamed.tap").stdout), [
    `C3 missing skip ${skip("beta needs pwsh", "pwsh is not on PATH")}`,
    `C3 extra skip ${skip("beta needs pwsh", "pwsh is not installed")}`,
  ]);
});

test("zero selection, count mismatch, todo, fail and suite skip each fail with their own line", (t) => {
  assert.deepEqual(verdicts(check("tests-0.tap").stdout), [
    "C2 tests 0 below floor 5",
    `C3 missing skip ${skip("alpha posix only", null)}`,
    `C3 missing skip ${skip("beta needs pwsh", "pwsh is not on PATH")}`,
    `C3 missing skip ${skip("inner posix only", null)}`,
  ]);
  const count = check("count-mismatch.tap");
  assert.deepEqual(verdicts(count.stdout), ["C4 3 skip records but # skipped 2"]);
  assert.ok(observedBlock(count.stdout));
  const todo = check("todo.tap");
  assert.deepEqual(verdicts(todo.stdout), ["C5 todo 1, TODO records: parked for later"]);
  const failed = check("fail-cancelled.tap");
  assert.deepEqual(verdicts(failed.stdout), ["C6 fail 1", "C6 cancelled 1"]);
  const floor = path.join(tempRepo(t, "node --test"), "floor.json");
  fs.writeFileSync(floor, JSON.stringify({ ...JSON.parse(fs.readFileSync(fixtureExpected, "utf8")), minTests: 99 }));
  const below = cli(["check", path.join(fixtures, "baseline.tap"), "--platform", "win32", "--expected", floor]);
  assert.deepEqual(verdicts(below.stdout), ["C2 tests 5 below floor 99"]);
  for (const result of [below, todo, failed]) {
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes(BEGIN), "no observed block when the skip set is as expected");
    assert.ok(!result.stdout.includes("codex-run-expected.json"), "no regeneration hint without a skip check failure");
  }
  const suite = check("suite-skip.tap");
  assert.equal(suite.status, 1);
  assert.deepEqual(verdicts(suite.stdout), ["C7 suite-level skip hides its tests: posix suite"]);
  assert.ok(observedBlock(suite.stdout));
  for (const result of [count, suite]) assert.ok(!result.stdout.includes("codex-run-expected.json"), "no regeneration hint without a C3 line");
});

test("missing, empty or malformed TAP exits 2 and prints no observed block", (t) => {
  const missing = path.join(fixtures, "no-such-file.tap");
  const absent = cli(["check", missing, "--platform", "win32", "--expected", fixtureExpected]);
  assert.equal(absent.status, 2);
  assert.ok(absent.stderr.includes(missing), absent.stderr);
  const empty = path.join(tempRepo(t, "node --test"), "empty.tap");
  fs.writeFileSync(empty, "");
  const cases: [string[], RegExp][] = [
    [["check", empty], /no summary block/],
    [["check", path.join(fixtures, "summary-missing-key.tap")], /no summary block/],
    [["check", path.join(fixtures, "truncated.tap")], /no summary block/],
    [["check", path.join(fixtures, "type-missing.tap")], /record without type: one passes/],
    [["check", path.join(fixtures, "baseline.tap"), "--platform", "darwin"], /no expectation for platform darwin/],
  ];
  for (const [args, message] of cases) {
    const argv = args.includes("--platform") ? args : [...args, "--platform", "win32"];
    const result = cli([...argv, "--expected", fixtureExpected]);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, message);
    assert.ok(!result.stdout.includes("observed skips"), result.stdout);
  }
  assert.equal(cli(["check"]).status, 2);
});

test("print emits the observed skips in the expected-file entry shape", () => {
  const printed = cli(["print", path.join(fixtures, "baseline.tap")]);
  assert.equal(printed.status, 0, printed.stderr);
  assert.deepEqual(JSON.parse(printed.stdout), loadExpected(fs.readFileSync(fixtureExpected, "utf8")).skips.win32);
});

test("run: a script whose patterns select nothing is red at C1, C2 and C3 (issue acceptance)", (t) => {
  const dir = tempRepo(t, 'node --test "a/*.test.mts" "b/*.test.mts"');
  fs.mkdirSync(path.join(dir, "a"));
  fs.writeFileSync(path.join(dir, "a", "helper.mts"), "export {};\n");
  const result = cli(["run", "--platform", "win32", "--repo", dir, "--tap", path.join(dir, "run.tap"), "--expected", fixtureExpected]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(verdicts(result.stdout), [
    "C1 pattern a/*.test.mts selects no file",
    "C1 pattern b/*.test.mts selects no file",
    "C2 tests 0 below floor 5",
    `C3 missing skip ${skip("alpha posix only", null)}`,
    `C3 missing skip ${skip("beta needs pwsh", "pwsh is not on PATH")}`,
    `C3 missing skip ${skip("inner posix only", null)}`,
  ]);
});

function passingRepo(t: TestContext) {
  const dir = tempRepo(t, 'node --test "a/*.test.mts"');
  fs.mkdirSync(path.join(dir, "a"));
  fs.writeFileSync(path.join(dir, "a", "one.test.mts"), 'import { test } from "node:test";\ntest("one", () => {});\n');
  const expected = path.join(dir, "expected.json");
  fs.writeFileSync(expected, JSON.stringify({ minTests: 1, skips: { win32: [], linux: [] } }));
  const tap = path.join(dir, "run.tap");
  fs.writeFileSync(tap, "STALE\n");
  return { args: ["run", "--platform", "linux", "--repo", dir, "--tap", tap, "--expected", expected], dir, tap };
}

test("run removes a stale TAP file and writes a fresh one", (t) => {
  const { args, tap } = passingRepo(t);
  const result = cli(args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.readFileSync(tap, "utf8").startsWith("TAP version 13"));
  assert.match(result.stdout, /codex-run-guard: linux tests=1 skipped=0 todo=0 ok/);
});

test("run starts its test child without an inherited NODE_TEST_CONTEXT", (t) => {
  const { args, tap } = passingRepo(t);
  const result = cli(args, { ...process.env, NODE_TEST_CONTEXT: "child-v8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.readFileSync(tap, "utf8").startsWith("TAP version 13"));
});

test("run without --tap writes its TAP under a per-process name in the temp directory", (t) => {
  const { args, dir } = passingRepo(t);
  const result = cli(args.filter((arg, index) => arg !== "--tap" && args[index - 1] !== "--tap"), { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.readFileSync(path.join(dir, `kherep-codex-run-${result.pid}.tap`), "utf8").startsWith("TAP version 13"));
});

test("run passes a failing test status through and gives no verdict", (t) => {
  const { args, dir } = passingRepo(t);
  fs.writeFileSync(path.join(dir, "a", "two.test.mts"), 'import { test } from "node:test";\ntest("two", () => { throw new Error("red"); });\n');
  const result = cli(args);
  assert.equal(result.status, 1);
  assert.ok(!result.stdout.includes("codex-run-guard:"), result.stdout);
});

test("run refuses an unknown platform before starting any test", (t) => {
  const { args, tap } = passingRepo(t);
  const result = cli(args.map((arg) => (arg === "linux" ? "darwin" : arg)));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no expectation for platform darwin/);
  assert.equal(fs.readFileSync(tap, "utf8"), "STALE\n");
});

test("the real expectation has exactly the win32 and linux lists in the entry shape", () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, "codex-run-expected.json"), "utf8");
  const raw = JSON.parse(text) as { measured: Record<string, unknown>; skips: Record<string, Record<string, unknown>[]> };
  const expected = loadExpected(text);
  assert.ok(Number.isInteger(expected.minTests) && expected.minTests > 0);
  assert.deepEqual(Object.keys(raw.skips).sort(), ["linux", "win32"]);
  assert.deepEqual(Object.keys(raw.measured).sort(), ["linux", "win32"]);
  for (const entries of Object.values(raw.skips)) {
    for (const entry of entries) assert.deepEqual(Object.keys(entry), ["name", "reason"]);
  }
});

// Synthetic TAP rebuilt from the complete sanitized Linux run metadata for
// PR #690 (run 40852887200), never from a raw CI log.
test("the Linux MCP transport run has no retired PowerShell broker-shell skip", (t) => {
  const observed: [string, string | null][] = [
    ["codex execpolicy loads the Windows launcher rule and allows only msg subcommands", "codex is not on PATH"],
    ["codex execpolicy loads the macOS launcher rule and allows only msg subcommands", "codex is not on PATH"],
    ["execpolicy checks the macOS rule without allowing other verbs or compound commands", "codex is not on PATH"],
    ["execpolicy checks the Windows path on current host rule without allowing other verbs or compound commands", "codex is not on PATH"],
    ["recognizes complete preserved upgrade artifacts while rejecting modified guards", "External preserved upgrade fixture not supplied"],
    ["native selection rejects Windows-unrepresentable bindings without changing old three-field compatibility", null],
    ["native CA path survives the actual Windows command shell", null],
    ["every new native command argument rejects Windows expansion bytes before emission", null],
    ["resolveWorkspace turns an MSYS drive path into the Windows drive", null],
  ];
  const lines = Array.from({ length: 802 }, (_, index) => `ok ${index + 1} - synthetic passing test ${index + 1}\n  ---\n  type: 'test'\n  ...`);
  for (const [index, [name, reason]] of observed.entries())
    lines.push(`ok ${803 + index} - ${name} # SKIP${reason ? ` ${reason}` : ""}\n  ---\n  type: 'test'\n  ...`);
  const tap = path.join(tempRepo(t, "node --test"), "hosted-linux.tap");
  fs.writeFileSync(tap, ["TAP version 13", ...lines, "1..811", "# tests 811", "# suites 0", "# pass 802",
    "# fail 0", "# cancelled 0", "# skipped 9", "# todo 0", "# duration_ms 1", ""].join("\n"));
  const result = cli(["check", tap, "--platform", "linux"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "codex-run-guard: linux tests=811 skipped=9 todo=0 ok\n");
});

test("a summary that contradicts its records is red at C8, with no observed block and no hint (issue #578)", () => {
  const cases: [string, string, string[]][] = [
    ["pass-inflated.tap", "win32", ["C8 2 passing records but # pass 999"]],
    ["tests-deflated.tap", "linux", ["C8 7 test records but # tests 6"]],
    ["suites-miscounted.tap", "win32", ["C8 0 suite records but # suites 1"]],
    ["not-ok-hidden.tap", "win32", ["C8 1 passing records but # pass 2", "C8 1 failing records but # fail 0 + # cancelled 0"]],
    ["plan-miscounted.tap", "win32", ["C8 4 top-level records but 1..5"]],
  ];
  for (const [name, platform, lines] of cases) {
    const result = check(name, platform);
    assert.equal(result.status, 1, name);
    assert.deepEqual(verdicts(result.stdout), lines, name);
    assert.ok(!result.stdout.includes("observed skips") && !result.stdout.includes("codex-run-expected.json"), result.stdout);
  }
  const nested = check("nested-suite.tap", "linux");
  assert.equal(nested.status, 0, nested.stdout + nested.stderr);
  assert.equal(nested.stdout, "codex-run-guard: linux tests=7 skipped=0 todo=0 ok\n");
});
