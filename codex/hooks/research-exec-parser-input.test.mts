// Issue #965. research-exec-parser.mts through its exports: which nested tool calls a source
// contains around literals, comments and regexes, and the input record read from each call.
import assert from "node:assert/strict";
import { test } from "node:test";

import { inputRecord, nestedToolCalls } from "./research-exec-parser.mts";

const record = (input: unknown) => inputRecord({ name: "exec", input });

test("an object input is kept; a JSON object string is parsed; anything else is an input string", () => {
  const input = { cmd: "ls" };
  assert.equal(record(input), input);
  assert.deepEqual(record(' {"cmd":"ls"} '), { cmd: "ls" });
  for (const value of [42, null, ["a"], "", "   "]) assert.deepEqual(record(value), { input: "" }, JSON.stringify(value));
  assert.deepEqual(record("[1]"), { input: "[1]" }, "a JSON array is no record");
  assert.deepEqual(record("plain words"), { input: "plain words" });
});

test("a quoted input string is unquoted; a malformed or templated one stays raw", () => {
  assert.deepEqual(record('"a\\nb"'), { input: "a\nb" });
  assert.deepEqual(record('"unterminated'), { input: '"unterminated' });
  assert.deepEqual(record(String.raw`'it\'s\na\rb'`), { input: "it's\na\rb" });
  assert.deepEqual(record("`plain`"), { input: "plain" });
  assert.deepEqual(record("`x ${y}`"), { input: "`x ${y}`" });
  assert.deepEqual(record("'open"), { input: "'open" });
});

test("a cmd or command property of the outer object literal is read lexically", () => {
  assert.deepEqual(record("{ cmd: 'ls -la' }"), { cmd: "ls -la" });
  assert.deepEqual(record('{ a: 1, command: "git status" }'), { command: "git status" });
  assert.deepEqual(record("{ opts: { cmd: 'inner' }, cmd: 'outer' }"), { cmd: "outer" }, "a nested cmd is not the outer one");
  assert.deepEqual(record("{ x: 1 /* cmd: 'no' */, cmd: `yes` }"), { cmd: "yes" });
  assert.deepEqual(record("{ x: 1 // cmd: 'no'\n, cmd: 'yes' }"), { cmd: "yes" });
  assert.deepEqual(record("{ x: /}/g, cmd: 'yes' }"), { cmd: "yes" }, "a } inside a regex is no brace");
  assert.deepEqual(record("{ x: /[/]\\//, cmd: 'yes' }"), { cmd: "yes" }, "a / inside a class or escaped ends no regex");
  assert.deepEqual(record("{ 'x': '}', cmd: 'yes' }"), { cmd: "yes" });
  for (const raw of ["{ cmd: run }", "{ cmd }", "{ a cmd: 'x' }", "{ x: /open", "{ x: 1 /* open"]) {
    assert.deepEqual(record(raw), { input: raw }, raw);
  }
});

test("nested calls skip literals, comments and regexes, at the top level and inside a call", () => {
  assert.deepEqual(nestedToolCalls("tools.f (1)"), [{ name: "f", input: "1" }]);
  assert.deepEqual(nestedToolCalls("tools.f(a /* ) */, b // )\n, ')', /\\)/)"), [{ name: "f", input: "a /* ) */, b // )\n, ')', /\\)/" }]);
  assert.deepEqual(nestedToolCalls("// tools.a(1)\n/* tools.b(2) */ 'tools.c(3)'; x = /tools.d(4)/; tools.e(5) // end"), [{ name: "e", input: "5" }]);
  for (const source of ["tools.f + 1", "tools.(1)", "tools.f(1", "tools.f('open", "mytools.f(1)", "/* tools.f(1)", "tools.f(/* open"]) {
    assert.deepEqual(nestedToolCalls(source), [], source);
  }
});
