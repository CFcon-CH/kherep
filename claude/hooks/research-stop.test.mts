#!/usr/bin/env node
// Contract test for research-stop.mts (OP-1440). Transcripts are written to a
// temp dir; whether a written file sits in a git repository is injected, so the
// result does not depend on where the temp dir happens to live. The spawn cases
// drive the real hook the way Claude Code does, next to observation-stop.mts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { decision, researchReason } from "./research-stop.mts";
import { OBSERVATION_REASON } from "./observation-stop.mts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "research-stop-test-"));
const WORKSPACE = "/Users/tester/Work";
const IN_SCOPE = `${WORKSPACE}/ForgeApps/app`;
const REPO = `${WORKSPACE}/ForgeApps/app`;
const ENV = { KHEREP_WORKSPACE: WORKSPACE };
const USER_TEXT = "please check the Example Corp tenant at host.example.com";
const inRepo = (p: string) => p === `${REPO}/.git`;

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

type Entry = Record<string, unknown>;
const user = (text: string): Entry => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const said = (text: string): Entry => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const tool = (name: string, input: Record<string, unknown> = {}): Entry => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name, input }] },
});
const bash = (command: string) => tool("Bash", { command });
const WORK = bash("npm run build");
const BRAIN = bash("node /Users/tester/Work/tools/atl-confluence-ccoder.mts search --space KB --query \"hook order\"");
const EDIT = tool("Edit", { file_path: `${REPO}/src/a.mts`, old_string: "a", new_string: "b" });
const GRAPH = tool("mcp__codebase-memory-mcp__search_graph", { query: "a" });
const OBS = tool("Agent", { subagent_type: "claude-obs", model: "haiku", prompt: "brief" });

let seq = 0;
function transcript(entries: Entry[] | string): string {
  const file = path.join(TMP, `t-${++seq}.jsonl`);
  fs.writeFileSync(file, typeof entries === "string" ? entries : entries.map((e) => JSON.stringify(e)).join("\n"), "utf8");
  return file;
}

function payload(entries: Entry[] | string, extra: Record<string, unknown> = {}) {
  return { cwd: IN_SCOPE, stop_hook_active: false, transcript_path: transcript(entries), ...extra };
}

const NO_SOURCES = path.join(TMP, "absent-research-sources.json");
const CONFIG = path.join(TMP, "confluence.json");
fs.writeFileSync(CONFIG, JSON.stringify({ spaceKey: "KB", spaceId: "9001" }), "utf8");
const decide = (entries: Entry[] | string, extra: Record<string, unknown> = {}, sources: string = NO_SOURCES) =>
  decision(payload(entries, extra), ENV, inRepo, sources, CONFIG);

