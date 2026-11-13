// Issue #906. An MCP table header left in the managed block next to the replaced
// fragment is found at a line start through horizontal whitespace only, so a
// long run of line ends is not rescanned from every line start.
import assert from "node:assert/strict";
import { test } from "node:test";

import { replaceExactManagedFragment } from "./config-preservation.mts";

const START = "# >>> Kherep Codex Maestro >>>";
const END = "# <<< Kherep Codex Maestro <<<";
const CURRENT = "[[hooks.Stop]]\nmatcher = 'current'";

// The current fragment kept as is (first check) and a known fragment replaced (second check).
const keep = (rest: string) => replaceExactManagedFragment([START, CURRENT, rest, END, ""].join("\n"), START, END, ["old"], CURRENT);
const replace = (rest: string) => replaceExactManagedFragment([START, CURRENT, rest, END, ""].join("\n"), START, END, [CURRENT], "new");

test("an indented MCP table header after blank lines is refused by both checks", () => {
  for (const run of [keep, replace]) assert.throws(() => run("\n\n \t[ mcp_servers . other ]"), /unmatched MCP tables/);
});

test("an MCP table name inside a value is no header", () => {
  const rest = 'x = "[mcp_servers.a]"';
  const config = [START, CURRENT, rest, END, ""].join("\n");
  assert.equal(keep(rest), config);
  assert.equal(replace(rest), config.replace(CURRENT, "new"));
});

test("a long run of line ends is checked in linear time", () => {
  for (const run of [keep, replace]) {
    const started = performance.now();
    assert.doesNotThrow(() => run("\n".repeat(100_000)));
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)} ms`);
  }
});
