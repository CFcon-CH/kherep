/**
 * hook-inventory.mts  -  which files Node has to load for the wired hooks to run
 *
 * Two parts. The wiring: every hook file named in a command of the live
 * settings, under <CLAUDE_HOME>/hooks/ (moved here from live-hook-integrity.mts
 * unchanged). The import closure: every file those hooks reach through relative
 * static imports, transitively, bounded to the same hooks directory.
 *
 * GRUND (issue #273): `node --check` does not resolve imports. A hook whose
 * lib/*.mts is missing or 0 bytes passes the syntax check and then dies at
 * import with exit 1, which Claude Code treats as non-blocking, so a blocking
 * guard failed open without notice. Measured: two libs on the privacy guard path
 * are reached only through other libs, and one hook imports a sibling outside
 * lib/, so "direct ./lib/* imports" would have missed both.
 *
 * The scan is a regex over the source, not a parser: the import surface of the
 * hooks is one syntactic family with explicit extensions, plus a dynamic
 * import() with a string literal. live-hook-integrity.mts loads its own libs
 * that way so it can report one it cannot load (issue #279); a computed
 * specifier is not seen, and `typeof import()` is a type, never loaded.
 * bootstrap/hook-require-resolution.test.mts holds the repo to that and checks
 * the closure against the install manifest with these same functions. A
 * leading byte order mark (PowerShell 5.1, Notepad) is dropped before the scan.
 *
 * A file that is a link, or sits in a linked directory, is loaded by Node from its
 * target (issue #524): when the reader names the real path, its imports resolve
 * from the real directory, bounded by the real hooks directory, and are named
 * under the wired hooks directory. Known limit: a link in the middle of a
 * specifier path (`../<alias>/x.mts` back through the alias) is not followed.
 *
 * Runtime-neutral on purpose: hooks directory and readers are parameters, so a
 * Codex counterpart can reuse the walk. Paths are strings (workspace-scope), so
 * POSIX and Windows payloads resolve the same way.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isWithinPath, joinPathLike, normalizePathLike } from "./workspace-scope.mts";

export type HookFile = { file: string; rel: string };
export type InventoryEntry = HookFile & { wired: boolean; importedBy: string[] };
// `real` is the path the bytes were read from; imports resolve from there, as Node does.
export type SourceText = { text: string; real?: string };
// Returns the source to scan, or null when there is none to read.
export type SourceReader = (file: string, rel: string) => string | SourceText | null;

const SETTINGS_FILES = ["settings.json", "settings.user.json"];
const errorCode = (error: unknown): string | undefined => (error ? (error as NodeJS.ErrnoException).code : undefined);

// Every hook event, not just SessionStart: a dead PreToolUse guard is the whole
// reason this exists. The settings are parsed JSON of any shape, read defensively.
function commandsIn(settings: { hooks?: unknown } | null): string[] {
  const out: string[] = [];
  const events = (settings && typeof settings.hooks === "object" && settings.hooks) || {};
  for (const groups of Object.values(events)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups as ({ hooks?: unknown } | null)[]) {
      for (const entry of ((group && Array.isArray(group.hooks) && group.hooks) || []) as ({ command?: unknown } | null)[]) {
        if (entry && typeof entry.command === "string") out.push(entry.command);
      }
    }
  }
  return out;
}

function expandToken(token: string, home: string): string {
  let raw = String(token).replace(/^['"]+|(?<!['"])['"]+$/g, "").replace(/\$\{?CLAUDE_HOME\}?/g, home);
  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) raw = os.homedir() + raw.slice(1);
  return normalizePathLike(raw);
}

// Issue #507, part 2: the coordinated form of a command that runs hooks/ code,
//   node <home>/kherep/hook-runtime/entry.mts <pretool|reader|writer> <home>/hooks/<main> ...
// and nothing else: every later token is an argument of that main. A leading `&`
// is PowerShell's call operator.
const ENTRY_MODES = new Set(["pretool", "reader", "writer"]);
function coordinated(command: string, tokens: string[], home: string, hooksDir: string): boolean {
  const call = tokens[0] === "&";
  if (!singleCommand(call ? command.replace(/^\s*&/, "") : command)) return false;
  const [node, entry, mode, main] = tokens.slice(call ? 1 : 0).map((token) => token.replace(/^['"]+|(?<!['"])['"]+$/g, ""));
  return node === "node" && sameEntryPath(expandToken(entry ?? "", home), `${home}/kherep/hook-runtime/entry.mts`)
    && ENTRY_MODES.has(mode ?? "") && isWithinPath(expandToken(main ?? "", home), hooksDir);
}

// The installed entry, by its normalized path: exact everywhere but on Windows, whose file
// systems ignore case (a home may differ in case from the rendered one). On a
// case-sensitive file system another case may be another program, never admitted.
export function sameEntryPath(candidate: string, entry: string, platform: string = process.platform): boolean {
  return platform === "win32" ? candidate.toLowerCase() === entry.toLowerCase() : candidate === entry;
}

// True when the shell runs exactly one command: no operator, separator,
// redirection or line break outside quotes, and no command substitution
// anywhere outside single quotes. A backslash before a quote or an operator is
// refused, since bash and PowerShell read it differently; elsewhere it is part
// of a Windows path. Anything else could run more code.
function singleCommand(command: string): boolean {
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

// Only .js and .mts under <CLAUDE_HOME>/hooks/ are in scope: an extension-less
// wrapper carries no syntax contract, files elsewhere are not this hook's business.
// `uncoordinated` lists the commands that run such a file without the hook runtime.
export function wiredFiles(
  home: string,
  readSettings: (name: string) => string = (name) => fs.readFileSync(path.join(home, name), "utf8")
): { files: HookFile[]; notes: string[]; readAny: boolean; uncoordinated: string[] } {
  const hooksDir = `${home}/hooks`;
  const found = new Map<string, HookFile>();
  const notes: string[] = [];
  const uncoordinated: string[] = [];
  let readAny = false;
  for (const name of SETTINGS_FILES) {
    let parsed: { hooks?: unknown } | null;
    try {
      parsed = JSON.parse(readSettings(name));
    } catch (error) {
      if (error instanceof SyntaxError) notes.push(`${name}: not valid JSON, its wiring is UNKNOWN from here`);
      else if (error && errorCode(error) !== "ENOENT") notes.push(`${name}: unreadable (${errorCode(error)})`);
      continue;
    }
    readAny = true;
    for (const command of commandsIn(parsed)) {
      // A quoted path may hold spaces (a Claude home under "Jane Doe").
      const tokens = [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
      let runsHookCode = false;
      for (const token of tokens) {
        const file = expandToken(token, home);
        if (!/\.(?:js|mts)$/i.test(file) || !isWithinPath(file, hooksDir)) continue;
        runsHookCode = true;
        if (!found.has(file.toLowerCase())) {
          found.set(file.toLowerCase(), { file, rel: file.slice(hooksDir.length + 1) });
        }
      }
      if (runsHookCode && !coordinated(command, tokens, home, hooksDir)) uncoordinated.push(command);
    }
  }
  return { files: [...found.values()], notes, readAny, uncoordinated };
}

// A comment opens only where code could stand: at a line start, after
// whitespace or after , ; { } ( ) . That keeps "http://x" and "hooks/*.mts"
// inside strings intact, which a blind strip would turn into a comment
// swallowing the imports that follow. Known limit: a /* after whitespace INSIDE
// a string or regex literal still swallows source up to the next */. For the
// repo hooks the agreement test in bootstrap/hook-require-resolution.test.mts
// bounds this: it fails when this scan misses an import the plain scan sees.
const COMMENT = /(^|[\s,;{}()])(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)/g;
// A statement starts a line. The clause between keyword and `from` holds names,
// braces and commas only, so it may span lines but never crosses a quote or ;.
const FROM_STATEMENT = /^[ \t]*(?:import|export)\b([^;'"]*?)\bfrom\s*(["'])(\.[^"']*)\2/gm;
const BARE_IMPORT = /^[ \t]*import\s*(["'])(\.[^"']*)\1/gm;
const DYNAMIC_IMPORT = /(?<!\btypeof\s+)\bimport\s*\(\s*(["'])(\.[^"']*)\1\s*\)/g;
const CODE_EXTENSION = /\.(?:mts|mjs|cjs|js)$/i;

// The relative specifiers Node resolves when it loads this module. `import type`
// and `export type` are erased before that and never resolved; an inline
// `{ type X }` is not, the module still loads. Without an explicit code extension
// a specifier does not resolve for .mts at all, so it is no file to measure.
export function relativeSpecifiers(source: string): string[] {
  const code = String(source).replace(/^\uFEFF/, "").replace(COMMENT, "$1");
  const found: string[] = [];
  for (const match of code.matchAll(FROM_STATEMENT)) {
    if (!/^\s*type\s+\S/.test(match[1])) found.push(match[3]);
  }
  for (const pattern of [BARE_IMPORT, DYNAMIC_IMPORT]) {
    for (const match of code.matchAll(pattern)) found.push(match[2]);
  }
  return [...new Set(found)].filter((specifier) => CODE_EXTENSION.test(specifier));
}

// Wired files first, then everything they import, transitively. Targets outside
// hooksDir are skipped like a wired file outside it: not this inventory's
// business, and never a place a restore may write to. Case-insensitive dedupe,
// a visited set ends cycles, importedBy names every importer by its rel path.
const parentOf = (p: string): string => p.slice(0, p.lastIndexOf("/"));
export function hookInventory(roots: HookFile[], hooksDir: string, readSource: SourceReader,
  realHooksDir: string = hooksDir): InventoryEntry[] {
  const dir = normalizePathLike(hooksDir);
  const realDir = normalizePathLike(realHooksDir) || dir;
  const byKey = new Map<string, InventoryEntry>();
  const queue: InventoryEntry[] = [];
  for (const { file, rel } of roots) {
    const key = file.toLowerCase();
    if (byKey.has(key)) continue;
    const entry: InventoryEntry = { file, rel, wired: true, importedBy: [] };
    byKey.set(key, entry);
    queue.push(entry);
  }
  for (let next = queue.shift(); next; next = queue.shift()) {
    const read = readSource(next.file, next.rel);
    const source = typeof read === "string" ? { text: read } : read;
    if (!source?.text) continue;
    // A plain read resolves from the alias directory, bounded by dir. A read the reader
    // names by its real path resolves from the real directory, bounded by the real hooks
    // directory, as Node does. An importer whose real path lies outside the real hooks
    // directory is skipped on purpose, even though its imports could point back inside:
    // that file is not this inventory's business. The dependency is then named at the
    // same place under dir.
    const real = source.real ? normalizePathLike(source.real) : "";
    if (real && !(isWithinPath(real, realDir) && real.length > realDir.length)) continue;
    const [base, bound] = real ? [parentOf(real), realDir] : [parentOf(next.file), dir];
    for (const specifier of relativeSpecifiers(source.text)) {
      // joinPathLike keeps a leading .. of the specifier; normalizing folds
      // lib/../x.mts onto x.mts, so both spellings share one dedupe key.
      const resolved = normalizePathLike(joinPathLike(base, specifier));
      if (!isWithinPath(resolved, bound) || resolved.length <= bound.length) continue;
      const file = bound === dir ? resolved : `${dir}${resolved.slice(bound.length)}`;
      let entry = byKey.get(file.toLowerCase());
      if (!entry) {
        entry = { file, rel: file.slice(dir.length + 1), wired: false, importedBy: [] };
        byKey.set(file.toLowerCase(), entry);
        queue.push(entry);
      }
      if (!entry.importedBy.includes(next.rel)) entry.importedBy.push(next.rel);
    }
  }
  return [...byKey.values()];
}
