#!/usr/bin/env node
/**
 * smoke-test-nudge.mts  -  SessionStart hook
 *
 * Makes the state of the install/guard assertions visible without paying for
 * them at session start. bootstrap/smoke-test.sh installs both host profiles
 * into throwaway homes and needs minutes, so this hook never waits for it: it
 * reads the report the previous run left behind and speaks up when that report
 * is missing, stale, incomplete, or reports failing assertions.
 *
 * Report (written by bootstrap/smoke-test.sh):
 *   <CLAUDE_HOME>/.cache/smoke-test/last-report.txt
 *
 * When the report is missing or stale the hook also spawns smoke-test.sh
 * DETACHED and returns immediately - same self-refresh as drift-check-nudge.mts.
 * A failing report is NOT rerun: it needs a human, not another run.
 *
 * Fail-safe: any error exits 0 silently. Never blocks a session start.
 *
 * GRUND: the 2026-08-05 wired-hook assertion existed and still missed a live
 * commit-guard.js sitting at 0 bytes for 19 hours, because nothing ever ran it.
 * An assertion that only runs when a human remembers is not an assertion.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { isKherepScope, joinPathLike, productEnv, type ScopePayload } from "./lib/workspace-scope.mts";
import { checkoutFor } from "./lib/orchestra-checkout.mts";

// A full run costs minutes, so a daily limit is the ceiling that still keeps a
// dead guard from surviving a working day unnoticed (the incident lasted 19h).
const MAX_AGE_HOURS = Number(productEnv(process.env, "SMOKE_MAX_AGE_HOURS") ?? 24);

// Backstop only. A PID can be recycled, so a lock that outlives any plausible
// run is treated as stale even if some process now answers to its number.
const STALE_LOCK_MINUTES = 180;

function cacheDir(): string {
  const home = process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
  return path.join(home, ".cache", "smoke-test");
}

function reportPath(): string {
  return path.join(cacheDir(), "last-report.txt");
}

function lockPath(): string {
  return path.join(cacheDir(), "refresh.pid");
}

function clearLock(): false {
  try {
    fs.rmSync(lockPath(), { force: true });
  } catch {
    /* best effort: a lock we cannot remove costs one skipped refresh, not a run */
  }
  return false;
}

/**
 * Whether a refresh started here is still alive.
 *
 * The previous version looked for a `.last-report.*` staging file. smoke-test.sh
 * is explicitly allowed to skip that file (`mktemp ... || true`), so a run could
 * be in flight leaving no trace at all - and every further trigger started
 * another one. On 2026-08-07 that left 61 processes on the box and starved an
 * unrelated install into a timeout (OP-679).
 *
 * A PID plus an existence probe is a measurement. A side effect of the thing
 * being measured is not (goldene Regel 12).
 */
function refreshInFlight(): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath(), "utf8").trim();
  } catch {
    return false;
  }
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return clearLock();
  try {
    if (Date.now() - fs.statSync(lockPath()).mtimeMs > STALE_LOCK_MINUTES * 60_000) {
      return clearLock();
    }
  } catch {
    /* unreadable mtime is not a verdict; the liveness probe below decides */
  }
  try {
    process.kill(pid, 0); // signal 0 asks whether it exists, it sends nothing
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to someone else.
    if (error && (error as NodeJS.ErrnoException).code === "EPERM") return true;
    return clearLock();
  }
}

