// Issue #237 batch 2. Hosts carry legacy groups that run the old .js guards
// under their own matchers. The install unwires every command whose script is
// in retired.txt (retired-hooks.mts), so after the upgrade only the managed .mts
// entry from claude/settings.user.json runs each guard. This proves that no
// tool loses a guard on the way: for every legacy group, the template wires the
// same guard at the same event under a matcher that covers every tool the legacy
// matcher covered.
//
// Matcher semantics follow the Claude Code hooks reference ("Matcher patterns",
// https://code.claude.com/docs/en/hooks): "*", "" or an omitted matcher match
// all; a value of only letters, digits, _, -, spaces, "," and "|" is a list of
// exact names; anything else is an unanchored JavaScript regular expression.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repo = path.resolve(import.meta.dirname, "..");

interface Group { matcher?: string; hooks?: { command?: unknown }[] }
const template = JSON.parse(fs.readFileSync(path.join(repo, "claude", "settings.user.json"), "utf8")) as
  { hooks: Record<string, Group[]> };

const matchesAll = (matcher: string | undefined): boolean => matcher === undefined || matcher === "" || matcher === "*";
const exactNames = (matcher: string): string[] | undefined =>
  /^[A-Za-z0-9_\- ,|]+$/.test(matcher) ? matcher.split(/[|,]/).map((name) => name.trim()) : undefined;

function matcherMatches(matcher: string | undefined, tool: string): boolean {
  if (matchesAll(matcher)) return true;
  const names = exactNames(matcher!);
  return names ? names.includes(tool) : new RegExp(matcher!).test(tool);
}

// True only when every tool the legacy matcher matches is matched by the
// template matcher. A regular-expression legacy matcher matches an unbounded
// set of names, so only a match-all or the identical matcher covers it.
function covers(templateMatcher: string | undefined, legacyMatcher: string | undefined): boolean {
  if (matchesAll(templateMatcher)) return true;
  if (matchesAll(legacyMatcher)) return false;
  const names = exactNames(legacyMatcher!);
  if (names) return names.every((name) => matcherMatches(templateMatcher, name));
  return templateMatcher === legacyMatcher;
}

