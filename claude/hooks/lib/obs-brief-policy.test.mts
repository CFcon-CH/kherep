import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_NOTHING_TO_FILE, OBS_BRIEF_FORMAT, OBS_BRIEF_REVISION, observationBriefIssue, observationBriefNotice,
} from "./obs-brief-policy.mts";

const MEASURED = "measured: `npm test` -> 42 pass, 0 fail";
const RELAYED = "relayed: the operator, in chat";

function denied(brief: string, needle: RegExp): string {
  const reason = observationBriefIssue(brief) ?? "";
  assert.match(reason, needle, brief);
  assert.ok(reason.includes(OBS_BRIEF_FORMAT), "the reason states the exact format");
  assert.match(reason, /\[obs: none – <reason>\]/, "the reason names the opt-out");
  return reason;
}

test("a brief without any marker is denied", () => {
  denied("", /marks no finding/);
  denied("Turn summary: fixed the guard and ran the tests.", /marks no finding/);
});

test("prose that says measured is no marker", () => {
  denied("MEASURED by running `npm test` -> 42 pass", /marks no finding/);
  denied("Measured: `npm test` -> 42 pass", /marks no finding/);
  denied("The tests were measured: `npm test` -> 42 pass", /marks no finding/);
});

test("a measured: finding without a code span is denied", () => {
  denied("measured: npm test -> 42 pass", /finding 1 \(measured:\) has no command in an inline code span/);
  denied("measured: `` -> 42 pass", /finding 1 \(measured:\) has no command/);
});

test("a measured: finding with a code span but no arrow is denied", () => {
  denied("measured: `npm test` printed 42 pass", /finding 1 \(measured:\) has no -> after the command/);
  // An arrow inside the command does not count.
  denied("measured: `a -> b` printed ok", /has no -> after the command/);
});

test("a measured: finding with an arrow but no excerpt is denied", () => {
  denied("measured: `npm test` ->   ", /has no deciding output excerpt/);
});

test("an empty relayed: finding is denied", () => {
  denied(`${MEASURED}\nrelayed:   `, /finding 2 \(relayed:\) names no source/);
});

test("the reason names the offending finding by its position", () => {
  const brief = [MEASURED, RELAYED, "measured: ran the tests -> green", MEASURED].join("\n");
  denied(brief, /finding 3 \(measured:\)/);
});

test("bulleted and numbered briefs are allowed", () => {
  assert.equal(observationBriefIssue(`Scope: Kherep\n- ${MEASURED}\n* ${RELAYED}`), null);
  assert.equal(observationBriefIssue(`1. ${MEASURED}\n2) ${RELAYED}\n  3. ${MEASURED}`), null);
  assert.equal(observationBriefIssue(`\t-  ${MEASURED}\r\n- ${RELAYED}\r\n`), null);
});

test("a relayed-only brief is allowed", () => {
  assert.equal(observationBriefIssue(`${RELAYED}\nrelayed: OP-1 comment by another session`), null);
});

test("a mixed brief is allowed, including a multi-line excerpt and a backticked command", () => {
  const brief = [
    "Turn summary first; the text before the first marker is no finding.",
    `- ${RELAYED}`,
    "- measured: ``git log --format=`%s` -1`` -> fix: check the brief",
    "- measured: `node x.test.mts` ->",
    "  === 12 pass, 0 fail ===",
  ].join("\n");
  assert.equal(observationBriefIssue(brief), null);
});

