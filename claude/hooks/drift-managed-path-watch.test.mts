#!/usr/bin/env node
// Contract test for drift-managed-path-watch. Drives the hook exactly as Claude
// Code does: JSON on stdin, JSON-or-nothing on stdout, always exit 0.
//
// OP-1138. Ported from the hand-rolled check() harness to node:test, like the
// other suites of this wave. Every assertion of the JavaScript version is kept;
// what disappeared is the private pass/fail counter and the repetition around
// each single check. The exit code is now asserted on EVERY run instead of
// being folded into a sentinel string: these hooks are fail-open, so an
// internal error has to end as silence and never as a crash.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const HOOK = path.join(import.meta.dirname, "drift-managed-path-watch.mts");
const REPO = path.resolve(import.meta.dirname, "..", "..");
const DRIFT_SCRIPT = path.join(REPO, "bootstrap", "drift-check.sh");
const REAL_MANIFEST = path.join(REPO, "bootstrap", "manifest", "files.txt");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "drift-managed-"));
// Scope is configured explicitly; fixture directory names carry no authority.
const WS = path.join(TMP, "ws", "workspace");
const HOME = path.join(TMP, "home", ".claude");
// The hook reads the manifest out of the checkout the workspace points at, so
// the fixture mirrors the real repo layout with the real manifest content.
const FIXTURE_MANIFEST = path.join(WS, "kherep", "bootstrap", "manifest", "files.txt");
fs.mkdirSync(path.dirname(FIXTURE_MANIFEST), { recursive: true });
fs.mkdirSync(path.join(WS, "kherep", "claude", "hooks"), { recursive: true });
fs.copyFileSync(REAL_MANIFEST, FIXTURE_MANIFEST);
fs.mkdirSync(HOME, { recursive: true });
after(() => {
  try { fs.rmSync(TMP, { force: true, recursive: true }); } catch { /* best effort */ }
});

interface RunOptions {
  cwd?: string;
  workspace?: string;
  raw?: string;
  tool?: string;
}

interface HookOutput {
  hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  systemMessage?: string;
}

function run(filePath: string | undefined, options: RunOptions = {}): string {
  const payload = {
    hook_event_name: "PostToolUse",
    session_id: "test",
    cwd: options.cwd ?? WS,
    tool_name: options.tool ?? "Edit",
    tool_input: { file_path: filePath },
  };
  const result = spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    env: { ...process.env, KHEREP_WORKSPACE: options.workspace ?? WS, CLAUDE_HOME: HOME },
    input: options.raw ?? JSON.stringify(payload),
    windowsHide: true,
  });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function contextOf(out: string): string | null {
  if (!out.trim()) return null;
  try {
    return (JSON.parse(out) as HookOutput).hookSpecificOutput?.additionalContext ?? null;
  } catch {
    return null;
  }
}

const names = (filePath: string, source: string): boolean =>
  Boolean(contextOf(run(filePath))?.includes(source));

// "did the hook say anything at all", for the cases where the source name is
// asserted elsewhere and only recognition is under test.
const fires = (filePath: string, options?: RunOptions): boolean => Boolean(contextOf(run(filePath, options)));

