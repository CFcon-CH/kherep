// Issue #274. The Codex app, storing hook trust, can rewrite config.toml so that
// its `[hooks.state]` tables sit inside the managed block while the rest of the
// managed fragment sits behind the end marker, and the end marker can separate
// the keys of one trust table. The TOML is unchanged, the text matches no fragment.
// Issue #684. The Codex CLI writes its trust tables and `[tui]` between the
// managed tables inside the block instead, with nothing managed behind it.

import { isDeepStrictEqual } from "node:util";

import { stableHookCommands } from "./control-plane-hook-path.mts";
import {
  blockPieces, fragmentPieces, scanDocument, structure, TomlStructureError,
  type ScannedDocument, type ScannedTable, type Span,
} from "./toml-block-structure.mts";

const MESSAGE = "Refusing to overwrite a managed block without an exact known managed fragment";

export class UnknownManagedFragmentError extends Error {
  readonly knownFragments: string[];

  constructor(knownFragments: string[]) {
    super(MESSAGE);
    this.knownFragments = knownFragments;
  }
}

const isState = ({ path, array }: ScannedTable): boolean => !array && path[0] === "hooks" && path[1] === "state";
const pathKey = (path: string[]): string => JSON.stringify(path);

// Issue #397. The checkout hooks run from the checkout or source pin the
// installer ran from, so a block from an earlier pin names another directory
// before them. The same hooks control-plane-hook-path.mts points at the current
// checkout in a whole block; here they take the fragment's own directory, and
// nothing else in the text may differ.
const CHECKOUT_DIR = /(?<=\\")(?:[^"\\]|\\\\)*?(?:\\\\|\/)modules(?:\\\\|\/)control-plane(?:\\\\|\/)node(?:\\\\|\/)(?=(?:deliver|attribution)-hook\.mts\\" \\"--runtime\\" \\"codex\\")/g;

// Issue #503. A fragment in the stable form names one entry point instead; a
// block written before it names checkout paths, which take that stable form.
const STABLE_ENTRY = /(?<=\\")(?:[^"\\]|\\\\)*?codex-control-plane-hook\.mts(?=\\" \\"(?:deliver|attribution)\\" \\"--runtime\\" \\"codex\\")/g;

function atCheckoutOf(fragment: string): (text: string) => string {
  const entries = new Set(Array.from(fragment.matchAll(STABLE_ENTRY), ([entry]) => entry));
  if (entries.size === 1) {
    const [entry] = entries;
    return (text) => stableHookCommands(text, JSON.parse(`"${entry}"`) as string);
  }
  const dirs = new Set(Array.from(fragment.matchAll(CHECKOUT_DIR), ([dir]) => dir));
  if (dirs.size !== 1) return (text) => text;
  const [dir] = dirs;
  return (text) => text.replace(CHECKOUT_DIR, () => dir);
}

// Returns the config with the fragment in the block and every table the Codex
// app or CLI added there, with the text TOML gives it, behind the end marker; or
// undefined unless the managed tables left in the block, followed by those
// behind the marker, are exactly a known fragment. Matching, refusals and the
// rewrite stay with the caller.
export function reanchorSplitManagedBlock(
  config: string, startMarker: string, endMarker: string, knownFragments: string[],
): string | undefined {
  const start = config.indexOf(startMarker);
  const end = start < 0 ? -1 : config.indexOf(endMarker, start);
  if (end < 0 || config[end - 1] !== "\n" || (start > 0 && config[start - 1] !== "\n")) return undefined;
  try {
    return reanchor(config, start, end, startMarker, endMarker, knownFragments);
  } catch (error) {
    // A document the scanner cannot follow is refused like any unknown block.
    if (error instanceof TomlStructureError) return undefined;
    throw error;
  }
}

function reanchor(
  config: string, start: number, end: number, startMarker: string, endMarker: string, knownFragments: string[],
): string | undefined {
  const text = ({ start: from, end: to }: Span): string => config.slice(from, to);
  const startLineEnd = config.indexOf("\n", start) + 1;
  const endNewline = config.indexOf("\n", end);
  const endLineEnd = endNewline < 0 ? config.length : endNewline + 1;
  const doc = scanDocument(config);
  // A multiline value in the block could hide or fake a table header.
  if (doc.multiline.some((span) => span.start < end && span.end > startLineEnd)) return undefined;
  const block = blockPieces(doc, startLineEnd, end, endLineEnd);
  if (text(block.preamble).split("\n").some((line) => line.trim() && !line.trim().startsWith("#"))) return undefined;
  const fragments = knownFragments.map((fragment) => fragment.trim()).sort((left, right) => right.length - left.length)
    .map((fragment) => ({ fragment, pieces: fragmentPieces(fragment) }));
  // Only a table whose binding does not depend on its position may move: plain,
  // under no array of tables, and a trust table or one no fragment defines.
  const managedPaths = new Set(fragments.flatMap(({ pieces }) => pieces.tables.map(({ table }) => pathKey(table.path))));
  const arrayPaths = new Set(doc.tables.filter(({ array }) => array).map(({ path }) => pathKey(path)));
  const liftable = (table: ScannedTable): boolean => !table.array
    && table.path.slice(0, -1).every((_, at) => !arrayPaths.has(pathKey(table.path.slice(0, at + 1))))
    && (isState(table) || (!managedPaths.has(pathKey(table.path)) && table.path[0] !== "mcp_servers" && table.path[0] !== "hooks"));
  const lifted = block.tables.filter(({ table }) => liftable(table));
  const kept = block.tables.filter(({ table }) => !liftable(table));
  // In TOML, the text between the marker and the next table belongs to the last
  // table of the block. It may move only along with a table that moves.
  const owner = block.tables.at(-1);
  if (text(block.carry).trim() && !(owner && liftable(owner.table))) return undefined;
  const behind = doc.tables.filter(({ span }) => span.start >= block.carry.end);
  const stateCount = behind.findIndex((table) => !isState(table));
  const stateBehind = behind.slice(0, stateCount < 0 ? behind.length : stateCount);
  const following = behind.slice(stateBehind.length);
  for (const { fragment, pieces } of fragments) {
    if (kept.length > pieces.tables.length) continue;
    // Issue #274: the tables behind the trust tables complete the fragment.
    const tail = following.slice(0, pieces.tables.length - kept.length);
    const managed = [...kept, ...tail.map((table) => ({ table, piece: table.span }))];
    if (managed.length !== pieces.tables.length) continue;
    if (text(block.preamble).trim() !== fragment.slice(pieces.preamble.start, pieces.preamble.end).trim()) continue;
    const atCheckout = atCheckoutOf(fragment);
    const matches = managed.every(({ table, piece }, index) => {
      const known = pieces.tables[index];
      return isDeepStrictEqual(table.path, known.table.path) && table.array === known.table.array
        && atCheckout(text(piece).trimEnd()) === fragment.slice(known.piece.start, known.piece.end).trimEnd();
    });
    if (!matches) continue;
    const moved = [...lifted.map(({ piece }) => text(piece)), text(block.carry), ...stateBehind.map(({ span }) => text(span))]
      .join("").replace(/^\n+|(?<!\n)\n+$/g, "");
    const last = tail.at(-1);
    const consumed = last ? last.span.start + text(last.span).trimEnd().length : stateBehind.at(-1)?.span.end ?? block.carry.end;
    const remainder = config.slice(consumed).replace(/^\n+/, "");
    const candidate = `${config.slice(0, start)}${startMarker}\n${fragment}\n${endMarker}\n`
      + (moved ? `\n${moved}\n` : "") + (remainder ? `\n${remainder}` : "");
    return sameDocument(doc, managed.map(({ table }) => table), candidate, start + startMarker.length + 1, fragment.length)
      ? candidate : undefined;
  }
  return undefined;
}

// Outside the managed tables, the candidate holds the same tables with the same
// lines as the original. A managed table matched exactly, and the text behind
// the marker that the last one owns is blank, so excluding them hides no key.
function sameDocument(
  doc: ScannedDocument, managed: ScannedTable[], candidate: string, blockStart: number, length: number,
): boolean {
  const next = scanDocument(candidate);
  const inside = next.tables.filter(({ span }) => span.start >= blockStart && span.start < blockStart + length);
  const identity = ({ address, array }: ScannedTable): string => `${array ? "[[" : "["}${address}`;
  if (!isDeepStrictEqual(inside.map(identity), managed.map(identity))) return false;
  return isDeepStrictEqual(structure(doc, new Set(managed.map(({ address }) => address))),
    structure(next, new Set(inside.map(({ address }) => address))));
}
