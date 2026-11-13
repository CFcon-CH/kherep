// Issue #906. A slash after a keyword starts a regex literal, any other slash is a
// division. The keyword is read by a backward scan of one identifier, so a ")"
// inside a regex literal never ends a tool call early and a long prefix is not
// rescanned per slash.
import assert from "node:assert/strict";
import { test } from "node:test";

import { nestedToolCalls } from "./research-exec-parser.mts";

const call = (body: string) => nestedToolCalls(`tools.f(${body})`);

test("a regex literal after a keyword keeps its ) inside the call", () => {
  for (const body of ["return /\\)/.test(x)", "typeof /\\)/", "case /\\)/: 1", "1return /\\)/", "x = 1return /\\)/"]) {
    assert.deepEqual(call(body), [{ name: "f", input: body }], body);
  }
});

test("a slash after a value or another name is a division and the next ) ends the call", () => {
  assert.deepEqual(nestedToolCalls("tools.f(x = a / b) + c)"), [{ name: "f", input: "x = a / b" }]);
  assert.deepEqual(call("areturn /\\)/"), [{ name: "f", input: "areturn /\\" }]);
  assert.deepEqual(call("a1return /\\)/"), [{ name: "f", input: "a1return /\\" }]);
});

test("a long argument parses in linear time", () => {
  for (const body of ["a".repeat(100_000) + " / 1", "a/".repeat(20_000) + "a"]) {
    const started = performance.now();
    assert.deepEqual(call(body), [{ name: "f", input: body }]);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 200, `${body.length} characters took ${elapsed.toFixed(1)} ms`);
  }
});
