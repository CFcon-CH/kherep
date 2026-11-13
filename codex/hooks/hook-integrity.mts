#!/usr/bin/env node
/**
 * hook-integrity.mts  -  Codex SessionStart hook (issue #275), the counterpart of
 * claude/hooks/live-hook-integrity.mts, which runs only when a Claude session
 * starts. Wired LAST in the Maestro SessionStart group: trust keys are positional.
 * What it checks and where each file comes from: hook-integrity-sources.mts; the
 * repair of one file: hook-integrity-repair.mts (issue #533). Own libs and both
 * modules load dynamically, so a broken one is reported (kind "self"). Cannot
 * block: silent when OK, always exit 0.
 *
 * Issue #507, part 3. Codex has no hook runtime, so before anything is restored
 * or journalled, own libs included, the hook takes run.lock (lib/integrity-
 * heartbeat.mts: an EXCLUSIVE SQLite transaction the OS releases with this
 * process); without it, it reports and changes nothing. It removes the heartbeat
 * before its first repair, walks the closure again after each repair pass
 * (lib/integrity-passes.mts, at most three), checks the live closure once more
 * read-only and writes <CODEX_HOME>/.cache/hook-integrity/heartbeat.json only
 * when all of that passed, with the fd-bound record of the three dispatcher files
 * (issue #507, part 4). `--trigger <source>` (the re-check of the hook adapter or
 * the shell dispatcher) prints plain lines instead of the SessionStart JSON.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { HookFile, InventoryEntry } from "../../claude/hooks/lib/hook-inventory.mts";
import type { PeerTuple, RunLock } from "../../claude/hooks/lib/integrity-heartbeat.mts";
import type { ScopePayload } from "../../claude/hooks/lib/workspace-scope.mts";
import type { Restored } from "./hook-integrity-repair.mts";

export type Libs = typeof import("../../claude/hooks/lib/workspace-scope.mts") & typeof import("../../claude/hooks/lib/orchestra-checkout.mts") &
  typeof import("../../claude/hooks/lib/restore-write.mts") & typeof import("../../claude/hooks/lib/integrity-heartbeat.mts") &
  typeof import("../../claude/hooks/lib/hook-inventory.mts") & typeof import("../../claude/hooks/lib/hook-syntax.mts") &
  typeof import("../../claude/hooks/lib/integrity-verdict.mts") & typeof import("../../claude/hooks/lib/integrity-passes.mts");
type Own = typeof import("./hook-integrity-repair.mts") & typeof import("./hook-integrity-sources.mts");
// The first step that did not load or lacks a used function; `loaded` steps did. file/from: the installed copy and its source.
type LoadFailure = { rel: string; why: string; loaded: number; file: string; from: string };

const SELF = "kherep-maestro/codex-hook-integrity.mts";
// A Node error code, else the error's class name, else "unknown"; never a message, which names paths (issue #564).
const errorCode = (error: unknown): string => { const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,40}$/.test(code) ? code : typeof name === "string" && /^[A-Za-z]{1,40}Error$/.test(name) ? name : "unknown"; };
// The bytes, or the error code that stopped the read.
function read(file: string | number): Buffer | string {
  try { return fs.readFileSync(file); } catch (error) { return errorCode(error); }
}
// Filled by loadLibs. A restore needs only the first RESTORE_LIBS of its steps, run.lock included.
export const lib = {} as Libs;
// The own modules, in an object of their own: integrity-verdict.mts exports a restore and a journal too (issue #533).
export const own = {} as Own;
const RESTORE_LIBS = 4;
const LIB_DIR = fs.existsSync(path.join(import.meta.dirname, "lib"))
  ? path.join(import.meta.dirname, "lib") : path.resolve(import.meta.dirname, "..", "..", "claude", "hooks", "lib");
const TRIGGER_AT = process.argv.indexOf("--trigger");
const PLAIN = TRIGGER_AT >= 0;
const TRIGGER = PLAIN ? process.argv[TRIGGER_AT + 1] || "unnamed" : "session-start";
const LOST = "the run lock was lost";
// Issue #533. Loaded right after the RESTORE_LIBS libs: the repair first, so a broken sources module is restored.
const OWN_STEPS: [string, () => Promise<object>, string[]][] = [
  ["hook-integrity-repair.mts", () => import("./hook-integrity-repair.mts"), ["restore", "journal", "checkoutOf", "entryChecker", "sourceReaders"]],
  ["hook-integrity-sources.mts", () => import("./hook-integrity-sources.mts"), ["sourceOf"]],
];

// Dependency order, so a broken lib is named before the libs importing it.
export async function loadLibs(): Promise<LoadFailure | null> {
  const steps: [string, string[]][] = [
    ["workspace-scope.mts", ["isWithinPath", "joinPathLike", "normalizePathLike"]], ["orchestra-checkout.mts", ["checkoutFor", "isCheckout"]],
    ["restore-write.mts", ["writeExact"]], ["integrity-heartbeat.mts", ["takeRunLock", "invalidateHeartbeat", "writeHeartbeat", "provenPeer"]],
    ["hook-inventory.mts", ["hookInventory"]], ["hook-syntax.mts", ["syntaxVerdict"]],
    ["integrity-verdict.mts", ["classify"]], ["integrity-passes.mts", ["repairPasses", "finalPass"]],
  ];
  const libStep = ([name, used]: [string, string[]]) => ({ rel: `lib/${name}`, used, file: path.join(LIB_DIR, name), from: `claude/hooks/lib/${name}`,
    into: lib as object, load: () => import(pathToFileURL(path.join(LIB_DIR, name)).href) as Promise<object> });
  const ownSteps = OWN_STEPS.map(([name, load, used]) => ({ rel: name, used, file: path.join(import.meta.dirname, name), from: `codex/hooks/${name}`, into: own, load }));
  const all = [...steps.slice(0, RESTORE_LIBS).map(libStep), ...ownSteps, ...steps.slice(RESTORE_LIBS).map(libStep)];
  for (const [index, { rel, used, file, from, into, load }] of all.entries()) {
    let mod: Record<string, unknown>;
    try { mod = (await load()) as Record<string, unknown>; } catch (error) {
      return { rel, file, from, why: errorCode(error), loaded: index };
    }
    const missing = used.filter((fn) => typeof mod[fn] !== "function");
    if (missing.length) return { rel, file, from, why: `no function ${missing.join(", ")}`, loaded: index };
    Object.assign(into, mod);
  }
  return null;
}

// The double-quoted parts of every `command` in a [[hooks.<event>.hooks]] table:
// a basic string is decoded as JSON, a literal string taken raw. Needs no lib.
export function hookCommandParts(config: string): string[] {
  const parts: string[] = [];
  let inHook = false;
  for (const line of config.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) inHook = /^\s*\[\[\s*hooks\.[^\]]+\.hooks\s*\]\]/.test(line);
    const value = inHook ? /^\s*command\s*=\s*(\S.*)?$/.exec(line)?.[1] : undefined;
    if (!value) continue;
    let text = /^'([^']*)'/.exec(value)?.[1] || "";
    const basic = /^"((?:[^"\\]|\\.)*)"/.exec(value)?.[1];
    try { if (basic !== undefined) text = JSON.parse(`"${basic}"`) as string; } catch { continue; }
    for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)"/g)) parts.push(match[1].replace(/\\"/g, '"'));
  }
  return parts;
}

// config.toml may name the home through a symlink (macOS /var -> /private/var) while
// hooksDir comes from this file's real path: a part under another spelling of the
// same directory is mapped onto hooksDir by the real path of its directory.
const realOrNull = (p: string): string | null => { try { return lib.normalizePathLike(fs.realpathSync(p)); } catch { return null; } };
function underHooksDir(part: string, hooksDir: string, realHooks: string | null): string {
  if (lib.isWithinPath(part, hooksDir) || !realHooks) return part;
  const realDir = realOrNull(path.dirname(part));
  const real = realDir && `${realDir}/${path.basename(part)}`;
  return real && lib.isWithinPath(real, realHooks) ? `${hooksDir}${real.slice(realHooks.length)}` : part;
}

export function wiredHookFiles(parts: string[], hooksDir: string): HookFile[] {
  const found = new Map<string, HookFile>();
  const realHooks = realOrNull(hooksDir);
  for (const file of parts.map((part) => underHooksDir(lib.normalizePathLike(part), hooksDir, realHooks))) {
    if (!/\.(?:js|mts)$/i.test(file) || !lib.isWithinPath(file, hooksDir) || file.length <= hooksDir.length) continue;
    found.set(file.toLowerCase(), { file, rel: file.slice(hooksDir.length + 1) });
  }
  return [...found.values()];
}

// The checkout to restore from (hook-integrity-repair.mts), after loadLibs.
export const checkoutOf = (parts: string[], payload: ScopePayload | null, env: NodeJS.ProcessEnv = process.env, home?: string): string =>
  own.checkoutOf(lib, parts, payload, env, home);

function emit(lines: string[]): void {
  if (!lines.length) return;
  if (PLAIN) return void process.stdout.write(lines.map((line) => `${line}\n`).join(""));
  const more = lines.length > 1 ? ` (+${lines.length - 1} more)` : "";
  const additionalContext = `KHEREP CODEX HOOK-INTEGRITY:\n${lines.map((l) => `  - ${l}`).join("\n")}`;
  process.stdout.write(JSON.stringify({ systemMessage: `Kherep hook integrity: ${lines[0]}${more}`,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
}

const outcome = (result: Restored): string => result.proven
  ? `RESTORED from the repo, verified at the target (sha256 ${result.sha!.slice(0, 12)})`
  : `NOT restored (${result.why}). ENFORCEMENT IS OFF for this hook`;

// This hook without one of its libs: one line. The lib is restored, after the
// heartbeat is gone, and journalled as kind "self" (with this file's own journal:
// integrity-verdict.mts may be the broken one) only under run.lock, and only when
// the libs the restore needs loaded. It never writes a heartbeat.
function ownImportFailed({ rel, why, loaded, file: at, from }: LoadFailure, payload: ScopePayload | null, home: string, parts: string[],
  lock: RunLock | string | null): string[] {
  const file = at.replace(/\\/g, "/");
  let result: Restored;
  if (!lock || loaded < RESTORE_LIBS) {
    result = { proven: false, why: "the restore itself needs workspace-scope, orchestra-checkout, restore-write and integrity-heartbeat (run.lock)" };
  } else if (typeof own.restore !== "function") {
    result = { proven: false, why: "the restore itself needs hook-integrity-repair.mts" };
  } else if (typeof lock === "string") {
    result = { proven: false, why: lock };
  } else {
    const blocked = lock.holding() ? lib.invalidateHeartbeat(home) : LOST;
    result = blocked ? { proven: false, why: blocked }
      : own.restore(lib, file, from, checkoutOf(parts, payload, process.env, home), `${lib.normalizePathLike(home)}/hooks`);
    if (lock.holding()) own.journal(home, {
      ts: new Date().toISOString(), trigger: TRIGGER, file: `kherep-maestro/${rel}`, path: file, state: "DEFEKT", reason: why, kind: "self",
      importedBy: [SELF], sha256After: result.sha || null, restoreProven: result.proven, restoreDetail: result.proven ? undefined : result.why,
    });
  }
  return [`own import ${rel} cannot be loaded (${why}); nothing was verified this session -> ${outcome(result)}`,
    ...(PLAIN ? [`heartbeat not written (own import ${rel} cannot be loaded)`] : [])];
}

// The install this file belongs to; run from anywhere else, CODEX_HOME or ~/.codex.
function codexHome(): string {
  const dir = import.meta.dirname;
  if (path.basename(dir) === "kherep-maestro" && path.basename(path.dirname(dir)) === "hooks") return path.dirname(path.dirname(dir));
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

// One run under run.lock: the repair passes, the final read-only pass, the heartbeat.
async function check(lock: RunLock, payload: ScopePayload | null, home: string, parts: string[]): Promise<string[]> {
  const hooksDir = `${lib.normalizePathLike(home)}/hooks`;
  const realHooks = realOrNull(hooksDir) ?? hooksDir;
  const repoRoot = checkoutOf(parts, payload, process.env, home);
  const wired = wiredHookFiles(parts, hooksDir);
  const lines = wired.length ? [] : ["no hook file under hooks/ is wired in config.toml, so WHICH hooks run is UNKNOWN here"];
  let unproven = wired.length ? "" : "no wired file";
  const ctx = { home, hooksDir, repoRoot, lock, trigger: TRIGGER, lines, lost: LOST, sourceOf: own.sourceOf, COMPUTED: own.COMPUTED,
    computedImports: own.computedImports, outcome, realOrNull };
  const { liveOnly, readSource } = own.sourceReaders(lib, ctx);
  const checkOne = own.entryChecker(lib, ctx);
  const walk = (reader: typeof readSource) => (): InventoryEntry[] => lib.hookInventory(wired, hooksDir, reader, realHooks);
  const passes = await lib.repairPasses({ walk: walk(readSource), checkOne });
  unproven ||= passes.unproven;
  // A dispatcher's record comes from its own fd-bound snapshot of the bytes judged, never from
  // classify's stat; a dispatcher without one is re-checked by the other on its next call.
  const peers: Record<string, PeerTuple> = {};
  if (!unproven) unproven = await lib.finalPass({ walk: walk(liveOnly), expected: passes.inventory, classify: async (entry) => {
    const verdict = await lib.classify(lib, entry.file, entry.wired ? "wired" : "imported");
    const peer = verdict.state === "OK" && own.DISPATCHERS.has(entry.rel) ? await lib.provenPeer(entry.file, lib.syntaxVerdict) : null;
    if (peer) peers[path.basename(entry.rel)] = peer;
    return verdict;
  } });
  if (!unproven && !lock.holding()) unproven = LOST;
  const files = passes.inventory.length;
  if (!unproven) unproven = lib.writeHeartbeat(home, { trigger: TRIGGER, runtime: "codex", files, peers });
  if (PLAIN) lines.push(unproven ? `heartbeat not written (${unproven})` : `all ${files} files OK (${passes.restored} restored), heartbeat refreshed`);
  return lines;
}

async function main(): Promise<void> {
  let payload: ScopePayload | null = {};
  try { payload = JSON.parse(String(read(0)) || "{}") as ScopePayload | null; } catch { /* no payload: no cwd */ }
  const home = codexHome();
  const failed = await loadLibs();
  const config = read(path.join(home, "config.toml"));
  const parts = typeof config === "string" ? [] : hookCommandParts(config.toString("utf8"));
  // Ownership before any mutation: without run.lock nothing is restored, journalled or published.
  const lock = failed && failed.loaded < RESTORE_LIBS ? null : lib.takeRunLock(home);
  let lines: string[] = [];
  try {
    if (failed) lines = ownImportFailed(failed, payload, home, parts, lock);
    else if (typeof lock === "string" || !lock) lines = [`${lock}; nothing checked, heartbeat not written`];
    else if (typeof config === "string") {
      lines = [`config.toml unreadable (${config}), so WHICH hooks are wired is UNKNOWN here`,
        ...(PLAIN ? ["heartbeat not written (config.toml unreadable)"] : [])];
    } else lines = await check(lock, payload, home, parts);
  } finally {
    if (lock && typeof lock !== "string") lock.release();
  }
  emit(lines);
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory matches only after realpath; both spellings count.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try { return [path.resolve(entry), fs.realpathSync(entry)].some((file) => import.meta.url === pathToFileURL(file).href); } catch { return false; }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    try { emit([`the integrity check itself failed (${errorCode(error)}); nothing was verified`]); } catch { /* never break session start */ }
  }).finally(() => process.exit(0));
}
