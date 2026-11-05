#!/usr/bin/env node
// Issue #592. The stable entry point of the Claude Control Plane hooks, installed
// as <CLAUDE_HOME>/kherep/control-plane/claude-control-plane-hook.mts. Every
// control-plane command of settings.json names this file, so the commands stay
// the same across upgrades and across the roots an install runs from. It runs
// the hook of the source the installer last ran from, named by the pointer
// beside it, source.json, and fails closed without it: exit 1, one stderr line,
// no stdout, never exit 2 (which would block a prompt or wake a session). Node
// built-ins only: the source it runs is the one it has to find.
//
// Unlike the Codex entry point (codex/hooks/control-plane-hook.mts) it starts no
// second process: the hook is imported into this one and runs as its own main
// module (argv[1] is rewritten to the hook file first, so the hook's own main
// check holds). The wake listener runs for up to 25 hours and ends itself when
// its parent, Claude Code, is gone; it also reads the launch flags of its
// ancestors. In this process its parent, ancestry, stdin, signals and exit code
// are exactly those of a direct hook call. The check per run is the pointer's
// shape and the existence of the hook file (and of the manifest of a source
// pin); `kherep-node doctor` verifies the identity.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ENTRY_NAME = "claude-control-plane-hook.mts";
export const POINTER_NAME = "source.json";
// The only hooks this entry point runs. argv selects an entry, never a path.
const HOOKS: Readonly<Record<string, string>> = Object.freeze({
  deliver: "deliver-hook.mts", wake: "wake-hook.mts", attribution: "attribution-hook.mts",
});

export const POINTER_REASONS = Object.freeze({
  missing: "no control-plane source pointer",
  invalid: "the control-plane source pointer is invalid",
  name: "unknown hook name",
  "missing-manifest": "the pointer's source pin has no manifest",
  "missing-hook": "the pointer's source has no such hook",
  load: "the hook could not be loaded",
});
export type PointerReason = keyof typeof POINTER_REASONS;

// The same record the Codex entry point reads (codex/hooks/control-plane-hook.mts);
// codex/lib/control-plane-pointer.mts renders it for both.
export interface ControlPlanePointer { version: 1; root: string; commit?: string; kind: "pin" | "checkout"; verified: boolean }

export function pointerFile(claudeHome: string): string {
  return path.join(claudeHome, "kherep", "control-plane", POINTER_NAME);
}

const isFile = (file: string): boolean => {
  try { return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true; } catch { return false; }
};

export function readPointer(file: string): { pointer: ControlPlanePointer } | { reason: PointerReason } {
  let value: Partial<ControlPlanePointer> | null;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ControlPlanePointer> | null; }
  catch (error) { return { reason: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "invalid" }; }
  if (!value || value.version !== 1 || typeof value.root !== "string" || !path.isAbsolute(value.root)
    || (value.kind !== "pin" && value.kind !== "checkout") || typeof value.verified !== "boolean"
    || (value.commit !== undefined && (typeof value.commit !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value.commit)))) {
    return { reason: "invalid" };
  }
  return { pointer: value as ControlPlanePointer };
}

// The hook file the pointer names for `name`, or why there is none.
export function resolveHook(name: string | undefined, file: string): { hook: string; pointer: ControlPlanePointer } | { reason: PointerReason } {
  const read = readPointer(file);
  if ("reason" in read) return read;
  if (!name || !Object.hasOwn(HOOKS, name)) return { reason: "name" };
  const { root, kind } = read.pointer;
  if (kind === "pin" && !isFile(path.join(root, ".kherep-source.json"))) return { reason: "missing-manifest" };
  const hook = path.join(root, "modules", "control-plane", "node", HOOKS[name]);
  return isFile(hook) ? { hook, pointer: read.pointer } : { reason: "missing-hook" };
}

function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try { return [path.resolve(entry), fs.realpathSync(entry)].some((file) => import.meta.url === pathToFileURL(file).href); } catch { return false; }
}

if (isMainModule()) {
  const file = path.join(import.meta.dirname, POINTER_NAME);
  // The reason travels with the result: one line, the first line of a load error included.
  const fail = (reason: PointerReason, cause?: unknown): void => {
    const detail = cause === undefined ? "" : ` (${String((cause as Error)?.message ?? cause).split(/\r?\n/, 1)[0]})`;
    process.stderr.write(`kherep control-plane-hook: ${POINTER_REASONS[reason]}${detail}; pointer ${file}; run bootstrap/install.sh\n`);
    process.exitCode = 1;
  };
  const resolved = resolveHook(process.argv[2], file);
  if ("reason" in resolved) fail(resolved.reason);
  else {
    // From here on this process is the hook's: argv[1] the hook file, argv[2..] its
    // arguments (`--timeout 90000` for wake). stdin stays unread for the hook. Node
    // warns about type stripping once per process, so the hook's warning shows as
    // from a direct call and this entry adds none. A rejected import is a hook that
    // did not load or threw while loading; it exits 1, as a direct call would.
    process.argv.splice(1, process.argv.length - 1, resolved.hook, ...process.argv.slice(3));
    import(pathToFileURL(resolved.hook).href).catch((error: unknown) => fail("load", error));
  }
}
