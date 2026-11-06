#!/usr/bin/env node
// Hook commands that run a retired or missing Claude-home script (issue #252).
//
// A host can carry a second, legacy wiring of its hooks in groups of their own:
// `node ~/.claude/hooks/<name>.js`. mergeSettings keeps every host hook it does
// not manage, so once retired.txt parks such a file the command stays wired and
// fails with "Cannot find module" on every event. The settings render takes
// these commands out of the existing settings before the merge; drift-check.sh
// reports any wired command whose Claude-home script is retired or missing.
//
// Only commands whose first token is `node` followed directly by the script are
// recognised, and only that script counts: a command that names a retired file
// as an argument runs another script and stays. `node <flags> script`,
// `ENV=x node script`, `node.exe`, a quoted node path and `$CLAUDE_CONFIG_DIR`
// forms are not matched, so they are neither unwired nor reported.
// The Claude home is its absolute path in drive (C:\ or C:/) or Git Bash (/c/)
// form. `~/.claude`, `$HOME/.claude`, `${HOME}/.claude` and
// `%USERPROFILE%/.claude` count only while the Claude home is the default
// `<HOME>/.claude`; with another CLAUDE_HOME they name a different directory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { toBashPath } from "./render-profile-paths.mts";
import type { HookCommand, HookEntry, Settings } from "./render-profile-settings.mts";
import { errorMessage } from "./shape.mts";

const RETIRED_MANIFEST = path.join(import.meta.dirname, "manifest", "retired.txt");
const HOME_TOKENS = ["~/.claude/", "$HOME/.claude/", "${HOME}/.claude/", "%USERPROFILE%/.claude/"];
// The home `~` and `$HOME` expand to in the shell that runs the hook.
export const userHomeNow = (): string => process.env.HOME || os.homedir();

export interface HookFinding { event: string; command: string; }

// Claude-home entries of retired.txt. install-retired.sh validates the manifest
// before anything moves; a project/ entry names a workspace file, not a hook.
export function readRetiredHomeEntries(file: string = RETIRED_MANIFEST): Set<string> {
  return new Set(fs.readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.split(" ")[0])
    .filter((entry) => entry && !entry.startsWith("#") && !entry.startsWith("project/")));
}

// One comparable form of a path: forward slashes and the Git Bash drive form
// (C:/x and /c/x have the same length), lowercased when it is a drive path.
function comparable(value: string): string {
  const bash = toBashPath(value);
  return /^\/[A-Za-z](?:\/|$)/.test(bash) ? bash.toLowerCase() : bash;
}

const absoluteHome = (claudeHome: string): string => `${comparable(claudeHome).replace(/(?<!\/)\/+$/, "")}/`;

// The shell spellings of the default Claude home; none when CLAUDE_HOME is another directory.
function homeTokenPrefixes(claudeHome: string, userHome: string): string[] {
  return absoluteHome(claudeHome) === `${comparable(userHome).replace(/(?<!\/)\/+$/, "")}/.claude/` ? HOME_TOKENS : [];
}

const homePrefixes = (claudeHome: string, userHome: string): string[] =>
  [absoluteHome(claudeHome), ...homeTokenPrefixes(claudeHome, userHome)];

// A path relative to the first matching prefix, or undefined.
function relativeUnder(token: string | undefined, prefixes: string[]): string | undefined {
  const script = token?.replace(/\\/g, "/");
  if (!script) return undefined;
  for (const prefix of prefixes) {
    if (comparable(script.slice(0, prefix.length)) !== prefix) continue;
    const rel = path.posix.normalize(script.slice(prefix.length));
    return rel === "." || rel === ".." || rel.startsWith("../") ? undefined : rel;
  }
  return undefined;
}

// The script a `node <script>` command runs relative to the first matching
// prefix, or undefined. An unquoted script ends at whitespace or a shell operator.
function scriptUnder(command: unknown, prefixes: string[]): string | undefined {
  if (typeof command !== "string") return undefined;
  const match = /^\s*node\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/.exec(command);
  return relativeUnder(match?.[1] ?? match?.[2] ?? match?.[3], prefixes);
}

// Issue #507. The scripts a `node <script> <args>` command passes as arguments,
// relative to the prefixes: the guards guard-dispatch.mts runs.
function argumentScriptsUnder(command: unknown, prefixes: string[]): string[] {
  if (typeof command !== "string" || scriptUnder(command, prefixes) === undefined) return [];
  return [...command.matchAll(/"([^"]+)"|'([^']+)'|([^\s;&|<>]+)/g)].slice(2)
    .map((token) => token[1] ?? token[2] ?? token[3])
    .filter((token) => /\.(?:js|mjs|cjs|mts)$/.test(token))
    .flatMap((token) => relativeUnder(token, prefixes) ?? []);
}

