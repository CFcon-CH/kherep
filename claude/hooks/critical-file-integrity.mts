#!/usr/bin/env node
/**
 * critical-file-integrity.mts  -  SessionStart hook
 *
 * live-hook-integrity.mts proves that every hook file WIRED IN SETTINGS can
 * still enforce something. Its scope is deliberately narrow: `.js` and `.mts`
 * under <CLAUDE_HOME>/hooks/. That leaves the one file that actually binds every
 * runtime completely unguarded - ~/.claude/kherep/githooks/commit-msg, the
 * git hook behind the work-item rule. It is not wired in settings, it is not
 * a script under hooks/, and it sits in the same tree where a file was
 * repeatedly replaced by a 0-byte version (OP-664, writer still UNKNOWN).
 *
 * A 0-byte commit-msg is fail-open in exactly the same way a 0-byte
 * commit-guard.mts is: sh runs it, it does nothing, it exits 0, and git reads
 * exit 0 as "message accepted". Nothing in the chain can tell that apart from
 * a real pass.
 *
 * Deliberately a SEPARATE file rather than an extension of
 * live-hook-integrity.mts: that one already reaches the 250 LOC ceiling of
 * the CLAUDE.md (goldene Regel 6), and it currently works. Adding a second concern
 * to it would force a split of a load-bearing file for no gain. This hook is
 * itself a wired .mts under hooks/, so live-hook-integrity covers IT - the two
 * guard each other.
 *
 * Same three states as its sibling, never merged (goldene Regel 12): OK,
 * DEFEKT, UNGEPRUEFT. A restore counts only when MEASURED at the target
 * (goldene Regel 13). Silent when everything is OK. Any error exits 0.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { joinPathLike, normalizePathLike, type ScopePayload } from "./lib/workspace-scope.mts";
import { checkoutFor } from "./lib/orchestra-checkout.mts";

interface CriticalFile {
  rel: string;
  source: string;
  executable: boolean;
  why: string;
}

interface Before {
  size: number;
  mtime: string;
  ino: number;
}

interface Verdict {
  state: "OK" | "DEFEKT" | "UNGEPRUEFT";
  reason?: string;
  before?: Partial<Before>;
}

interface Restored {
  proven: boolean;
  sha?: string;
  why?: string;
}

const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");
const errorCode = (error: unknown): string => (error ? (error as NodeJS.ErrnoException).code : undefined) || "unknown";

// Live path relative to CLAUDE_HOME -> source path relative to the checkout.
// Non-.js, security-bearing files that no other integrity layer looks at.
const CRITICAL: CriticalFile[] = [
  {
    rel: "kherep/githooks/commit-msg",
    source: "claude/kherep/githooks/commit-msg",
    // git skips a hook without the mode bit SILENTLY, so restoring the bytes
    // without the bit would look repaired and enforce nothing.
    executable: true,
    why: "git commit-msg hook: the only work-item enforcement that binds every runtime",
  },
  {
    // Issue #325. The same 0-byte failure mode: sh runs it and warns about nothing.
    rel: "kherep/githooks/post-checkout",
    source: "claude/kherep/githooks/post-checkout",
    executable: true,
    why: "git post-checkout hook: the only main-checkout warning that reaches every runtime",
  },
  // Issue #325, PR-A. A 0-byte pre-push or writer records no push, silently.
  { rel: "kherep/githooks/pre-push", source: "claude/kherep/githooks/pre-push", executable: true,
    why: "git pre-push hook: the only push attribution that reaches every runtime" },
  { rel: "kherep/githooks/attribution-record.mts", source: "claude/kherep/githooks/attribution-record.mts",
    executable: false, why: "the writer pre-push runs; outside hooks/, so live-hook-integrity never sees it" },
  // OP-734, 2026-08-10. Both run or are trusted at SessionStart and no other
  // layer looks at them: live-hook-integrity.mts covers only .js and .mts under
  // hooks/, and drift-check.sh only reports when a human runs it.
];

function classify(file: string): Verdict {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { state: "DEFEKT", reason: "wired but not present on disk" };
    return { state: "UNGEPRUEFT", reason: `stat failed (${code})` };
  }
  // Before the size test: a directory reports size 0 on Windows and would
  // otherwise be mistaken for the 0-byte incident.
  if (!stat.isFile()) return { state: "UNGEPRUEFT", reason: "not a regular file" };
  const before = { size: stat.size, mtime: new Date(stat.mtimeMs).toISOString(), ino: stat.ino };
  if (stat.size === 0) {
    return { state: "DEFEKT", reason: "0 bytes - sh runs it, it enforces nothing and exits 0 (fail-open)", before };
  }
  return { state: "OK", before };
}

// OP-734. Emptiness is only the loud half of the problem. A file that was
// SWAPPED keeps a plausible size and passes classify(), which is precisely the
// dangerous case for a pinned trust anchor: verification still runs, against
// the attacker's certificate. Every file in CRITICAL is repo-managed, so live
// content that differs from the checkout is a defect by definition - the same
// assertion drift-check.sh makes, just self-triggered here.
// Returns null when the comparison itself could not be made; the caller must
// not turn that into a verdict (goldene Regel 12).
function contentMismatch(file: string, entry: CriticalFile, repoRoot: string): { liveSha: string; wantSha: string } | false | null {
  if (!repoRoot) return null;
  const source = joinPathLike(repoRoot, entry.source);
  let live: Buffer;
  let want: Buffer;
  try {
    live = fs.readFileSync(file);
    want = fs.readFileSync(source);
  } catch {
    return null;
  }
  if (live.equals(want)) return false;
  return {
    liveSha: crypto.createHash("sha256").update(live).digest("hex").slice(0, 16),
    wantSha: crypto.createHash("sha256").update(want).digest("hex").slice(0, 16),
  };
}

function restore(file: string, entry: CriticalFile, repoRoot: string): Restored {
  if (!repoRoot) return { proven: false, why: "no kherep checkout resolved" };
  const source = joinPathLike(repoRoot, entry.source);
  let wanted: Buffer;
  try {
    wanted = fs.readFileSync(source);
  } catch (error) {
    return { proven: false, why: `versioned source ${entry.source} unreadable (${errorCode(error)})` };
  }
  if (!wanted.length) return { proven: false, why: `versioned source ${entry.source} is itself 0 bytes` };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(source, file);
    if (entry.executable) fs.chmodSync(file, 0o755);
  } catch (error) {
    return { proven: false, why: `copy failed (${errorCode(error)})` };
  }
  // Measured at the target. Reporting one's own copy call is not a measurement.
  let landed: Buffer;
  try {
    landed = fs.readFileSync(file);
  } catch (error) {
    return { proven: false, why: `target unreadable after the copy (${errorCode(error)})` };
  }
  const sha = sha256(landed);
  if (!landed.length || sha !== sha256(wanted)) {
    return { proven: false, sha, why: "the target does not match the versioned source after the copy" };
  }
  return { proven: true, sha };
}

function journal(home: string, entry: Record<string, unknown>): void {
  try {
    const dir = path.join(home, ".cache", "hook-integrity");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "incidents.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* a journal we cannot write must never break a session start */
  }
}

