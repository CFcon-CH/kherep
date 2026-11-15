#!/usr/bin/env node
/**
 * drift-check-nudge.mts  -  SessionStart hook
 *
 * Makes repo-vs-live drift visible without paying for it at session start.
 * bootstrap/drift-check.sh needs ~2 minutes on Windows, so this hook never
 * waits for it: it reads the report the previous run left behind and speaks up
 * when that report is stale or shows drift.
 *
 * Report (written by bootstrap/drift-check.sh):
 *   <CLAUDE_HOME>/.cache/drift-check/last-report.txt
 *
 * It warns when the report is missing, older than MAX_AGE_HOURS, or contains
 * DRIFT / MISSING lines. Silent when the last run was recent and clean.
 *
 * SELF-REFRESH (2026-08-05): when the report is missing or stale, the hook also
 * spawns drift-check.sh DETACHED and returns immediately. Session start stays
 * instant; the report is fresh for the next one. The earlier note here said
 * running the check from a hook was not an option - that held for a synchronous
 * run and no longer applies to a detached one. Without this the report only ever
 * refreshes when a human remembers, which is exactly how two wired guards were
 * able to sit broken undetected.
 *
 * The alternative was an OS-level scheduled task per machine. Rejected: it lives
 * outside the repo, needs separate Windows and macOS mechanisms, is not
 * versioned or testable, and a fresh box silently lacks it.
 *
 * Refresh is skipped when a run is already in progress, when the workspace has
 * no kherep checkout, or when KHEREP_DRIFT_AUTOREFRESH=0.
 *
 * Fail-safe: any error exits 0 silently. Never blocks a session start.
 *
 * GRUND: the Maestro banner fix lived only in ~/.claude for two days while the
 * repo kept the superseded version. drift-check.sh would have caught it on day
 * one - nothing ever ran it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { isKherepScope, joinPathLike, productEnv, type ScopePayload } from "./lib/workspace-scope.mts";
import { checkoutFor } from "./lib/orchestra-checkout.mts";

// A day is short enough that a fix cannot quietly live only in ~/.claude across
// a weekend, and long enough that a normal working day nudges at most once.
const MAX_AGE_HOURS = Number(productEnv(process.env, "DRIFT_MAX_AGE_HOURS") ?? 24);

// drift-check.sh stages its output as .last-report.XXXXXX in the same directory
// and renames only when complete, so a fresh temp file means a run is in
// flight. Older leftovers are treated as crash debris, not as a live run.
const IN_FLIGHT_MINUTES = 30;

function cacheDir(): string {
  const home = process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
  return path.join(home, ".cache", "drift-check");
}

function reportPath(): string {
  return path.join(cacheDir(), "last-report.txt");
}

function refreshInFlight(): boolean {
  try {
    const cutoff = Date.now() - IN_FLIGHT_MINUTES * 60_000;
    return fs
      .readdirSync(cacheDir())
      .filter((name) => name.startsWith(".last-report."))
      .some((name) => {
        try {
          return fs.statSync(path.join(cacheDir(), name)).mtimeMs > cutoff;
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

function driftScriptFor(payload: ScopePayload | null): string {
  const root = checkoutFor(payload, process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude"));
  if (!root) return "";
  const script = joinPathLike(root, "bootstrap/drift-check.sh");
  return fs.existsSync(script) ? script : "";
}

// A bare "bash" resolves to the WSL stub in WindowsApps, which cannot read the
// Windows paths the script is given. Git Bash is the interpreter this repo's
// scripts are written for, so prefer it explicitly and fall back to PATH.
const GIT_BASH_CANDIDATES = [
  "C:/Program Files/Git/bin/bash.exe",
  "C:/Program Files (x86)/Git/bin/bash.exe",
];

function resolveBash(): string {
  const configured = productEnv(process.env, "BASH");
  if (configured) return configured;
  if (process.platform !== "win32") return "bash";
  const local = process.env.LOCALAPPDATA
    ? [`${process.env.LOCALAPPDATA.replace(/\\/g, "/")}/Programs/Git/bin/bash.exe`]
    : [];
  for (const candidate of [...GIT_BASH_CANDIDATES, ...local]) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return "bash";
}

// Detached: the caller must not wait ~2 minutes, and the run must survive this
// process exiting. Output goes to the report file, so stdio is discarded.
function spawnRefresh(payload: ScopePayload | null): boolean {
  if (productEnv(process.env, "DRIFT_AUTOREFRESH") === "0") return false;
  if (refreshInFlight()) return false;
  const script = driftScriptFor(payload);
  if (!script) return false;
  try {
    const child = spawn(resolveBash(), [script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// Per-file status lines from drift-check.sh: every label it prints except "ok",
// RETIRED-LIVE (#45) and NOT-INSTALLED (#302), which are information and never
// change the verdict.
// The trailing \s is load-bearing: it keeps the closing "DRIFT-CHECK FOUND
// DRIFT" summary out of the count.
function findingsOf(report: string): string[] {
  return report
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) =>
      /^(DRIFT|MISSING-REPO|MISSING-LIVE|EXTRA-LIVE|MISSING-BLOCK|BLOCK-INVALID|NORMALIZE-FAIL)\s/.test(l)
    );
}

function hasTerminalMarker(report: string): boolean {
  return /(?:^|\r?\n)DRIFT-CHECK (?:PASS \(repo == live\)|FOUND DRIFT \(see above\))\s*$/.test(report);
}

function emit(message: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: message,
      },
    })
  );
}

const RECONCILE_HINT =
  "Reconcile per file - direction is NOT uniform: a live-only fix belongs in the repo, a stale live " +
  "file belongs to install.";

const RUN_HINT = `Run \`bash kherep/bootstrap/drift-check.sh\` (~2 min, read-only). ${RECONCILE_HINT}`;

const REFRESH_STARTED =
  "A refresh was started in the background just now (~2 min, read-only); its result lands in the " +
  `report for the next session start. ${RECONCILE_HINT}`;

async function main(): Promise<void> {
  let data: ScopePayload | null = {};
  try {
    data = JSON.parse((await (await import("./lib/stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8") || "{}") as ScopePayload | null;
  } catch {
    return;
  }
  if (!isKherepScope(data)) return;

  const file = reportPath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    const started = spawnRefresh(data);
    emit(
      "ORCHESTRA DRIFT-CHECK: no report has ever been written. Repo kherep and the live " +
        `~/.claude install are unverified against each other. ${started ? REFRESH_STARTED : RUN_HINT}`
    );
    return;
  }

  const ageHours = (Date.now() - stat.mtimeMs) / 3_600_000;
  let report = "";
  try {
    report = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }

  if (!hasTerminalMarker(report)) {
    const started = spawnRefresh(data);
    emit(
      `ORCHESTRA DRIFT-CHECK: the last report (${Math.round(ageHours)}h ago) is incomplete because it has no ` +
        `valid terminal PASS or FOUND DRIFT marker. Its partial results are not trusted. ` +
        `${started ? REFRESH_STARTED : RUN_HINT}`
    );
    return;
  }

  const findings = findingsOf(report);
  const stale = ageHours > MAX_AGE_HOURS;
  if (!findings.length && !stale) return;

  // A fresh report already reflects reality, so re-running it would change
  // nothing - only staleness earns a refresh. Findings need a human, not a rerun.
  const started = stale ? spawnRefresh(data) : false;

  const age = ageHours < 48 ? `${Math.round(ageHours)}h` : `${Math.round(ageHours / 24)}d`;

  if (findings.length) {
    const shown = findings.slice(0, 12);
    const more = findings.length > shown.length ? `\n  ... and ${findings.length - shown.length} more` : "";
    emit(
      `ORCHESTRA DRIFT-CHECK: the last run (${age} ago${stale ? ", STALE" : ""}) found ` +
        `${findings.length} unreconciled file(s) between repo kherep and live ~/.claude:\n` +
        shown.map((l) => `  - ${l}`).join("\n") +
        more +
        `\n\nAn un-captured live file is lost on the next reinstall; a stale live file means the fix is not active here. ` +
        `${started ? REFRESH_STARTED : RUN_HINT}`
    );
    return;
  }

  emit(
    `ORCHESTRA DRIFT-CHECK: last run was ${age} ago (limit ${MAX_AGE_HOURS}h) and was clean, but repo-vs-live ` +
      `has not been verified since. ${started ? REFRESH_STARTED : RUN_HINT}`
  );
}

try {
  await main();
} catch {
  // never break session start
}
process.exit(0);
