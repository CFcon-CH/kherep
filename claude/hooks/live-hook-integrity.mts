#!/usr/bin/env node
/**
 * live-hook-integrity.mts  -  SessionStart hook, and the re-check of guard-dispatch
 *
 * Proves that every hook file wired in the LIVE settings, plus the transitive
 * closure of their relative imports under hooks/ (lib/hook-inventory.mts), can
 * load, and restores it from the versioned source when it cannot. A missing or
 * 0-byte lib kills its importer at import with exit 1, which Claude Code treats
 * as non-blocking (issue #273); a 0-byte guard runs, enforces nothing, exits 0.
 *
 * States, never merged (goldene Regel 12): OK, DEFEKT (absent, 0 bytes, rejected
 * by Node's parser, lib/hook-syntax.mts, issue #278), UNGEPRUEFT (the read or the
 * check failed). A restore counts only when MEASURED at the target: SHA-256 equal
 * to the source (goldene Regel 13). The source comes from lib/orchestra-checkout,
 * not the session cwd; the write (lib/restore-write.mts) lands in the checked
 * regular file or nowhere. A restore changes what the file imports, so the walk
 * is repeated, at most three passes, until it finds nothing new.
 * Own libs load dynamically (loadLibs, issue #279), so a broken one is reported.
 *
 * Heartbeat and coordination (issue #507, part 2): this hook is the one
 * integrity writer. kherep/hook-runtime/entry.mts admits it EXCLUSIVE on its
 * hooks directory before it loads anything, and every repair goes through the
 * runtime's durable intent (lib/integrity-run.mts). Only a run whose final
 * read-only proof passed (lib/integrity-proof.mts) writes <home>/.cache/
 * hook-integrity/heartbeat.json. Started without the runtime, for another
 * hooks directory, or next to a wired command that bypasses the runtime, it
 * reports and repairs nothing. `--trigger <source>` (guard-dispatch.mts, the
 * entry) prints plain lines instead of the SessionStart JSON. Any unexpected
 * error is reported, exit 0; silent at session start when everything is OK.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Restored } from "./lib/integrity-verdict.mts";
import type { RunLibs, WriterHold } from "./lib/integrity-run.mts";
import type { ScopePayload } from "./lib/workspace-scope.mts";

type Libs = RunLibs & typeof import("./lib/integrity-run.mts");
// The first lib that did not load or lacks a used function; `loaded` libs did.
type LoadFailure = { rel: string; why: string; loaded: number };

// Filled by loadLibs. A repair of an own lib needs the first RESTORE_LIBS of its steps
// and hook-inventory (step INVENTORY_LIBS) to check the wiring first.
const lib = {} as Libs;
const RESTORE_LIBS = 4;
const INVENTORY_LIBS = 5;
const TRIGGER_AT = process.argv.indexOf("--trigger");
const PLAIN = TRIGGER_AT >= 0;
const TRIGGER = PLAIN ? process.argv[TRIGGER_AT + 1] || "unnamed" : "session-start";
const runtime = (globalThis as Record<symbol, unknown>)[Symbol.for("kherep.hook-runtime")] as (WriterHold & { mode?: string }) | undefined;
const HOLD: WriterHold | null = runtime?.mode === "writer" ? runtime : null;
// A Node error code, else the error's class name, else "unknown"; never a message, which names paths (issue #564).
const codeOf = (error: unknown): string => { const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,40}$/.test(code) ? code : typeof name === "string" && /^[A-Za-z]{1,40}Error$/.test(name) ? name : "unknown"; };

// Dependency order, so a broken lib is named before the libs importing it.
// String literals on purpose: lib/hook-inventory.mts and the install manifest
// test see exactly this form. null when all are in.
async function loadLibs(): Promise<LoadFailure | null> {
  const steps: [string, () => Promise<object>, string[]][] = [
    ["lib/integrity-verdict.mts", () => import("./lib/integrity-verdict.mts"), ["classify", "restore", "journal"]],
    ["lib/workspace-scope.mts", () => import("./lib/workspace-scope.mts"), ["joinPathLike", "normalizePathLike"]],
    ["lib/orchestra-checkout.mts", () => import("./lib/orchestra-checkout.mts"), ["checkoutFor"]],
    ["lib/integrity-heartbeat.mts", () => import("./lib/integrity-heartbeat.mts"), ["invalidateHeartbeat", "writeHeartbeat"]],
    ["lib/hook-inventory.mts", () => import("./lib/hook-inventory.mts"), ["hookInventory", "wiredFiles"]],
    ["lib/hook-syntax.mts", () => import("./lib/hook-syntax.mts"), ["quietStripWarning", "syntaxVerdict", "esmParses", "cjsParses"]],
    ["lib/integrity-proof.mts", () => import("./lib/integrity-proof.mts"), ["finalProof"]],
    ["lib/integrity-passes.mts", () => import("./lib/integrity-passes.mts"), ["repairPasses"]],
    ["lib/integrity-run.mts", () => import("./lib/integrity-run.mts"), ["runIntegrity"]],
  ];
  for (const [index, [rel, load, used]] of steps.entries()) {
    let mod: Record<string, unknown>;
    try {
      mod = (await load()) as Record<string, unknown>;
    } catch (error) {
      return { rel, why: codeOf(error), loaded: index };
    }
    const missing = used.filter((fn) => typeof mod[fn] !== "function");
    if (missing.length) return { rel, why: `no function ${missing.join(", ")}`, loaded: index };
    Object.assign(lib, mod);
  }
  return null;
}

function emit(lines: string[]): void {
  if (!lines.length) return;
  if (PLAIN) return void process.stdout.write(lines.map((line) => `${line}\n`).join(""));
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `ORCHESTRA LIVE-HOOK-INTEGRITY:\n${lines.map((l) => `  - ${l}`).join("\n")}`,
      },
    })
  );
}

const realOrEmpty = (dir: string): string => {
  try { return fs.realpathSync(dir); } catch { return ""; }
};

// Why this run may not repair, or "" when it may. Settings that could not be read
// (notes), or none read at all, leave the wiring UNKNOWN, so an uncoordinated reader
// cannot be ruled out.
function gateOf(home: string, wiring: { uncoordinated: string[]; notes: string[]; readAny: boolean }): string {
  if (!HOLD) return "this run is not coordinated: start it through kherep/hook-runtime/entry.mts";
  if (realOrEmpty(`${home}/hooks`) !== HOLD.root) return "the coordinated hooks directory is not this installation's hooks/";
  if (wiring.notes.length) return "the live settings were not read completely, so the wiring is UNKNOWN";
  if (!wiring.readAny) return "no live settings could be read, so the wiring is UNKNOWN";
  const { uncoordinated } = wiring;
  if (uncoordinated.length) return `${uncoordinated.length} wired command(s) run hooks/ code outside kherep/hook-runtime/entry.mts`;
  return "";
}

// This hook without one of its libs: one line, journalled as kind "self". The lib
// is repaired next to this file only inside the runtime's hold on this directory,
// only when the libs that repair needs loaded, and only when the wiring passes the
// same gate as every other repair. It never publishes a heartbeat.
async function ownImportFailed({ rel, why, loaded }: LoadFailure, payload: ScopePayload | null, home: string): Promise<void> {
  const hooksDir = import.meta.dirname.replace(/\\/g, "/");
  const file = `${hooksDir}/${rel}`;
  const hold = HOLD && realOrEmpty(hooksDir) === HOLD.root ? HOLD : null;
  let result: Restored = { proven: false, why: "the restore itself needs integrity-verdict, workspace-scope, orchestra-checkout and integrity-heartbeat" };
  let gated = false;
  if (!hold) result = { proven: false, why: "this run is not coordinated on this hooks directory" };
  else if (loaded >= RESTORE_LIBS && loaded < INVENTORY_LIBS) {
    result = { proven: false, why: "the wiring cannot be checked without lib/hook-inventory.mts; the next installation restores it" };
  } else if (loaded >= INVENTORY_LIBS) {
    const normalized = lib.normalizePathLike(home);
    const gate = gateOf(normalized, lib.wiredFiles(normalized));
    gated = !!gate;
    const blocked = gate || lib.invalidateHeartbeat(home);
    result = blocked ? { proven: false, why: blocked }
      : await lib.restore(lib, hold, file, rel, lib.checkoutFor(payload, normalized));
  }
  // Without integrity-verdict there is no journal function to call; outside the hold, or
  // where the gate refuses every repair, no journal at all (as in the ordinary run).
  if (loaded > 0 && !gated && hold?.holding()) lib.journal(home, {
    ts: new Date().toISOString(), trigger: TRIGGER, file: rel, path: file, state: "DEFEKT", reason: why, kind: "self",
    importedBy: ["live-hook-integrity.mts"],
    sha256After: result.sha || null, restoreProven: result.proven, restoreDetail: result.proven ? undefined : result.why,
  });
  const outcome = result.proven
    ? `RESTORED from the repo, verified at the target (sha256 ${result.sha!.slice(0, 12)}); the next session checks again`
    : `NOT restored (${result.why})`;
  emit([`own import ${rel} cannot be loaded (${why}); nothing was verified this session -> ${outcome}`,
    ...(PLAIN ? [`heartbeat not written (own import ${rel} cannot be loaded)`] : [])]);
}

async function main(): Promise<void> {
  let payload: ScopePayload | null = {};
  try {
    payload = JSON.parse((await (await import("./lib/stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8") || "{}") as ScopePayload | null;
  } catch {
    payload = {};
  }
  const rawHome = process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
  const failed = await loadLibs();
  if (failed) return ownImportFailed(failed, payload, rawHome);
  lib.quietStripWarning();
  const home = lib.normalizePathLike(rawHome);
  const { files, notes, readAny, uncoordinated } = lib.wiredFiles(home);
  const lines = notes.slice();
  if (!readAny && !files.length) {
    lines.push("no live settings could be read in this home, so WHICH hooks are wired is UNKNOWN here");
  }
  if (!files.length) {
    if (PLAIN) lines.push("heartbeat not written (no hook file is wired)");
    return emit(lines);
  }
  await lib.runIntegrity({ lib, hold: HOLD, gate: gateOf(home, { uncoordinated, notes, readAny }), files, notes, lines, payload, home, trigger: TRIGGER, plain: PLAIN });
  emit(lines);
}

main()
  .catch((error: unknown) => {
    try {
      emit([`the integrity check itself failed (${codeOf(error)}); nothing was verified`]);
    } catch {
      /* never break session start */
    }
  })
  .finally(() => {
    HOLD?.end();
    process.exit(0);
  });