// The hook files a command names, in order. Issue #507: a PreToolUse guard is
// an argument of guard-dispatch.mts, not the end of its own command.
const hookFiles = (command: unknown): string[] =>
  [...String(command).matchAll(/\/hooks\/([\w.-]+\.(?:js|mts))"/g)].map((match) => match[1]!);

// Every template matcher that wires <hook> at <event>. Issue #808: commit-guard and
// deploy-guard run under two groups, "Bash" and "PowerShell".
function templateMatchers(event: string, hook: string): (string | undefined)[] {
  const found = (template.hooks[event] ?? []).filter((group) =>
    (group.hooks ?? []).some((entry) => hookFiles(entry.command).includes(hook)));
  assert.ok(found.length > 0, `${hook} is wired under ${event}`);
  return found.map((group) => group.matcher);
}

// The template matcher that wires <hook> at <event>, exactly once.
function templateMatcher(event: string, hook: string): string | undefined {
  const found = templateMatchers(event, hook);
  assert.equal(found.length, 1, `${hook} is wired once under ${event}`);
  return found[0];
}

// True when the template matchers together cover every tool the legacy matcher matches.
function coveredByAny(templates: (string | undefined)[], legacyMatcher: string | undefined): boolean {
  if (templates.some((matcher) => covers(matcher, legacyMatcher))) return true;
  const names = matchesAll(legacyMatcher) ? undefined : exactNames(legacyMatcher!);
  return Boolean(names && names.every((name) => templates.some((matcher) => matcherMatches(matcher, name))));
}

// Every legacy group a host may still carry for a batch-2 guard: the groups
// the hosts carry (issue #237, batch 2) and the template's own .js
// wiring before this change. All are PreToolUse.
const LEGACY: { guard: string; matcher: string }[] = [
  { guard: "privacy-boundary-guard", matcher: "Read|Grep|Glob|Edit|Write|MultiEdit|Bash" },
  { guard: "privacy-boundary-guard", matcher: "Agent|Task|Workflow|WebSearch|WebFetch|mcp__.*" },
  { guard: "privacy-boundary-guard", matcher: "" },
  { guard: "secret-output-guard", matcher: "Bash|PowerShell" },
  { guard: "secret-output-guard", matcher: "" },
  { guard: "playwright-file-guard", matcher: "mcp__plugin_playwright_playwright__browser_navigate" },
  { guard: "playwright-file-guard", matcher: "" },
  { guard: "dispatch-contract-guard", matcher: "Agent|Task" },
  { guard: "commit-guard", matcher: "Bash" },
  { guard: "deploy-guard", matcher: "Bash" },
];

test("the matcher model follows the documented examples", () => {
  assert.ok(matcherMatches("Bash", "Bash"));
  assert.ok(!matcherMatches("Bash", "BashOutput"));
  assert.ok(matcherMatches("Edit|Write", "Write") && matcherMatches("Edit, Write", "Edit"));
  assert.ok(matcherMatches("Edit.*", "NotebookEdit"));
  assert.ok(matcherMatches("mcp__memory__.*", "mcp__memory__create_entities"));
  assert.ok(!matcherMatches("mcp__memory", "mcp__memory__create_entities"));
  assert.ok(matcherMatches("", "AnyTool") && matcherMatches("*", "AnyTool") && matcherMatches(undefined, "AnyTool"));
  // The coverage relation is conservative: a regex is never assumed covered by a list.
  assert.ok(!covers("Agent|Task", "Agent|Task|mcp__.*"));
  assert.ok(!covers("Bash", "Bash|PowerShell"));
  assert.ok(covers("Bash|PowerShell", "Bash"));
  // Issue #808: two exact-name groups together cover a list neither covers alone.
  assert.ok(coveredByAny(["Bash", "PowerShell"], "Bash|PowerShell"));
  assert.ok(!coveredByAny(["Bash"], "Bash|PowerShell"));
  assert.ok(!coveredByAny(["Bash", "PowerShell"], "mcp__.*") && !coveredByAny(["Bash", "PowerShell"], ""));
});

for (const legacy of LEGACY) {
  test(`${legacy.guard}.mts covers the legacy PreToolUse "${legacy.matcher}" group`, () => {
    const current = templateMatchers("PreToolUse", `${legacy.guard}.mts`);
    assert.ok(coveredByAny(current, legacy.matcher),
      `template matchers ${JSON.stringify(current)} do not cover legacy "${legacy.matcher}" for ${legacy.guard}`);
  });
}

// Issue #325. main-checkout-guard has no legacy group: it is new, and it has to
// see both shell tools. It gets its own group, so the "Bash" group keeps exactly
// commit-guard and deploy-guard and no matcher of an existing group changes.
test("main-checkout-guard.mts covers Bash and PowerShell in a group of its own", () => {
  const current = templateMatcher("PreToolUse", "main-checkout-guard.mts");
  assert.ok(matcherMatches(current, "Bash") && matcherMatches(current, "PowerShell"), `matcher "${current}"`);
  assert.ok(!matcherMatches(current, "Read"), `matcher "${current}" is limited to the shell tools`);
  const bash = template.hooks.PreToolUse!.filter((group) => group.matcher === "Bash");
  assert.equal(bash.length, 1);
  assert.deepEqual(bash[0]!.hooks!.flatMap((entry) => hookFiles(entry.command)),
    ["guard-dispatch.mts", "commit-guard.mts", "deploy-guard.mts"]);
});

// Issue #833. A further command of the shell tools; the group of #325 fits it, so
// no new group is added and no matcher changes.
test("module-label-guard.mts runs in the main-checkout group", () => {
  assert.equal(templateMatcher("PreToolUse", "module-label-guard.mts"), templateMatcher("PreToolUse", "main-checkout-guard.mts"));
  const group = template.hooks.PreToolUse!.filter((entry) => entry.matcher === "Bash|PowerShell");
  assert.equal(group.length, 1);
  assert.deepEqual(group[0]!.hooks!.flatMap((entry) => hookFiles(entry.command)),
    ["guard-dispatch.mts", "main-checkout-guard.mts", "module-label-guard.mts"]);
});

// Issue #808. Claude Code for Windows runs shell commands through the PowerShell tool;
// a commit or deploy there passed unguarded (the Windows guard canary measured ALLOWED).
// A group of its own beside the unchanged "Bash" group keeps every existing matcher.
test("commit-guard.mts and deploy-guard.mts run for PowerShell in a group of its own", () => {
  const groups = (matcher: string) => template.hooks.PreToolUse!.filter((group) => group.matcher === matcher);
  const files = (group: Group) => group.hooks!.flatMap((entry) => hookFiles(entry.command));
  assert.equal(groups("PowerShell").length, 1);
  assert.deepEqual(files(groups("PowerShell")[0]!), files(groups("Bash")[0]!));
  assert.deepEqual(groups("PowerShell")[0]!.hooks, groups("Bash")[0]!.hooks);
});

// Each shell tool runs each PreToolUse guard exactly once, commit-guard and deploy-guard included.
test("every shell tool wires each PreToolUse guard at most once and the commit and deploy guards exactly once", () => {
  const guards = new Set(template.hooks.PreToolUse!.flatMap((group) => (group.hooks ?? []).flatMap((entry) => hookFiles(entry.command))));
  guards.delete("guard-dispatch.mts");
  for (const tool of ["Bash", "PowerShell"]) {
    for (const guard of guards) {
      const count = template.hooks.PreToolUse!.filter((group) => matcherMatches(group.matcher, tool)
        && (group.hooks ?? []).some((entry) => hookFiles(entry.command).includes(guard))).length;
      const exact = guard === "commit-guard.mts" || guard === "deploy-guard.mts";
      assert.ok(exact ? count === 1 : count <= 1, `${tool} wires ${guard} ${count} times`);
    }
  }
});

test("no template entry wires a .js script", () => {
  const files = Object.values(template.hooks).flat().flatMap((group) => group.hooks ?? []).flatMap((h) => hookFiles(h.command));
  assert.deepEqual(files.filter((file) => file.endsWith(".js")), []);
});
