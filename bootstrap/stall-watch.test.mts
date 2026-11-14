// Issue #744. The pure decision of the scheduled stall watch: which open pull
// requests have required checks that stayed red past the threshold, and what
// one comment per head SHA (plus the author assignment) says. No network.
import assert from "node:assert/strict";
import test from "node:test";

import { decide, marker, type Action } from "./stall-watch.mts";
import { BOT, CONFIG, NOW, comment, input, pull, rules, run, sha } from "./stall-watch.fixture.mts";

const A = sha("a");
const comments = (actions: Action[]) => actions.filter((a) => a.kind === "comment");
const assigns = (actions: Action[]) => actions.filter((a) => a.kind === "assign");

test("a required check red for the threshold gets one comment and the user author assigned", () => {
  const result = decide(input([pull()], { [A]: [run("typescript", "failure", 20), run("unit (ubuntu-latest)", "success", 25)] }, { 7: [] }), NOW, CONFIG);
  assert.deepEqual(result.errors, []);
  assert.equal(comments(result.actions).length, 1);
  const [body] = comments(result.actions).map((a) => a.kind === "comment" ? a.body : "");
  assert.ok(body.startsWith(marker(A)));
  assert.match(body, /required checks red for 20 min/);
  assert.match(body, /- typescript: failure - https:\/\/github\.com\//);
  assert.doesNotMatch(body, /unit \(ubuntu-latest\)/);
  assert.deepEqual(assigns(result.actions), [{ kind: "assign", pull: 7, login: "example-author" }]);
  assert.deepEqual(result.counts, { scanned: 1, stalled: 1, alreadyReported: 0, skippedDrafts: 0 });
});

test("threshold edge: 19 minutes red is not stalled, 20 is", () => {
  const at = (m: number) => decide(input([pull()], { [A]: [run("typescript", "failure", m)] }, { 7: [] }), NOW, CONFIG);
  assert.equal(at(19).actions.length, 0);
  assert.equal(at(19).counts.stalled, 0);
  assert.equal(at(20).counts.stalled, 1);
});

test("a new head SHA resets the clock: only its own check runs count", () => {
  const B = sha("b");
  const runs = { [A]: [run("typescript", "failure", 90)], [B]: [run("typescript", "failure", 5)] };
  assert.equal(decide(input([pull({ head: { sha: B, repo: { full_name: "example-org/example-repo" } } })], runs, { 7: [] }), NOW, CONFIG).actions.length, 0);
});

test("each red conclusion counts; success, skipped, neutral, in_progress and queued do not", () => {
  for (const conclusion of ["failure", "timed_out", "cancelled", "action_required", "startup_failure"]) {
    const result = decide(input([pull()], { [A]: [run("typescript", conclusion, 30)] }, { 7: [] }), NOW, CONFIG);
    assert.equal(result.counts.stalled, 1, conclusion);
  }
  for (const conclusion of ["success", "skipped", "neutral", null]) {
    const result = decide(input([pull()], { [A]: [run("typescript", conclusion, conclusion === null ? null : 30)] }, { 7: [] }), NOW, CONFIG);
    assert.equal(result.counts.stalled, 0, String(conclusion));
  }
  const queued = run("typescript", null, null, { status: "queued" });
  assert.equal(decide(input([pull()], { [A]: [queued] }, { 7: [] }), NOW, CONFIG).counts.stalled, 0);
});

test("a re-run that is in progress replaces the older red run of the same check", () => {
  const red = run("typescript", "failure", 60);
  const rerun = run("typescript", null, null);
  assert.equal(decide(input([pull()], { [A]: [red, rerun] }, { 7: [] }), NOW, CONFIG).counts.stalled, 0);
});

test("red since is the earliest completed_at among the red required checks", () => {
  const result = decide(input([pull()], { [A]: [run("typescript", "failure", 25), run("unit (ubuntu-latest)", "timed_out", 47)] }, { 7: [] }), NOW, CONFIG);
  const body = comments(result.actions).map((a) => a.kind === "comment" ? a.body : "")[0];
  assert.match(body, /red for 47 min/);
  assert.match(body, /red since 2026-11-14 11:13 UTC/);
});

test("a non-required red check and a required name from another app are ignored", () => {
  const other = run("typescript", "failure", 60, { app: { id: 999 } });
  const extra = run("lint-extra", "failure", 60);
  const result = decide(input([pull()], { [A]: [other, extra] }, { 7: [] }), NOW, CONFIG);
  assert.equal(result.counts.stalled, 0);
  assert.deepEqual(result.errors, []);
});

test("a required check without integration_id matches any app", () => {
  const anyApp = { ...input([pull()], { [A]: [run("typescript", "failure", 60, { app: { id: 999 } })] }, { 7: [] }), rules: rules([{ context: "typescript" }]) };
  assert.equal(decide(anyApp, NOW, CONFIG).counts.stalled, 1);
});

test("the marker counts only for the current head and only from github-actions[bot]", () => {
  const runs = { [A]: [run("typescript", "failure", 30)] };
  const assigned = pull({ assignees: [{ login: "example-author" }] });
  const reported = decide(input([assigned], runs, { 7: [comment(BOT, `${marker(A)}\nold report`)] }), NOW, CONFIG);
  assert.equal(reported.actions.length, 0);
  assert.equal(reported.counts.alreadyReported, 1);
  const olderSha = decide(input([pull()], runs, { 7: [comment(BOT, marker(sha("c")))] }), NOW, CONFIG);
  assert.equal(comments(olderSha.actions).length, 1);
  const fromUser = decide(input([pull()], runs, { 7: [comment("example-author", marker(A))] }), NOW, CONFIG);
  assert.equal(comments(fromUser.actions).length, 1);
});

test("drafts are reported by default and skipped only when includeDrafts is false", () => {
  const runs = { [A]: [run("typescript", "failure", 30)] };
  assert.equal(decide(input([pull({ draft: true })], runs, { 7: [] }), NOW, CONFIG).counts.stalled, 1);
  const skipped = decide(input([pull({ draft: true })], runs, { 7: [] }), NOW, { ...CONFIG, includeDrafts: false });
  assert.deepEqual(skipped.counts, { scanned: 0, stalled: 0, alreadyReported: 0, skippedDrafts: 1 });
});

test("bot authors, fork pull requests and already assigned authors get no assignment", () => {
  const runs = { [A]: [run("typescript", "failure", 30)] };
  const cases = [
    pull({ user: { login: "dependabot[bot]", type: "Bot" } }),
    pull({ head: { sha: A, repo: { full_name: "someone-else/example-repo" } } }),
    pull({ assignees: [{ login: "example-author" }] }),
  ];
  for (const p of cases) {
    const result = decide(input([p], runs, { 7: [] }), NOW, CONFIG);
    assert.equal(comments(result.actions).length, 1);
    assert.equal(assigns(result.actions).length, 0);
  }
});

test("the comment carries no @, no #<digits>, no PR title or branch", () => {
  const unsafeUrl = run("typescript", "failure", 30, { html_url: "https://evil.example/@x#1" });
  const result = decide(input([pull()], { [A]: [unsafeUrl] }, { 7: [] }), NOW, CONFIG);
  const body = comments(result.actions).map((a) => a.kind === "comment" ? a.body : "")[0];
  assert.doesNotMatch(body, /@/);
  assert.doesNotMatch(body, /#\d/);
  assert.doesNotMatch(body, /someone|Fix |feat\//);
  assert.doesNotMatch(body, /evil/);
});

test("more than maxPulls open pull requests is an error, never a clean result", () => {
  const pulls = Array.from({ length: 51 }, (_, i) => pull({ number: i + 1 }));
  const result = decide(input(pulls, { [A]: [] }, {}), NOW, CONFIG);
  assert.ok(result.errors.some((e) => /more than 50/.test(e)));
  assert.equal(result.counts.scanned, 50);
});

test("a missing required_status_checks rule, an unparsable date or unread data are errors", () => {
  const noRule = decide({ ...input([pull()], { [A]: [] }), rules: [{ type: "deletion" }] }, NOW, CONFIG);
  assert.ok(noRule.errors.some((e) => /required_status_checks/.test(e)));
  const badDate = decide(input([pull()], { [A]: [run("typescript", "failure", 30, { completed_at: "yesterday" })] }, { 7: [] }), NOW, CONFIG);
  assert.ok(badDate.errors.some((e) => /completed_at/.test(e)));
  assert.equal(badDate.actions.length, 0);
  const unreadRuns = decide(input([pull()], {}, { 7: [] }), NOW, CONFIG);
  assert.ok(unreadRuns.errors.some((e) => /check runs/.test(e)));
  const unreadComments = decide(input([pull()], { [A]: [run("typescript", "failure", 30)] }, {}), NOW, CONFIG);
  assert.ok(unreadComments.errors.some((e) => /comments/.test(e)));
  assert.equal(unreadComments.actions.length, 0);
  const badSha = decide(input([pull({ head: { sha: "not-a-sha" } })], {}, {}), NOW, CONFIG);
  assert.ok(badSha.errors.some((e) => /head SHA/.test(e)));
});

test("an assignment that failed after the comment is retried on the next run", () => {
  const runs = { [A]: [run("typescript", "failure", 30)] };
  const result = decide(input([pull()], runs, { 7: [comment(BOT, marker(A))] }), NOW, CONFIG);
  assert.deepEqual(result.actions, [{ kind: "assign", pull: 7, login: "example-author" }]);
  assert.equal(result.counts.alreadyReported, 1);
});

test("a required_status_checks rule with no check list or an empty one is an error", () => {
  for (const rule of [{ type: "required_status_checks" }, { type: "required_status_checks", parameters: { required_status_checks: [] } }]) {
    const result = decide({ ...input([pull()], { [A]: [] }), rules: [rule] }, NOW, CONFIG);
    assert.ok(result.errors.some((e) => /check list|lists no check/.test(e)), JSON.stringify(rule));
  }
});