test("a managed live path names its versioned source", () => {
  const pairs: [string, string][] = [
    [path.join(WS, "CLAUDE.md"), "claude/CLAUDE.project.md"],
    [path.join(HOME, "CLAUDE.md"), "claude/CLAUDE.user.md"],
    [path.join(HOME, "hooks", "commit-guard.mts"), "claude/hooks/commit-guard.mts"],
    // A nested manifest entry keeps its full relative path.
    [path.join(HOME, "hooks", "lib", "workspace-scope.mts"), "claude/hooks/lib/workspace-scope.mts"],
    // skills/codebase-memory is a directory entry: drift-check.sh walks it with
    // cmp_tree, so a file below it is managed too and must name its own source
    // file rather than the directory.
    [path.join(HOME, "skills", "codebase-memory", "SKILL.md"), "claude/skills/codebase-memory/SKILL.md"],
    // The live name differs from the source it is rendered from.
    [path.join(HOME, "settings.json"), "claude/settings.user.json"],
    // The Jira brokers: each names its own canonical source, not a shared one.
    [path.join(WS, "tools", "atl-jira.mts"), "modules/atl-jira-brokers/atl-jira.mts"],
    [path.join(WS, "tools", "atl-jira-ccoder.mts"), "modules/atl-jira-brokers/atl-jira-ccoder.mts"],
    [path.join(WS, "tools", "atlassian-credentials.mts"), "modules/atl-jira-brokers/atlassian-credentials.mts"],
    [path.join(WS, "tools", "atlassian-cli-args.mts"), "modules/atl-jira-brokers/atlassian-cli-args.mts"],
    [path.join(WS, "tools", "jira-adf.mts"), "modules/atl-jira-brokers/jira-adf.mts"],
    [path.join(WS, "tools", "jira-transition-guard.mts"), "modules/atl-jira-brokers/jira-transition-guard.mts"],
    // OP-1405. The Confluence broker, installed into the same flat tools
    // directory and therefore versioned in the Jira broker directory.
    [path.join(WS, "tools", "atl-confluence.mts"), "modules/atl-jira-brokers/atl-confluence.mts"],
    [path.join(WS, "tools", "atl-confluence-ccoder.mts"), "modules/atl-jira-brokers/atl-confluence-ccoder.mts"],
    [path.join(WS, "tools", "confluence-contract.mts"), "modules/atl-jira-brokers/confluence-contract.mts"],
    [path.join(WS, "tools", "confluence-content.mts"), "modules/atl-jira-brokers/confluence-content.mts"],
    [path.join(WS, "tools", "confluence-session.mts"), "modules/atl-jira-brokers/confluence-session.mts"],
  ];
  for (const [live, source] of pairs) assert.ok(names(live, source), `${live} does not name ${source}`);
});

// OP-1425. The workspace rule files belong to the operator; only the block is Kherep's.
test("a workspace rule file says that only its block is managed", () => {
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const context = contextOf(run(path.join(WS, name))) ?? "";
    assert.match(context, /kherep-project-rules/, `${name} does not name the block`);
    assert.match(context, /operator content and never drift/);
  }
  assert.doesNotMatch(contextOf(run(path.join(HOME, "CLAUDE.md"))) ?? "", /kherep-project-rules/);
});

// Issue #436. install.sh renders the intercom command into CLAUDE.md and the
// Kherep routing file, so like settings.json they are built from their source.
test("a file install.sh renders says the edit belongs in its source", () => {
  for (const [live, source] of [[path.join(HOME, "CLAUDE.md"), "claude/CLAUDE.user.md"],
    [path.join(HOME, "teams", "kherep", "ROUTING.md"), "claude/teams/kherep/ROUTING.md"],
    [path.join(HOME, "settings.json"), "claude/settings.user.json"]]) {
    const context = contextOf(run(live)) ?? "";
    assert.ok(context.includes(`kherep/${source}\n`), `${live}: ${context}`);
    assert.match(context, /BUILT from that source/, live);
  }
  assert.doesNotMatch(contextOf(run(path.join(HOME, "hooks", "commit-guard.mts"))) ?? "", /BUILT/);
});

// Issue #737. install.sh renders model and effort into the installed agents
// from the policy files, so those two lines belong in the user policy file.
test("an installed agent names the user policy file for model and effort", () => {
  const context = contextOf(run(path.join(HOME, "agents", "claude-obs.md"))) ?? "";
  assert.ok(context.includes("kherep/claude/agents/claude-obs.md\n"), context);
  assert.match(context, /model-policy\.user\.json/);
  assert.doesNotMatch(context, /Carry this change into the repo source/);
});

test("backslashes, upper case and a . segment still match", () => {
  const shouted = path.join(HOME, "HOOKS", "Commit-Guard.mts").replace(/\//g, "\\").toUpperCase();
  assert.ok(names(shouted, "claude/hooks/"), "a shouted Windows path is not recognised");
  assert.ok(names(path.join(HOME, "hooks", ".", "commit-guard.mts"), "claude/hooks/commit-guard.mts"));
});

test("an unmanaged path stays silent", () => {
  assert.equal(contextOf(run(path.join(WS, "some-app", "src", "index.js"))), null, "unmanaged repo file");
  assert.equal(contextOf(run(path.join(HOME, "not-managed", "x.js"))), null, "unmanaged file below CLAUDE_HOME");
  // The repo source itself is not a live target.
  assert.equal(contextOf(run(path.join(WS, "kherep", "claude", "CLAUDE.project.md"))), null, "repo source");
  const outside = { cwd: "C:/Users/Example/Documents" };
  assert.equal(contextOf(run(path.join(HOME, "CLAUDE.md"), outside)), null, "out-of-scope cwd");
  assert.equal(contextOf(run(path.join(HOME, "CLAUDE.md"), { tool: "Bash" })), null, "non-write tool");
});

test("malformed input stays silent and exits 0", () => {
  assert.equal(run(undefined, { raw: "not json" }).trim(), "");
  assert.equal(run(undefined, { raw: "" }).trim(), "");
  assert.equal(run(undefined, { raw: "null" }).trim(), "", "a payload that parses to null");
  assert.equal(run(undefined).trim(), "", "a payload without file_path");
});

test("Write and MultiEdit are covered too", () => {
  assert.ok(fires(path.join(HOME, "CLAUDE.md"), { tool: "Write" }));
  assert.ok(fires(path.join(HOME, "CLAUDE.md"), { tool: "MultiEdit" }));
});

interface Invocation {
  kind: string;
  live: string;
}

// Minimal argv splitter: the script only ever passes double-quoted words here.
function argsOf(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2]);
  return out;
}