function smokeScriptFor(payload: ScopePayload | null): string {
  const root = checkoutFor(payload, process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude"));
  if (!root) return "";
  const script = joinPathLike(root, "bootstrap/smoke-test.sh");
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

// Detached: the caller must not wait minutes, and the run must survive this
// process exiting. Output goes to the report file, so stdio is discarded.
function spawnRefresh(payload: ScopePayload | null): boolean {
  if (productEnv(process.env, "SMOKE_AUTOREFRESH") === "0") return false;
  if (refreshInFlight()) return false;
  const script = smokeScriptFor(payload);
  if (!script) return false;
  try {
    const child = spawn(resolveBash(), [script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    // The lock is written HERE, by the process that made the spawn decision, and
    // as the first thing after it. Leaving it to the child would reintroduce the
    // window in which a run exists and nothing records it.
    try {
      fs.mkdirSync(cacheDir(), { recursive: true });
      fs.writeFileSync(lockPath(), String(child.pid), "utf8");
    } catch {
      /* an unwritable lock weakens the guard, it must never fail the run */
    }
    return true;
  } catch {
    return false;
  }
}

// Only the closing summary decides the verdict. Everything above it is free-form
// output from install.sh and node --test and must never flip a result.
function verdictOf(report: string): "pass" | "fail" | null {
  const match = report.match(/(?:^|\r?\n)SMOKE (PASS \([^)]*\)|FAIL)\s*$/);
  if (!match) return null;
  return match[1].startsWith("PASS") ? "pass" : "fail";
}

// smoke-test.sh routes every failing assertion through its note_fail(), which
// stamps exactly this marker. Matching that contract - instead of guessing at
// line shapes - is what keeps the count honest, and it makes a future assertion
// countable the moment it is written, because the marker comes from the same
// place as fail=1.
const FINDING_MARKER = /^SMOKE-FINDING /;

// Reports written before the note_fail contract carry no marker. Falling back
// keeps such a report readable instead of claiming zero findings, but PASS
// lines are excluded: counting them is the whole of OP-669 (13 sub-test PASS
// lines plus 2 TEST PASS lines turned 4 real failures into 19).
function legacyFindingsOf(lines: string[]): string[] {
  return lines
    .filter((l) => !/^TAP\b/.test(l) && !/^SMOKE (?:PASS \(|FAIL$)/.test(l))
    .filter((l) => !/\bPASS\b/.test(l))
    .filter((l) => /^[A-Z][A-Z0-9-]+\b/.test(l) || /\[(?:win|mac)\]/.test(l));
}

// Used only to decorate an already-established FAIL, never to derive one.
function findingsOf(report: string): string[] {
  const lines = report.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const marked = lines.filter((l) => FINDING_MARKER.test(l)).map((l) => l.replace(FINDING_MARKER, ""));
  return marked.length ? marked : legacyFindingsOf(lines);
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

const STAKES =
  "Every failing assertion is a guard that is not proven to enforce anything on this box.";

const RUN_HINT = "Run `bash kherep/bootstrap/smoke-test.sh` (minutes, throwaway homes only).";

const RUN_STARTED =
  "A run was started in the background just now (minutes, throwaway homes only); its result lands " +
  "in the report for the next session start.";

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
      "ORCHESTRA SMOKE-TEST: no report has ever been written. The install layout, the wired hooks and " +
        `the per-repo git hook coverage are unverified on this box. ${started ? RUN_STARTED : RUN_HINT}`
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

  const verdict = verdictOf(report);
  if (!verdict) {
    const started = spawnRefresh(data);
    emit(
      `ORCHESTRA SMOKE-TEST: the last report (${Math.round(ageHours)}h ago) is incomplete because it has no ` +
        "terminal SMOKE PASS or SMOKE FAIL marker, so the run aborted midway. Its partial results are not " +
        `trusted. ${started ? RUN_STARTED : RUN_HINT}`
    );
    return;
  }

  const stale = ageHours > MAX_AGE_HOURS;
  if (verdict === "pass" && !stale) return;

  // A fresh failing report already reflects reality, so a rerun would change
  // nothing - only staleness earns a refresh. Findings need a human.
  const started = stale ? spawnRefresh(data) : false;
  const age = ageHours < 48 ? `${Math.round(ageHours)}h` : `${Math.round(ageHours / 24)}d`;

  if (verdict === "fail") {
    const findings = findingsOf(report);
    // A FAIL verdict with nothing to show means the report failed somewhere
    // that never went through note_fail(). That is a hole in the reporting
    // contract, not a clean run - say so instead of printing "0 failing
    // assertion(s)", which reads like there was nothing wrong (goldene Regel 12).
    if (findings.length === 0) {
      emit(
        `ORCHESTRA SMOKE-TEST: the last run (${age} ago${stale ? ", STALE" : ""}) FAILED but the report carries ` +
          "no SMOKE-FINDING line, so what failed is UNKNOWN from here. Read " +
          `${file} directly. ${STAKES} ${started ? RUN_STARTED : RUN_HINT}`
      );
      return;
    }
    const shown = findings.slice(0, 12);
    const more = findings.length > shown.length ? `\n  ... and ${findings.length - shown.length} more` : "";
    emit(
      `ORCHESTRA SMOKE-TEST: the last run (${age} ago${stale ? ", STALE" : ""}) FAILED with ` +
        `${findings.length} failing assertion(s):\n` +
        shown.map((l) => `  - ${l}`).join("\n") +
        more +
        `\n\n${STAKES} ${started ? RUN_STARTED : RUN_HINT}`
    );
    return;
  }

  emit(
    `ORCHESTRA SMOKE-TEST: last run was ${age} ago (limit ${MAX_AGE_HOURS}h) and passed, but nothing has been ` +
      `verified since. ${started ? RUN_STARTED : RUN_HINT}`
  );
}

try {
  await main();
} catch {
  // never break session start
}
process.exit(0);
