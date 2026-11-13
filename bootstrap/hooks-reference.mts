// Issues #587 and #588. The parts of the hook-reference check: the inventory of
// wired hooks from the sources the product ships (both Claude settings
// templates, the Codex hook render, the Git hooks the manifest installs), the
// parser of the docs/HOOKS.md table and the README link rule. Test support
// only: bootstrap/hooks-reference.test.mts runs them against the repository,
// bootstrap/hooks-reference-fixtures.test.mts pins them on fixtures.
import fs from "node:fs";
import path from "node:path";

import { wiredFiles } from "../claude/hooks/lib/hook-inventory.mts";
import { renderHooks, type RenderOptions } from "../codex/lib/parity-config.mts";

export const repo = path.resolve(import.meta.dirname, "..");
export const HOME = "/synthetic/claude";
export const REPO = "/synthetic/repo";
export const REFERENCE = "docs/HOOKS.md";
export const HEADER = "| Hook | Runtime | Event | Kind | What it does |";
const RUNTIMES = ["Claude", "Codex", "Git", "Control Plane"];
const KINDS = ["blocking guard", "asks operator", "watcher (warns)", "recorder", "context", "gate"];
export const read = (rel: string): string => fs.readFileSync(path.join(repo, rel), "utf8").replace(/\r\n/g, "\n");

// Test-local copy of singleCommand, claude/hooks/lib/hook-inventory.mts:98-110,
// which stays module-private. The fixture test pins it to the original.
export function singleCommand(command: string): boolean {
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") { if (c === "'") quote = ""; continue; }
    if (c === "\\" && /['"`$;&|<>\r\n]/.test(command[i + 1] ?? "")) return false;
    if (c === "`" || (c === "$" && command[i + 1] === "(")) return false;
    if (quote === '"') { if (c === '"') quote = ""; continue; }
    if (c === "'" || c === '"') quote = c;
    else if (/[;&|<>\r\n]/.test(c)) return false;
  }
  return quote === "";
}

// One template command: a managed hook behind the hook runtime entry (judged by
// wiredFiles alone, as a one-hook settings.json), a Control Plane script run
// directly by node, or neither, which fails.
export type Classified = { stems: string[]; controlPlane: boolean } | { error: string };
const TOKENS = /"([^"]*)"|'([^']*)'|(\S+)/g; // the quoting regex of hook-inventory.mts:136
const CONTROL_PLANE = /^\/synthetic\/repo\/modules\/control-plane\/node\/([\w-]+)\.mts$/;
// Issue #592. The stable entry point under the Claude home and the hook its first
// argument selects: both are wired by such a command, so both need a row.
const STABLE_ENTRY = /^\/synthetic\/claude\/kherep\/control-plane\/(claude-control-plane-hook)\.mts$/;
const STABLE_NAMES: Readonly<Record<string, string>> = { deliver: "deliver-hook", wake: "wake-hook", attribution: "attribution-hook" };
const enoent = Object.assign(new Error("absent"), { code: "ENOENT" });
export function wiredAlone(event: string, command: string) {
  return wiredFiles(HOME, (name) => {
    if (name === "settings.json") return JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: "command", command }] }] } });
    throw enoent;
  });
}
export function classify(event: string, command: string): Classified {
  const { files, uncoordinated } = wiredAlone(event, command);
  if (files.length) {
    return uncoordinated.length ? { error: `uncoordinated managed hook command under ${event}: ${command}` }
      : { stems: files.map((file) => file.rel.replace(/\.(?:mts|js)$/, "")), controlPlane: false };
  }
  // A token counts only as a whole shell word, ended by whitespace, an operator
  // (which singleCommand then refuses) or the end: `"x.mts".js` is the file x.mts.js.
  const matches = [...command.matchAll(TOKENS)];
  const word = (i: number): string | undefined => {
    const match = matches[i];
    const end = match ? match.index + match[0].length : 0;
    return match && (end === command.length || /[\s;&|<>]/.test(command[end]!)) ? match[1] ?? match[2] ?? match[3] : undefined;
  };
  const stem = word(0) === "node" ? CONTROL_PLANE.exec(word(1) ?? "")?.[1] : undefined;
  if (stem && singleCommand(command)) return { stems: [stem], controlPlane: true };
  const entry = word(0) === "node" ? STABLE_ENTRY.exec(word(1) ?? "")?.[1] : undefined;
  const selected = entry ? STABLE_NAMES[word(2) ?? ""] : undefined;
  if (entry && selected && singleCommand(command)) return { stems: [entry, selected], controlPlane: true };
  return { error: `unclassified wired command under ${event}: ${command}${stem ? " (runs more than one shell command)" : ""}` };
}

