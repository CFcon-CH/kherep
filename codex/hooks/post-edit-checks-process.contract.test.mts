import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { copyAdapter, copySource } from "./hook-adapter.fixture.mts";

const HERE = import.meta.dirname;
const SOURCE = path.join(HERE, "post-edit-checks.mts");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "post-edit-process-"));
const HOOKS = path.join(ROOT, "hooks $(touch sentinel-file) ; literal");
const TRACE = path.join(ROOT, "child-trace.jsonl");
const SENTINEL = path.join(ROOT, "sentinel-file");
const WATCHERS = ["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge"];
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function materialize(): string {
  assert.ok(fs.existsSync(SOURCE), "the fixed post-edit dispatcher must exist");
  fs.mkdirSync(HOOKS, { recursive: true });
  for (const dependency of [
    "post-edit-checks.mts", "post-edit-tool-calls.mts", "research-exec-parser.mts",
  ]) {
    copySource(dependency, path.join(HOOKS, dependency));
  }
  copyAdapter(HOOKS);
  for (const watcher of WATCHERS) {
    fs.writeFileSync(path.join(HOOKS, `${watcher}.mts`), [
      "import fs from 'node:fs';",
      "const payload = JSON.parse(fs.readFileSync(0, 'utf8'));",
      `fs.appendFileSync(process.env.KHEREP_TEST_CHILD_TRACE, JSON.stringify({ watcher: ${JSON.stringify(watcher)}, tool_name: payload.tool_name, tool_input: payload.tool_input }) + '\\n');`,
    ].join("\n"));
  }
  return path.join(HOOKS, "post-edit-checks.mts");
}

function run(payload: Record<string, unknown>): Record<string, unknown>[] {
  fs.writeFileSync(TRACE, "");
  const result = spawnSync(process.execPath, [materialize()], {
    cwd: ROOT,
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, KHEREP_TEST_CHILD_TRACE: TRACE },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(fs.existsSync(SENTINEL), false, "metacharacters stayed data");
  return fs.readFileSync(TRACE, "utf8").split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const PATCH = [
  "*** Begin Patch",
  "*** Update File: src/one $(touch payload-sentinel).mts",
  "*** Add File: src/two ; literal.mts",
  "*** Delete File: src/three | literal.mts",
  "*** End Patch",
].join("\n");

test("measures the routine read and direct Write/MultiEdit child counts", () => {
  assert.equal(run({
    tool_name: "functions.exec",
    tool_input: 'await tools.mcp__codebase_memory_mcp__search_graph({query:"hooks"});',
  }).length, 0);

  for (const payload of [
    { tool_name: "Write", tool_input: { file_path: "/work/a.mts", content: "next" } },
    { tool_name: "MultiEdit", tool_input: { file_path: "/work/b.mts", edits: [{ new_string: "next" }] } },
  ]) {
    const records = run(payload);
    assert.equal(records.length, 4);
    assert.deepEqual(records.map(({ watcher }) => watcher), WATCHERS);
  }
});

test("measures twelve children for a direct functions.exec apply_patch wrapper", () => {
  const records = run({
    cwd: ROOT,
    tool_name: "functions.exec",
    tool_input: `await tools.apply_patch(${JSON.stringify(PATCH)});`,
  });
  assert.equal(records.length, 12);
  assert.deepEqual(new Set(records.map(({ tool_name }) => tool_name)), new Set(["Edit"]));
  for (const target of [
    path.resolve(ROOT, "src/one $(touch payload-sentinel).mts"),
    path.resolve(ROOT, "src/two ; literal.mts"),
    path.resolve(ROOT, "src/three | literal.mts"),
  ]) {
    assert.equal(records.filter(({ tool_input }) =>
      (tool_input as { file_path?: unknown }).file_path === target).length, 4);
  }
  assert.equal(fs.existsSync(path.join(ROOT, "payload-sentinel")), false);
});

test("measures twelve children for three recognized patch targets and keeps paths as data", () => {
  const records = run({ cwd: ROOT, tool_name: "apply_patch", tool_input: PATCH });
  assert.equal(records.length, 12);
  for (const target of [
    path.resolve(ROOT, "src/one $(touch payload-sentinel).mts"),
    path.resolve(ROOT, "src/two ; literal.mts"),
    path.resolve(ROOT, "src/three | literal.mts"),
  ]) {
    assert.equal(records.filter(({ tool_input }) =>
      (tool_input as { file_path?: unknown }).file_path === target).length, 4);
  }
  assert.equal(fs.existsSync(path.join(ROOT, "payload-sentinel")), false);
});

test("measures zero children for Bash fallbacks and twelve for three extracted edit targets", () => {
  const unknown = run({
    cwd: ROOT, tool_name: "functions.exec", tool_input: "await tools.future_tool({value: 1});",
  });
  assert.equal(unknown.length, 0);

  const mixed = run({
    cwd: ROOT,
    tool_name: "functions.exec",
    tool_input: `await tools.future_tool({}); await tools.apply_patch(${JSON.stringify(PATCH)});`,
  });
  assert.equal(mixed.length, 12);
  assert.deepEqual(new Set(mixed.map(({ tool_name }) => tool_name)), new Set(["Edit"]));

  for (const malformed of [
    String.raw`await tools.mcp__codebase_memory_mcp__search_graph({query:"\x"});`,
    String.raw`await tools.mcp__codebase_memory_mcp__search_graph({query:"\uZZZZ"});`,
    'await tools.mcp__codebase_memory_mcp__search_graph({`query`:"hooks"});',
  ]) {
    const records = run({ cwd: ROOT, tool_name: "functions.exec", tool_input: malformed });
    assert.equal(records.length, 0, malformed);
  }
});
