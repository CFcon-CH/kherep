// The rules of the Windows test route (issue #832): when exit 0 is a proof. Every check that proved
// something on the base must prove the same on the candidate; whatever the route cannot show is
// no verdict, with a list a human can act on. Pure; bootstrap/test-route.mts does the I/O.

import { parseTap, reconcile, type ParsedTap } from "../codex/scripts/codex-run-tap.mts";
import { errorMessage } from "./shape.mts";
import { failingNames, passingNames, tscNames, type Failing, type RunResult } from "./test-route-compare.mts";

export type SuiteStatus = "no-new-failures" | "new-failures" | "no-verdict";
export interface Outcome {
  finished: boolean; reason: string | null; tests: number; fail: number; cancelled: number; skipped: number;
  failing: Failing[]; passing: string[];
}
export interface Accounting { known: string[]; fresh: string[]; fixed: string[]; gone: string[]; missing: string[]; duplicates: number }
export interface Proof extends Accounting { status: SuiteStatus; reasons: string[]; note: string | null; ceiling: number }

// 1 % of the base's tests, at least 1. Calibrated on two pairs of numbers only: the route measured
// 12 known of 2862 and 0 of 828, the sandbox runs of issue #832 had 80 of about 2900 and 35 of about
// 830. A sandbox under this share and without a marker would pass.
export const KNOWN_CEILING = (baseTests: number): number => Math.ceil(baseTests / 100);

// Multiset difference, like minus() in codex/scripts/codex-run-tap.mts.
function minus(a: string[], b: string[]): string[] {
  const rest = [...b];
  return a.filter((name) => {
    const at = rest.indexOf(name);
    if (at >= 0) rest.splice(at, 1);
    return at < 0;
  });
}

const sorted = (names: string[]) => names.sort((left, right) => Number(left > right) - Number(left < right));

export function unfinished(reason: string): Outcome {
  return { finished: false, reason, tests: 0, fail: 0, cancelled: 0, skipped: 0, failing: [], passing: [] };
}

// Only a complete TAP file that agrees with itself counts. A non-zero exit is normal here (the
// known failures), but one without a failing record means the runner stopped for another reason.
// Node 26.10 writes an expected failure as `ok N - <name> # EXPECTED FAILURE`, which the TAP reader
// keeps in the name: it never counts as a pass of <name>, so a base pass of <name> stays missing.
export function nodeOutcome(run: RunResult, tap: string | null, root: string): Outcome {
  if (run.error) return unfinished(run.error);
  if (run.signal) return unfinished(`killed by ${run.signal}`);
  if (tap === null) return unfinished(`exit ${run.status} and no TAP file`);
  let parsed: ParsedTap;
  try { parsed = parseTap(tap); } catch (error) { return unfinished(errorMessage(error)); }
  const contradictions = reconcile(parsed);
  if (contradictions.length) return unfinished(`summary contradicts records: ${contradictions.join("; ")}`);
  const failing = failingNames(parsed, root);
  if (run.status !== 0 && !failing.length) return unfinished(`exit ${run.status} without a failing test`);
  const { tests, fail, cancelled, skipped } = parsed.summary;
  return { finished: true, reason: null, tests, fail, cancelled, skipped, failing, passing: passingNames(parsed) };
}

// The type check as tests: each error identity is one, and a tree without errors passes `tsc`.
export function tscOutcome(run: RunResult, log: string): Outcome {
  if (run.error) return unfinished(run.error);
  if (run.signal) return unfinished(`killed by ${run.signal}`);
  const names = tscNames(log);
  const failed = run.status !== 0 || names.length > 0;
  const failing = failed ? ["tsc", ...names].map((name) => ({ name, file: null })) : [];
  return { finished: true, reason: null, tests: names.length + 1, fail: failing.length, cancelled: 0, skipped: 0, failing, passing: failed ? [] : ["tsc"] };
}

// A base failure that no longer fails is fixed only if the candidate passed a test of that name,
// otherwise gone. A base pass the candidate neither passed nor newly failed is missing: a known
// failure of the same name does not account for it.
export function account(base: Outcome, candidate: Outcome): Accounting {
  const names = (outcome: Outcome) => outcome.failing.map((failing) => failing.name);
  const [before, after] = [names(base), names(candidate)];
  const fresh = minus(after, before);
  const absent = minus(before, after);
  const gone = minus(absent, candidate.passing);
  return {
    known: sorted(minus(after, fresh)), fresh: sorted(fresh), fixed: sorted(minus(absent, gone)), gone: sorted(gone),
    missing: sorted(minus(minus(base.passing, candidate.passing), fresh)), duplicates: after.length - new Set(after).size,
  };
}

export function suiteVerdict(suite: string, candidate: Outcome, base: Outcome): Proof {
  const accounting = account(base, candidate);
  const ceiling = KNOWN_CEILING(base.tests);
  const note = candidate.cancelled > 0 && base.cancelled === 0 ? "cancelled on candidate" : null;
  const reasons: string[] = [];
  for (const [tree, outcome] of [["candidate", candidate], ["base", base]] as const) {
    if (!outcome.finished) reasons.push(`${tree} ${suite} did not finish: ${outcome.reason}`);
    else if (outcome.tests === 0) reasons.push(`${tree} ${suite} ran 0 tests`);
  }
  // A run that did not finish says nothing about single tests.
  const compared = candidate.finished && base.finished;
  const missing = compared ? accounting.missing : [];
  if (compared) {
    if (!base.passing.length) reasons.push("no test passed on the base");
    if (missing.length) reasons.push(`${missing.length} base passes missing on the candidate`);
    if (accounting.known.length > ceiling) reasons.push(`known failures ${accounting.known.length} exceed the ceiling ${ceiling} (1% of base tests): environment suspect`);
  }
  const status: SuiteStatus = reasons.length ? "no-verdict" : accounting.fresh.length ? "new-failures" : "no-new-failures";
  return { ...accounting, missing, status, reasons, note, ceiling };
}

export function overallVerdict(statuses: SuiteStatus[], identityOk: boolean): { verdict: SuiteStatus; exitCode: number } {
  if (!identityOk) return { verdict: "no-verdict", exitCode: 2 };
  if (statuses.includes("new-failures")) return { verdict: "new-failures", exitCode: 1 };
  if (!statuses.length || statuses.includes("no-verdict")) return { verdict: "no-verdict", exitCode: 2 };
  return { verdict: "no-new-failures", exitCode: 0 };
}
