import fs from "node:fs";
import path from "node:path";
import { inputRecord, nestedToolCalls, type ParsedToolCall } from "./research-exec-parser.mts";

export type ToolCall = ParsedToolCall;
export interface ParsedTurn { assistantText: string; finalAssistantText: string; calls: ToolCall[] }
export interface ResearchFacts { brain: boolean; codeGraph: boolean; codeWork: boolean; substantial: boolean }
export type Exists = (candidate: string) => boolean;

interface RecordLike { type?: unknown; payload?: unknown; [key: string]: unknown }

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function payloadOf(entry: RecordLike): Record<string, unknown> {
  return object(entry.payload) || entry;
}

function taskId(entry: RecordLike): string {
  const payload = payloadOf(entry);
  for (const value of [payload.turn_id, payload.turnId, payload.id, entry.turn_id]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function isTaskStart(entry: RecordLike): boolean {
  const payload = payloadOf(entry);
  return entry.type === "event_msg" && payload.type === "task_started";
}

function isUserMessage(entry: RecordLike): boolean {
  const payload = payloadOf(entry);
  return entry.type === "response_item" && payload.type === "message" && payload.role === "user";
}

function textContent(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.content)) return "";
  return payload.content.map((part) => {
    const item = object(part);
    return item && typeof item.text === "string" ? item.text : "";
  }).join("");
}

function parsedInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function callsFrom(entry: RecordLike): ToolCall[] {
  const payload = payloadOf(entry);
  if (entry.type !== "response_item" || !["function_call", "custom_tool_call"].includes(String(payload.type))) return [];
  if (typeof payload.name !== "string") return [];
  const input = parsedInput(payload.arguments ?? payload.input ?? {});
  // Codex Desktop records the code-mode wrapper as a freeform custom_tool_call named
  // "exec" with no namespace field at all (#398). Only that exact form is accepted
  // without a namespace; a bare exec function_call or another namespace is not the wrapper.
  const isExec = payload.name === "functions.exec"
    || (payload.name === "exec" && (payload.namespace === "functions"
      || (payload.type === "custom_tool_call" && !("namespace" in payload))));
  if (isExec && typeof input === "string") return nestedToolCalls(input);
  return [{ name: payload.name, input }];
}

export function parseRollout(raw: string, requestedTurnId?: string): ParsedTurn | null {
  const entries: RecordLike[] = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      const entry = object(JSON.parse(line));
      if (entry) entries.push(entry);
    } catch {
      // A live rollout can end with a half-written line. Valid earlier records remain usable.
    }
  }
  if (!entries.length) return null;
  const starts = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => isTaskStart(entry));
  let start = -1;
  if (starts.length) {
    const identified = starts.filter(({ entry }) => taskId(entry));
    if (requestedTurnId && identified.length) {
      start = starts.findLast(({ entry }) => taskId(entry) === requestedTurnId)?.index ?? -1;
      if (start < 0) return null;
    } else start = starts.at(-1)!.index;
  } else {
    start = entries.findLastIndex(isUserMessage);
  }
  if (start < 0) return null;
  const nextStart = entries.findIndex((entry, index) => index > start && isTaskStart(entry));
  const turn = entries.slice(start, nextStart < 0 ? undefined : nextStart);
  const assistantParts = turn.map((entry) => {
    const payload = payloadOf(entry);
    return entry.type === "response_item" && payload.type === "message" && payload.role === "assistant"
      ? textContent(payload) : "";
  }).filter(Boolean);
  return {
    assistantText: assistantParts.join(""),
    finalAssistantText: assistantParts.at(-1) || "",
    calls: turn.flatMap(callsFrom),
  };
}

export function readLatestTurn(file: string, turnId?: string): ParsedTurn | null {
  try { return parseRollout(fs.readFileSync(file, "utf8"), turnId); } catch { return null; }
}

function commandOf(call: ToolCall): string {
  const input = inputRecord(call);
  const command = input.cmd ?? input.command;
  return typeof command === "string" ? command : "";
}

const SHELL_TOOLS = new Set(["Bash", "shell_command", "exec_command"]);

function mcpParts(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const cut = name.lastIndexOf("__");
  return cut > 5 ? { server: name.slice(5, cut).replaceAll("_", "-"), tool: name.slice(cut + 2) } : null;
}

