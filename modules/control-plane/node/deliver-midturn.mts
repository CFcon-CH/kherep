import fs from "node:fs";
import path from "node:path";

import { bypassesPermissions, isPlainSessionId, listenerDir } from "./autonomy.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { contextOutput, deliveryContext, sessionInbox, type HookDeps } from "./deliver-core.mts";
import { classifyExclusiveCreate, CONTENTION_ATTEMPTS, CONTENTION_PAUSE_MS, pauseSync } from "./lock-contention.mts";
import { appendRenameHint, renameOwner } from "./rename-notices.mts";
import { unnoticedNotices } from "./sent-notices.mts";

// Claude Code PostToolUse delivery inside a running turn (issue #388). From
// https://code.claude.com/docs/en/hooks (read 2026-10-12): PostToolUse
// additionalContext is "added to Claude's context alongside the tool result"
// and read "on the next model request"; PostToolUse "fires concurrently when
// Claude makes parallel tool calls"; a hook inside a subagent or in-process
// teammate carries agent_id. The offer is no receipt: the turn's Stop confirms
// it (issue #308). No turn is started, so no budget is checked or spent.

// A lock older than this belongs to a hook process that died holding it. A live
// call stays well inside it: its record lock waits share deliver-core.mts
// RECORD_LOCK_BUDGET_MS (issue #627), the rest is file I/O.
export const MIDTURN_LOCK_STALE_MS = 5_000;

export const midTurnLock = (paths: NodePaths, sessionId: string): string =>
  path.join(listenerDir(paths), `${sessionId}.deliver.lock`);

// Runs body under the session's exclusive lock; undefined when another call
// holds a live lock (it delivers) or the lock cannot be taken. A create failing
// with EPERM, EACCES or EBUSY (Windows delete pending, issue #602) is retried
// up to CONTENTION_ATTEMPTS times without using one of the two EEXIST attempts
// and is never taken for a stale lock.
export function withMidTurnLock(paths: NodePaths, sessionId: string, body: () => string): string | undefined {
  const lock = midTurnLock(paths, sessionId);
  ensureDir(listenerDir(paths));
  let transient = 0;
  for (let attempt = 0; attempt < 2;) {
    let fd: number;
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      const outcome = classifyExclusiveCreate(error);
      if (outcome === "other") return undefined;
      if (outcome === "retry") {
        if (++transient >= CONTENTION_ATTEMPTS) return undefined;
        pauseSync(CONTENTION_PAUSE_MS);
        continue;
      }
      attempt++;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs <= MIDTURN_LOCK_STALE_MS) return undefined;
        fs.rmSync(lock, { force: true });
      } catch {
        // released meanwhile: try again
      }
      continue;
    }
    let closing = false;
    try {
      fs.writeFileSync(fd, String(process.pid));
      closing = true;
      fs.closeSync(fd);
    } catch {
      // Ours by the exclusive create: removed, not left to the stale rule. A
      // descriptor is closed at most once: after a failed close its number may
      // already belong to another descriptor.
      if (!closing) try { fs.closeSync(fd); } catch { /* the write failed already */ }
      try { fs.rmSync(lock, { force: true }); } catch { /* left to the stale rule */ }
      return undefined;
    }
    try {
      return body();
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }
  return undefined;
}

export function midTurnOutput(input: Record<string, unknown>, sessionId: string, refs: string[], deps: HookDeps): string {
  if (Object.hasOwn(input, "agent_id") || !isPlainSessionId(sessionId) || bypassesPermissions(input.permission_mode)) return "";
  // Valid rename owners also compare their disposable display snapshot.
  const owner = renameOwner(input);
  const waiting = sessionInbox(deps.paths, refs, { sessionId, runtime: "claude-code" }).some((record) => record.state === "accepted");
  // One read of sent/ per call: deliveryContext rechecks only these records.
  const notices = waiting ? undefined : unnoticedNotices(deps.paths, refs, deps.now?.() ?? Date.now());
  if (!owner && notices && notices.failures.length === 0 && notices.receipts.length === 0) return "";
  const call: HookDeps = { ...deps, ...(notices ? { notices } : {}), owner: { sessionId, runtime: "claude-code" } };
  return withMidTurnLock(deps.paths, owner ?? sessionId, () => {
    const context = deliveryContext("PostToolUse", refs, call);
    return contextOutput("PostToolUse", owner ? appendRenameHint(deps.paths, owner, context, deps.maxBytes) : context);
  }) ?? "";
}
