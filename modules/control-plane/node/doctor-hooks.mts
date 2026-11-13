import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { duplicateControlPlaneHooks, type DuplicateHook } from "../../../bootstrap/duplicate-hooks.mts";
import type { Check } from "./doctor-local.mts";
import { CLAUDE, CODEX, entryStatus, legacyNote, pointerRoot, stableCommand, stableHook, stableProblem,
  type EntryStatus, type PointerStatus, type StableForm } from "./doctor-hooks-stable.mts";
import { captureSourceIdentity, compareSourceIdentity, type SourceIdentity } from "./daemon-source.mts";

// The hook check of `kherep-node doctor` (issue #215): whether the delivery
// and wake hook commands in Claude settings.json and Codex config.toml name
// this checkout. Only hook command fields are read, never permissions or other
// settings, and only the matched script path is reported.

const HOOK = String.raw`[\\/](?:deliver|wake)-hook\.mts`;
const START = String.raw`(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])`;
// A quoted path may hold spaces; an unquoted one ends at whitespace and must
// start a word, so a command prefix or an inline VAR=value never joins it.
const HOOK_PATH = new RegExp(String.raw`(["'])(${START}[^"'\n]*?${HOOK})\1|(?:^|[\s=])(${START}[^\s"']*?${HOOK})(?=$|[\s;&|])`, "g");

export function hookPaths(command: string): string[] {
  return [...command.matchAll(HOOK_PATH)].map((match) => match[2] ?? match[3]);
}

// Claude settings: hooks.<event>[].hooks[].command.
function claudeCommands(text: string): string[] {
  const hooks = (JSON.parse(text) as { hooks?: unknown }).hooks;
  if (typeof hooks !== "object" || hooks === null) return [];
  return Object.values(hooks).flat().flatMap((group: unknown) => {
    const list = (group as { hooks?: unknown } | null)?.hooks;
    return Array.isArray(list) ? list.map((hook: { command?: unknown } | null) => hook?.command) : [];
  }).filter((command): command is string => typeof command === "string");
}

// Codex config: command and commandWindows keys inside [hooks.*] or
// [[hooks.*]] tables, as TOML basic strings (JSON-compatible escapes); with
// event, only those of that event's tables.
function codexCommands(text: string, event?: string): string[] {
  const commands: string[] = [];
  const table = event ? new RegExp(`^hooks\\.${event}(?:\\.|$)`) : /^hooks\./;
  let inHooks = false;
  for (const line of text.split(/\r?\n/)) {
    // The table name is the bracket content, trimmed. "[[]" and "[ ]" keep the single character the lazy group used to take.
    const header = /^\s*\[(\[?)([^\]]*)\]\]?\s*$/.exec(line);
    const name = header ? header[2].trim() || header[2].slice(-1) || header[1] : "";
    if (name) { inHooks = table.test(name); continue; }
    const entry = inHooks ? /^\s*command(?:Windows)?\s*=\s*("(?:[^"\\]|\\.)*")\s*$/.exec(line) : null;
    if (!entry) continue;
    try { commands.push(JSON.parse(entry[1]) as string); } catch { /* not a JSON-compatible string */ }
  }
  return commands;
}

function expand(file: string): string {
  return /^~[\\/]/.test(file) ? path.join(os.homedir(), file.slice(2)) : file;
}

function realOrResolved(file: string): string {
  const expanded = expand(file);
  try { return fs.realpathSync.native(expanded); } catch { return path.resolve(expanded); }
}

type HookScan = { present: boolean; deliver: number; wake: number; foreign: string[]; pinned?: string[]; checkouts?: string[];
  duplicates?: DuplicateHook[]; duplicatesUnknown?: true; pointer?: PointerStatus; stable?: number; legacy?: number; entry?: EntryStatus };
type DuplicatesOf = (settings: { hooks?: unknown }) => DuplicateHook[];