function sourcesFile(content: string): string {
  const file = path.join(TMP, `sources-${++seq}.json`);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

test("blocks a substantial turn without any lookup, with a fixed reason naming both sources", () => {
  const result = decide([user(USER_TEXT), WORK, said("done")]);
  const reason = researchReason(WORKSPACE, CONFIG);
  assert.deepEqual(result, { decision: "block", reason });
  assert.match(reason, /codebase-memory/);
  assert.doesNotMatch(reason, /Example Corp|host\.example\.com/);
});

// Issue #13. The reason used to print a literal <workspace>, leaving the path to
// the model. It names the resolved command exactly as research-first does.
test("the reason names the resolved broker command, never a placeholder", () => {
  const reason = decide([user(USER_TEXT), WORK, said("done")])?.reason ?? "";
  assert.ok(reason.includes(`node ${path.resolve(WORKSPACE).replace(/\\/g, "/")}/tools/atl-confluence-ccoder.mts search --space KB --query "<terms>"`), reason);
  assert.doesNotMatch(reason, /<workspace>|<key>/);
});

// Git Bash consumes the backslashes of a native Windows path: the command uses
// forward slashes, the form the allow rule has on Windows.
test("on a Windows workspace the reason uses forward slashes", () => {
  const result = decision(payload([user(USER_TEXT), WORK, said("done")], { cwd: "D:\\Workspaces\\kherep" }),
    { KHEREP_WORKSPACE: "D:\\Workspaces" }, inRepo, NO_SOURCES, CONFIG);
  const reason = result?.reason ?? "";
  const root = path.resolve("D:/Workspaces").replace(/\\/g, "/");
  assert.ok(reason.includes(`node ${root}/tools/atl-confluence-ccoder.mts search --space KB`), reason);
  assert.doesNotMatch(reason, /\\/);
  if (process.platform === "win32") assert.ok(reason.includes("node D:/Workspaces/tools/atl-confluence-ccoder.mts search"), reason);
});

test("passes a substantial turn that looked up the Brain", () => {
  assert.equal(decide([user("q"), WORK, BRAIN, said("done")]), null);
});

test("every accepted Brain lookup form passes, a foreign search tool does not", () => {
  const forms = [
    bash("node C:/Kherep/tools/atl-confluence-ccoder.mts related --space KB --title \"x\""),
    bash("node \"C:/Kherep/tools/atl-confluence-ccoder.mts\" get --id 5001"),
    bash("twg rovo search --app confluence -- \"hook order\""),
    tool("mcp__rovo__search", { query: "x" }),
    tool("mcp__0000-aaaa__searchConfluenceUsingCql", { cql: "text ~ x" }),
    tool("mcp__atlassian__searchConfluence", { query: "x" }),
    tool("mcp__plugin_atlassian_atlassian__searchConfluence", { query: "x" }),
    tool("mcp__1cecfb42-00ea-4453-a5ff-9da9581aab32__searchConfluence", { query: "x" }),
    tool("mcp__atlassian__executeRead", { name: "searchConfluence", cloudId: "x", inputs: { cql: "text ~ x" } }),
    tool("mcp__Atlassian_MCP__executeRead", { name: "searchConfluenceUsingCql", cloudId: "x", inputs: {} }),
  ];
  for (const form of forms) assert.equal(decide([user("q"), WORK, form]), null, JSON.stringify(form));
  for (const form of [tool("mcp__bexio__search", {}), bash("node C:/Kherep/tools/atl-confluence-ccoder.mts create --space KB"),
    // Issue #897. The retired wrapper and its skill no longer count, nor does a
    // vendor TWG skill the operator has not listed.
    bash("node C:/Users/x/.claude/kherep/twg/cli.mts confluence-search hooks"),
    tool("Skill", { skill: "kherep-twg" }), tool("Skill", { skill: "twg" }), tool("Skill", { skill: "twg-confluence" }),
    tool("mcp__atlassian__executeRead", { name: "searchJiraIssuesUsingJql", cloudId: "x", inputs: {} }),
    tool("mcp__atlassian__executeRead", {}),
    tool("mcp__atlassian__executeWrite", { name: "searchConfluence", cloudId: "x", inputs: {} })]) {
    assert.ok(decide([user("q"), WORK, form]), `${JSON.stringify(form)} must not count as research`);
  }
});

test("an atlassian-broker dispatch counts only with a Confluence read or search intent", () => {
  const broker = (prompt: string, name = "Agent") => tool(name, { subagent_type: "atlassian-broker", prompt });
  for (const prompt of [
    "Search the KB space for hook order",
    "run related --space KB --title x",
    "please get page 5001 and return its body",
    "CQL: text ~ \"hook\"",
    "call searchConfluenceUsingCql with space = KB",
  ]) {
    assert.equal(decide([user("q"), WORK, broker(prompt)]), null, prompt);
  }
  assert.equal(decide([user("q"), WORK, broker("search the KB space", "Task")]), null, "Task is the older name of Agent");
  for (const prompt of ["Create a page with these research findings", "comment on OP-1 and transition it", ""]) {
    assert.ok(decide([user("q"), WORK, broker(prompt)]), `${JSON.stringify(prompt)} must not count as research`);
  }
  const other = tool("Agent", { subagent_type: "general-purpose", prompt: "search Confluence for x" });
  assert.ok(decide([user("q"), WORK, other]), "only the atlassian-broker counts");
});

test("a skill named in the operator research-sources file counts as a Brain lookup", () => {
  const skill = tool("Skill", { skill: "acme-wiki-search" });
  assert.ok(decide([user("q"), WORK, skill]), "unknown without the file");
  const sources = sourcesFile(JSON.stringify({ brainSkills: ["acme-wiki-search", 7, ""] }));
  assert.equal(decide([user("q"), WORK, skill], {}, sources), null);
  assert.ok(decide([user("q"), WORK, tool("Skill", { skill: "kherep-twg" })], {}, sources), "the retired wrapper skill is no built-in");
  const vendor = sourcesFile(JSON.stringify({ brainSkills: ["twg-agentic-search"] }));
  assert.equal(decide([user("q"), WORK, tool("Skill", { skill: "twg-agentic-search" })], {}, vendor), null, "a listed vendor TWG skill counts");
  assert.ok(decide([user("q"), WORK, tool("Skill", { skill: "twg" })], {}, vendor), "only the listed vendor skill counts");
  assert.ok(decide([user("q"), WORK, tool("Skill", { skill: "other-skill" })], {}, sources));
});

test("a malformed or unreadable research-sources file leaves only the built-ins and never throws", () => {
  const skill = tool("Skill", { skill: "acme-wiki-search" });
  const bad = ["{not json", "[\"acme-wiki-search\"]", "{\"brainSkills\": \"acme-wiki-search\"}", "null", ""];
  for (const content of bad) {
    const sources = sourcesFile(content);
    assert.ok(decide([user("q"), WORK, skill], {}, sources), JSON.stringify(content));
    assert.equal(decide([user("q"), WORK, BRAIN], {}, sources), null);
  }
  assert.ok(decide([user("q"), WORK, skill], {}, TMP), "a directory is unreadable as a file");
});

test("code work inside a git repository also needs the code graph", () => {
  assert.ok(decide([user("q"), BRAIN, EDIT, said("done")]), "Brain alone is not enough for code work");
  assert.equal(decide([user("q"), GRAPH, BRAIN, EDIT, said("done")]), null);
  assert.ok(decide([user("q"), GRAPH, EDIT, said("done")]), "the code graph alone is not enough either");
  const relative = tool("Write", { file_path: "src/b.mts", content: "x" });
  assert.ok(decide([user("q"), BRAIN, relative]), "a relative path resolves against cwd");
  const elsewhere = tool("Write", { file_path: "/Users/tester/notes/todo.txt", content: "x" });
  assert.equal(decide([user("q"), BRAIN, elsewhere]), null, "a file outside any repository is not code work");
});

test("the visible marker passes, from the transcript or from last_assistant_message", () => {
  assert.equal(decide([user("q"), WORK, EDIT, said("Done. [research: none - pure rename]")]), null);
  assert.equal(decide([user("q"), WORK, said("done")], { last_assistant_message: "[Research: NONE - trivial]" }), null);
  assert.ok(decide([user("q"), WORK, said("[research: none]")]), "a marker without reason does not opt out (#293)");
  assert.equal(decide([user("q"), WORK, said("Done. [research: none \u2013 pure rename]")]), null, "an en dash opts out (#293)");
  assert.ok(decide([user("q"), WORK, said("research none - missing brackets")]));
});

test("banal and non-substantial turns are never gated", () => {
  assert.equal(decide([user("hi"), said("Hello.")]), null);
  assert.equal(decide([user("q"), tool("Read", { file_path: "/x" }), said("It says x.")]), null);
});

test("only stop_hook_active exactly false is judged, and scope is required", () => {
  for (const active of [true, undefined, "false", 0]) {
    assert.equal(decide([user("q"), WORK], { stop_hook_active: active }), null, String(active));
  }
  assert.equal(decide([user("q"), WORK], { cwd: "/Users/tester/other" }), null);
});

test("an unreadable or empty transcript fails open", () => {
  assert.equal(decision({ cwd: IN_SCOPE, stop_hook_active: false, transcript_path: path.join(TMP, "missing.jsonl") }, ENV), null);
  assert.equal(decide(""), null);
  assert.equal(decide("{not json\n"), null);
  assert.equal(decision({ cwd: IN_SCOPE, stop_hook_active: false }, ENV), null);
  assert.equal(decision("nonsense", ENV), null);
});

// The two Stop hooks run side by side. A blocked turn continues with
// stop_hook_active true, and both hooks stand down on it, so neither can hand
// the turn back a second time - with its own reason or with the other's.
function spawnHook(file: string, stdin: string): string {
  const env: Record<string, string | undefined> = { ...process.env, ...ENV };
  const result = spawnSync(process.execPath, [path.join(HERE, file)], { input: stdin, encoding: "utf8", env });
  assert.equal(result.status, 0, `${file} must always exit 0`);
  return result.stdout;
}

test("no loop with observation-stop: both block once, both stand down on the continuation", () => {
  const entries = [user(USER_TEXT), WORK, said("done")];
  const first = JSON.stringify(payload(entries));
  assert.deepEqual(JSON.parse(spawnHook("research-stop.mts", first)), { decision: "block", reason: researchReason(WORKSPACE) });
  assert.deepEqual(JSON.parse(spawnHook("observation-stop.mts", first)), { decision: "block", reason: OBSERVATION_REASON });

  const continuation = JSON.stringify(payload(entries, { stop_hook_active: true }));
  assert.equal(spawnHook("research-stop.mts", continuation), "");
  assert.equal(spawnHook("observation-stop.mts", continuation), "");

  // A turn that did both jobs ends under both hooks, and neither reason is the
  // other's opt-out, so satisfying one never silences the other by accident.
  const done = JSON.stringify(payload([user("q"), WORK, BRAIN, OBS, said("done")]));
  assert.equal(spawnHook("research-stop.mts", done), "");
  assert.equal(spawnHook("observation-stop.mts", done), "");
  assert.doesNotMatch(OBSERVATION_REASON, /\[research: none/);
  assert.doesNotMatch(researchReason(WORKSPACE), /\[obs: none/);
});

test("the hook fails open on malformed stdin", () => {
  assert.equal(spawnHook("research-stop.mts", "not-json"), "");
});