function isBrain(call: ToolCall): boolean {
  const mcp = mcpParts(call.name);
  // A bare "search" counts only on an Atlassian server; the v1 CQL search and the
  // v2 "searchConfluence" count under any server name, a UUID connector included,
  // and so does the v2 executeRead that names one of them (#376).
  if (mcp) {
    const searches = ["searchConfluenceUsingCql", "searchConfluence"];
    return searches.includes(mcp.tool)
      || (mcp.tool === "executeRead" && searches.includes(String(inputRecord(call).name)))
      || (mcp.tool === "search" && /rovo|atlassian/i.test(mcp.server));
  }
  if (!SHELL_TOOLS.has(call.name)) return false;
  const command = commandOf(call);
  return /^\s*(?:&\s*)?(?:"[^"]*node(?:\.exe)?"|'[^']*node(?:\.exe)?'|node(?:\.exe)?)\s+(?:"[^"]*atl-confluence(?:-ccoder)?\.mts"|'[^']*atl-confluence(?:-ccoder)?\.mts'|\S*atl-confluence(?:-ccoder)?\.mts)\s+(?:search|related|get)\b/i.test(command)
    || /^\s*twg(?:\.exe)?\s+rovo\s+search\b/i.test(command);
}

function isCodeGraph(call: ToolCall): boolean {
  const mcp = mcpParts(call.name);
  return Boolean(mcp && (mcp.server === "codebase-memory-mcp" || mcp.server.endsWith("-codebase-memory-mcp")));
}

function patchPaths(call: ToolCall): string[] {
  if (!["apply_patch", "functions.apply_patch"].includes(call.name)) return [];
  const input = inputRecord(call);
  const raw = typeof input.input === "string" ? input.input : "";
  return [...raw.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1].trim());
}

function fileToolPaths(call: ToolCall): string[] {
  if (!["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(call.name)) return [];
  const input = inputRecord(call);
  return [input.file_path, input.notebook_path].filter((value): value is string => typeof value === "string" && Boolean(value));
}

function resolvePathLike(cwd: string, target: string): string {
  const normalizedTarget = target.replace(/\\/g, "/");
  if (normalizedTarget.startsWith("/") || /^[A-Za-z]:\//.test(normalizedTarget)) return normalizedTarget;
  return `${cwd.replace(/\\/g, "/").replace(/(?<!\/)\/+$/, "")}/${normalizedTarget}`;
}

function inRepository(target: string, cwd: string, exists: Exists): boolean {
  let current = path.posix.normalize(resolvePathLike(cwd || ".", target));
  while (current) {
    if (exists(`${current}/.git`)) return true;
    const parent = current.slice(0, current.lastIndexOf("/")) || (current.startsWith("/") ? "/" : "");
    if (!parent || parent === current) return false;
    current = parent;
  }
  return false;
}

const SHELL_WRITE = /(?:^|[;&|]\s*)(?:(?:Set-Content|Add-Content|Out-File|tee|touch|mv|cp|Move-Item|Copy-Item|Remove-Item)\b|git\s+apply\b|sed\s+-[^\r\n;|&]*i\b)|(?:^|\s)(?:>>|>)(?!=)/i;

const READ_ONLY_COMMAND = /^\s*(?:pwd|ls\b|dir\b|cat\b|head\b|tail\b|rg\b|grep\b|Get-(?:ChildItem|Content|Item|Process)\b|Select-String\b|Test-Path\b|git\s+(?:status\b|diff\b|log\b|show\b|rev-parse\b|branch\s+(?:--show-current|--list)\b))[^;\r\n&|<>`]*$/i;
function isReadOnly(call: ToolCall): boolean {
  return ["Read", "Grep", "Glob"].includes(call.name)
    || (SHELL_TOOLS.has(call.name) && READ_ONLY_COMMAND.test(commandOf(call)));
}

export function researchFacts(turn: ParsedTurn, cwd: string, exists: Exists = fs.existsSync): ResearchFacts {
  return {
    brain: turn.calls.some(isBrain),
    codeGraph: turn.calls.some(isCodeGraph),
    codeWork: turn.calls.some((call) => {
      const targets = [...patchPaths(call), ...fileToolPaths(call)];
      if (targets.some((target) => inRepository(target, cwd, exists))) return true;
      return SHELL_TOOLS.has(call.name)
        && SHELL_WRITE.test(commandOf(call)) && inRepository(".", cwd, exists);
    }),
    substantial: turn.assistantText.length >= 400 || turn.calls.length >= 3 || turn.calls.some((call) => !isReadOnly(call)),
  };
}
