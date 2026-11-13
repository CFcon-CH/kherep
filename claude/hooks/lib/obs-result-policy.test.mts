import assert from "node:assert/strict";
import test from "node:test";

import { checkObsResult } from "./obs-result-policy.mts";

function valid(message: string, status: string): void {
  assert.deepEqual(checkObsResult(message), { status }, message);
}

function malformed(message: string, needle: RegExp): void {
  const result = checkObsResult(message);
  assert.ok("problem" in result, `accepted: ${message}`);
  assert.match(result.problem, needle, message);
}

test("a wrote line with n equal to the number of numeric ids is valid", () => {
  valid("OBS-RESULT: wrote 1 276858041", "wrote");
  valid("OBS-RESULT: wrote 3 1,2,3", "wrote");
  valid("OBS-RESULT: wrote 3 1, 2, 3\n1 First title\n2 Second\n3 Third", "wrote");
  valid("\n  \r\nOBS-RESULT: wrote 2 11 22\r\n11 Title", "wrote");
});

test("empty and failed with a reason are valid", () => {
  valid("OBS-RESULT: empty nothing new in this turn", "empty");
  valid("OBS-RESULT: failed missing broker /home/x/.claude/kherep/confluence.json", "failed");
  valid("OBS-RESULT: failed abandoned page 4711\n4711 Half-written page", "failed");
});

test("the observed mixed line is malformed", () => {
  malformed("OBS-RESULT: failed wrote 4 pages: 1,2,3,4", /reason starts with a status word/);
  malformed("OBS-RESULT: empty Empty turn", /reason starts with a status word/);
  malformed("OBS-RESULT: failed (failed) twice", /reason starts with a status word/);
});

test("the first non-empty line has to be the status line", () => {
  malformed("", /no OBS-RESULT status line/);
  malformed("   \n\t\n", /no OBS-RESULT status line/);
  malformed("Done.\nOBS-RESULT: wrote 1 5", /no OBS-RESULT status line/);
  malformed("`OBS-RESULT: wrote 1 5`", /no OBS-RESULT status line/);
  malformed("OBS-RESULT: written 1 5", /no OBS-RESULT status line/);
  malformed("OBS-RESULT: wrote,1 5", /no OBS-RESULT status line/);
  malformed("obs-result: wrote 1 5", /no OBS-RESULT status line/);
});

test("exactly one OBS-RESULT line may exist", () => {
  malformed("OBS-RESULT: wrote 1 5\nOBS-RESULT: empty nothing", /more than one OBS-RESULT line/);
  malformed("OBS-RESULT: wrote 1 5\n  OBS-RESULT: failed again", /more than one OBS-RESULT line/);
  // A page title in the list after the status line may name OBS-RESULT.
  valid("OBS-RESULT: wrote 1 278102262\n278102262 OBS-RESULT failure handling is a Maestro duty", "wrote");
  valid("OBS-RESULT: empty nothing\nnote: OBS-RESULT was hard", "empty");
});

test("wrote needs a positive integer count", () => {
  malformed("OBS-RESULT: wrote", /positive count/);
  malformed("OBS-RESULT: wrote 0", /positive count/);
  malformed("OBS-RESULT: wrote 01 5", /positive count/);
  malformed("OBS-RESULT: wrote two 5,6", /positive count/);
  malformed("OBS-RESULT: wrote -1 5", /positive count/);
});

test("wrote needs numeric ids", () => {
  malformed("OBS-RESULT: wrote 4 pages: 1,2,3,4", /ids are not numeric/);
  malformed("OBS-RESULT: wrote 1 abc", /ids are not numeric/);
  malformed("OBS-RESULT: wrote 1 5;", /ids are not numeric/);
});

test("wrote needs as many ids as its count", () => {
  malformed("OBS-RESULT: wrote 1", /count differs from the number of ids/);
  malformed("OBS-RESULT: wrote 2 5", /count differs from the number of ids/);
  malformed("OBS-RESULT: wrote 1 5,6", /count differs from the number of ids/);
  malformed("OBS-RESULT: wrote 2 5,,", /count differs from the number of ids/);
});

test("empty and failed need a reason", () => {
  malformed("OBS-RESULT: empty", /empty needs a reason/);
  malformed("OBS-RESULT: failed   ", /failed needs a reason/);
});

test("a problem never quotes the message", () => {
  const secret = "Example Corp host.example.com 99999";
  for (const message of [
    `OBS-RESULT: failed wrote ${secret}`,
    `OBS-RESULT: wrote 7 ${secret}`,
    `${secret}\nOBS-RESULT: empty x`,
    `OBS-RESULT: wrote 3 99999`,
  ]) {
    const result = checkObsResult(message);
    assert.ok("problem" in result, message);
    assert.doesNotMatch(result.problem, /Example|example\.com|99999|\b7\b|\b3\b/, result.problem);
  }
});

// Issue #906: the reason starts at the first non-blank after the status word.
test("a reason starts after the blanks; a line break or a glued word makes no status line", () => {
  assert.deepEqual(checkObsResult("OBS-RESULT: wrote 2 11,12"), { status: "wrote" });
  assert.deepEqual(checkObsResult("OBS-RESULT:\tfailed \t  broker down "), { status: "failed" });
  assert.deepEqual(checkObsResult("OBS-RESULT: empty"), { problem: "empty needs a reason" });
  const none = { problem: "the first non-empty line is no OBS-RESULT status line" };
  for (const message of ["OBS-RESULT: wrote\t\r2 11 12", "OBS-RESULT: failedx"]) assert.deepEqual(checkObsResult(message), none, message);
  const started = performance.now();
  assert.deepEqual(checkObsResult(`OBS-RESULT: failed${" ".repeat(50_000)}x\u2028y`), none);
  assert.ok(performance.now() - started < 200, "linear on a long blank run");
});