type Wired = { stem: string; source: string; runtime: string };
export function templateCommands(file: string): { event: string; command: string }[] {
  const text = read(file).replaceAll("__KHEREP_CLAUDE_HOME__", HOME).replaceAll("__KHEREP_REPO__", REPO);
  const hooks = (JSON.parse(text).hooks ?? {}) as Record<string, { hooks?: { command?: unknown }[] }[]>;
  return Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((group) => (group.hooks ?? [])
    .flatMap((hook) => (typeof hook.command === "string" ? [{ event, command: hook.command }] : []))));
}
export function claudeInventory(): { wired: Wired[]; errors: string[] } {
  const wired: Wired[] = [];
  const errors: string[] = [];
  for (const file of ["claude/settings.user.json", "claude/settings.project.json"]) {
    for (const { event, command } of templateCommands(file)) {
      const result = classify(event, command);
      if ("error" in result) { errors.push(`${file}: ${result.error}`); continue; }
      const source = `${file} ${event}${result.controlPlane ? " (Control Plane)" : ""}`;
      for (const stem of result.stems) wired.push({ stem, source, runtime: "Claude" });
    }
  }
  return { wired, errors };
}

// The installer's option set (codex/install.mts): hookDir "" keeps every command
// separator-free, so the stems are the same under path.posix and path.win32.
const CODEX_OPTIONS: RenderOptions = {
  contextHook: "kherep-maestro-context.mts", hookDir: "", node: "node", mcpServers: [],
  controlPlaneHook: `${REPO}/modules/control-plane/node/deliver-hook.mts`,
  messagingClient: { enabled: true, bridge: "mcp-stdio-bridge.mts", intentHook: "mcp-intent-hook.mts", configRoot: "/synthetic/config" },
};
function codexInventory(): Wired[] {
  const out: Wired[] = [];
  let event = "";
  for (const line of renderHooks(CODEX_OPTIONS).split("\n")) {
    event = /^\[\[hooks\.([A-Za-z]+)\]\]$/.exec(line)?.[1] ?? event;
    if (!line.startsWith("command = ")) continue;
    for (const token of line.split(/[^\w.-]+/)) {
      const end = token.lastIndexOf(".mts");
      if (end > 0) out.push({ stem: token.slice(0, end), source: `codex/lib/parity-config.mts renderHooks ${event}`, runtime: "Codex" });
    }
  }
  return out;
}
function gitInventory(): Wired[] {
  return read("bootstrap/manifest/files.txt").split("\n").flatMap((line) => {
    const stem = /^kherep\/githooks\/([^/.]+)$/.exec(line.trim())?.[1];
    return stem ? [{ stem, source: "bootstrap/manifest/files.txt kherep/githooks", runtime: "Git" }] : [];
  });
}
// Throws when a source yields nothing: that is a broken read, not a complete reference.
export function inventory(): Map<string, { sources: string[]; runtimes: Set<string> }> {
  const claude = claudeInventory().wired;
  const [codex, git] = [codexInventory(), gitInventory()];
  for (const [name, list] of [["Claude templates", claude], ["Codex render", codex], ["Git manifest", git]] as const) {
    if (!list.length) throw new Error(`${name} yielded no wired hook; the read is broken, not the reference`);
  }
  const out = new Map<string, { sources: string[]; runtimes: Set<string> }>();
  for (const { stem, source, runtime } of [...claude, ...codex, ...git]) {
    const entry = out.get(stem) ?? { sources: [], runtimes: new Set<string>() };
    if (!entry.sources.includes(source)) entry.sources.push(source);
    entry.runtimes.add(runtime);
    out.set(stem, entry);
  }
  return out;
}

