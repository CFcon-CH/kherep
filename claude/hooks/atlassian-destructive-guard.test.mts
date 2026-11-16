import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

import { decide } from "./atlassian-destructive-guard.mts";
import { warningDocument, type ShapeReason } from "./lib/tool-event-shape.mts";

const HOOK = path.join(import.meta.dirname, "atlassian-destructive-guard.mts");

function run(payload: unknown, ...args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [HOOK, ...args], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout };
}

function decision(output: string | null): string | undefined {
  return output ? JSON.parse(output).hookSpecificOutput.permissionDecision : undefined;
}

const SERVERS = [
  "atlassian",
  "plugin_atlassian_atlassian",
  "claude_ai_Atlassian",
  "Atlassian_MCP",
  "1cecfb42-00ea-4453-a5ff-9da9581aab32",
];

test("asks on Claude for executeDestructive under any server name", () => {
  for (const server of SERVERS) {
    const output = decide({ tool_name: `mcp__${server}__executeDestructive`, tool_input: { name: "deleteJiraIssue" } }, "claude");
    assert.equal(decision(output), "ask", server);
    assert.match(String(output), /deleteJiraIssue/);
  }
});

test("denies on Codex, whose hooks cannot ask", () => {
  for (const server of SERVERS) {
    const output = decide({ tool_name: `mcp__${server}__executeDestructive`, tool_input: {} }, "codex");
    assert.equal(decision(output), "deny", server);
    assert.match(String(output), /operator, who runs it/);
  }
});

test("leaves reads, writes and unrelated tools alone", () => {
  for (const tool of [
    "mcp__atlassian__executeRead", "mcp__atlassian__executeWrite", "mcp__atlassian__createJiraIssue",
    "mcp__atlassian__discover", "mcp__other__executeDestructiveLater", "executeDestructive", "Bash",
  ]) {
    assert.equal(decide({ tool_name: tool, tool_input: {} }, "claude"), null, tool);
    assert.equal(decide({ tool_name: tool, tool_input: {} }, "codex"), null, tool);
  }
  // Wired after the privacy guard on every Agent, web and MCP call in Codex.
  for (const tool of ["Agent", "spawn_agent", "WebFetch", "mcp__playwright__browser_navigate"]) {
    assert.equal(decide({ tool_name: tool, tool_input: { name: "executeDestructive" } }, "codex"), null, tool);
  }
});

test("keeps an operation name out of the reason unless it is a plain identifier", () => {
  const output = decide({ tool_name: "mcp__atlassian__executeDestructive", tool_input: { name: "x\ny; rm -rf /" } }, "claude");
  assert.doesNotMatch(String(output), /rm -rf/);
});

test("the wired process prints the decision and exits 0, for malformed input only the event-shape warning", () => {
  const ask = run({ tool_name: "mcp__atlassian__executeDestructive", tool_input: { name: "deleteJiraIssue" } });
  assert.equal(ask.status, 0);
  assert.equal(decision(ask.stdout), "ask");
  const deny = run({ tool_name: "mcp__atlassian__executeDestructive", tool_input: {} }, "--runtime", "codex");
  assert.equal(deny.status, 0);
  assert.equal(decision(deny.stdout), "deny");
  // Issue #808: a quiet allow of an unclassifiable event carries the fixed warning, never a decision.
  for (const [input, reason] of [["", "TOOL_NAME_MISSING"], ["not json", "EVENT_ENVELOPE_INVALID"], ["[]", "EVENT_ENVELOPE_INVALID"],
    ["null", "EVENT_ENVELOPE_INVALID"]] as [string, ShapeReason][]) {
    const result = run(input);
    assert.equal(result.status, 0, input);
    assert.equal(result.stdout, warningDocument([{ guard: "atlassian-destructive-guard", reason }]), input);
  }
  const read = run({ tool_name: "mcp__atlassian__executeRead", tool_input: {} });
  assert.equal(read.stdout, "");
});
