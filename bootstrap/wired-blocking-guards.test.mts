// Issue #237, acceptance 4. The guards that emit a block decision still block
// after their move from .js to .mts, run exactly the way the installed settings
// run them: the command string from claude/settings.user.json, under the event
// it is wired to, with the Claude home placeholder resolved, executed through a
// shell. Since issue #507 a PreToolUse guard that is missing or cannot load
// denies the call instead of exiting without a decision (fail-open).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { syntaxVerdict } from "../claude/hooks/lib/hook-syntax.mts";
import { declareCopy } from "./coverage-copy-fixture.mts";

const repo = path.resolve(import.meta.dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wired-blocking-guards-"));
// Issue #507, part 2: every wired command runs through kherep/hook-runtime/entry.mts,
// which keeps its coordination state beside the hooks it admits. A copy of the
// checkout's hooks and runtime plays the Claude home, so no state lands in the checkout.
function claudeCopy(name: string, unchanged = true): string {
  const copy = path.join(TMP, name);
  fs.cpSync(path.join(repo, "claude", "hooks"), path.join(copy, "hooks"), { recursive: true });
  // The broken-guard case edits its copies and must remain undeclared.
  if (unchanged) declareCopy(path.join(repo, "claude", "hooks", "playwright-file-guard.mts"), path.join(copy, "hooks", "playwright-file-guard.mts"));
  fs.cpSync(path.join(repo, "claude", "kherep", "hook-runtime"), path.join(copy, "kherep", "hook-runtime"), { recursive: true });
  // Issue #737. The dispatch guard reads the installed shipped model policy.
  fs.copyFileSync(path.join(repo, "claude", "kherep", "model-policy.json"), path.join(copy, "kherep", "model-policy.json"));
  return copy.replace(/\\/g, "/");
}
const claudeSource = claudeCopy("claude");
const WORKSPACE = path.join(TMP, "workspace");
fs.mkdirSync(WORKSPACE, { recursive: true });
after(() => {
  try { fs.rmSync(TMP, { force: true, recursive: true }); } catch { /* best effort */ }
});

interface HookCommand { command?: unknown }
interface HookEntry { matcher?: string; hooks?: HookCommand[] }
interface Settings { hooks?: Record<string, HookEntry[]> }

const settings = JSON.parse(fs.readFileSync(path.join(repo, "claude", "settings.user.json"), "utf8")) as Settings;

interface Wired { event: string; matcher: string; command: string }

// The one wired command, in whichever event, that runs the named hook file.
function wiredCommand(hook: string): Wired {
  const found: Wired[] = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of groups) {
      for (const entry of group.hooks ?? []) {
        if (typeof entry.command === "string" && entry.command.includes(`/hooks/${hook}`)) {
          found.push({ event, matcher: group.matcher ?? "", command: entry.command });
        }
      }
    }
  }
  assert.equal(found.length, 1, `the settings template wires ${hook} exactly once`);
  return found[0]!;
}

function transcript(name: string, entries: unknown[]): string {
  const file = path.join(TMP, `${name}.jsonl`);
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return file;
}

const user = (text: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

interface Run { status: number | null; decision: unknown; permission: unknown; reason: unknown; context: unknown; stderr: string }

// Runs the wired command through a shell, the way Claude Code starts a hook.
// claudeHome replaces the placeholder (default: this checkout's claude/), so a
// test can point the same command at a copy with a broken guard.
function runWired(
  { event, command }: Wired, payload: Record<string, unknown>,
  claudeHome = claudeSource, env: Record<string, string | undefined> = {},
): Run {
  const resolved = command.replaceAll("__KHEREP_CLAUDE_HOME__", claudeHome);
  const result = spawnSync(resolved, {
    shell: true,
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: event, cwd: WORKSPACE, ...payload }),
    env: { ...process.env, KHEREP_WORKSPACE: WORKSPACE, ...env },
    windowsHide: true,
  });
  let output: { decision?: unknown; hookSpecificOutput?: Record<string, unknown> } = {};
  try {
    output = JSON.parse(result.stdout) ?? {};
  } catch { /* no JSON on stdout */ }
  return {
    status: result.status,
    decision: output.decision ?? null,
    permission: output.hookSpecificOutput?.permissionDecision ?? null,
    reason: output.hookSpecificOutput?.permissionDecisionReason ?? null,
    context: output.hookSpecificOutput?.additionalContext ?? null,
    stderr: result.stderr,
  };
}

