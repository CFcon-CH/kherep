// Issue #921. The Codex app records a tool approval as its own table,
// `[mcp_servers.<server>.tools.<tool>]`. The Codex configuration reference
// documents two keys for it. Such a table is the operator's: its text is kept.

import { blockPieces, scanDocument, TomlStructureError, type ScannedTable, type Span } from "./toml-block-structure.mts";

const KEYS = new Set(["approval_mode", "output_token_limit"]);
// One key on one line with a quoted string or an integer; the value is never interpreted.
const LINE = /^([A-Za-z_]+)[ \t]*=[ \t]*(?:"[^"\\]*"|'[^']*'|[0-9_]+)[ \t]*(?:#.*)?$/;
const BARE = /^[A-Za-z0-9_-]+$/;

export interface ToolApproval { path: string[]; text: string }

const pathKey = (path: string[]): string => JSON.stringify(path);

// Collapses a run of trailing newlines into one, in linear time; text without one stays as it is.
function oneTrailingNewline(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === "\n") end--;
  return end === text.length ? text : `${text.slice(0, end)}\n`;
}

// A plain table under no array of tables, whose address is therefore its path.
export function isToolApprovalTable({ path, array, address, payload }: ScannedTable): boolean {
  if (array || path.length !== 4 || path[0] !== "mcp_servers" || path[2] !== "tools") return false;
  if (address !== path.map((key) => BARE.test(key) ? key : JSON.stringify(key)).join(".")) return false;
  const keys = payload.slice(1).map((line) => LINE.exec(line.trim())?.[1]);
  return keys.every((key) => key !== undefined && KEYS.has(key)) && new Set(keys).size === keys.length;
}

// Puts the operator's text in the place of a tool approval table the block
// renders. `held` came out of the block; any other copy stands outside it and
// leaves its comments there. A held table the block no longer renders goes
// behind the end marker. Codex refuses to load a tools table without its server
// table, so a held or `lifted` table whose server the config no longer defines
// is dropped, its comments kept; an orphan that was outside already stays.
export function restoreToolApprovals(
  config: string, startMarker: string, endMarker: string, held: ToolApproval[], lifted: string[][] = [],
): string {
  const start = config.indexOf(startMarker), end = start < 0 ? -1 : config.indexOf(endMarker, start);
  if (end < 0) return config;
  let doc;
  try {
    doc = scanDocument(config);
  } catch (error) {
    // With nothing held, a document the scanner cannot follow stays as it was.
    if (error instanceof TomlStructureError && !held.length && !lifted.length) return config;
    throw error;
  }
  const lineEnd = (at: number): number => config.indexOf("\n", at) < 0 ? config.length : config.indexOf("\n", at) + 1;
  const inside = new Map(blockPieces(doc, lineEnd(start), end, lineEnd(end)).tables
    .filter(({ table }) => isToolApprovalTable(table)).map(({ table, piece }) => [pathKey(table.path), piece]));
  // A table before the start marker ends there.
  const outside = doc.tables.filter((table) => (table.span.start < start || table.span.start >= end)
    && isToolApprovalTable(table) && inside.has(pathKey(table.path)))
    .map((table) => ({ table, span: { start: table.span.start, end: table.span.start < start ? Math.min(table.span.end, start) : table.span.end } }));
  const served = new Set(doc.tables.filter(({ path, array }) => !array && path.length === 2 && path[0] === "mcp_servers")
    .map(({ path }) => path[1]));
  const liftedKeys = new Set(lifted.map(pathKey));
  const orphans = doc.tables.filter((table) => table.span.start >= end && isToolApprovalTable(table)
    && liftedKeys.has(pathKey(table.path)) && !inside.has(pathKey(table.path)) && !served.has(table.path[1]))
    .map((table) => ({ table, span: table.span }));
  const leaving = [...outside, ...orphans];
  const texts = new Map<string, ToolApproval>();
  for (const approval of [...held, ...leaving.map(({ table }) => ({ path: table.path, text: table.payload.join("\n") }))]) {
    if (texts.has(pathKey(approval.path))) throw new Error("Refusing to merge more than one copy of a tool approval table");
    texts.set(pathKey(approval.path), approval);
  }
  // A table that leaves its place keeps its comments there.
  const edits: (Span & { text: string })[] = leaving.map(({ span }) => ({ ...span, text: config.slice(span.start, span.end)
    .split(/(?<=\n)/).filter((line) => !line.trim() || line.trimStart().startsWith("#")).join("").replace(/^\n+/, "") }));
  const appended: string[] = [];
  for (const [key, { path, text }] of texts) {
    const piece = inside.get(key);
    if (!piece) { if (served.has(path[1])) appended.push(text); continue; }
    const current = config.slice(piece.start, piece.end);
    edits.push({ ...piece, text: text + current.slice(current.trimEnd().length) });
  }
  let next = config;
  for (const edit of edits.sort((left, right) => right.start - left.start)) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  if (orphans.length) next = oneTrailingNewline(next);
  if (!appended.length) return next;
  const at = next.indexOf(endMarker, next.indexOf(startMarker)) + endMarker.length;
  return oneTrailingNewline(`${next.slice(0, at)}\n\n${appended.join("\n\n")}\n${next.slice(at).replace(/^\n*/, "\n")}`);
}
