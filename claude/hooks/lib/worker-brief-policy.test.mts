import assert from "node:assert/strict";
import test from "node:test";

import {
  declaresRevision, REVIEW_ASSUMPTION_RULE, WORKER_BRIEF_FORMAT, WORKER_BRIEF_REVISION, workerBriefIssue, workerBriefNotice,
} from "./worker-brief-policy.mts";

const SHA = "2733b35e2c102ac54295568509c68b18b6d92cab";
const HEAD = "f0893d7e62823a48d89ec57f1e33f5c8f57eebca";
const ROUTES = "test-route: Node fixture :: node fixture.test.mts :: report.txt\nroute-source: page KB-EXAMPLE";
const build = (brief: string) => `${brief}\n${ROUTES}`;
const BUILD = `Objective: fix the guard.\nrevision: kherep@${SHA}\ndecided: none\nOwnership: claude/hooks only.`;

function denied(brief: string, codeBound: boolean, needle: RegExp): string {
  const reason = workerBriefIssue(brief, codeBound) ?? "";
  assert.match(reason, needle, brief);
  assert.ok(reason.startsWith("Worker brief format: "), reason);
  assert.ok(reason.endsWith(`. ${WORKER_BRIEF_FORMAT}`), "the reason states the exact format");
  return reason;
}

test("a code-bound brief needs both markers, revision: first", () => {
  denied("Build the feature.", true, /: the brief names no revision:\./);
  denied(`revision: kherep@${SHA}\nBuild it.`, true, /: the brief names no decided:\./);
  denied("decided: keep the API\nBuild it.", true, /names no revision:/);
  assert.equal(workerBriefIssue(build(BUILD), true), null);
});

test("every accepted revision form passes", () => {
  for (const revision of [SHA, `${SHA}-dirty`, `${SHA}..${HEAD}`, `${SHA}..${HEAD}-dirty`]) {
    assert.equal(workerBriefIssue(build(`revision: kherep@${revision}\ndecided: none`), true), null, revision);
  }
  assert.equal(workerBriefIssue(build(`revision: kherep@${SHA} org/tools@${HEAD}\ndecided: none`), true), null, "two tokens");
  assert.equal(workerBriefIssue(build(`- revision: kherep@${SHA}\n2) revision: tools@${HEAD}\n1. decided: none`), true), null, "lists");
  assert.equal(workerBriefIssue(build(`  * revision: kherep@${SHA}\n\t- decided: none`), true), null, "indented bullets");
});

test("a malformed token is denied by position and never quoted", () => {
  for (const token of ["kherep", "kherep@f0893d7", `kherep@${SHA.toUpperCase()}`, `@${SHA}`, `kherep@${SHA}-DIRTY`,
    `kherep@${SHA}..`, `kherep@${SHA}...${HEAD}`, `kherep@${SHA}..${HEAD}..${SHA}`, `kherep@${SHA}-dirty..${HEAD}`,
    `kherep@${SHA},`, `-bad@${SHA}`]) {
    const reason = denied(`revision: ${token}\ndecided: none`, true, /: revision 1 has a malformed token\./);
    assert.ok(!reason.includes(token), "a reason never quotes the brief");
  }
  denied(`revision: kherep@${SHA}\nrevision: kherep@${SHA} kherep\ndecided: none`, true, /revision 2 has a malformed token/);
});

test("a revision: without a token names no repository", () => {
  denied("revision:\ndecided: none", true, /: revision 1 names no repository\./);
  denied(`revision: kherep@abc\nrevision:\ndecided: none`, true, /revision 1 has a malformed token/);
});

test("only the revision line is a token list; the text after it is not", () => {
  assert.equal(workerBriefIssue(build(`revision: kherep@${SHA}\n\nObjective: review the guard @ the top.\ndecided: none`), true), null);
});

test("an empty decided: is denied; decided: none and a multi-line list pass", () => {
  denied(`revision: kherep@${SHA}\ndecided:\n`, true, /: decided 1 is empty\./);
  denied(`decided: keep it\nrevision: kherep@${SHA}\ndecided:`, true, /decided 2 is empty/);
  assert.equal(workerBriefIssue(build(`revision: kherep@${SHA}\ndecided:\n- keep the API\n- no new deps`), true), null);
  assert.equal(workerBriefIssue(build(`revision: kherep@${SHA}\ndecided: x`), true), null, "decided: content is never judged");
});

test("markers are lowercase at the start of a line only", () => {
  denied(`Revision: kherep@${SHA}\nDecided: none`, true, /names no revision:/);
  denied(`The revision: kherep@${SHA} and decided: none`, true, /names no revision:/);
  assert.equal(declaresRevision(`see revision: kherep@${SHA}`), false);
  assert.equal(declaresRevision(`  * revision: kherep@${SHA}`), true);
});

test("a dispatch that is not code-bound is checked only when it declares revision:", () => {
  assert.equal(workerBriefIssue("Look this up.", false), null);
  assert.equal(workerBriefIssue("decided:\nLook this up.", false), null, "an undeclared brief is not checked");
  assert.equal(workerBriefIssue(`revision: kherep@${SHA}`, false), null, "decided: is not required by declaration");
  denied("revision: kherep@abc", false, /revision 1 has a malformed token/);
  denied(`revision: kherep@${SHA}\ndecided:`, false, /decided 1 is empty/);
});

