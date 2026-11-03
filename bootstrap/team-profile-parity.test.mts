// Issue #761. Each runtime ships its own lead and team-lead profile, written in
// that runtime's terms, and both ROUTING files describe the team model. The text
// differs by design; the contract does not: the chain of command, the message
// kinds, the field names and their order, the STATE set, the deadline shape and
// the approvals only the operator gives. This test holds the six texts to that
// one contract and keeps each runtime's vocabulary out of the other's files.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repo = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(repo, rel), "utf8").replace(/\r\n/g, "\n");

const ROLES = ["kherep-lead", "kherep-team-lead"] as const;
const profile = (runtime: "claude" | "codex", role: string): string => `${runtime}/agents/${role}.md`;
const ROUTING = { claude: "claude/teams/kherep/ROUTING.md", codex: "codex/ROUTING.md" } as const;

const CHAIN = "operator -> lead -> team leads";
const KINDS = ["PACKAGE", "REPORT", "PACKAGE-CLOSED", "QUESTION", "ANSWER", "HANDOVER"];
const PACKAGE_FIELDS = ["PACKAGE", "OWNER", "GOAL", "ACCEPT", "DEADLINE", "AUTHORITY", "CONTEXT"];
const REPORT_FIELDS = ["REPORT", "STATE", "EVIDENCE", "BLOCKER", "NEXT"];
const HANDOVER_FIELDS = ["HANDOVER", "PACKAGE-LINE"];
const STATES = ["accepted", "in-progress", "at-risk", "blocked", "review", "done", "failed", "declined"];
const STATE_LINE = `STATE: ${STATES.join(" | ")}`;
const DEADLINE_SHAPE = "<YYYY-MM-DD HH:MM> <zone>";
const OPERATOR_ONLY = ["deployment", "publication", "deletion", "permission changes",
  "installation on a shared host", "merges to a protected branch"];

// Words that belong to one runtime only. A profile names its own runtime's
// mechanisms; the other runtime's terms would make it unreadable on its own.
const CODEX_ONLY = [/\bCodex\b/, /AGENTS\.md/, /developer_instructions/, /spawn_agent/, /\bSOL\b/, /\bAstra\b/,
  /\bTerra\b/, /\bLuna\b/, /codex-obs/, /orchestra\/ROUTING\.md/, /CODEX_HOME/];
const CLAUDE_ONLY = [/\bClaude\b/, /CLAUDE\.md/, /subagent_type/, /claude-obs/, /~\/\.claude/, /SubagentHandback/,
  /CLAUDE_HOME/, /\bAgent tool\b/];