// docs/HOOKS.md: CommonMark fences are skipped, exactly one header line outside
// them opens the table, the separator follows, and the rows are the consecutive
// lines after it that start with `|`. Cells split on unescaped pipes only.
export type Row = { stem: string; cells: string[] };
export function cellsOf(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return body.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
}
export function referenceRows(text: string): Row[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const headers: number[] = [];
  let fence: { char: string; length: number } | undefined;
  lines.forEach((line, index) => {
    if (fence) {
      const close = /^ {0,3}(`+|~+)\s*$/.exec(line)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.length) fence = undefined;
      return;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (open) fence = { char: open[0]!, length: open.length };
    else if (line.trimEnd() === HEADER) headers.push(index);
  });
  if (headers.length !== 1) throw new Error(`${REFERENCE}: expected exactly one table header "${HEADER}" outside code fences, found ${headers.length}`);
  const start = headers[0]! + 1;
  if (!/^\|(?:\s*:?-{3,}:?\s*\|){5}\s*$/.test(lines[start] ?? "")) throw new Error(`${REFERENCE}: the table header must be followed by a five-column |---| separator`);
  const rows: Row[] = [];
  for (let i = start + 1; i < lines.length && lines[i]!.startsWith("|"); i++) {
    const cells = cellsOf(lines[i]!);
    const stem = /^`([A-Za-z0-9][\w.-]*)`$/.exec(cells[0] ?? "")?.[1];
    if (stem) rows.push({ stem, cells });
  }
  return rows;
}
export function cellProblems(row: Row, required: Iterable<string> = []): string[] {
  if (row.cells.length !== 5) return [`row ${row.stem}: ${row.cells.length} cells, expected 5 (write a pipe inside a cell as \\|)`];
  const [, runtime, event, kind, text] = row.cells as [string, string, string, string, string];
  const runtimes = runtime.split(",").map((name) => name.trim());
  const problems: string[] = [];
  if (runtimes.some((name) => !RUNTIMES.includes(name))) problems.push(`row ${row.stem}: Runtime "${runtime}" is not a comma-separated subset of ${RUNTIMES.join(", ")}`);
  for (const name of required) if (!runtimes.includes(name)) problems.push(`row ${row.stem}: Runtime must contain ${name}, a source wires it there`);
  if (!event) problems.push(`row ${row.stem}: Event is empty`);
  if (!KINDS.includes(kind)) problems.push(`row ${row.stem}: Kind "${kind}" is not one of ${KINDS.join(", ")}`);
  if (!text) problems.push(`row ${row.stem}: What it does is empty`);
  return problems;
}

// README.md, split at `## ` headings: the Documentation table has a row whose
// link target is exactly docs/HOOKS.md, and Security model links the same
// target. An anchor may follow; any other character before `)` is another file.
const TARGET = String.raw`\]\(docs/HOOKS\.md(?:#[^)\s]*)?\)`;
export function readmeLinkProblems(text: string): string[] {
  const sections = new Map(text.replace(/\r\n/g, "\n").split(/^## /m).slice(1)
    .map((part) => [part.slice(0, part.indexOf("\n")).trim(), part]));
  const problems: string[] = [];
  if (!new RegExp(String.raw`^\| \[[^\]]+${TARGET}`, "m").test(sections.get("Documentation") ?? "")) {
    problems.push("README.md: the Documentation table needs a row linking docs/HOOKS.md");
  }
  if (!new RegExp(TARGET).test(sections.get("Security model") ?? "")) {
    problems.push("README.md: the Security model section needs a link to docs/HOOKS.md");
  }
  return problems;
}
