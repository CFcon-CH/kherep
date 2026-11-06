// The verdict rules of the Windows test route (issue #832): when exit 0 is a proof.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  account, KNOWN_CEILING, nodeOutcome, overallVerdict, suiteVerdict, tscOutcome, type Outcome,
} from "./test-route-proof.mts";

const FIXTURE = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "test-route", "windows-locations.tap"), "utf8");
const SUMMARY = "1..0\n# tests 0\n# suites 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n";
const exit = (status: number | null) => ({ status, signal: null, error: null, killed: false });
const failed = (...names: string[]) => names.map((name) => ({ name, file: null }));
const outcome = (over: Partial<Outcome>): Outcome =>
  ({ finished: true, reason: null, tests: 100, fail: 0, cancelled: 0, skipped: 0, failing: [], passing: ["p"], ...over });
const verdict = (candidate: Partial<Outcome>, base: Partial<Outcome>) => suiteVerdict("s", outcome(candidate), outcome(base));

function tap(line: string, counts: Record<string, number>): string {
  const count = (key: string) => counts[key] ?? 0;
  return `${line}\n  ---\n  type: 'test'\n  ...\n1..1\n# tests 1\n# suites 0\n# pass ${count("pass")}\n# fail ${count("fail")}\n# cancelled 0\n# skipped ${count("skipped")}\n# todo ${count("todo")}\n# duration_ms 1\n`;
}

test("P1 a base pass that is gone from the candidate is missing, and no verdict", () => {
  const seen = verdict({ passing: ["a", "b"] }, { passing: ["a", "b", "c"] });
  assert.deepEqual([seen.missing, seen.status], [["c"], "no-verdict"]);
  assert.match(seen.reasons.join("\n"), /missing/);
});

test("P2 a base pass skipped on the candidate is missing", () => {
  const candidate = nodeOutcome(exit(0), tap("ok 1 - a # SKIP", { skipped: 1 }), "C:\\w");
  assert.deepEqual(suiteVerdict("s", candidate, outcome({ passing: ["a"] })).missing, ["a"]);
});

test("P3 a TODO does not hide a failure on the candidate", () => {
  const candidate = nodeOutcome(exit(0), tap("not ok 1 - a # TODO", { todo: 1 }), "C:\\w");
  const seen = suiteVerdict("s", candidate, outcome({ passing: ["a"] }));
  assert.deepEqual([seen.fresh, seen.status, seen.missing], [["a"], "new-failures", []]);
});

test("P3b a passing TODO is no pass either", () => {
  const candidate = nodeOutcome(exit(0), tap("ok 1 - a # TODO", { todo: 1 }), "C:\\w");
  assert.deepEqual(suiteVerdict("s", candidate, outcome({ passing: ["a"] })).missing, ["a"]);
});

test("P4 known failures above 1% of the base's tests are no verdict", () => {
  const names = Array.from({ length: 50 }, (_, index) => `n${index}`);
  const seen = verdict({ tests: 50, failing: failed(...names) }, { tests: 50, failing: failed(...names) });
  assert.equal(seen.status, "no-verdict");
  assert.match(seen.reasons.join("\n"), /known failures 50 exceed the ceiling 1 \(1% of base tests\): environment suspect/);
});

test("P4b the ceiling allows the measured route, and only that", () => {
  assert.deepEqual([KNOWN_CEILING(2862), KNOWN_CEILING(828), KNOWN_CEILING(1), KNOWN_CEILING(100), KNOWN_CEILING(101)], [29, 9, 1, 1, 2]);
  const known = Array.from({ length: 12 }, (_, index) => `n${index}`);
  const seen = verdict({ tests: 2862, failing: failed(...known) }, { tests: 2862, failing: failed(...known) });
  assert.deepEqual([seen.status, seen.ceiling], ["no-new-failures", 29]);
  const over = Array.from({ length: 30 }, (_, index) => `n${index}`);
  assert.equal(verdict({ tests: 2862, failing: failed(...over) }, { tests: 2862, failing: failed(...over) }).status, "no-verdict");
});

test("P5 a base on which nothing passed proves nothing", () => {
  const seen = verdict({ passing: [], failing: failed("a") }, { passing: [], failing: failed("a") });
  assert.equal(seen.status, "no-verdict");
  assert.match(seen.reasons.join("\n"), /no test passed on the base/);
});

test("P6 missing is a multiset by name", () => {
  assert.deepEqual(account(outcome({ passing: ["dup", "dup"] }), outcome({ passing: ["dup"] })).missing, ["dup"]);
});

test("P6b only a new failure accounts for a base pass, a known failure of that name does not", () => {
  const base = outcome({ passing: ["twin"], failing: failed("twin") });
  assert.deepEqual(account(base, outcome({ passing: [], failing: failed("twin") })).missing, ["twin"]);
  const both = account(base, outcome({ passing: [], failing: failed("twin", "twin") }));
  assert.deepEqual([both.missing, both.fresh, both.known], [[], ["twin"], ["twin"]]);
});

