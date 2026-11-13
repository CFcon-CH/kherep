// OP-1440. What counts as research in a Claude Code turn, shared by the prompt
// hook that asks for it (research-first.mts) and the Stop hook that enforces it
// (research-stop.mts). Pure pattern matching plus local existence checks: no
// model call, no network, nothing leaves the host.
//
// Two sources, as ROUTING.md "Evidence first" names them:
//   - the Central Brain, the Confluence knowledge space, reached through the
//     Claude broker's read verbs, the Teamwork Graph search, an Atlassian
//     search MCP tool, an atlassian-broker dispatch that asks to read or
//     search, or a lookup skill the operator lists in research-sources.json
//   - the code graph, the codebase-memory MCP server, required only when the
//     turn changed files inside a git repository
import fs from "node:fs";
import path from "node:path";

import { contentBlocks, type ContentBlock, type TranscriptEntry } from "./turn-substance.mts";
import { joinPathLike, normalizePathLike } from "./workspace-scope.mts";

// The visible classification a turn gives when research is not relevant:
// [research: none - <reason>], the dash a hyphen, en dash or em dash, the reason
// required. Byte-identical to codex/hooks/research-common.mts (#293).
export const RESEARCH_OPT_OUT = /\[\s*research\s*:\s*none\s*[\-\u2013\u2014]\s*[^\]\[\s][^\]\[\r\n]*\]/i;

// <claude-home>/kherep/confluence.json, seen from <claude-home>/hooks/lib.
const DEFAULT_CONFIG = path.join(import.meta.dirname, "..", "..", "kherep", "confluence.json");
const SPACE_KEY = /^[A-Za-z0-9~_-]{1,64}$/;

// The installed space key, or a pointer to where it lives. A key that does not
// look like one is not printed: this file is operator configuration.
export function spaceKeyFrom(configPath: string = DEFAULT_CONFIG): string {
  try {
    const key = (JSON.parse(fs.readFileSync(configPath, "utf8")) as { spaceKey?: unknown }).spaceKey;
    if (typeof key === "string" && SPACE_KEY.test(key)) return key;
  } catch {
    // Absent or unreadable: fall through to the pointer.
  }
  return "<spaceKey from <claude-home>/kherep/confluence.json>";
}