// The two Stop guards read the Stop payload (stop_hook_active, the finished turn), so
// Stop is the only event they may be wired to (#254): under PreToolUse the
// CLQ gate would judge a turn that is still running and block a tool call.
// obs-result-check (#326) judges the observation agent's final message instead.
const GUARDS = [
  {
    hook: "clq-accept-gate.mts", event: "Stop", matcher: "",
    blocking: () => ({ transcript_path: transcript("clq", [
      user("baue das"),
      assistant("Dispatched: 1 agents\nOutcomes: kherep-builder[opus] -> added retry\nEvidence: npm test 3/3\nNext: ship"),
    ]) }),
  },
  { hook: "maestro-banner-gate.mts", event: "Stop", matcher: "",
    blocking: () => ({ transcript_path: transcript("banner", [user("wo stehen wir"), assistant("x".repeat(500))]) }) },
  { hook: "obs-result-check.mts", event: "SubagentStop", matcher: "claude-obs",
    blocking: () => ({ agent_type: "claude-obs", stop_hook_active: false, last_assistant_message: "OBS-RESULT: failed wrote 4 pages" }) },
];

for (const guard of GUARDS) {
  test(`${guard.hook} is wired under ${guard.event} as an .mts file that exists`, () => {
    const { event, matcher, command } = wiredCommand(guard.hook);
    assert.equal(event, guard.event, `${guard.hook} is wired under ${event}`);
    assert.equal(matcher, guard.matcher);
    assert.match(command, new RegExp(`^node "__KHEREP_CLAUDE_HOME__/kherep/hook-runtime/entry\\.mts" reader "__KHEREP_CLAUDE_HOME__/hooks/${guard.hook.replace(".", "\\.")}"$`));
    assert.ok(fs.existsSync(path.join(repo, "claude", "hooks", guard.hook)), `claude/hooks/${guard.hook} exists`);
  });

  test(`${guard.hook} still blocks a blocking turn through its wired command`, () => {
    const { status, decision, stderr } = runWired(wiredCommand(guard.hook), guard.blocking());
    assert.equal(status, 0, stderr);
    assert.equal(decision, "block", `no block decision; stderr: ${stderr}`);
  });

  test(`${guard.hook} does not block its own continuation through its wired command`, () => {
    const { status, decision } = runWired(wiredCommand(guard.hook), {
      ...guard.blocking(),
      stop_hook_active: true,
    });
    assert.equal(status, 0);
    assert.equal(decision, null);
  });
}

