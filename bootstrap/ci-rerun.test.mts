// Issue #973. The pure decision of the CI rerun helper against real API responses
// (bootstrap/ci-rerun.fixture.mts): job classes, eligibility, cap, superseded guard.
import assert from "node:assert/strict";
import test from "node:test";

import { NOT_ACQUIRED, classifyJob, decide, judgeJobs, plain, supersededBy } from "./ci-rerun.mts";
import type { DecideInput } from "./ci-rerun.mts";
import { ANNOTATIONS, JOBS, NEWER, NOW, REPO, RUNS, SINGLE_JOBS } from "./ci-rerun.fixture.mts";

const MIN = 60_000;
const all = [...Object.values(JOBS).flat(), ...Object.values(SINGLE_JOBS)];
const job = (id: number): Record<string, unknown> => {
  const found = all.find((j) => (j as { id: number }).id === id);
  assert.ok(found, `fixture job ${id}`);
  return found as Record<string, unknown>;
};
const classify = (id: number, annotations: unknown = ANNOTATIONS[id]) => classifyJob(job(id), annotations);

function input(key: string, overrides: Partial<DecideInput> = {}, run: Record<string, unknown> = {}): DecideInput {
  const [id, attempt] = key.split("-");
  const jobs = JOBS[key] ?? [];
  const annotations: Record<string, unknown> = {};
  for (const j of jobs) { const k = String((j as { id: number }).id); if (ANNOTATIONS[k]) annotations[k] = ANNOTATIONS[k]; }
  return { repository: REPO, run: { ...RUNS[key], ...run }, attempt: Number(attempt), jobs, annotations, newer: NEWER[id], now: NOW[key], ...overrides };
}

test("classifyJob on the eight listed jobs", () => {
  assert.deepEqual(classify(135138612627), { kind: "lost", reason: "smoke (macos-latest)" });
  assert.deepEqual(classify(134966328146), { kind: "blocked", reason: "unit (macos-latest): cancelled for a higher priority request" });
  assert.deepEqual(classify(135103208949), { kind: "blocked", reason: "unit (macos-latest): cancelled" });
  assert.deepEqual(classify(134919628393), { kind: "blocked", reason: "coverage-report: cancelled" });
  assert.deepEqual(classify(132189887668), { kind: "blocked", reason: 'coverage-report: cancelled, not only "not acquired"' });
  assert.deepEqual(classify(132586093599), { kind: "blocked", reason: "unit-windows (control-plane-hook-install): cancelled for a higher priority request" });
  assert.deepEqual(classify(134182246179), { kind: "derived", reason: "coverage-report" });
  assert.deepEqual(classify(135132217156), { kind: "blocked", reason: "unit-engines-floor (24.1.0): failure" });
});

test("a duplicated not-acquired annotation is LOST; a duplicate plus another failure message blocks", () => {
  const listed = ANNOTATIONS[134153805849] as Array<{ annotation_level: string; message: string }>;
  assert.equal(listed.filter((a) => a.annotation_level === "failure" && a.message === NOT_ACQUIRED).length, 2);
  assert.deepEqual(classify(134153805849), { kind: "lost", reason: "unit (macos-latest)" });
  const mixed = [...listed, { annotation_level: "failure", message: "The operation was canceled." }];
  assert.equal(classify(134153805849, mixed).kind, "blocked");
  const notices = listed.filter((a) => a.annotation_level === "notice");
  assert.equal(classify(134153805849, notices).kind, "blocked", "notices alone are not the not-acquired failure");
});

test("not-acquired outside macos-latest is LOST out of scope and blocks; unread annotations throw", () => {
  const windows = { ...job(132586093599) };
  assert.deepEqual(classifyJob(windows, [{ annotation_level: "failure", message: NOT_ACQUIRED }]),
    { kind: "blocked", reason: "unit-windows (control-plane-hook-install): LOST, out of scope (not macos-latest)" });
  assert.equal(classifyJob({ ...job(134153805849), labels: ["macos-latest", "arm64"] }, ANNOTATIONS[134153805849]).kind, "blocked");
  assert.equal(classifyJob({ ...job(134153805849), labels: "macos-latest" }, ANNOTATIONS[134153805849]).kind, "blocked");
  assert.equal(classifyJob({ ...job(134153805849), runner_id: null }, ANNOTATIONS[134153805849]).kind, "blocked");
  assert.throws(() => classifyJob(job(134153805849), undefined), /annotations of unit \(macos-latest\) unread/);
});

test("odd job shapes block", () => {
  assert.deepEqual(classifyJob({ name: "x", status: "in_progress" }, []), { kind: "blocked", reason: "x: not completed" });
  assert.deepEqual(classifyJob({ name: "x", status: "completed", conclusion: "failure" }, []), { kind: "blocked", reason: "x: steps unreadable" });
  assert.deepEqual(classifyJob({ name: "x", status: "completed", steps: [] }, []), { kind: "blocked", reason: "x: no conclusion" });
  const coverage = job(134182246179);
  const steps = (coverage.steps as Array<Record<string, string>>).map((s) => (s.conclusion === "failure" ? { ...s, name: "Assemble" } : s));
  assert.equal(classifyJob({ ...coverage, steps }, []).kind, "blocked");
  const twice = [...(coverage.steps as unknown[]), { name: "Upload", conclusion: "failure" }];
  assert.equal(classifyJob({ ...coverage, steps: twice }, []).kind, "blocked");
});