// Reusable product text: no host, person, organization or private path.
const PRIVATE = [/\/Users\//, /[A-Za-z]:\\Users/, /\bcfcon\b/i, /@[a-z0-9-]+\.(?:org|com|net)\b/i];

// The contract lines of every fenced block, as the ordered list of field names.
// The first line may carry the send command before the quoted first field.
function contractBlocks(text: string): string[][] {
  const blocks: string[][] = [];
  for (const match of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    const fields = match[1].split("\n")
      .map((line) => line.match(/(?:^|")([A-Z][A-Z-]*[A-Z]):(?:\s|$)/)?.[1])
      .filter((field): field is string => field !== undefined);
    if (fields.length && KINDS.includes(fields[0])) blocks.push(fields);
  }
  return blocks;
}

function blockLines(text: string): string[] {
  return [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].flatMap((match) => match[1].split("\n"));
}

function kindsNamed(text: string): string[] {
  return KINDS.filter((kind) => new RegExp(`(?:^|[\\s\`"])${kind}:`, "m").test(text));
}

function teamSection(text: string, label: string): string {
  const start = text.indexOf("\n## Team model\n");
  assert.ok(start >= 0, `${label} has no "## Team model" section`);
  const next = text.indexOf("\n## ", start + 1);
  return next < 0 ? text.slice(start) : text.slice(start, next);
}

function frontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "frontmatter");
  return Object.fromEntries(match[1].split("\n").map((line) => {
    const index = line.indexOf(":");
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
}

// Prose wraps freely; phrases are compared with whitespace collapsed.
const prose = (text: string): string => text.replace(/\s+/g, " ");

function assertContract(text: string, label: string): void {
  assert.ok(prose(text).toLowerCase().includes(CHAIN), `${label}: chain of command "${CHAIN}"`);
  assert.deepEqual(kindsNamed(text), KINDS, `${label}: names every message kind`);
  assert.ok(text.includes(STATE_LINE), `${label}: the eight STATE values in order`);
  for (const term of OPERATOR_ONLY) assert.ok(prose(text).includes(term), `${label}: operator-only approval "${term}"`);
  for (const line of blockLines(text)) {
    if (/(?:^|")DEADLINE:/.test(line)) assert.ok(line.endsWith(`DEADLINE: ${DEADLINE_SHAPE}`), `${label}: ${line}`);
    if (/^NEXT:/.test(line)) assert.ok(line.includes(`by ${DEADLINE_SHAPE}`), `${label}: ${line}`);
  }
  for (const block of contractBlocks(text)) {
    const expected = { PACKAGE: PACKAGE_FIELDS, REPORT: REPORT_FIELDS, HANDOVER: HANDOVER_FIELDS }[block[0]];
    assert.deepEqual(block, expected, `${label}: ${block[0]} fields in order`);
  }
}

test("both runtimes ship the same two team profiles with their own frontmatter", () => {
  for (const role of ROLES) {
    const claude = frontmatter(read(profile("claude", role)));
    const codex = frontmatter(read(profile("codex", role)));
    assert.equal(claude.name, role);
    assert.equal(codex.name, role);
    assert.ok(claude.description && codex.description, `${role}: description`);
    assert.equal(claude.model, "__KHEREP_MODEL__", `${role}: Claude model placeholder`);
    assert.equal(claude.effort, "__KHEREP_EFFORT__", `${role}: Claude effort placeholder`);
    assert.deepEqual(Object.keys(codex).sort(), ["description", "name"], `${role}: Codex frontmatter`);
  }
});

test("every profile and both ROUTING sections carry the same contract", () => {
  for (const runtime of ["claude", "codex"] as const) {
    for (const role of ROLES) assertContract(read(profile(runtime, role)), profile(runtime, role));
    assertContract(teamSection(read(ROUTING[runtime]), ROUTING[runtime]), `${ROUTING[runtime]} Team model`);
  }
});

test("each role carries the same contract blocks on both runtimes, and the text is not shared", () => {
  for (const role of ROLES) {
    const claude = read(profile("claude", role));
    const codex = read(profile("codex", role));
    assert.deepEqual(contractBlocks(codex), contractBlocks(claude), `${role}: same blocks, same order`);
    assert.notEqual(codex.split("---\n").slice(2).join(), claude.split("---\n").slice(2).join(), `${role}: native text`);
  }
  assert.deepEqual(contractBlocks(read(profile("claude", "kherep-lead"))).map((block) => block[0]),
    ["PACKAGE", "REPORT", "HANDOVER"], "the lead sends PACKAGE and HANDOVER and reads REPORT");
  assert.deepEqual(contractBlocks(read(profile("claude", "kherep-team-lead"))).map((block) => block[0]),
    ["REPORT"], "the team lead sends REPORT");
  const routing = (runtime: "claude" | "codex") => contractBlocks(teamSection(read(ROUTING[runtime]), runtime));
  assert.deepEqual(routing("codex"), routing("claude"), "both ROUTING sections define the same blocks");
  assert.deepEqual(routing("claude").map((block) => block[0]), ["PACKAGE", "REPORT", "HANDOVER"]);
});

test("each runtime's files use only that runtime's terms and no private detail", () => {
  for (const role of ROLES) {
    const claude = read(profile("claude", role));
    const codex = read(profile("codex", role));
    for (const word of CODEX_ONLY) assert.doesNotMatch(claude, word, `${profile("claude", role)} names ${word}`);
    for (const word of CLAUDE_ONLY) assert.doesNotMatch(codex, word, `${profile("codex", role)} names ${word}`);
    for (const word of PRIVATE) {
      assert.doesNotMatch(claude, word, `${profile("claude", role)} private detail ${word}`);
      assert.doesNotMatch(codex, word, `${profile("codex", role)} private detail ${word}`);
    }
  }
  assert.doesNotMatch(teamSection(read(ROUTING.claude), "claude"), /\bCodex\b|\bSOL\b|\bAstra\b/);
  assert.doesNotMatch(teamSection(read(ROUTING.codex), "codex"), /\bClaude\b|claude-obs/);
});

test("the profiles are correct before the Control Plane names roles", () => {
  // Until the team record and role line exist, the operator names the lead in
  // chat. A profile must not depend on the line, only accept it once it exists.
  for (const runtime of ["claude", "codex"] as const) {
    for (const role of ROLES) {
      const text = prose(read(profile(runtime, role)));
      assert.match(text, /operator names?\b[^.]*\blead\b[^.]*\bin (?:this|its own) (?:chat|thread)/i, `${runtime} ${role}`);
      assert.match(text, /`TEAM ROLE:/, `${runtime} ${role}: accepts the later role line`);
      assert.doesNotMatch(text, /__KHEREP_NODE__/, `${runtime} ${role}: agent files are not intercom-rendered`);
    }
  }
});
