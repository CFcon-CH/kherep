// Issue #965. The literal tool-call grammar of post-edit-tool-calls.mts through its two exports:
// which direct `tools.<name>(<literal>)` sequences are complete, and which of them are read-only.
import assert from "node:assert/strict";
import { test } from "node:test";

import { completeDirectLiteralToolCalls, isCompleteReadOnlyToolSequence } from "./post-edit-tool-calls.mts";

const complete = (source: string): boolean => completeDirectLiteralToolCalls(source) !== null;
const READ = "tools.mcp__codebase_memory_mcp__search_graph";

test("a complete sequence returns its calls; a read-only one is recognized as such", () => {
  const source = `await ${READ}({"query": "x"}); tools.mcp__codebase_memory_mcp__list_projects({});`;
  assert.deepEqual(completeDirectLiteralToolCalls(source), [
    { name: "mcp__codebase_memory_mcp__search_graph", input: '{"query": "x"}' },
    { name: "mcp__codebase_memory_mcp__list_projects", input: "{}" },
  ]);
  assert.equal(isCompleteReadOnlyToolSequence(source), true);
  assert.equal(isCompleteReadOnlyToolSequence("tools.mcp__codebase_memory_mcp__index_repository({})"), false, "not read-only");
  assert.equal(isCompleteReadOnlyToolSequence(`${READ}(x)`), false, "not a literal");
});

test("string escapes: the valid forms are accepted, every malformed one rejects the sequence", () => {
  const accepted = [String.raw`"\0"`, String.raw`"\x41"`, String.raw`"\u{1F600}"`, '"' + "\\" + "u0041" + '"', String.raw`"\"\'\\\b\f\n\r\t\v\/"`,
    "`a\nb`", "'single'"];
  for (const literal of accepted) assert.equal(complete(`tools.f(${literal})`), true, literal);
  const rejected = [String.raw`"\01"`, String.raw`"\x4"`, String.raw`"\u{110000}"`, String.raw`"\u00"`, String.raw`"\q"`,
    '"a\nb"', "`${x}`", '"abc', '"abc\\', '"a\\\nb"'];
  for (const literal of rejected) assert.equal(complete(`tools.f(${literal})`), false, literal);
});

test("numbers, keywords, arrays and objects", () => {
  for (const value of ["-1.5e3", "0", "true", "[null, false]", "[]", "[1,]", "[ 1 , 2 ]", "{}", "{a: 1,}", "{'k': 1, \"j\": [2]}", "{ $x : { y: \"z\" } }"]) {
    assert.equal(complete(`tools.f(${value})`), true, value);
  }
  for (const value of ["trueish", "[1 2]", "[1,,2]", "[1", "{a: 1 b: 2}", "{a 1}", "{1: 2}", "{`k`: 1}", "{a: }", "{a: 1", "x", "", "01"]) {
    assert.equal(complete(`tools.f(${value})`), false, value);
  }
});

test("nesting deeper than 50 levels is rejected", () => {
  assert.equal(complete(`tools.f(${"[".repeat(50)}${"]".repeat(50)})`), true);
  assert.equal(complete(`tools.f(${"[".repeat(52)}${"]".repeat(52)})`), false);
});

test("the call sequence: await, names, parentheses, separators", () => {
  for (const source of ["tools.f(1)", " await  tools.f(1) ; tools.g(2);", "tools.f(1)\n;\ntools.g(2)"]) assert.equal(complete(source), true, source);
  for (const source of ["", "   ", "awaittools.f(1)", "await(tools.f(1))", "await", "tools.(1)", "tools.f 1", "tools.f(1 2)", "tools.f(1",
    "tools.f(1) tools.g(2)", "other.f(1)", "tools.f(1);x"]) {
    assert.equal(complete(source), false, JSON.stringify(source));
  }
});
