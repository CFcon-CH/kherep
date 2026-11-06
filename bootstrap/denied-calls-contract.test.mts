// Issue #504. Three contracts of the denied-call journal that its own suites cannot see:
// - lead decision 3: the journal lib holds a fourth copy of the private marker pattern; the three
//   guard copies stay untouched, and all four keep the same source and flags;
// - the worker key is held equal across its five copies;
// - review P3-11: every journal write is fs.promises raced against a cap. A synchronous write would
//   bypass the test seam and still pass against a real temporary home, so the writers' source
//   names no synchronous write call.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { AGENT_KEY, PRIVATE_MARKER_PATTERN } from "../claude/hooks/lib/denial-journal.mts";

const repo = path.resolve(import.meta.dirname, "..");
const source = (rel: string): string => fs.readFileSync(path.join(repo, rel), "utf8");

// The regex literal assigned to `name` in a file's source, as source and flags.
function literal(rel: string, name: string): { source: string; flags: string } {
  const match = new RegExp(`\\b${name} =\\s*\\/(.+)\\/([a-z]*);\\s*$`, "m").exec(source(rel));
  assert.ok(match, `${rel} assigns ${name} a regex literal`);
  return { source: match[1]!, flags: match[2]! };
}

test("the four private marker pattern copies have one source and one flag set", () => {
  const copies = {
    "claude/hooks/privacy-boundary-guard.mts": literal("claude/hooks/privacy-boundary-guard.mts", "PRIVATE_PATTERN"),
    "claude/hooks/lib/dispatch-policy.mts": literal("claude/hooks/lib/dispatch-policy.mts", "PRIVACY_PATTERN"),
    "codex/hooks/privacy-boundary-guard.mts": literal("codex/hooks/privacy-boundary-guard.mts", "PRIVATE"),
    "claude/hooks/lib/denial-journal.mts": literal("claude/hooks/lib/denial-journal.mts", "PRIVATE_MARKER_PATTERN"),
  };
  for (const [rel, copy] of Object.entries(copies)) {
    assert.deepEqual(copy, { source: PRIVATE_MARKER_PATTERN.source, flags: PRIVATE_MARKER_PATTERN.flags }, rel);
  }
});

// Review P3-11: the worker key is copied where the static-import rules forbid importing the lib;
// every copy, assigned or tested inline, keeps the lib's source and flags.
// codex/hooks/hook-adapter.mts holds no literal; codex/hooks/hook-adapter-agent-leaf.test.mts pins it to AGENT_KEY.
test("the four agent key copies have one source and one flag set", () => {
  const copies = ["claude/hooks/lib/denial-journal.mts", "claude/hooks/guard-dispatch.mts", "claude/kherep/hook-runtime/entry.mts",
    "codex/hooks/shell-checks.mts"];
  for (const rel of copies) {
    const found = [...source(rel).matchAll(/(?:AGENT_KEY = |!)\/(\^\[[^\]\n]*\][^/\n]*\$)\/([a-z]*)/g)];
    assert.ok(found.length >= 1, `${rel} holds an agent key literal`);
    for (const match of found) assert.deepEqual({ source: match[1], flags: match[2] }, { source: AGENT_KEY.source, flags: AGENT_KEY.flags }, rel);
  }
});

test("the journal writers name no synchronous write call", () => {
  const writers = [
    "claude/hooks/lib/denial-journal.mts",
    "claude/hooks/denied-calls-delivered.mts",
    "claude/hooks/guard-dispatch.mts",
    "claude/kherep/hook-runtime/entry.mts",
    "codex/hooks/hook-adapter.mts",
    "codex/hooks/shell-checks.mts",
  ];
  for (const rel of writers) {
    assert.doesNotMatch(source(rel), /\b(?:appendFileSync|writeFileSync|renameSync|unlinkSync|openSync|writeSync|mkdirSync)\b/, rel);
  }
});