// The scan as reported, and the reason of its first foreign hook (not reported in the scan).
// form: the runtime's stable form, whose commands resolve through the pointer of the
// file's home. duplicatesOf: the scan for a script wired twice on one event (Claude only).
function scanHooks(
  file: string, repoRoot: string, commandsOf: (text: string) => string[], cache: SourceCache, form: StableForm, duplicatesOf?: DuplicatesOf,
): { scan: HookScan; reason?: string } | null {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { scan: { present: false, deliver: 0, wake: 0, foreign: [] } };
    return null;
  }
  let commands: string[];
  try { commands = commandsOf(text); } catch { return null; }
  // Issue #590. Claude settings: a control-plane script wired more than once on
  // one event (the entries of two installs from different roots, or a hand
  // copy). Codex commands name the stable entry point, never a root, and the
  // installer replaces its managed block whole, so only Claude is counted. The
  // scan reads the installer template of the running source; a source tree
  // without it leaves the duplicates unknown, which is not clean (#592).
  let duplicates: DuplicateHook[] = [];
  let duplicatesUnknown = false;
  try { duplicates = duplicatesOf ? duplicatesOf(JSON.parse(text) as { hooks?: unknown }) : []; } catch { duplicatesUnknown = true; }
  const counts = { deliver: 0, wake: 0 };
  const foreign = new Set<string>();
  const pinned = new Set<string>();
  const checkouts = new Set<string>();
  let reason: string | undefined;
  const home = path.dirname(file);
  const pointer = pointerRoot(form, home);
  const entry = entryStatus(form, home, pointer.root);
  // The entry directory must be the one of the canonical home: a link to the whole
  // home still binds, a linked entry directory (whose entry point would read another
  // home's pointer) does not. The file itself is checked without following a link.
  const entryDir = form.entryDir(realOrResolved(home));
  const forms = { stable: 0, legacy: 0 };
  const paths = commands.flatMap((command) => {
    const stable = stableCommand(form, command);
    if (form.legacy.test(command)) forms.legacy++;
    if (!stable) return hookPaths(command);
    forms.stable++;
    // Another home's entry point reads another pointer: never resolved through this one.
    if (path.basename(stable.entry) !== form.entryName || realOrResolved(path.dirname(stable.entry)) !== entryDir) {
      foreign.add(stable.entry); reason ??= `the entry point belongs to another ${form.label} home`; return [];
    }
    const kind = form.counted[stable.name];
    return kind && pointer.root && entry === "valid" ? [stableHook(pointer.root, kind)] : [];
  });
  for (const found of paths) {
    const kind = /deliver-hook\.mts$/.test(found) ? "deliver" : "wake";
    const expected = path.join(repoRoot, "modules", "control-plane", "node", `${kind}-hook.mts`);
    if (realOrResolved(found) === realOrResolved(expected)) { counts[kind]++; continue; }
    const same = sameSource(found, kind, cache);
    if ("reason" in same) { foreign.add(found); reason ??= same.reason; continue; }
    counts[kind]++;
    (same.kind === "pin" ? pinned : checkouts).add(found);
  }
  const scan = { present: true, ...counts, foreign: [...foreign], ...(pinned.size ? { pinned: [...pinned] } : {}),
    ...(checkouts.size ? { checkouts: [...checkouts] } : {}), ...(duplicates.length ? { duplicates } : {}),
    ...(duplicatesUnknown ? { duplicatesUnknown: true as const } : {}), pointer: pointer.status, ...forms, ...(forms.stable ? { entry } : {}) };
  return { scan, reason };
}

const UNVERIFIED = "no verified source identity";

// Issue #445, symmetric to #397: the hook file is the hook of a source root (a
// complete verified source pin under source-pins/, or a clean checkout) whose
// identity, commit and tree, matches the invoking source. A directory name
// alone is never source evidence. Any failure refuses, with its reason.
function sameSource(found: string, kind: "deliver" | "wake", cache: SourceCache): { kind: "pin" | "checkout" } | { reason: string } {
  try {
    const hook = fs.realpathSync.native(expand(found));
    if (!fs.statSync(hook).isFile()) return { reason: UNVERIFIED };
    const root = path.resolve(path.dirname(hook), "..", "..", "..");
    if (hook !== path.join(root, "modules", "control-plane", "node", `${kind}-hook.mts`)) return { reason: UNVERIFIED };
    const actual = cache.of(root);
    if (!actual || (actual.kind === "pin" && path.basename(path.dirname(root)) !== "source-pins")) return { reason: UNVERIFIED };
    const invoking = cache.invoking();
    if (!invoking) return { reason: UNVERIFIED };
    if (!invoking.verified) return { reason: "the invoking source has tracked changes" };
    if (!actual.verified) return { reason: "the hook's source has tracked changes" };
    const compared = compareSourceIdentity(invoking, actual);
    if (compared.status === "match") return { kind: actual.kind };
    if (compared.status === "mismatch") return { reason: compared.reason === "commit" ? "commit differs" : "source tree differs" };
    return { reason: UNVERIFIED };
  } catch { return { reason: UNVERIFIED }; }
}