test("P7 tscOutcome names errors by file, code and first message line", () => {
  const log = "a.mts(1,2): error TS2322: x\n  continuation\nb.mts(3,4): error TS1005: y\n";
  const seen = tscOutcome(exit(2), log);
  assert.deepEqual(seen.failing.map((failing) => failing.name), ["tsc", "a.mts TS2322 x", "b.mts TS1005 y"]);
  assert.deepEqual([seen.tests, seen.passing], [3, []]);
  const clean = tscOutcome(exit(0), "");
  assert.deepEqual([clean.tests, clean.failing, clean.passing], [1, [], ["tsc"]]);
  assert.deepEqual(tscOutcome(exit(2), "garbage").failing.map((failing) => failing.name), ["tsc"]);
  const killed = tscOutcome({ status: null, signal: "SIGKILL", error: null, killed: true }, "");
  assert.deepEqual([killed.finished, killed.reason], [false, "killed by SIGKILL"]);
});

test("P7b a moved error keeps its identity", () => {
  const base = tscOutcome(exit(2), "a.mts(1,2): error TS2322: x\n"), candidate = tscOutcome(exit(2), "a.mts(9,9): error TS2322: x\n");
  assert.deepEqual(account(base, candidate).fresh, []);
});

test("P8 overallVerdict: a changed identity is no verdict, whatever the suites say", () => {
  assert.deepEqual(overallVerdict(["no-new-failures"], false), { verdict: "no-verdict", exitCode: 2 });
  assert.deepEqual(overallVerdict(["new-failures"], false), { verdict: "no-verdict", exitCode: 2 });
  assert.deepEqual(overallVerdict(["no-verdict", "new-failures"], true), { verdict: "new-failures", exitCode: 1 });
  assert.deepEqual(overallVerdict(["no-verdict", "no-new-failures"], true), { verdict: "no-verdict", exitCode: 2 });
  assert.deepEqual(overallVerdict(["no-new-failures"], true), { verdict: "no-new-failures", exitCode: 0 });
  assert.deepEqual(overallVerdict([], true), { verdict: "no-verdict", exitCode: 2 });
});

test("P9 a new failing test is not swallowed by the accounting", () => {
  const seen = verdict({ passing: ["a"], failing: failed("b") }, { passing: ["a"] });
  assert.deepEqual([seen.fresh, seen.status, seen.missing], [["b"], "new-failures", []]);
});

test("account keeps fixed and gone apart, a multiset by name", () => {
  const names = (base: string[], candidate: string[], passing: string[]) => {
    const { missing: _missing, ...rest } = account(outcome({ failing: failed(...base), passing: [] }), outcome({ failing: failed(...candidate), passing }));
    return rest;
  };
  assert.deepEqual(names(["a", "b"], ["b", "c", "c"], ["a"]), { known: ["b"], fresh: ["c", "c"], fixed: ["a"], gone: [], duplicates: 1 });
  assert.deepEqual(names(["b"], ["b", "b"], []), { known: ["b"], fresh: ["b"], fixed: [], gone: [], duplicates: 1 });
  assert.deepEqual(names(["deleted", "healed", "skipped"], [], ["healed"]), { known: [], fresh: [], fixed: ["healed"], gone: ["deleted", "skipped"], duplicates: 0 });
  assert.deepEqual(names(["a", "a"], ["a"], ["a"]), { known: ["a"], fresh: [], fixed: ["a"], gone: [], duplicates: 0 });
});

test("suiteVerdict: an unfinished or empty run gives no verdict, and lists nothing as missing", () => {
  assert.deepEqual(verdict({ tests: 0, passing: [] }, { tests: 0, passing: [] }).reasons.slice(0, 2), ["candidate s ran 0 tests", "base s ran 0 tests"]);
  const stopped = verdict({ finished: false, reason: "killed", passing: [] }, {});
  assert.deepEqual([stopped.status, stopped.reasons, stopped.missing], ["no-verdict", ["candidate s did not finish: killed"], []]);
  const cancelled = verdict({ failing: failed("x"), cancelled: 1 }, {});
  assert.deepEqual([cancelled.status, cancelled.fresh, cancelled.note], ["new-failures", ["x"], "cancelled on candidate"]);
  const gone = verdict({}, { failing: failed("deleted") });
  assert.deepEqual([gone.status, gone.fixed, gone.gone], ["no-new-failures", [], ["deleted"]]);
});

test("nodeOutcome: only a complete, consistent TAP counts as finished", () => {
  const reason = (run: Parameters<typeof nodeOutcome>[0], text: string | null) => {
    const seen = nodeOutcome(run, text, "C:\\w");
    assert.equal(seen.finished, false);
    return seen.reason;
  };
  assert.match(reason({ status: null, signal: "SIGKILL", error: "ETIMEDOUT", killed: true }, FIXTURE) ?? "", /ETIMEDOUT/);
  assert.match(reason({ status: null, signal: "SIGTERM", error: null, killed: true }, FIXTURE) ?? "", /SIGTERM/);
  assert.match(reason(exit(1), null) ?? "", /no TAP file/);
  assert.match(reason(exit(1), "TAP version 13\n") ?? "", /malformed TAP/);
  assert.match(reason(exit(0), FIXTURE.replace("# pass 2", "# pass 9")) ?? "", /contradicts/);
  assert.match(reason(exit(3), SUMMARY) ?? "", /exit 3 without a failing test/);
  const seen = nodeOutcome(exit(1), FIXTURE, "C:\\w");
  assert.deepEqual([seen.finished, seen.tests, seen.fail, seen.skipped, seen.failing.length], [true, 8, 5, 1, 6]);
});
