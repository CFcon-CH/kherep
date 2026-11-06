import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { promptContext } from "./research-first.mts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-research-first-"));
const config = path.join(tmp, "confluence.json");
fs.writeFileSync(config, JSON.stringify({ spaceKey: "KB" }));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("adds a private-safe prompt with a quoted Codex broker path and repository graph instruction", () => {
  const workspace = "D:/Work Space ' and $(literal)";
  const text = promptContext(
    { cwd: `${workspace}/repo`, prompt: "Example Corp secret" },
    { KHEREP_WORKSPACE: workspace }, config,
    (candidate) => candidate === `${workspace}/repo/.git`,
  );
  assert.match(text, /^RESEARCH FIRST/);
  assert.match(text, /node 'D:\/Work Space '' and \$\(literal\)\/tools\/atl-confluence\.mts' search --space KB/);
  assert.match(text, /mcp__codebase[_-]memory[_-]mcp/);
  assert.match(text, /\[research: none - <reason>\]/);
  assert.doesNotMatch(text, /Example Corp|secret/);
});

test("omits graph outside a repository and emits nothing outside scope or when scope is disabled", () => {
  const env = { KHEREP_WORKSPACE: "D:/Work" };
  assert.doesNotMatch(promptContext({ cwd: "D:/Work/notes" }, env, config, () => false), /code graph/i);
  assert.equal(promptContext({ cwd: "D:/Elsewhere" }, env, config, () => false), "");
  assert.equal(promptContext({ cwd: "D:/Work" }, { KHEREP_WORKSPACE: "" }, config, () => false), "");
  assert.equal(promptContext("bad", env, config, () => false), "");
  assert.match(promptContext({ cwd: "D:/Work/repo///" }, { KHEREP_WORKSPACE: "D:/Work///" }, config, () => false), /^RESEARCH FIRST/);
  assert.equal(promptContext({ cwd: "D:/Work-copy///" }, { KHEREP_WORKSPACE: "D:/Work///" }, config, () => false), "");
});

test("guides a blocked broker read through scoped approval without granting network access", () => {
  const text = promptContext(
    { cwd: "D:/Work/repo", prompt: "PRIVATE-PROMPT-MARKER" },
    { KHEREP_WORKSPACE: "D:/Work" }, config, () => false,
  );
  assert.match(text, /read-only.*broker.*search/i);
  assert.match(text, /sandbox_permissions.*require_escalated/);
  assert.match(text, /codex exec --approve-for-me/);
  assert.match(text, /reviewed/);
  assert.match(text, /unavailable.*UNKNOWN/);
  assert.doesNotMatch(text, /PRIVATE-PROMPT-MARKER|network_access\s*=\s*true|dangerously-bypass/);
});

test("invalid configuration never echoes its space value", () => {
  const bad = path.join(tmp, "bad.json");
  fs.writeFileSync(bad, JSON.stringify({ spaceKey: "KB; LEAK-MARKER" }));
  const text = promptContext({ cwd: "D:/Work" }, { KHEREP_WORKSPACE: "D:/Work" }, bad, () => false);
  assert.match(text, /<spaceKey from/);
  assert.doesNotMatch(text, /LEAK-MARKER/);
});

test("the executable hook emits context in scope and stays silent on malformed input", () => {
  const hook = path.join(import.meta.dirname, "research-first.mts");
  const env = { ...process.env, KHEREP_WORKSPACE: "D:/Work" };
  const run = (input: string) => spawnSync(process.execPath, [hook], { input, encoding: "utf8", env });
  const inside = run(JSON.stringify({ cwd: "D:/Work/repo" }));
  assert.equal(inside.status, 0);
  assert.match(inside.stdout, /RESEARCH FIRST/);
  const broken = run("not-json");
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, "");
});