type SourceCache = { invoking: () => SourceIdentity | undefined; of: (root: string) => SourceIdentity | undefined };

// Source identities of one run, read at most once per real root and only when
// a hook names another root; a failed read stays undefined for the run. A
// dirty checkout yields verified: false rather than an error.
export function sourceCache(repoRoot: string): SourceCache {
  const known = new Map<string, SourceIdentity | undefined>();
  const of = (root: string): SourceIdentity | undefined => {
    const key = realOrResolved(root);
    if (!known.has(key)) {
      let identity: SourceIdentity | undefined;
      try { identity = captureSourceIdentity(key, false); } catch { /* stays undefined */ }
      known.set(key, identity);
    }
    return known.get(key);
  };
  return { invoking: () => of(repoRoot), of };
}

// ok: at least one hook is installed, every hook command names this source,
// or a source pin or checkout of the same identity, every stable command has a
// usable pointer and entry point, and no control-plane script is wired twice on
// one event (#590), which an unreadable template leaves unknown, not clean (#592).
// deps.duplicatesOf: the duplicate scan, injectable for the unknown case.
export function checkHooks(files: { claude: string; codex: string }, repoRoot: string, deps: { duplicatesOf?: DuplicatesOf } = {}): Check {
  const cache = sourceCache(repoRoot);
  const claude = scanHooks(files.claude, repoRoot, claudeCommands, cache, CLAUDE, deps.duplicatesOf ?? duplicateControlPlaneHooks);
  const codex = scanHooks(files.codex, repoRoot, codexCommands, cache, CODEX);
  if (!claude || !codex) return { ok: false, detail: "a runtime configuration file is unreadable" };
  const foreign = claude.scan.foreign.length + codex.scan.foreign.length;
  const duplicatesUnknown = claude.scan.duplicatesUnknown === true;
  const duplicated = claude.scan.duplicates?.length ?? 0;
  const total = claude.scan.deliver + claude.scan.wake + codex.scan.deliver + codex.scan.wake + foreign;
  const stable = stableProblem(CLAUDE, claude.scan) ?? stableProblem(CODEX, codex.scan);
  let detail: string | undefined;
  if (foreign > 0) detail = `a hook command names another checkout: ${claude.reason ?? codex.reason ?? UNVERIFIED}`;
  else if (stable) detail = stable;
  else if (total === 0) detail = "no delivery or wake hook is installed";
  else if (duplicatesUnknown) detail = "the control-plane template of this source is unreadable; duplicates unknown";
  else if (duplicated > 0) detail = "a control-plane script is wired more than once on one event; run bootstrap/install.sh again";
  else detail = legacyNote(CLAUDE, claude.scan) ?? legacyNote(CODEX, codex.scan);
  return { ok: foreign === 0 && total > 0 && !stable && !duplicatesUnknown && duplicated === 0, checkout: repoRoot, claude: claude.scan, codex: codex.scan,
    ...(detail ? { detail } : {}) };
}

// Issue #408: whether the Codex config runs this checkout's delivery hook (or
// that of a source of the same identity) on PostToolUse, which records the tool
// boundaries that keep a running turn from reading idle. An unreadable config is false.
export function codexPostToolHookInstalled(codexConfig: string, repoRoot: string): boolean {
  return (scanHooks(codexConfig, repoRoot, (text) => codexCommands(text, "PostToolUse"), sourceCache(repoRoot), CODEX)?.scan.deliver ?? 0) > 0;
}
