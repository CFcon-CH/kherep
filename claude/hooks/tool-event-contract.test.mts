// Issue #808, PR 1 (stage 2a). Every PreToolUse guard that claude/settings.user.json wires,
// run as the process the dispatcher starts: a known-bad event still blocks; dropping or
// renaming tool_name, dropping tool_input, renaming the input key the guard reads or sending
// no JSON gives a block or exactly the canonical event-shape warning, never silence; an event
// for another tool stays silent. Synthetic events only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";
import { warningText, type ShapeGuard, type ShapeReason } from "./lib/tool-event-shape.mts";

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, "../..");
const PRIVATE = ["work", "credentials"].join("-"); // a private-path marker the privacy policy refuses
const REASONS: ShapeReason[] = ["EVENT_ENVELOPE_INVALID", "TOOL_NAME_MISSING", "TOOL_NAME_INVALID", "TOOL_INPUT_MISSING",
  "TOOL_INPUT_INVALID", "COMMAND_MISSING", "COMMAND_INVALID"];

// The guards the template wires under PreToolUse; guard-dispatch is the dispatcher that runs them.
function wiredGuards(): string[] {
  const settings = JSON.parse(fs.readFileSync(path.join(REPO, "claude", "settings.user.json"), "utf8")) as
    { hooks: { PreToolUse: { hooks: { command: string }[] }[] } };
  const stems = settings.hooks.PreToolUse.flatMap((group) => group.hooks.flatMap((hook) =>
    [...hook.command.matchAll(/__KHEREP_CLAUDE_HOME__\/hooks\/([\w-]+)\.mts/g)].map((match) => match[1]!)));
  return [...new Set(stems)].filter((stem) => stem !== "guard-dispatch").sort();
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-event-contract-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const workspace = path.join(root, "ws");
const noHooks = path.join(root, "no-hooks");
fs.mkdirSync(noHooks);
const git = (cwd: string, ...args: string[]): void => {
  const r = spawnSync("git", ["-c", `core.hooksPath=${noHooks}`, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.com", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};
// A main checkout on its default branch inside the workspace (main-checkout-guard).
const mainCheckout = path.join(workspace, "repo");
fs.mkdirSync(mainCheckout, { recursive: true });
git(mainCheckout, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(mainCheckout, "a.txt"), "a\n");
git(mainCheckout, "add", "a.txt");
git(mainCheckout, "commit", "-q", "-m", "init");
git(mainCheckout, "update-ref", "refs/remotes/origin/main", "HEAD");
git(mainCheckout, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
// A repository with a module-label rule (module-label-guard).
const labelled = path.join(workspace, "labelled");
fs.mkdirSync(path.join(labelled, ".github"), { recursive: true });
fs.writeFileSync(path.join(labelled, ".git"), "gitdir: /elsewhere\n");
fs.writeFileSync(path.join(labelled, ".github", "module-labels.json"), JSON.stringify({ version: 1, repository: "example/project", labels: ["bootstrap"] }));
// obs-handback-gate keeps its once-only markers under <home>, the parent of its hooks directory.
const obsHooks = path.join(root, "home", "hooks");
fs.mkdirSync(obsHooks, { recursive: true });
fs.cpSync(path.join(HERE, "lib"), path.join(obsHooks, "lib"), { recursive: true });
fs.copyFileSync(path.join(HERE, "obs-handback-gate.mts"), path.join(obsHooks, "obs-handback-gate.mts"));
declareCopy(path.join(HERE, "obs-handback-gate.mts"), path.join(obsHooks, "obs-handback-gate.mts"));

const shell = (command: string, cwd = mainCheckout) => ({ tool_name: "Bash", cwd, tool_input: { command } });
let handback = 0;
const obs = (message: string) => ({ tool_name: "SubagentHandback", agent_type: "claude-obs", agent_id: `synthetic-agent-${++handback}`,
  tool_use_id: `synthetic-use-${handback}`, tool_input: { message } });
// Per guard: a known-bad event, the tool_input key the guard reads (none: it reads no key for
// its decision) and a recognized event that must stay silent.
interface Case { bad: () => Record<string, unknown>; key?: string; good: () => Record<string, unknown> }
const CASES: Record<string, Case> = {
  "privacy-boundary-guard": { bad: () => ({ tool_name: "Read", tool_input: { file_path: `/synthetic/${PRIVATE}/a.txt` } }), key: "file_path",
    good: () => ({ tool_name: "Read", tool_input: { file_path: "/synthetic/public/a.txt" } }) },
  "secret-output-guard": { bad: () => shell("env"), key: "command", good: () => shell("git status") },
  "playwright-file-guard": { bad: () => ({ tool_name: "mcp__plugin_playwright_playwright__browser_navigate", tool_input: { url: "file:///synthetic/a.html" } }),
    key: "url", good: () => ({ tool_name: "mcp__plugin_playwright_playwright__browser_navigate", tool_input: { url: "http://localhost:8080/" } }) },
  "dispatch-contract-guard": { bad: () => ({ tool_name: "Agent", tool_input: { subagent_type: "kherep-builder", prompt: "synthetic brief" } }),
    key: "prompt", good: () => ({ tool_name: "Agent", tool_input: { subagent_type: "general-purpose", model: "sonnet", prompt: "synthetic brief" } }) },
  "commit-guard": { bad: () => shell('git commit -m "synthetic — subject"'), key: "command", good: () => shell("git status") },
  "deploy-guard": { bad: () => shell("kubectl delete pods synthetic"), key: "command", good: () => shell("git status") },
  "main-checkout-guard": { bad: () => shell("git checkout -b synthetic"), key: "command", good: () => shell("git status") },
  "module-label-guard": { bad: () => shell("gh issue create -t synthetic -b body", labelled), key: "command", good: () => shell("gh issue list", labelled) },
  "atlassian-destructive-guard": { bad: () => ({ tool_name: "mcp__synthetic__executeDestructive", tool_input: { name: "deletePage" } }),
    good: () => ({ tool_name: "mcp__synthetic__executeRead", tool_input: { name: "getPage" } }) },
  "obs-handback-gate": { bad: () => obs("synthetic malformed report"), key: "message", good: () => obs("OBS-RESULT: empty nothing durable in this synthetic turn") },
};

const hookOf = (guard: string): string => guard === "obs-handback-gate" ? path.join(obsHooks, `${guard}.mts`) : path.join(HERE, `${guard}.mts`);
const env: Record<string, string | undefined> = { ...process.env, KHEREP_WORKSPACE: workspace };
for (const key of ["KHEREP_ALLOWED_MODELS", "KHEREP_AGENT_MODEL_POLICY", "KHEREP_MAIN_CHECKOUT", "KHEREP_WORK_ITEM_REQUIRED"]) delete env[key];
function run(guard: string, input: unknown): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", hookOf(guard)],
    { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const canonical = (guard: string, reason: ShapeReason): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: warningText(guard as ShapeGuard, reason) } });
// "blocked": exit 2 or a deny/ask document; "warned": exit 0 with exactly one canonical warning on stdout and stderr.
function outcome(guard: string, r: ReturnType<typeof run>): string {
  if (r.status === 2) return "blocked";
  if (r.status !== 0) return `exit ${r.status}`;
  if (!r.stdout) return "silent";
  const decision = (JSON.parse(r.stdout) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
  if (decision === "deny" || decision === "ask") return "blocked";
  const reason = REASONS.find((candidate) => r.stdout === canonical(guard, candidate));
  return reason && r.stderr.includes(`${warningText(guard as ShapeGuard, reason)}\n`) ? "warned" : `unexpected output ${r.stdout}`;
}

// Field mutations of a known-bad event: each must still be seen.
function mutations(guard: string): [string, unknown][] {
  const { tool_name, tool_input, ...rest } = CASES[guard]!.bad();
  const key = CASES[guard]!.key;
  const renamedInput = key && tool_input && typeof tool_input === "object"
    ? Object.fromEntries(Object.entries(tool_input).map(([name, value]) => [name === key ? `${key}_renamed` : name, value])) : undefined;
  return [
    ["tool_name dropped", { ...rest, tool_input }],
    ["tool_name renamed", { ...rest, tool: tool_name, tool_input }],
    ["tool_input dropped", { ...rest, tool_name }],
    ["tool_input renamed", { ...rest, tool_name, input: tool_input }],
    ...(renamedInput ? [[`${key} renamed`, { ...rest, tool_name, tool_input: renamedInput }] as [string, unknown]] : []),
    ["no JSON", "{synthetic"],
  ];
}

test("every wired Claude PreToolUse guard has a contract row and a case here", async () => {
  const { TOOL_EVENT_CONTRACT } = await import("./lib/tool-event-contract.mts");
  const wired = wiredGuards();
  assert.equal(wired.length, 10, `wired guards: ${wired.join(", ")}`);
  assert.deepEqual(wired.filter((guard) => !Object.hasOwn(TOOL_EVENT_CONTRACT, guard)), []);
  assert.deepEqual(Object.keys(CASES).sort(), wired);
});

for (const guard of wiredGuards()) {
  test(`${guard}: a known-bad event still blocks`, () => {
    const r = run(guard, CASES[guard]!.bad());
    assert.equal(outcome(guard, r), "blocked", r.stderr);
  });
  test(`${guard}: every field mutation blocks or warns, never silent`, () => {
    for (const [label, event] of mutations(guard)) {
      const result = outcome(guard, run(guard, event));
      assert.ok(result === "blocked" || result === "warned", `${guard} ${label}: ${result}`);
    }
  });
  test(`${guard}: another tool's event and a recognized event stay silent`, () => {
    for (const event of [{ tool_name: "TodoWrite", tool_input: { todos: [] } }, CASES[guard]!.good()]) {
      const r = run(guard, event);
      assert.deepEqual([r.status, r.stdout], [0, ""], `${guard} ${JSON.stringify(event)}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /event-shape/);
    }
  });
}