// The script a `node <script>` command runs, relative to the Claude home, or
// undefined when the command runs something else or a script outside it.
export function claudeHomeScript(
  command: unknown, claudeHome: string, userHome: string = userHomeNow(),
): string | undefined {
  return scriptUnder(command, homePrefixes(claudeHome, userHome));
}

// Removes every hook command the predicate selects, from any event and group.
// A group left without hooks goes with them; everything else stays as written.
function removeHooks(
  existing: Settings, select: (event: string, command: unknown, hook: HookCommand | undefined) => boolean,
): { settings: Settings; removed: HookFinding[] } {
  const removed: HookFinding[] = [];
  if (!existing.hooks || typeof existing.hooks !== "object") return { settings: existing, removed };
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(existing.hooks)) {
    if (!Array.isArray(entries)) { hooks[event] = entries; continue; }
    hooks[event] = entries.flatMap((entry) => {
      if (!entry || !Array.isArray(entry.hooks)) return [entry];
      const remaining = entry.hooks.filter((hook) => {
        if (!select(event, hook?.command, hook)) return true;
        removed.push({ event, command: String(hook.command) });
        return false;
      });
      if (remaining.length === entry.hooks.length) return [entry];
      return remaining.length ? [{ ...entry, hooks: remaining }] : [];
    });
  }
  return removed.length ? { settings: { ...existing, hooks }, removed } : { settings: existing, removed };
}

// Removes every command that runs a retired script.
export function retireHookCommands(
  existing: Settings, retired: ReadonlySet<string>, claudeHome: string, userHome: string = userHomeNow(),
): { settings: Settings; removed: HookFinding[] } {
  return removeHooks(existing, (_event, command) => {
    const rel = claudeHomeScript(command, claudeHome, userHome);
    return rel !== undefined && retired.has(rel);
  });
}

const scriptStem = (rel: string): string => rel.replace(/\.(?:js|mjs|cjs|mts)$/, "");

// Review of #254. The template decides at which events a managed hook runs, but
// mergeHooks replaces only in a group the template still has (#568): an entry the
// installer wrote at an event the template dropped would run on. Such an entry
// (the hook under the absolute Claude home, .js and .mts folded) is removed; a
// hand-written ~/.claude form stays unless it is a raw command for a main the
// template runs through kherep/hook-runtime/entry.mts or passes to the dispatcher
// behind it (then it is that entry's duplicate); every unmanaged hook stays.
// Issue #507. A script the template passes as an argument (a guard that
// guard-dispatch.mts runs) is managed "<event> via <first script>". A direct
// entry for it is removed, or it would run a second time next to the dispatcher.
// Part 2: a command through kherep/hook-runtime/entry.mts counts by the main it
// starts. A raw command for a main the template runs through the entry, or an
// entry command at an event the template has dropped, is removed.
const ENTRY = "kherep/hook-runtime/entry";
// A home-token command goes only as exactly `node <script>`: one closed quote or one
// plain word, nothing glued to it, no argument, operator, redirect or line break,
// in a hook that is the bare { type, command } the old installer wrote. Below the
// token the path is a plain literal one: no expansion, glob or escape, and no `.`,
// `..` or empty segment, so neither the shell nor normalising can change it.
const SINGLE_INVOCATION = /^[ \t]*node[ \t]+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;&|<>"'`]+))[ \t]*$/;
const LITERAL_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const bareHook = (hook: HookCommand | undefined): boolean =>
  hook?.type === "command" && Object.keys(hook).every((key) => key === "type" || key === "command");
function literalTokenScript(command: unknown, tokens: string[]): boolean {
  const match = typeof command === "string" ? SINGLE_INVOCATION.exec(command) : null;
  const script = (match?.[1] ?? match?.[2] ?? match?.[3])?.replace(/\\/g, "/");
  const token = script === undefined ? undefined : tokens.find((prefix) => script.startsWith(prefix));
  const rest = token === undefined ? undefined : script!.slice(token.length);
  return rest !== undefined && LITERAL_PATH.test(rest) && path.posix.normalize(rest) === rest
    && !rest.split("/").some((segment) => segment === "." || segment === "..");
}
function hookOf(command: unknown, prefixes: string[]): { rel: string; main: string; wrapped: boolean; args: string[] } | undefined {
  const rel = scriptUnder(command, prefixes);
  if (rel === undefined) return undefined;
  const args = argumentScriptsUnder(command, prefixes);
  const stem = scriptStem(rel);
  const [first, ...rest] = args;
  if (stem !== ENTRY || first === undefined) return { rel, main: stem, wrapped: false, args };
  return { rel: first, main: scriptStem(first), wrapped: true, args: rest };
}

