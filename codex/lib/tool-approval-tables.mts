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
// behind the end marker.
export function restoreToolApprovals(config: string, startMarker: string, endMarker: string, held: ToolApproval[]): string {
  const start = config.indexOf(startMarker), end = start < 0 ? -1 : config.indexOf(endMarker, start);
  if (end < 0) return config;
  let doc;
  try {
    doc = scanDocument(config);
  } catch (error) {
    // With nothing held, a document the scanner cannot follow stays as it was.
    if (error instanceof TomlStructureError && !held.length) return config;
    throw error;
  }
  const lineEnd = (at: number): number => config.indexOf("\n", at) < 0 ? config.length : config.indexOf("\n", at) + 1;
  const inside = new Map(blockPieces(doc, lineEnd(start), end, lineEnd(end)).tables
    .filter(({ table }) => isToolApprovalTable(table)).map(({ table, piece }) => [pathKey(table.path), piece]));
  // A table before the start marker ends there.
  const outside = doc.tables.filter((table) => (table.span.start < start || table.span.start >= end)
    && isToolApprovalTable(table) && inside.has(pathKey(table.path)))
    .map((table) => ({ table, span: { start: table.span.start, end: table.span.start < start ? Math.min(table.span.end, start) : table.span.end } }));
  const texts = new Map<string, string>();
  for (const { path, text } of [...held, ...outside.map(({ table }) => ({ path: table.path, text: table.payload.join("\n") }))]) {
    if (texts.has(pathKey(path))) throw new Error("Refusing to merge more than one copy of a tool approval table");
    texts.set(pathKey(path), text);
  }
  const edits: (Span & { text: string })[] = outside.map(({ span }) => ({ ...span, text: config.slice(span.start, span.end)
    .split(/(?<=\n)/).filter((line) => !line.trim() || line.trimStart().startsWith("#")).join("").replace(/^\n+/, "") }));
  const appended: string[] = [];
  for (const [path, text] of texts) {
    const piece = inside.get(path);
    if (!piece) { appended.push(text); continue; }
    const current = config.slice(piece.start, piece.end);
    edits.push({ ...piece, text: text + current.slice(current.trimEnd().length) });
  }
  let next = config;
  for (const edit of edits.sort((left, right) => right.start - left.start)) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  if (!appended.length) return next;
  const at = next.indexOf(endMarker, next.indexOf(startMarker)) + endMarker.length;
  return `${next.slice(0, at)}\n\n${appended.join("\n\n")}\n${next.slice(at).replace(/^\n*/, "\n")}`.replace(/\n+$/, "\n");
}