// Issue #237 batch 2: the six PreToolUse guards, and main-checkout-guard from #325.
// Four block with exit 2 and a stderr reason, three with a JSON deny on exit 0;
// guard-dispatch.mts (#507) turns exit 2 into a deny, stderr forwarded. Each case
// names a tool its wired matcher must cover, legacy groups included (guard-matcher-coverage).
type Mode = "exit2" | "deny" | "ask";
interface ToolCase { tool: string; input: Record<string, unknown> }
const bash = (command: string, tool = "Bash"): ToolCase => ({ tool, input: { command } });
// Issue #325. main-checkout-guard judges a real repository: a main checkout in
// the workspace whose default branch is origin/HEAD -> origin/main.
const MAIN_CHECKOUT = path.join(WORKSPACE, "repo");
fs.mkdirSync(MAIN_CHECKOUT);
for (const args of [["init", "-q", "-b", "main"], ["commit", "-q", "--allow-empty", "-m", "init"],
  ["update-ref", "refs/remotes/origin/main", "HEAD"], ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]]) {
  const result = spawnSync("git", ["-c", `core.hooksPath=${TMP}`, "-c", "user.name=Synthetic",
    "-c", "user.email=synthetic@example.com", ...args], { cwd: MAIN_CHECKOUT, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}
// Issue #833. A repository that opted in to the module label rule.
const LABELLED = path.join(WORKSPACE, "labelled");
fs.mkdirSync(path.join(LABELLED, ".github"), { recursive: true });
fs.mkdirSync(path.join(LABELLED, ".git"));
fs.writeFileSync(path.join(LABELLED, ".github", "module-labels.json"), JSON.stringify({ version: 1, repository: "example/project", labels: ["area"] }));
// Synthetic private markers, assembled so this file itself carries none.
const PRIVATE_FILE = `D:/Work-${"credentials"}/fixture.env`;
const PRIVATE_TAG = `<${"private"}>synthetic</${"private"}>`;
const PRETOOL_GUARDS: { hook: string; matcher: string; mode: Mode; blocking: ToolCase[]; benign: ToolCase }[] = [
  { hook: "commit-guard.mts", matcher: "Bash", mode: "exit2",
    blocking: [bash('git commit -m "em — dash"')], benign: bash('git commit -m "plain subject\n\nCo-Authored-By: bot"') },
  { hook: "deploy-guard.mts", matcher: "Bash", mode: "exit2",
    blocking: [bash("git push --force")], benign: bash("git push origin main") },
  { hook: "main-checkout-guard.mts", matcher: "Bash|PowerShell", mode: "exit2",
    blocking: [bash(`git -C "${MAIN_CHECKOUT}" switch feat`), bash(`git -C "${MAIN_CHECKOUT}" checkout -b feat`, "PowerShell")],
    benign: bash(`git -C "${MAIN_CHECKOUT}" switch main`) },
  { hook: "module-label-guard.mts", matcher: "Bash|PowerShell", mode: "exit2",
    blocking: [bash(`cd "${LABELLED}" && gh issue create -t x`), bash(`cd "${LABELLED}"; gh pr create --fill`, "PowerShell")],
    benign: bash(`cd "${LABELLED}" && gh issue create -t x --label area`) },
  { hook: "secret-output-guard.mts", matcher: "", mode: "exit2",
    blocking: [bash("printenv"), bash("Get-ChildItem Env:", "PowerShell")], benign: bash("git status") },
  { hook: "privacy-boundary-guard.mts", matcher: "", mode: "deny",
    blocking: [
      { tool: "Read", input: { file_path: PRIVATE_FILE } },
      { tool: "mcp__rovo__search", input: { query: PRIVATE_TAG } },
    ],
    benign: { tool: "Read", input: { file_path: path.join(WORKSPACE, "src", "a.ts") } } },
  { hook: "dispatch-contract-guard.mts", matcher: "Agent|Task", mode: "deny",
    blocking: [{ tool: "Agent", input: { subagent_type: "kherep-builder", prompt: "build it" } }],
    benign: { tool: "Agent", input: { subagent_type: "general-purpose", model: "sonnet", prompt: "look it up" } } },
  { hook: "playwright-file-guard.mts", matcher: "", mode: "deny",
    blocking: [{ tool: "mcp__plugin_playwright_playwright__browser_navigate", input: { url: "file:///C:/report/index.html" } }],
    benign: { tool: "mcp__plugin_playwright_playwright__browser_navigate", input: { url: "http://localhost:8080/" } } },
  // Issue #376. Not a block: Claude asks the operator to confirm the call.
  { hook: "atlassian-destructive-guard.mts", matcher: "mcp__.*__executeDestructive", mode: "ask",
    blocking: [{ tool: "mcp__atlassian__executeDestructive", input: { name: "deleteJiraIssue", cloudId: "x", inputs: {} } }],
    benign: { tool: "mcp__atlassian__executeDestructiveProbe", input: {} } },
];

// The host's own policy settings must not decide these cases.
const NEUTRAL_ENV = { KHEREP_WORK_ITEM_REQUIRED: "", KHEREP_ALLOWED_MODELS: undefined, KHEREP_AGENT_MODEL_POLICY: undefined };

function runCase(wired: Wired, item: ToolCase, claudeHome?: string): Run {
  return runWired(wired, { tool_name: item.tool, tool_input: item.input }, claudeHome, NEUTRAL_ENV);
}

function blocked(run: Run, mode: Mode, hook: string): boolean {
  return run.status === 0 && run.permission === (mode === "exit2" ? "deny" : mode)
    && (mode !== "exit2" || run.stderr.includes(hook.replace(".mts", "")));
}

// Asserts that the guard blocks every blocking case and lets the benign one pass.
function assertBlocks(guard: (typeof PRETOOL_GUARDS)[number], claudeHome?: string): void {
  const wired = wiredCommand(guard.hook);
  for (const item of guard.blocking) {
    const run = runCase(wired, item, claudeHome);
    assert.ok(blocked(run, guard.mode, guard.hook),
      `${guard.hook} did not block ${item.tool}: status ${run.status}, stderr ${run.stderr}`);
  }
  const run = runCase(wired, guard.benign, claudeHome);
  assert.equal(run.status, 0, `${guard.hook} benign: ${run.stderr}`);
  assert.equal(run.permission, null, `${guard.hook} denied a benign ${guard.benign.tool}`);
}

for (const guard of PRETOOL_GUARDS) {
  test(`${guard.hook} is wired under PreToolUse "${guard.matcher}" as an .mts file that exists`, async () => {
    const { event, matcher, command } = wiredCommand(guard.hook);
    assert.equal(event, "PreToolUse");
    assert.equal(matcher, guard.matcher);
    assert.ok(command.startsWith('node "__KHEREP_CLAUDE_HOME__/kherep/hook-runtime/entry.mts" pretool "__KHEREP_CLAUDE_HOME__/hooks/guard-dispatch.mts" ')
      && command.split(" ").includes(`"__KHEREP_CLAUDE_HOME__/hooks/${guard.hook}"`), command);
    const file = path.join(repo, "claude", "hooks", guard.hook);
    assert.ok(fs.statSync(file).size > 0, `claude/hooks/${guard.hook} is not empty`);
    // live-hook-integrity.mts calls a hook DEFEKT when Node's parser rejects it.
    // `node --check` cannot say so for .mts (issue #278); lib/hook-syntax.mts can.
    const verdict = await syntaxVerdict(file, fs.readFileSync(file, "utf8"));
    assert.equal(verdict.state, "OK", `Node's parser rejects ${guard.hook}: ${JSON.stringify(verdict)}`);
  });

  test(`${guard.hook} still blocks through its wired command and allows a benign call`, () => {
    assertBlocks(guard);
  });
}

test("a dispatch-contract notice (#505) leaves the wired dispatcher as additionalContext, no decision", () => {
  const prompt = "- measured: code `node x.test.mts` -> 12 pass, 0 fail";
  const run = runCase(wiredCommand("dispatch-contract-guard.mts"), { tool: "Agent", input: { subagent_type: "claude-obs", model: "haiku", prompt } });
  assert.ok(run.status === 0 && run.permission === null && run.reason === null, JSON.stringify(run));
  assert.match(String(run.context), /^\[dispatch-contract:OBS_BRIEF_REVISION\] Observation brief revision: /);
});

// Issue #571. Not a PRETOOL_GUARDS item: the gate keys on agent_id and agent_type,
// which runCase does not send. Its .refused markers land in the Claude copy.
test("obs-handback-gate is wired under PreToolUse SubagentHandback and refuses a malformed handback once per agent id", () => {
  const wired = wiredCommand("obs-handback-gate.mts");
  assert.equal(wired.event, "PreToolUse");
  assert.equal(wired.matcher, "SubagentHandback");
  assert.equal(wired.command, 'node "__KHEREP_CLAUDE_HOME__/kherep/hook-runtime/entry.mts" pretool '
    + '"__KHEREP_CLAUDE_HOME__/hooks/guard-dispatch.mts" "__KHEREP_CLAUDE_HOME__/hooks/obs-handback-gate.mts"');
  const handback = (message: string, agent_id: string, agent_type = "claude-obs") =>
    runWired(wired, { tool_name: "SubagentHandback", tool_input: { message }, agent_id, agent_type }, claudeSource, NEUTRAL_ENV);
  const malformed = "OBS-RESULT: failed wrote 4 pages: 1,2,3,4";
  const first = handback(malformed, "wired-a");
  assert.ok(first.status === 0 && first.permission === "deny" && String(first.reason).includes("obs-handback-gate"), JSON.stringify(first));
  for (const run of [handback(malformed, "wired-a"), handback("OBS-RESULT: empty nothing new", "wired-b"),
    handback(malformed, "wired-c", "general-purpose")]) {
    assert.ok(run.status === 0 && run.permission === null, JSON.stringify(run));
  }
});

// Issue #507. A 0-byte or missing guard used to exit without a decision (fail-open).
// Through the dispatcher it denies every call, benign included, naming the file.
test("a 0-byte or missing PreToolUse guard denies every call and names its file", () => {
  const home = claudeCopy("broken-claude", false);
  const copy = home;
  for (const guard of PRETOOL_GUARDS) {
    const file = path.join(copy, "hooks", guard.hook);
    const original = fs.readFileSync(file);
    assertBlocks(guard, home);
    for (const breakGuard of [() => fs.writeFileSync(file, ""), () => fs.rmSync(file)]) {
      breakGuard();
      for (const run of [...guard.blocking, guard.benign].map((item) => runCase(wiredCommand(guard.hook), item, home))) {
        assert.ok(run.status === 0 && run.permission === "deny" && String(run.reason).includes(`[guard-dispatch] ${guard.hook} cannot run`),
          `${guard.hook}: ${JSON.stringify(run)}`);
      }
    }
    fs.writeFileSync(file, original);
  }
});

// Red-first evidence for the syntax assertion above: a 0-byte guard and one with
// an ESM syntax error must not pass it. `node --check` passes both (issue #278).
test("the syntax assertion rejects a 0-byte guard and an ESM syntax error", async () => {
  for (const guard of PRETOOL_GUARDS) {
    const file = path.join(TMP, "syntax", guard.hook);
    for (const source of ["", "export const x = ;\n"]) {
      const verdict = await syntaxVerdict(file, source);
      assert.equal(verdict.state, "DEFEKT", `${guard.hook} with ${JSON.stringify(source)}: ${JSON.stringify(verdict)}`);
    }
  }
});