test("the listed run attempts: one rerun, the mixed cases and the cancelled run do not", () => {
  assert.deepEqual(decide(input("44115918168-1")), { action: "rerun", reason: "lost: contract (macos-latest), unit (macos-latest)" });
  const mixed = decide(input("44397779907-1"));
  assert.equal(mixed.action, "none");
  assert.equal(mixed.reason, "blocked: unit-engines-floor (24.1.0): failure");
  assert.deepEqual(decide(input("44337919183-1")), {
    action: "none",
    reason: "blocked: unit-windows (codex): failure; unit (windows-latest): failure; coverage-report: a contributing job is red for another reason",
  });
  assert.deepEqual(decide(input("43909265750-1")), { action: "none", reason: "conclusion cancelled, not failure" });
});

test("44327898911-1 is superseded once the newer main push exists, and would have been rerun before", () => {
  assert.deepEqual(decide(input("44327898911-1")), { action: "none", reason: "superseded by run 44376576769" });
  const early = Date.parse("2026-11-18T15:55:05Z");
  const newer = NEWER["44327898911"].filter((r) => Date.parse((r as { created_at: string }).created_at) <= early);
  assert.deepEqual(decide(input("44327898911-1", { now: early, newer })), { action: "rerun", reason: "lost: smoke (macos-latest)" });
});

test("eligibility is read from the fresh run", () => {
  const reason = (run: Record<string, unknown>, overrides: Partial<DecideInput> = {}) => decide(input("44115918168-1", overrides, run)).reason;
  assert.equal(reason({ path: ".github/workflows/other.yml" }), "not a run of .github/workflows/ci.yml");
  assert.equal(reason({ event: "workflow_dispatch" }), "event workflow_dispatch is neither push nor pull_request");
  assert.equal(reason({ event: undefined }), "event unknown is neither push nor pull_request");
  assert.equal(reason({ head_repository: { full_name: "someone/fork" } }), "head repository is not this repository");
  assert.equal(reason({ status: "in_progress" }), "not completed");
  assert.equal(reason({ conclusion: null }), "conclusion none, not failure");
  assert.equal(reason({ run_attempt: 2 }), "current attempt 2 is not the evaluated attempt 1");
  assert.equal(reason({}, { now: Date.parse("2026-11-17T21:35:00Z") }), "created more than 6 h ago");
  assert.throws(() => decide(input("44115918168-1", {}, { created_at: "soon" })), /created_at unparsable/);
});

test("cap: attempt 8 warns, attempt 7 reruns after 10 min, a fresh attempt waits", () => {
  const at = (attempt: number, minutesAgo: number) => {
    const now = NOW["44115918168-1"];
    return decide(input("44115918168-1", { attempt, now }, { run_attempt: attempt, updated_at: new Date(now - minutesAgo * MIN).toISOString() }));
  };
  assert.deepEqual(at(8, 30), { action: "cap", reason: "attempt 8 reached the cap of 8 attempts" });
  assert.equal(at(7, 10).action, "rerun");
  assert.deepEqual(at(2, 9), { action: "none", reason: "attempt 2 finished less than 10 min ago; a later sweep decides" });
  assert.throws(() => decide(input("44115918168-1", { attempt: 2 }, { run_attempt: 2, updated_at: "" })), /updated_at unparsable/);
});

test("superseded guard follows the concurrency group of ci.yml", () => {
  const pr = RUNS["44115918168-1"];
  const other = (fields: Record<string, unknown>) => ({ id: pr.id + 1, event: "pull_request", head_branch: pr.head_branch, head_repository: { full_name: REPO }, ...fields });
  assert.equal(supersededBy(pr, [other({})]), pr.id + 1);
  assert.equal(supersededBy(pr, [other({ id: pr.id - 1 })]), null);
  assert.equal(supersededBy(pr, [other({ head_repository: { full_name: "someone/fork" } })]), null);
  assert.equal(supersededBy(pr, [other({ event: "push" })]), null);
  assert.equal(supersededBy(pr, [other({ head_branch: "other" })]), null);
  const push = RUNS["44327898911-1"];
  const later = { id: push.id + 1, head_branch: "main", head_repository: { full_name: REPO } };
  assert.equal(supersededBy(push, [{ ...later, event: "workflow_dispatch" }]), push.id + 1);
  assert.equal(supersededBy(push, [{ ...later, event: "pull_request" }]), null);
});

test("DERIVED needs every red contributing job LOST, and at least one", () => {
  const jobs = JOBS["44115918168-1"].map((j) => ({ ...(j as Record<string, unknown>) }));
  const annotations = { 134153803950: ANNOTATIONS[134153803950], 134153805849: ANNOTATIONS[134153805849] };
  const unit = jobs.find((j) => j.name === "unit (macos-latest)") as Record<string, unknown>;
  unit.conclusion = "skipped";
  assert.match(judgeJobs(jobs, annotations).reason, /coverage-report: a contributing job is red for another reason/);
  unit.conclusion = "success";
  assert.match(judgeJobs(jobs, annotations).reason, /coverage-report: a contributing job is red/);
  const green = jobs.filter((j) => j.name !== "coverage-report" && j.name !== "contract (macos-latest)");
  assert.deepEqual(judgeJobs(green, annotations), { ok: false, reason: "no lost macOS job" });
});

test("plain keeps job names readable and drops markup and control characters", () => {
  assert.equal(plain("unit (macos-latest)"), "unit (macos-latest)");
  assert.equal(plain("::set-output x=@me <b>`#1`\n%0A"), "set-output x=me b10A");
  assert.equal(plain(42), "");
  assert.equal(plain("a".repeat(200)).length, 120);
});
