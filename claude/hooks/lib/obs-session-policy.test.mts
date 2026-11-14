// Issue #922. The claude-obs brief starts with the dispatching session's id line.
import assert from "node:assert/strict";
import test from "node:test";

import { OBS_BRIEF_SESSION, observationSessionIssue } from "./obs-session-policy.mts";

const ID = "0f3c2a9e-1b7d-4c55-9e21-5a0d6b8c4f17";
const FINDING = "- measured: `node x.test.mts` -> 12 pass, 0 fail";

function denied(brief: string, sessionId: string): string[] {
  const reason = observationSessionIssue(brief, sessionId);
  assert.ok(reason, `expected a deny for ${JSON.stringify(brief)}`);
  const lines = reason.split("\n");
  assert.equal(lines.length, 3, "a three-line reason");
  assert.equal(lines[0], OBS_BRIEF_SESSION);
  assert.doesNotMatch(lines[0], new RegExp(sessionId), "line 1 never carries the id (denial journal keeps it)");
  assert.equal(lines[1], `Session id: ${sessionId}`);
  assert.equal(lines[2], "Put that line first, unchanged, and dispatch again with the same findings.");
  return lines;
}

test("the session line first is accepted", () => {
  assert.equal(observationSessionIssue(`Session id: ${ID}\n${FINDING}`, ID), null);
  assert.equal(observationSessionIssue(`Session id: ${ID}`, ID), null);
});

test("blank lines before it, CRLF and trailing whitespace are accepted", () => {
  assert.equal(observationSessionIssue(`\n  \r\nSession id: ${ID}\r\n${FINDING}`, ID), null);
  assert.equal(observationSessionIssue(`Session id: ${ID} \t\n${FINDING}`, ID), null);
});

test("a brief without the line is denied with the line to copy", () => {
  denied(FINDING, ID);
  denied("", ID);
});

test("a forged id is denied and the reason names the payload id only", () => {
  const forged = "a1b2c3d4-0000-4000-8000-000000000000";
  const lines = denied(`Session id: ${forged}\n${FINDING}`, ID);
  assert.ok(!lines.join("\n").includes(forged), "the reason never quotes the brief");
});

test("the right line in second place or after a finding is denied", () => {
  denied(`Scope: Kherep\nSession id: ${ID}\n${FINDING}`, ID);
  denied(`${FINDING}\nSession id: ${ID}`, ID);
});

test("another shape of the line is denied", () => {
  denied(`  Session id: ${ID}\n${FINDING}`, ID);
  denied(`session id: ${ID}\n${FINDING}`, ID);
  denied(`Session id: ${ID} (this session)\n${FINDING}`, ID);
});

test("a payload without a usable session id fails open", () => {
  for (const sessionId of [undefined, null, 42, "", "ABC123", "abc 123", "abc\n123", "-abc", "a".repeat(81), {}]) {
    assert.equal(observationSessionIssue(FINDING, sessionId), null, JSON.stringify(sessionId));
  }
  assert.equal(observationSessionIssue(FINDING, "a".repeat(80)) === null, false, "80 characters is still an id");
});
