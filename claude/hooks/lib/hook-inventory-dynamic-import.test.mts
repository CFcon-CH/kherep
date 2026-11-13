// Issue #906. A dynamic import counts unless it is a `typeof import(...)` type
// query; the type query is consumed by an optional group instead of a lookbehind
// that rescanned every whitespace run. Runs on its own: node hook-inventory-dynamic-import.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";

import { relativeSpecifiers } from "./hook-inventory.mts";

// Fixture sources spell `import(` through a helper, as hook-inventory.test.mts does:
// bootstrap/hook-require-resolution.test.mts scans every hook file and would read a fixture as a real import.
const dynamic = (specifier: string, open = '"', close = open): string => `import(${open}${specifier}${close})`;

test("a dynamic import counts, a typeof type query does not", () => {
  const cases: [string, string[]][] = [
    [`const a = await ${dynamic("./a.mts")};`, ["./a.mts"]],
    [`type T = typeof ${dynamic("./t.mts")}; const b = ${dynamic("./b.mts", "'")}`, ["./b.mts"]],
    [`type T = typeof\n  ${dynamic("./t.mts")}`, []],
    [`xtypeof ${dynamic("./c.mts")}`, ["./c.mts"]],
    [dynamic("./d.mts", '"', "'"), []],
  ];
  for (const [source, expected] of cases) assert.deepEqual(relativeSpecifiers(source), expected, source);
});

test("long whitespace and repeated typeof scan in linear time", () => {
  for (const source of [" ".repeat(100_000), "typeof ".repeat(20_000)]) {
    const started = performance.now();
    assert.deepEqual(relativeSpecifiers(source), []);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 200, `${source.length} characters took ${elapsed.toFixed(1)} ms`);
  }
});
