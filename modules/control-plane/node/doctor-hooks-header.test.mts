// Issue #906. A Codex table header is read as its bracket content, trimmed in code,
// instead of a lazy group between two whitespace runs that backtracked cubically.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkHooks } from "./doctor-hooks.mts";

function files(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-doctor-header-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "checkout");
  const hooks = path.join(repo, "modules", "control-plane", "node");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "deliver-hook.mts"), "");
  const command = `command = ${JSON.stringify(`node "${path.join(hooks, "deliver-hook.mts")}"`)}`;
  return { repo, command, claude: path.join(root, "settings.json"), codex: path.join(root, "config.toml") };
}

// How many delivery hooks the check reads from a Codex config.
function delivered(f: ReturnType<typeof files>, lines: string[]): number {
  fs.writeFileSync(f.codex, `${lines.join("\n")}\n`);
  const scan = checkHooks({ claude: f.claude, codex: f.codex }, f.repo).codex as { deliver?: number } | undefined;
  return scan?.deliver ?? -1;
}

test("hooks table headers are read with their bracket content trimmed", (t) => {
  const f = files(t);
  for (const header of ["[[hooks.PostToolUse]]", "  [[ hooks.PostToolUse.hooks ]]  ", "[hooks.PostToolUse]"]) {
    assert.equal(delivered(f, [header, f.command]), 1, header);
  }
});

test("a header naming another table leaves the hooks table, a line that is no header does not", (t) => {
  const f = files(t);
  for (const header of ["[[]", "[ ]", "[other]"]) assert.equal(delivered(f, ["[[hooks.Stop]]", header, f.command]), 0, header);
  for (const line of ["[]", "[a] b"]) assert.equal(delivered(f, ["[[hooks.Stop]]", line, f.command]), 1, line);
});

test("a long header line is read in linear time", (t) => {
  const f = files(t);
  const line = `[${" ".repeat(50_000)}a${" ".repeat(50_000)}x`;
  const started = performance.now();
  assert.equal(delivered(f, ["[[hooks.Stop]]", line, f.command]), 1);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)} ms`);
});