test("the review notice fires only on a review brief without revision:", () => {
  const notice = workerBriefNotice("Review the diff of the guard.") ?? "";
  assert.equal(notice, `Worker brief revision: the brief mentions a review but names no revision:. ${WORKER_BRIEF_REVISION}`);
  for (const word of ["reviews", "reviewed", "reviewing", "a REVIEWER"]) assert.ok(workerBriefNotice(`Please see ${word} notes.`), word);
  assert.equal(workerBriefNotice(`Review it.\nrevision: kherep@${SHA}..${HEAD}`), null);
  assert.equal(workerBriefNotice("Look it up."), null);
  assert.equal(workerBriefNotice("Open the preview."), null, "review must start a word");
  assert.equal(workerBriefNotice("Read the reviewers list."), null, "only the listed word forms count");
  assert.ok(!notice.includes("the diff of the guard"), "a notice never quotes the brief");
});

test("the reviewer rule is the approved sentence", () => {
  assert.equal(REVIEW_ASSUMPTION_RULE,
    "A finding that rests on an assumption stated neither in the brief nor in the code is reported as `assumed: <assumption> -> <finding>` and counted in ASSUMED:, never resolved silently.");
});

test("build routes require every own-line field and retain earlier error priority", () => {
  denied(BUILD, true, /names no test-route:/);
  denied(`${BUILD}\ntest-route: Node :: check :: report`, true, /names no route-source:/);
  denied(`revision: kherep@HEAD\ndecided: none`, true, /malformed token/);
  for (const marker of ["test-route", "route-source"]) {
    denied(`revision: kherep@${SHA}\ndecided:\n${marker}: actual`, true, /decided 1 is empty/);
  }
  for (const prefix of ["", "  ", "- ", "* ", "1. ", "2) ", "  - "]) {
    assert.equal(workerBriefIssue(`${BUILD}\n${ROUTES.replace(/^/gm, prefix)}`, true), null, prefix);
  }
  assert.equal(workerBriefIssue(build(BUILD) + `\n2) ${ROUTES.replace(/\n/g, "\n  * ")}`, true), null, "every repeated valid field passes");
  for (const bad of ["Test-route:", "text test-route:"]) {
    denied(`${BUILD}\n${ROUTES.replace("test-route:", bad)}`, true, /names no test-route:/);
  }
});

test("test-route has exactly three real components on its own line", () => {
  for (const value of ["", "Node", "Node :: check", " :: check :: report", "Node ::  :: report",
    "Node :: check :: ", "Node :: check :: report :: extra", "\nNode :: check :: report",
    "Node ::\ncheck :: report", "TBD :: check :: report", "Node :: UNKNOWN :: report",
    "Node :: check :: none", "<execution context> :: check :: report", "Node :: {{check}} :: report",
    "Node :: check :: [result]"]) {
    denied(`${BUILD}\n${ROUTES.replace(/^test-route:.*$/m, `test-route: ${value}`)}`, true, /test-route 1 is malformed/);
  }
  denied(build(BUILD) + "\ntest-route: TBD", true, /test-route 2 is malformed/);
});

test("route-source requires a completed page or query outcome on its own line", () => {
  for (const value of ["page KB-EXAMPLE", "query build route :: hit documented Node tests", "query build route :: no-match"]) {
    assert.equal(workerBriefIssue(`${BUILD}\n${ROUTES.replace(/^route-source:.*$/m, `route-source: ${value}`)}`, true), null, value);
  }
  for (const value of ["", "page", "page UNKNOWN", "page <safe reference>", "query", "query route",
    "query :: no-match", "query route :: hit", "query route :: hit TBD", "query route :: UNKNOWN",
    "query route :: refused", "query route :: unavailable", "query route :: no-match truncated",
    "query route :: no-match :: extra", "UNKNOWN", "refused", "unavailable", "none",
    "query <safe terms> :: no-match", "query route :: hit <safe finding>", "\npage KB-EXAMPLE"]) {
    denied(`${BUILD}\n${ROUTES.replace(/^route-source:.*$/m, `route-source: ${value}`)}`, true, /route-source 1 is malformed/);
  }
  denied(build(BUILD) + "\nroute-source: query route", true, /route-source 2 is malformed/);
  denied(`${BUILD}\n${ROUTES.replace("route-source:", "Route-source:")}`, true, /names no route-source:/);
  denied(`${BUILD}\nroute-source: UNKNOWN\ntest-route: TBD`, true, /test-route 1 is malformed/);
  const reason = denied(build(BUILD) + "\nroute-source: private-sentinel", true, /route-source 2 is malformed/);
  assert.ok(!reason.includes("private-sentinel"));
});

test("non-build contracts do not acquire route requirements or new decision boundaries", () => {
  assert.equal(workerBriefIssue(BUILD, false), null);
  assert.equal(workerBriefIssue(`revision: kherep@${SHA}\ndecided:\ntest-route: none\nroute-source: UNKNOWN`, false), null);
});
