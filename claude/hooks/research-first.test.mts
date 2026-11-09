#!/usr/bin/env node
// Contract test for research-first.mts (OP-1440): in scope it adds the
// instruction, out of scope it says nothing, it never echoes the prompt, and it
// names the code graph only when the working directory is in a git repository.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { spaceKeyFrom } from "./lib/research-evidence.mts";
import { promptContext } from "./research-first.mts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "research-first-test-"));
const WORKSPACE = "/Users/tester/Work";
const ENV = { KHEREP_WORKSPACE: WORKSPACE };
const CONFIG = path.join(TMP, "confluence.json");
const REPO = `${WORKSPACE}/ForgeApps/app`;
const inRepo = (p: string) => p === `${REPO}/.git`;
const never = () => false;

fs.writeFileSync(CONFIG, JSON.stringify({ spaceKey: "KB", spaceId: "9001" }), "utf8");
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test("in scope: the instruction names the Brain search with the installed space key and the marker", () => {
  const text = promptContext({ cwd: `${WORKSPACE}/notes`, prompt: "secret Example Corp" }, ENV, CONFIG, never);
  assert.match(text, /^RESEARCH FIRST/);
  // Rendered like the allowlist entry, so the suggestion matches the allow rule.
  assert.ok(text.includes(`node ${path.resolve(WORKSPACE).replace(/\\/g, "/")}/tools/atl-confluence-ccoder.mts search --space KB --query "<terms>"`));
  assert.match(text, /\[research: none - <reason>\]/);
  assert.match(text, /privacy classification/);
  assert.doesNotMatch(text, /codebase-memory/, "no repository, no code graph line");
  assert.doesNotMatch(text, /Example Corp/, "the prompt is never echoed");
  assert.ok(text.split("\n").length <= 5, "the text stays short");
});

// Issue #13. Git Bash consumes the backslashes of a native Windows path, so the
// command uses forward slashes, the form the allow rule has on Windows.
test("on a Windows workspace the command uses forward slashes", () => {
  const text = promptContext({ cwd: "D:\\Workspaces\\kherep" }, { KHEREP_WORKSPACE: "D:\\Workspaces" }, CONFIG, never);
  const root = path.resolve("D:/Workspaces").replace(/\\/g, "/");
  assert.ok(text.includes(`node ${root}/tools/atl-confluence-ccoder.mts search --space KB`), text);
  assert.doesNotMatch(text, /\\/);
  if (process.platform === "win32") assert.ok(text.includes("node D:/Workspaces/tools/atl-confluence-ccoder.mts search"), text);
});

test("in a git repository the code graph comes first, worded for an unknown index", () => {
  const text = promptContext({ cwd: `${REPO}/src` }, ENV, CONFIG, inRepo);
  assert.match(text, /If it is indexed by codebase-memory, query the code graph \(mcp__codebase-memory-mcp__\*\) first/);
});

test("out of scope or malformed payloads add nothing", () => {
  assert.equal(promptContext({ cwd: "/Users/tester/elsewhere" }, ENV, CONFIG, never), "");
  assert.equal(promptContext("nope", ENV, CONFIG, never), "");
  assert.equal(promptContext(null, ENV, CONFIG, never), "");
});

test("a missing or odd space key becomes a pointer, never printed raw", () => {
  assert.match(spaceKeyFrom(path.join(TMP, "absent.json")), /<spaceKey from/);
  const odd = path.join(TMP, "odd.json");
  fs.writeFileSync(odd, JSON.stringify({ spaceKey: "KB; rm -rf /" }), "utf8");
  assert.match(spaceKeyFrom(odd), /<spaceKey from/);
});

function spawnHook(stdin: string, env: Record<string, string | undefined>) {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  if (!Object.hasOwn(env, "KHEREP_WORKSPACE")) delete merged.KHEREP_WORKSPACE;
  return spawnSync(process.execPath, [path.join(HERE, "research-first.mts")], { input: stdin, encoding: "utf8", env: merged });
}

test("as a hook: JSON additionalContext in scope, silence out of scope, exit 0 always", () => {
  const inside = spawnHook(JSON.stringify({ cwd: `${WORKSPACE}/x` }), ENV);
  assert.equal(inside.status, 0);
  const out = JSON.parse(inside.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /RESEARCH FIRST/);

  const outside = spawnHook(JSON.stringify({ cwd: "/Users/tester/elsewhere" }), ENV);
  assert.equal(outside.status, 0);
  assert.equal(outside.stdout, "");

  const broken = spawnHook("not-json", ENV);
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, "");
});
