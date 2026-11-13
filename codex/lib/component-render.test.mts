import assert from "node:assert/strict";
import { test } from "node:test";

import { adaptCodexText, adaptSkillText, parseFrontmatter } from "./component-render.mts";

test("maps Claude layout concepts to their real Codex destinations", () => {
  const source = [
    "Read ~/.claude/teams/kherep/ROUTING.md",
    "Rules: C:\\Users\\ExampleUser\\.claude\\CLAUDE.md",
    "Override: .claude.local.md",
  ].join("\n");
  const adapted = adaptCodexText(source);
  assert.match(adapted, /~\/\.codex\/orchestra\/ROUTING\.md/);
  assert.equal((adapted.match(/~\/\.codex\/orchestra\/ROUTING\.md/g) || []).length, 1);
  assert.match(adapted, /~\/\.codex\/AGENTS\.md/);
  assert.match(adapted, /AGENTS\.override\.md/);
  assert.doesNotMatch(adapted, /\.codex\/teams|~\/\.codex\\|\.claude\.local/);
});

test("projected skills report unconfigured memory and require explicit native policy selection", () => {
  const source = [
    "---",
    "name: memory-check",
    "description: Use when checking shared memory.",
    "---",
    "",
    "# Memory check",
  ].join("\n");
  const adapted = adaptSkillText(source);
  assert.match(adapted, /Central memory is unconfigured/);
  assert.match(adapted, /stop when an operation requires an unavailable memory service/);
  assert.doesNotMatch(adapted, /Central Brain MCP/);
  assert.match(adapted, /raw Claude sessions, transcripts, configuration, plugins, or hooks remain forbidden/);
  assert.doesNotMatch(adapted, /Never access or modify Claude-owned configuration, plugins, hooks, sessions, or memory/);
});

// Issue #906: a field value is the rest of its line after the blanks behind the colon.
test("frontmatter values start after the blanks, and a line break inside a value drops the field", () => {
  assert.deepEqual(parseFrontmatter("---\nname:   \"x\"  \ndescription:\nkey-1: a: b\n---\nbody").metadata,
    { name: "x", description: "", "key-1": "a: b" });
  assert.deepEqual(parseFrontmatter("---\nname: a\rb\n---\n").metadata, {});
  const started = performance.now();
  assert.deepEqual(parseFrontmatter(`---\nname:${" ".repeat(50_000)}x\ry\n---\n`).metadata, {});
  assert.ok(performance.now() - started < 200, "linear on a long blank run");
});
