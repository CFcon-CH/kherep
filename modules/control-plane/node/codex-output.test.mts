// Issue #906. A URL query in a stderr line is redacted per run of non-space,
// non-# characters, from the first "?" after the earliest scheme://, instead of
// by an expression that rescanned the run from every scheme separator.
import assert from "node:assert/strict";
import test from "node:test";

import { lastLine } from "./codex-output.mts";

test("the query after the first ? that follows scheme:// is redacted, nothing else", () => {
  const cases: [string, string][] = [
    ["x https://h.example/p?a=1 y", "x https://h.example/p?<redacted> y"],
    ["https://h.example/p#f?a=1", "https://h.example/p#f?a=1"],
    ["a://b://c?d?e", "a://b://c?<redacted>"],
    ["1://x?y", "1://x?y"],
    ["u://h/p?$1&$&", "u://h/p?<redacted>"],
  ];
  for (const [line, expected] of cases) assert.equal(lastLine(line), expected, line);
});

test("a long run of scheme separators is redacted in linear time", () => {
  const started = performance.now();
  assert.equal(lastLine("a://".repeat(50_000)).length, 200);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)} ms`);
});