// The Brain search both hooks name, resolved so no model composes the broker
// path (issue #13). The same form bootstrap/render-profile-paths.mts renders
// into the permission allowlist (path.resolve with forward slashes, then
// "/tools/..."), so the suggested command matches the allow rule instead of
// raising a prompt. Forward slashes because Git Bash consumes the backslashes
// of a native Windows path.
export function brainSearchCommand(workspace: string, configPath?: string): string {
  const root = path.resolve(workspace).replace(/\\/g, "/");
  return `node ${root}/tools/atl-confluence-ccoder.mts search --space ${spaceKeyFrom(configPath)} --query "<terms>"`;
}

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const WRITE_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit", "Write"]);
const BROKER_LOOKUP = /atl-confluence-ccoder\.mts["']?\s+(?:search|related|get)\b/;
// Issue #897. Only the vendor CLI's own search counts. The retired kherep-twg
// wrapper and its skill no longer do, and a vendor TWG skill counts only when
// the operator lists it in research-sources.json.
const TWG_LOOKUP = /(?:^|[\s"'/\\])twg(?:\.exe)?["']?\s+rovo\s+search\b/i;
const AGENT_TOOLS = new Set(["Agent", "Task"]);
const BROKER_AGENT = "atlassian-broker";
// Read verbs and search intent in the dispatch prompt. \bsearch keeps
// "searchConfluenceUsingCql" and drops "research", which is not a lookup.
const BROKER_READ_INTENT = /\bsearch|related|\sget\s|cql/i;
const CODE_GRAPH_SERVER = "codebase-memory-mcp";
const CONFLUENCE_SEARCH_TOOLS = ["searchConfluenceUsingCql", "searchConfluence"];

// mcp__<server>__<tool>. The server part may itself carry underscores (plugin
// namespaces), so the tool is whatever follows the LAST double underscore.
function mcpParts(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const cut = name.lastIndexOf("__");
  if (cut <= 4) return null;
  return { server: name.slice(5, cut), tool: name.slice(cut + 2) };
}

function toolUses(turn: TranscriptEntry[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const entry of turn) {
    const msg = entry && entry.message;
    if (!msg || msg.role !== "assistant") continue;
    for (const block of contentBlocks(msg)) {
      if (block && block.type === "tool_use" && typeof block.name === "string") out.push(block);
    }
  }
  return out;
}

// extraSkills: operator-listed lookup skills, matched by exact name. No skill
// counts without that list.
export function isBrainLookup(block: ContentBlock, extraSkills: ReadonlySet<string> = new Set()): boolean {
  const name = String(block.name);
  const input = block.input || {};
  if (SHELL_TOOLS.has(name)) {
    const command = typeof input.command === "string" ? input.command : "";
    return BROKER_LOOKUP.test(command) || TWG_LOOKUP.test(command);
  }
  if (name === "Skill") {
    const skill = typeof input.skill === "string" ? input.skill.trim() : "";
    return extraSkills.has(skill);
  }
  if (AGENT_TOOLS.has(name)) {
    return input.subagent_type === BROKER_AGENT
      && typeof input.prompt === "string" && BROKER_READ_INTENT.test(` ${input.prompt} `);
  }
  const mcp = mcpParts(name);
  if (!mcp) return false;
  // A bare "search" tool is only an Atlassian search when the server says so.
  // The v1 CQL search and the v2 "searchConfluence" are unambiguous under any
  // server name, including a claude.ai connector named by a UUID. The v2 server
  // also runs them through executeRead with the operation in input.name (#376).
  return CONFLUENCE_SEARCH_TOOLS.includes(mcp.tool)
    || (mcp.tool === "executeRead" && CONFLUENCE_SEARCH_TOOLS.includes(String(input.name)))
    || (mcp.tool === "search" && /rovo|atlassian/i.test(mcp.server));
}

export function isCodeGraphCall(block: ContentBlock): boolean {
  const mcp = mcpParts(String(block.name));
  if (!mcp) return false;
  return mcp.server === CODE_GRAPH_SERVER || mcp.server.endsWith(`_${CODE_GRAPH_SERVER}`);
}

export type Exists = (path: string) => boolean;

// The parent of "C:/x" is "C:/", of "/x" it is "/"; a root is its own parent.
function parentOf(dir: string, cut: number): string {
  if (cut === 0) return "/";
  if (cut === 2 && /^[A-Za-z]:/.test(dir)) return dir.slice(0, 3);
  return dir.slice(0, cut);
}

// Walks up from a path to the filesystem root looking for a .git entry (a
// directory in a clone, a file in a worktree). Offline and bounded by the
// path's depth. Whether the repository is also INDEXED by codebase-memory is not
// knowable offline from here, so a repository is the trigger and the code graph
// itself answers whether it knows the project.
export function gitRepositoryOf(target: unknown, exists: Exists = fs.existsSync): string {
  let dir = normalizePathLike(target);
  while (dir) {
    if (exists(dir === "/" ? "/.git" : joinPathLike(dir, ".git"))) return dir;
    const cut = dir.lastIndexOf("/");
    if (cut < 0) return "";
    const parent = parentOf(dir, cut);
    if (parent === dir) return "";
    dir = parent;
  }
  return "";
}

function writtenPath(block: ContentBlock, cwd: string): string {
  const input = block.input || {};
  let raw = "";
  if (typeof input.file_path === "string") raw = input.file_path;
  else if (typeof input.notebook_path === "string") raw = input.notebook_path;
  if (!raw) return "";
  const normalized = normalizePathLike(raw);
  const absolute = normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
  return absolute ? normalized : joinPathLike(cwd, normalized);
}

export interface ResearchFacts {
  brain: boolean;
  codeGraph: boolean;
  codeWork: boolean;
}

export function researchFacts(
  turn: TranscriptEntry[],
  cwd: unknown,
  exists: Exists = fs.existsSync,
  extraSkills: ReadonlySet<string> = new Set(),
): ResearchFacts {
  const uses = toolUses(turn);
  const base = normalizePathLike(cwd);
  return {
    brain: uses.some((block) => isBrainLookup(block, extraSkills)),
    codeGraph: uses.some(isCodeGraphCall),
    codeWork: uses.some((block) => WRITE_TOOLS.has(String(block.name))
      && Boolean(gitRepositoryOf(writtenPath(block, base), exists))),
  };
}