function invocationsOf(script: string): Invocation[] {
  const found: Invocation[] = [];
  for (const line of script.replace(/\\\r?\n\s*/g, " ").split(/\r?\n/)) {
    const m = /^\s*(cmp_file|cmp_tree|cmp_block|cmp_rendered|cmp_agent)\s+(.+)$/.exec(line);
    if (!m) continue;
    const args = argsOf(m[2]);
    if (args.length < 3) continue; // function definition / malformed - not a call
    found.push({ kind: m[1], live: args[2] });
  }
  return found;
}

// EQUIVALENCE with bootstrap/drift-check.sh. The two path maps live in
// different languages and would drift apart silently, so this parses the
// literal cmp_file/cmp_tree invocations out of the shell script and asserts the
// hook recognises every live target they name.
test("every literal cmp_ target of drift-check.sh is recognised", () => {
  const resolvable: Invocation[] = [];
  const generic = new Set<string>();
  for (const inv of invocationsOf(fs.readFileSync(DRIFT_SCRIPT, "utf8"))) {
    const live = inv.live.replace("$CLAUDE_HOME", HOME).replace("$WS", WS);
    if (live.includes("$")) generic.add(inv.live);
    else resolvable.push({ ...inv, live });
  }

  // Anti-vacuity: if the parser stops finding calls the assertions below would
  // all pass trivially, so the floor is asserted explicitly. 8 literal live
  // targets as of 2026-08-06 (settings.json, CLAUDE.md, 4x kherep/*, 2x project).
  assert.ok(resolvable.length >= 8, `the parser found only ${resolvable.length} literal cmp_ invocations`);
  // The generic calls are the manifest-driven loop and cmp_tree's own recursion.
  // Any NEW variable-driven pair shows up here and fails loudly instead of being
  // skipped, which is what keeps this test honest.
  assert.deepEqual([...generic].sort(), ["$live", "$live_dir/$sub"]);

  for (const inv of resolvable) {
    const label = inv.live.replace(HOME, "$CLAUDE_HOME").replace(WS, "$WS");
    assert.ok(fires(inv.live), `hook does not recognise ${inv.kind} target ${label}`);
    if (inv.kind !== "cmp_tree") continue;
    assert.ok(fires(path.join(inv.live, "nested", "file.js")), `hook does not recognise a file below ${label}`);
  }

  // Discriminator: the recognition assertions above would be worthless if the
  // hook simply answered yes to everything below CLAUDE_HOME.
  const invented = path.join(HOME, `definitely-not-managed-${Date.now()}`, "x.txt");
  assert.equal(contextOf(run(invented)), null, "recognition is blanket-yes, not discriminating");
});

test("every manifest entry is recognised", () => {
  const entries = fs.readFileSync(REAL_MANIFEST, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  assert.ok(entries.length > 0, "the manifest read empty - a loop over nothing would prove nothing");
  const unrecognised = entries.filter((rel) => !fires(path.join(HOME, rel)));
  assert.deepEqual(unrecognised, [], `unrecognised manifest entries: ${unrecognised.join(", ")}`);
});

test("a workspace without a checkout keeps the non-manifest pairs and drops the rest", () => {
  const bare = path.join(TMP, "bare", "workspace");
  fs.mkdirSync(bare, { recursive: true });
  assert.ok(fires(path.join(HOME, "CLAUDE.md"), { cwd: bare, workspace: bare }), "the fixed pairs need no checkout");
  assert.equal(contextOf(run(path.join(HOME, "hooks", "commit-guard.mts"), { cwd: bare, workspace: bare })), null);
});
