#!/usr/bin/env node
/**
 * orphan-check-nudge.mts  -  SessionStart hook
 *
 * Keeps the knowledge space's orphan count visible. A page nothing links to is
 * reachable only by search, and the whole point of the linking contract is that
 * the space stops producing them. A contract nobody measures is a wish.
 *
 * Report (written by bootstrap/orphan-check.sh):
 *   <CLAUDE_HOME>/.cache/orphan-check/last-report.txt
 *
 * Like drift-check-nudge.mts this never waits for the check: the scan reads every
 * page body in the space and takes minutes. It reads the previous report and,
 * when that report is missing or stale, spawns the check DETACHED for the next
 * session.
 *
 * WHAT IT DOES NOT DO, deliberately: it never stitches. The check is read-only.
 * Stitching writes pages in a live space, and a writer triggered automatically
 * by a session start is a different risk class than a reader - the operator
 * decides when links get written, the machine decides when to count.
 *
 * Silent when the last run was recent and found nothing.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkoutFor } from "./lib/orchestra-checkout.mts";
import { isKherepScope, joinPathLike, productEnv, type ScopePayload } from "./lib/workspace-scope.mts";

const MAX_AGE_HOURS = Number(productEnv(process.env, "ORPHAN_MAX_AGE_HOURS") ?? 24);

function claudeHome(): string {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
}

function reportPath(): string {
  return path.join(claudeHome(), ".cache", "orphan-check", "last-report.txt");
}

// Resolved the same way drift-check-nudge resolves its own script: from the
// payload's workspace, never from a guess at the home directory. The installed
// copy of this hook sits in <CLAUDE_HOME>/hooks, where a repo-relative path
// points at a directory that does not exist.
function scriptFor(payload: ScopePayload): string {
  const root = checkoutFor(payload, claudeHome());
  if (!root) return "";
  const script = joinPathLike(root, "bootstrap/orphan-check.sh");
  return fs.existsSync(script) ? script : "";
}

const GIT_BASH = ["C:\\Program Files\\Git\\bin\\bash.exe", "/bin/bash", "/usr/bin/bash"];

function resolveBash(): string {
  const local = process.env.LOCALAPPDATA
    ? [`${process.env.LOCALAPPDATA.replace(/\\/g, "/")}/Programs/Git/bin/bash.exe`]
    : [];
  for (const candidate of [...GIT_BASH, ...local]) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* an unreadable candidate is simply not the one */
    }
  }
  return "bash";
}

// Detached: the scan reads every body in the space and the session must not
// wait for it. Output goes to the report file, so stdio is discarded.
function spawnRefresh(payload: ScopePayload): boolean {
  if (productEnv(process.env, "ORPHAN_AUTOREFRESH") === "0") return false;
  const script = scriptFor(payload);
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

function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

function main(): void {
  let payload: ScopePayload = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return;
  }
  if (!isKherepScope(payload)) return;

  let text = "";
  let ageHours = Infinity;
  try {
    text = fs.readFileSync(reportPath(), "utf8");
    ageHours = (Date.now() - fs.statSync(reportPath()).mtimeMs) / 3_600_000;
  } catch {
    // No report is not "no orphans". It is "nobody has looked".
    const started = spawnRefresh(payload);
    emit("ORPHAN-CHECK: the knowledge space has never been checked for pages nothing links to."
      + (started ? " A read-only scan was started in the background; its result lands at the next session start."
        : " Run `bash kherep/bootstrap/orphan-check.sh` (minutes, read-only)."));
    return;
  }

  const stale = ageHours > MAX_AGE_HOURS;
  const age = ageHours >= 24 ? `${Math.round(ageHours / 24)}d` : `${Math.round(ageHours)}h`;
  const started = stale ? spawnRefresh(payload) : false;

  if (/^UNMEASURED$/m.test(text)) {
    emit(`ORPHAN-CHECK: the last run (${age} ago) could not measure the space. The orphan count is`
      + " UNKNOWN, not zero. Read the report before treating the space as linked.");
    return;
  }

  const count = Number((text.match(/^count: (\d+)$/m) || [])[1]);
  if (!Number.isFinite(count)) {
    emit(`ORPHAN-CHECK: the last run (${age} ago) left a report without a count. Treat it as UNKNOWN.`);
    return;
  }
  if (count === 0 && !stale) return;

  const titles = (text.match(/^orphan\t\S+\t.+$/gm) || [])
    .slice(0, 5)
    .map((line) => `  - ${line.split("\t")[2]}`);

  if (count === 0) {
    emit(`ORPHAN-CHECK: the last run (${age} ago, limit ${MAX_AGE_HOURS}h) found no orphans, but it is`
      + ` stale.${started ? " A refresh was started in the background." : ""}`);
    return;
  }

  emit(`ORPHAN-CHECK: ${count} page(s) in the knowledge space have no incoming link`
    + `${stale ? ` (report ${age} old, STALE)` : ""}:`);
  for (const title of titles) emit(title);
  if (count > titles.length) emit(`  ... and ${count - titles.length} more`);
  emit("Each of them is findable only by search. `<confluence broker> stitch --space <key>` lists link"
    + " candidates per orphan and writes nothing; a link is written only by stitch --id with judged decisions."
    + (started ? " A fresh read-only count was started in the background." : ""));
}

try {
  main();
} catch {
  // never break session start
}
// exitCode, not exit(): under the ESM loader on Windows an immediate exit()
// races the still-closing stdin handle and aborts with a libuv assertion, which
// would turn a silent hook into a crashing one exactly on the quiet paths.
process.exitCode = 0;
