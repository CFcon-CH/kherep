// Issue #808, PR 1 (stage 2a). The tool event contract on Codex: every PreToolUse guard the
// rendered hook block runs is covered (or a recorded exception), the shell dispatcher carries
// the canonical warning of all four slots and still denies a non-canonical notice from each,
// and the adapter-run guards keep their decisions while a field mutation is never silent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";
import { warningText, type ShapeGuard, type ShapeReason } from "../../claude/hooks/lib/tool-event-shape.mts";
import { renderHooks } from "../lib/parity-config.mts";
import { runAdaptedHook } from "./hook-adapter-run.mts";
import { copyAdapter } from "./hook-adapter.fixture.mts";

const HERE = import.meta.dirname;
const SHARED = path.resolve(HERE, "../../claude/hooks");
const PRIVATE = ["work", "credentials"].join("-");
const SLOTS = [...fs.readFileSync(path.join(HERE, "shell-checks.mts"), "utf8").matchAll(/\["([\w-]+)\.mts", "pre/g)].map((m) => m[1]!);
// Wired Codex guards with no contract row, and why: the Codex dispatch guard denies a
// missing or non-string tool_name itself; the messaging intent hook is unproven (lead decision D4).
const EXCEPTIONS: Record<string, string> = { "codex-dispatch-contract-guard": "denies", "mcp-intent-hook": "unproven" };

// The guard each PreToolUse adapter entry runs; the shell dispatcher's slots come from its source.
function codexGuards(): string[] {
  const text = renderHooks({ contextHook: "context.mts", hookDir: "", node: "node", mcpServers: [],
    messagingClient: { enabled: true, bridge: "mcp-stdio-bridge.mts", intentHook: "mcp-intent-hook.mts", configRoot: "/synthetic/config" } } as Parameters<typeof renderHooks>[0]);
  const stems = text.split("[[hooks.").filter((block) => block.startsWith("PreToolUse")).flatMap((block) =>
    [...block.matchAll(/^command = .*codex-hook-adapter\.mts\\" \\"([\w-]+)\.mts/gm)].map((m) => m[1]!));
  return [...new Set(stems)].sort();
}

test("every Codex PreToolUse guard has a contract row or a recorded exception", async () => {
  const { TOOL_EVENT_CONTRACT } = await import("../../claude/hooks/lib/tool-event-contract.mts");
  const rows = TOOL_EVENT_CONTRACT as Record<string, { codex?: unknown }>;
  assert.deepEqual(SLOTS, ["commit-guard", "deploy-guard", "main-checkout-guard", "module-label-guard"]);
  // Slots and Codex-owned guards see the native event only through the adapter, which needs a codex row.
  const native = [...SLOTS, ...codexGuards().filter((stem) => stem.startsWith("codex-")).map((stem) => stem.slice("codex-".length))];
  const shared = codexGuards().filter((stem) => !stem.startsWith("codex-") && !(stem in EXCEPTIONS));
  assert.deepEqual(native.filter((name) => !rows[name]?.codex && !(`codex-${name}` in EXCEPTIONS)), []);
  assert.deepEqual(shared.filter((name) => !Object.hasOwn(rows, name)), []);
  assert.deepEqual(codexGuards().filter((stem) => stem in EXCEPTIONS).sort(), Object.keys(EXCEPTIONS).sort());
  for (const tool_name of [undefined, 12]) {
    const r = runAdaptedHook(path.join(HERE, "dispatch-contract-guard.mts"), "pre", { tool_name, tool_input: {} }, 10_000);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny", "the recorded exception denies itself");
  }
});

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-event-contract-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const workspace = path.join(root, "ws");
const labelled = path.join(workspace, "labelled");
fs.mkdirSync(path.join(labelled, ".github"), { recursive: true });
fs.writeFileSync(path.join(labelled, ".git"), "gitdir: /elsewhere\n");
fs.writeFileSync(path.join(labelled, ".github", "module-labels.json"), JSON.stringify({ version: 1, repository: "example/project", labels: ["bootstrap"] }));
const dir = path.join(root, "hooks");
fs.mkdirSync(dir);
copyAdapter(dir);
fs.cpSync(path.join(SHARED, "lib"), path.join(dir, "lib"), { recursive: true });
fs.copyFileSync(path.join(HERE, "shell-checks.mts"), path.join(dir, "shell-checks.mts"));
declareCopy(path.join(HERE, "shell-checks.mts"), path.join(dir, "shell-checks.mts"));
const restore = (slot: string): void => { fs.copyFileSync(path.join(SHARED, `${slot}.mts`), path.join(dir, `${slot}.mts`)); };
SLOTS.forEach(restore);
const shellRun = (event: unknown) => {
  const r = spawnSync(process.execPath, [path.join(dir, "shell-checks.mts")], { input: JSON.stringify(event), encoding: "utf8",
    env: { ...process.env, KHEREP_WORKSPACE: workspace, KHEREP_MAIN_CHECKOUT: "" } });
  assert.equal(r.status, 0, r.stderr);
  return (r.stdout ? JSON.parse(r.stdout) : {}).hookSpecificOutput as { permissionDecision?: string; additionalContext?: string } | undefined;
};
const lines = (reason: ShapeReason): string => SLOTS.map((slot) => warningText(slot as ShapeGuard, reason)).join("\n");

test("shell dispatcher carries the canonical warning of all four slots for each native field mutation", () => {
  const command = { command: "git status" };
  for (const [event, reason] of [[{ tool_input: command }, "TOOL_NAME_MISSING"], [{ tool: "shell_command", tool_input: command }, "TOOL_NAME_MISSING"],
    [{ tool_name: "exec_command" }, "TOOL_INPUT_MISSING"], [{ tool_name: "shell_command", tool_input: { cmd: "git status" } }, "COMMAND_MISSING"],
  ] as const) {
    const output = shellRun({ ...event, cwd: workspace });
    assert.equal(output?.permissionDecision, undefined, JSON.stringify(event));
    assert.equal(output?.additionalContext, lines(reason), JSON.stringify(event));
  }
  assert.equal(shellRun({ tool_name: "shell_command", tool_input: command, cwd: workspace }), undefined, "a recognized event stays silent");
  assert.equal(shellRun({ tool_name: "Read", tool_input: {}, cwd: workspace }), undefined, "another tool stays silent");
});

test("shell dispatcher still denies each slot's known-bad event and any non-canonical notice", () => {
  for (const command of ['git commit -m "synthetic \u2014 subject"', "kubectl delete pods synthetic", "gh issue create -t synthetic -b body"]) {
    assert.equal(shellRun({ tool_name: "shell_command", tool_input: { command }, cwd: labelled })?.permissionDecision, "deny", command);
  }
  for (const slot of SLOTS) {
    const own = warningText(slot as ShapeGuard, "COMMAND_MISSING");
    const other = warningText((slot === "commit-guard" ? "deploy-guard" : "commit-guard") as ShapeGuard, "COMMAND_MISSING");
    for (const forged of [own.replace("Required tool", "Synthetic tool"), other, `${own}\n${own}`]) {
      fs.writeFileSync(path.join(dir, `${slot}.mts`), `process.stdout.write(${JSON.stringify(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: forged } }))});`);
      assert.equal(shellRun({ tool_name: "shell_command", tool_input: { command: "git status" } })?.permissionDecision, "deny", `${slot}: ${forged}`);
    }
    fs.writeFileSync(path.join(dir, `${slot}.mts`), `process.stdout.write(${JSON.stringify(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: own } }))});`);
    assert.equal(shellRun({ tool_name: "shell_command", tool_input: { command: "git status" } })?.additionalContext, own, `${slot}: its exact notice is admitted`);
    restore(slot);
  }
});

// The adapter-run guards: [target, phase, guard args, contract name, known-bad, input key].
const ADAPTED: [string, string, string[], string, Record<string, unknown>, string?][] = [
  [path.join(HERE, "privacy-boundary-guard.mts"), "pre-privacy", [], "privacy-boundary-guard",
    { tool_name: "Read", tool_input: { file_path: `/synthetic/${PRIVATE}/a.txt` } }, "file_path"],
  [path.join(SHARED, "playwright-file-guard.mts"), "pre", [], "playwright-file-guard",
    { tool_name: "mcp__playwright__browser_navigate", tool_input: { url: "file:///synthetic/a.html" } }, "url"],
  [path.join(SHARED, "atlassian-destructive-guard.mts"), "pre", ["--runtime", "codex"], "atlassian-destructive-guard",
    { tool_name: "mcp__synthetic__executeDestructive", tool_input: { name: "deletePage" } }],
];
for (const [target, phase, guardArgs, name, bad, key] of ADAPTED) test(`${name}: Codex adapter blocks the known-bad event, never silences a mutation`, () => {
  const run = (event: Record<string, unknown>) => runAdaptedHook(target, phase, event, 10_000, { guardArgs });
  const outcome = (event: Record<string, unknown>): string => {
    const r = run(event);
    if (!r.stdout) return "silent";
    const doc = JSON.parse(r.stdout).hookSpecificOutput as { permissionDecision?: string; additionalContext?: string };
    if (doc.permissionDecision === "deny") return "blocked";
    return [...new Set(doc.additionalContext?.split("\n"))].every((line) => /^\[kherep:event-shape:WARN:/.test(line) && line.includes(`:${name}:`)) ? "warned" : r.stdout;
  };
  assert.equal(outcome(bad), "blocked");
  const { tool_name, tool_input, ...rest } = bad;
  const renamed = Object.fromEntries(Object.entries(tool_input as object).map(([field, value]) => [field === key ? `${field}_renamed` : field, value]));
  for (const event of [{ ...rest, tool_input }, { ...rest, tool: tool_name, tool_input }, { ...rest, tool_name },
    ...(key ? [{ ...rest, tool_name, tool_input: renamed }] : [])]) {
    assert.ok(["blocked", "warned"].includes(outcome(event)), `${name} ${JSON.stringify(event)}: ${outcome(event)}`);
  }
  assert.equal(run({ tool_name: "TodoWrite", tool_input: { todos: [] } }).stdout, "", "another tool stays silent");
});