test("the caller chooses the advice for a turn with nothing to file", () => {
  const reason = observationBriefIssue("nothing", CODEX_NOTHING_TO_FILE) ?? "";
  assert.ok(reason.endsWith(CODEX_NOTHING_TO_FILE), reason);
  assert.doesNotMatch(reason, /\[obs: none/);
});

// Issue #505. A code-bound measured finding names the commit it was measured
// against; a missing or partial binding is a notice and `assumed`, never a deny.
const SHA = "2733b35e2c102ac54295568509c68b18b6d92cab";
const OTHER = "87da9d9aa1b2c3d4e5f60718293a4b5c6d7e8f90";
const NO_REPO = /finding 1 \(measured:\) is code-bound but names no repository/;
const NO_SHA = /finding 1 \(measured:\) names a repository without a full 40-hex commit SHA/;
const DIRTY = /finding 1 \(measured:\) was measured on a dirty tree/;
const MALFORMED = /finding 1 \(measured:\) has a malformed repository or revision/;
const CONDITIONAL = (n: number) => `Observation brief revision: finding ${n} (measured:) names no repository and commit SHA. `
  + "If it is about repository code, tests or a build, the observation agent files it as assumed; add `code <name>@<sha>` after measured:. "
  + "A finding that is not about repository code is unchanged.";

function notice(brief: string): string | null {
  assert.equal(observationBriefIssue(brief), null, `well-formed: ${brief}`);
  return observationBriefNotice(brief);
}
const bound = (binding: string, command = "npm test") => `measured: code ${binding} \`${command}\` -> 42 pass, 0 fail`;

test("the revision sentence is pinned", () => {
  assert.equal(OBS_BRIEF_REVISION,
    "A finding about repository code starts with code after measured: and names each repository as <name>@<full commit sha> before the command, each followed by -- and the repo-relative paths the finding rests on.");
});

test("T1 a complete, scoped binding is silent", () => {
  assert.equal(notice(bound(`kherep@${SHA} -- README.md`)), null);
  assert.equal(notice(bound(`CFcon-CH/kherep@${SHA} -- src/a.mts`)), null);
  assert.equal(notice(`- ${bound(`kherep@${SHA} -- README.md`)}\n- ${RELAYED}`), null);
});

test("T2 a bare code finding names no repository and is not the conditional notice", () => {
  const text = notice("measured: code `npm test` -> 42 pass") ?? "";
  assert.match(text, NO_REPO);
  assert.match(text, /files each as assumed: no exact binding to the measured code/);
  assert.notEqual(text, CONDITIONAL(1));
});

test("T3 a name, a symbolic or short revision, uppercase hex and a nameless SHA are no full binding", () => {
  for (const binding of ["kherep", "kherep@HEAD", "kherep@2733b35", "kherep@main", `kherep@${SHA.toUpperCase()}`, `kherep@${SHA}0`]) {
    assert.match(notice(bound(binding)) ?? "", NO_SHA, binding);
  }
  for (const binding of [`@${SHA}`, `https://example.com/kherep@${SHA}`, `D:/work/kherep@${SHA}`, `kherep//x@${SHA}`, `.kherep@${SHA}`]) {
    assert.match(notice(bound(binding)) ?? "", MALFORMED, binding);
  }
});

test("T4 a dirty tree is no exact binding", () => {
  assert.match(notice(bound(`kherep@${SHA}-dirty`)) ?? "", DIRTY);
});

test("T5 the validator never inspects the command", () => {
  assert.equal(notice(bound(`kherep@${SHA} -- README.md`, `git show ${SHA}:README.md`)), null);
  assert.match(notice(bound(`kherep@${SHA}-dirty`, `git show ${SHA}:README.md`)) ?? "", DIRTY);
});

test("T6 every repository needs its own complete token, and the finding is named once", () => {
  assert.equal(notice(bound(`kherep@${SHA} -- a.mts cfaysal/other@${OTHER} -- b.mts`)), null);
  const text = notice(bound(`kherep@${SHA} other@HEAD`)) ?? "";
  assert.match(text, NO_SHA);
  assert.equal(text.match(/finding 1 /g)?.length, 1, text);
});

test("T7 a finding never borrows a binding from the preamble or another finding", () => {
  assert.match(notice(`Revision: kherep@${SHA}\nmeasured: code \`npm test\` -> ok`) ?? "", NO_REPO);
  const text = notice(`${bound(`kherep@${SHA} -- README.md`)}\nmeasured: code \`npm test\` -> ok`) ?? "";
  assert.match(text, /finding 2 \(measured:\) is code-bound but names no repository/);
  assert.doesNotMatch(text, /finding 1/);
});

test("T8 unmarked findings: a binding is silent, none gets the fixed conditional notice", () => {
  assert.equal(notice(`measured: kherep@${SHA} \`cmd\` -> ok`), null);
  assert.equal(notice(MEASURED), CONDITIONAL(1));
  assert.equal(notice("measured: `cmd` -> code kherep"), CONDITIONAL(1));
  assert.equal(notice(`measured: \`cmd\` -> code kherep@${SHA}`), CONDITIONAL(1));
  assert.equal(notice(`${RELAYED}\n${MEASURED}`), CONDITIONAL(2));
  assert.equal(notice("relayed: code kherep"), null);
  assert.equal(notice(`relayed: code kherep@${SHA}-dirty \`x\` -> y`), null);
  assert.equal(notice(RELAYED), null);
});

test("T8b an unmarked finding is silent only when every binding it names is complete", () => {
  const partial = (n: number) => CONDITIONAL(n).replace("names no repository and commit SHA", "has no complete binding of all named repositories");
  assert.equal(notice(`measured: alpha@${SHA} beta@HEAD \`cmd\` -> ok`), partial(1), "valid + missing SHA");
  assert.equal(notice(`measured: alpha@${SHA} beta@${OTHER}-dirty \`cmd\` -> ok`), partial(1), "valid + dirty");
  assert.equal(notice(`measured: alpha@${SHA} @${OTHER} \`cmd\` -> ok`), partial(1), "valid + malformed");
  assert.equal(notice(`measured: alpha@${SHA} beta@${OTHER} \`cmd\` -> ok`), null);
  assert.equal(notice(`measured: alpha@${SHA} \`a\` -> x\nmeasured: beta@HEAD \`b\` -> y`), partial(2), "no borrowing");
  assert.equal(notice(`measured: alpha@${SHA} \`a\` -> x\nmeasured: \`b\` -> y`), CONDITIONAL(2), "no borrowing");
  assert.doesNotMatch(partial(1), /alpha|beta|[0-9a-f]{7,}/);
  assert.match(notice(bound(`alpha@${SHA} beta@HEAD`)) ?? "", NO_SHA, "a marked finding keeps the unconditional notice");
});

test("T11 a missing repository and a missing SHA are two clauses of one notice", () => {
  const text = notice("measured: code `a` -> x\nmeasured: code kherep `b` -> y") ?? "";
  assert.match(text, /finding 1 \(measured:\) is code-bound but names no repository; finding 2 \(measured:\) names a repository without a full 40-hex commit SHA\./);
  assert.equal(text.match(/Observation brief revision:/g)?.length, 1);
});

test("T9 a denied brief gets no notice, and the deny says nothing about revisions", () => {
  for (const brief of ["", "prose only", "measured: code npm test -> 42", "measured: code kherep `x` printed ok", `${bound("kherep")}\nrelayed:  `]) {
    assert.equal(observationBriefNotice(brief), null, brief);
    assert.doesNotMatch(observationBriefIssue(brief) ?? "", /revision|code-bound|-dirty/i, brief);
  }
});

test("T10 a notice quotes no name, no SHA and no brief text", () => {
  for (const brief of [
    bound("examplecorp"), bound(`examplecorp@${SHA}-dirty`), bound(`examplecorp@${SHA.slice(0, 12)}`),
    bound(`https://token@examplecorp.example.com/x@${SHA}`), "measured: `examplecorp deploy` -> examplecorp ok",
  ]) {
    const text = notice(brief) ?? "";
    assert.ok(text, brief);
    assert.doesNotMatch(text, /examplecorp|example\.com|token/i, brief);
    assert.doesNotMatch(text, /[0-9a-f]{7,}/i, brief);
  }
});

// Issue #906: code span cases of the current expression, kept as the reference for its replacement.
test("code spans follow CommonMark backtick runs", () => {
  for (const brief of ["measured: `npm test` -> 42 pass", "measured: ``a`b`` -> ok", "measured: ```x` -> ok"]) {
    assert.equal(observationBriefIssue(brief), null, brief);
  }
  denied("measured: `a`` -> ok", /has no command in an inline code span/);
  denied("measured: ` ` -> ok", /has no command in an inline code span/);
  denied("measured: `a` then `b` no arrow", /has no -> after the command/);
  // The binding words end where the span starts: an opener used from its last backtick leaves the others before it.
  const bound = `measured: code r@${"0123456789abcdef".repeat(2)}01234567 -- a/b.mts`;
  assert.equal(observationBriefNotice(`${bound} \`x\` -> ok`), null);
  for (const span of ["``x`", "```x`"]) assert.match(observationBriefNotice(`${bound} ${span} -> ok`) ?? "", /path list that is not repo-relative/, span);
  const rising = `measured: ${Array.from({ length: 400 }, (_, i) => `${"`".repeat(i + 1)}a`).join("")}`;
  const started = performance.now();
  denied(rising, /has no command in an inline code span/);
  assert.ok(performance.now() - started < 200, "linear on rising backtick runs");
});