function emit(lines: string[]): void {
  if (!lines.length) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `ORCHESTRA CRITICAL-FILE-INTEGRITY:\n${lines.map((l) => `  - ${l}`).join("\n")}`,
      },
    })
  );
}

async function main(): Promise<void> {
  let payload: ScopePayload | null = {};
  try {
    payload = JSON.parse((await (await import("./lib/stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8") || "{}") as ScopePayload | null;
  } catch {
    payload = {};
  }
  const home = normalizePathLike(process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude"));
  const repoRoot = checkoutFor(payload, home);
  const lines: string[] = [];

  for (const entry of CRITICAL) {
    const file = joinPathLike(home, entry.rel);
    let { state, reason, before = {} } = classify(file);
    if (state === "OK") {
      const swapped = contentMismatch(file, entry, repoRoot);
      if (swapped === null) continue;      // comparison impossible -> say nothing, claim nothing
      if (swapped === false) continue;     // proven identical to its source
      state = "DEFEKT";
      reason = `content differs from source (live ${swapped.liveSha}..., source ${swapped.wantSha}...)`;
    }
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(), file: entry.rel, path: file, state, reason,
      sizeBefore: before.size === undefined ? null : before.size,
      mtimeBefore: before.mtime || null,
      inoBefore: before.ino === undefined ? null : before.ino,
      sha256After: null, restoreProven: false, guard: "critical-file-integrity", checkout: repoRoot,
    };
    if (state === "UNGEPRUEFT") {
      lines.push(`${entry.rel}: UNCHECKED - ${reason}. Neither proven healthy nor proven broken.`);
      journal(home, record);
      continue;
    }
    const result = restore(file, entry, repoRoot);
    record.sha256After = result.sha || null;
    record.restoreProven = result.proven;
    if (!result.proven) record.restoreDetail = result.why;
    journal(home, record);
    lines.push(
      result.proven
        ? `${entry.rel}: ${reason} -> RESTORED from the repo, verified at the target (sha256 ${result.sha!.slice(0, 12)})`
        : `${entry.rel}: ${reason} -> NOT restored (${result.why}). ${entry.why} IS OFF.`
    );
  }

  emit(lines);
}

try {
  await main();
} catch (error) {
  try {
    const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown }; // a code, else the class name; never a message (issue #576)
    emit([`the critical-file check itself failed (${typeof code === "string" && /^[A-Z][A-Z0-9_]{0,40}$/.test(code) ? code : typeof name === "string" && /^[A-Za-z]{1,40}Error$/.test(name) ? name : "unknown"}); nothing was verified`]);
  } catch {
    /* never break session start */
  }
}
process.exit(0);
