// Issue #684. The tables of a config.toml as text: where each one starts and
// ends, the lines it holds and the instance it addresses. Values are never
// interpreted; a document this scanner cannot follow throws.

export interface Span { start: number; end: number }

export interface ScannedTable {
  path: string[];
  array: boolean;
  // Each prefix seen as `[[…]]` takes the ordinal of its latest element under
  // the current parent instance: `hooks.Stop[1].hooks[0]`.
  address: string;
  // The header line up to the next structural header or the end of the text.
  span: Span;
  // The span's lines without blank and full-line comment lines, each trimEnd().
  payload: string[];
}

export interface ScannedDocument { top: string[]; tables: ScannedTable[]; multiline: Span[] }

export interface Pieces { preamble: Span; tables: { table: ScannedTable; piece: Span }[]; carry: Span }

const KEY = /"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+/g;
const BARE = /^[A-Za-z0-9_-]+$/;
const PAIRS: Record<string, string> = { "]": "[", "}": "{" };

export class TomlStructureError extends Error {}

function fail(): never {
  throw new TomlStructureError("Cannot read the TOML structure safely");
}

function decoded(token: string): string {
  try {
    return JSON.parse(token) as string;
  } catch {
    return fail();
  }
}

// As in post-tool-trust-position.mts: dotted keys, bare or quoted.
function headerPath(line: string): { path: string[]; array: boolean } {
  const match = /^[ \t]*(\[\[?)(.*?)(\]\]?)[ \t]*(?:#.*)?$/.exec(line);
  if (!match || match[1].length !== match[3].length) fail();
  const body = match[2];
  let end = 0;
  const path = [...body.matchAll(KEY)].map((token, index) => {
    if (body.slice(end, token.index).trim() !== (index ? "." : "")) fail();
    end = token.index + token[0].length;
    return token[0].startsWith('"') ? decoded(token[0])
      : token[0].startsWith("'") ? token[0].slice(1, -1) : token[0];
  });
  if (path.length === 0 || body.slice(end).trim()) fail();
  return { path, array: match[1] === "[[" };
}

// The index after the string opened at `at`; a multiline string is recorded.
function stringEnd(text: string, at: number, multiline: Span[]): number {
  const quote = text[at], triple = quote.repeat(3);
  if (text.startsWith(triple, at)) {
    for (let index = at + 3; index < text.length; index++) {
      if (quote === '"' && text[index] === "\\") index++;
      else if (text.startsWith(triple, index)) {
        let close = index + 3;
        while (text[close] === quote && close - index < 5) close++;
        multiline.push({ start: at, end: close });
        return close;
      }
    }
    fail();
  }
  for (let index = at + 1; index < text.length && text[index] !== "\n"; index++) {
    if (quote === '"' && text[index] === "\\") {
      if (text[++index] === "\n") break;
    } else if (text[index] === quote) return index + 1;
  }
  fail();
}

const lineEnd = (text: string, at: number): number => {
  const newline = text.indexOf("\n", at);
  return newline < 0 ? text.length : newline;
};

const payload = (text: string, span: Span): string[] => text.slice(span.start, span.end).split("\n")
  .map((line) => line.trimEnd()).filter((line) => line.trim() && !line.trimStart().startsWith("#"));

export function scanDocument(text: string): ScannedDocument {
  const headers: { start: number; path: string[]; array: boolean }[] = [];
  const multiline: Span[] = [], open: { char: string; start: number }[] = [];
  let lineStart = true;
  let at = -1;
  while (++at < text.length) {
    const char = text[at];
    if (lineStart && !open.length) {
      const line = text.slice(at, lineEnd(text, at));
      if (/^[ \t]*\[/.test(line)) {
        headers.push({ start: at, ...headerPath(line) });
        at += line.length;
        continue;
      }
    }
    lineStart = char === "\n";
    if (char === "#") at = lineEnd(text, at) - 1;
    else if (char === '"' || char === "'") at = stringEnd(text, at, multiline) - 1;
    else if (char === "[" || char === "{") open.push({ char, start: at });
    else if (char === "]" || char === "}") {
      const opened = open.pop();
      if (opened?.char !== PAIRS[char]) fail();
      if (text.slice(opened.start, at).includes("\n")) multiline.push({ start: opened.start, end: at + 1 });
    }
  }
  if (open.length) fail();
  const latest = new Map<string, number>();
  const tables = headers.map(({ start, path, array }, index): ScannedTable => {
    let address = "";
    path.forEach((key, at) => {
      address += (at ? "." : "") + (BARE.test(key) ? key : JSON.stringify(key));
      if (array && at === path.length - 1) {
        latest.set(address, (latest.get(address) ?? -1) + 1);
        address += `[${latest.get(address)}]`;
      } else if (latest.has(address)) address += `[${latest.get(address)}]`;
    });
    const span = { start, end: headers[index + 1]?.start ?? text.length };
    return { path, array, address, span, payload: payload(text, span) };
  });
  return { top: payload(text, { start: 0, end: headers[0]?.start ?? text.length }), tables, multiline };
}

// The tables whose header lies between the markers, each cut at the end marker,
// and the carry: the text behind the end marker line that TOML still gives to
// the last of them. Without a table in the block, the carry runs to the next header.
export function blockPieces(doc: ScannedDocument, startMarkerLineEnd: number, endMarkerStart: number,
  endMarkerLineEnd: number): Pieces {
  const inside = doc.tables.filter(({ span }) => span.start >= startMarkerLineEnd && span.start < endMarkerStart);
  const next = doc.tables.find(({ span }) => span.start >= endMarkerLineEnd)?.span.start;
  const carryEnd = inside.at(-1)?.span.end ?? next ?? endMarkerLineEnd;
  return {
    preamble: { start: startMarkerLineEnd, end: inside[0]?.span.start ?? endMarkerStart },
    tables: inside.map((table) => ({ table, piece: { start: table.span.start, end: Math.min(table.span.end, endMarkerStart) } })),
    carry: { start: endMarkerLineEnd, end: Math.max(endMarkerLineEnd, carryEnd) },
  };
}

export function fragmentPieces(fragment: string): Pieces {
  return blockPieces(scanDocument(fragment), 0, fragment.length, fragment.length);
}

export interface Structure { top: string[]; plain: Map<string, string[]>; arrays: [string, string[]][] }

// The document without the excluded addresses; a repeated address throws.
export function structure(doc: ScannedDocument, exclude: Set<string>): Structure {
  const seen = new Set<string>();
  const result: Structure = { top: doc.top, plain: new Map(), arrays: [] };
  for (const { address, array, payload: lines } of doc.tables) {
    if (seen.has(address)) fail();
    seen.add(address);
    if (exclude.has(address)) continue;
    if (array) result.arrays.push([address, lines]);
    else result.plain.set(address, lines);
  }
  return result;
}