export function unwireMovedHooks(
  existing: Settings, source: Settings, claudeHome: string, userHome: string = userHomeNow(),
): { settings: Settings; removed: Array<HookFinding & { managedAt: string[] }> } {
  // The template is rendered with the absolute home; a token form in it is not managed.
  const prefixes = [absoluteHome(claudeHome)];
  const tokens = homeTokenPrefixes(claudeHome, userHome);
  const raw = new Map<string, Set<string>>();
  const wrapped = new Map<string, Set<string>>();
  const via = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, stem: string, label: string): void => {
    map.set(stem, (map.get(stem) || new Set()).add(label));
  };
  for (const [event, entries] of Object.entries(source.hooks || {})) {
    for (const hook of (Array.isArray(entries) ? entries : []).flatMap((entry) => entry?.hooks || [])) {
      const found = hookOf(hook?.command, prefixes);
      if (found === undefined) continue;
      add(found.wrapped ? wrapped : raw, found.main, event);
      for (const arg of found.args) add(via, scriptStem(arg), `${event} via ${found.rel}`);
    }
  }
  const managedAt = (main: string): string[] =>
    [...new Set([...(raw.get(main) || []), ...(wrapped.get(main) || [])]), ...(via.get(main) || [])];
  const classify = (command: unknown) => {
    const direct = hookOf(command, prefixes);
    if (direct) return { ...direct, viaToken: false };
    const token = literalTokenScript(command, tokens) ? hookOf(command, tokens) : undefined;
    return token && { ...token, viaToken: true };
  };
  const result = removeHooks(existing, (event, command, hook) => {
    const found = classify(command);
    if (found === undefined) return false;
    const movedAway = managedAt(found.main).length > 0 && !(found.wrapped ? wrapped : raw).get(found.main)?.has(event);
    // Issue #507 follow-up: a ~/.claude form goes only as the raw duplicate of an entry.
    if (found.viaToken) return bareHook(hook) && !found.wrapped && (wrapped.has(found.main) || via.has(found.main)) && movedAway;
    return movedAway;
  });
  return {
    settings: result.settings,
    removed: result.removed.map((item) => ({ ...item, managedAt: managedAt(classify(item.command)!.main) })),
  };
}

// Wired commands whose Claude-home script, or a Claude-home script it passes as
// an argument (a guard guard-dispatch.mts runs, issue #507), is retired or does
// not exist.
export function danglingHookCommands(
  settings: Settings, retired: ReadonlySet<string>, claudeHome: string, userHome: string = userHomeNow(),
  exists: (file: string) => boolean = fs.existsSync,
): HookFinding[] {
  const found: HookFinding[] = [];
  const prefixes = homePrefixes(claudeHome, userHome);
  const dangles = (rel: string): boolean => retired.has(rel) || !exists(path.join(claudeHome, rel));
  for (const [event, entries] of Object.entries(settings.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const hook of (Array.isArray(entry?.hooks) ? entry.hooks : [])) {
        const rel = scriptUnder(hook?.command, prefixes);
        if (rel === undefined) continue;
        if ([rel, ...argumentScriptsUnder(hook?.command, prefixes)].some(dangles)) {
          found.push({ event, command: String(hook.command) });
        }
      }
    }
  }
  return found;
}

// drift-check.sh: `dangling <settings.json> <claude-home>` prints one
// DANGLING-HOOK line per finding; exit 0 clean, 3 findings, 1 error.
function main(argv: string[]): number {
  const [mode, file, claudeHome] = argv;
  if (mode !== "dangling" || !file || !claudeHome) throw new Error("usage: dangling <settings.json> <claude-home>");
  if (!fs.existsSync(file)) return 0;
  const settings = JSON.parse(fs.readFileSync(file, "utf8")) as Settings;
  const found = danglingHookCommands(settings, readRetiredHomeEntries(), claudeHome);
  for (const item of found) console.log(`DANGLING-HOOK ${item.event} ${item.command}`);
  return found.length ? 3 : 0;
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(`FATAL: hook check failed: ${errorMessage(error)}`); process.exitCode = 1; }
}
