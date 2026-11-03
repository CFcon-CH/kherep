import fs from "node:fs";

import { wakeAudit } from "./autonomy.mts";
import { ensureDir } from "./config.mts";
import { runClaude, type RunnerDeps } from "./session-runner.mts";
import { writeTask, type TaskRecord } from "./task-records.mts";

// Issue #111: each resume of an intercom session that Claude Code continues as
// a copy under a new id (issue #109) leaves the copy the record held before
// running idle. closed-resume.mts notes that session in the record (retire);
// once the new copy is adopted, the previous one is stopped with `claude stop
// <short id>`, only while `claude agents --json` lists it under that short id
// with the session id the record held, its process alive and `status` idle
// (https://code.claude.com/docs/en/agent-view, "`pid`, `status` ... one of
// `busy`, `waiting`, or `idle`", fetched 2026-09-28). A busy or waiting one is
// tried again on later watch rounds, up to MAX_RETIRE_ROUNDS; one that is not
// listed, not ours or without a live process is left alone. Only sessions a
// node-started intercom record held are noted, never the closed session the
// messages were sent to.

export const MAX_RETIRE_ROUNDS = 30;

export type RetiringCopy = NonNullable<TaskRecord["retire"]>[number];

function audit(deps: RunnerDeps, record: TaskRecord, copy: RetiringCopy, outcome: "retired-copy" | "copy-kept", reason?: string): void {
  ensureDir(deps.paths.dir);
  fs.appendFileSync(wakeAudit(deps.paths), `${JSON.stringify({ ts: new Date(deps.now?.() ?? Date.now()).toISOString(),
    sessionId: copy.sessionId, shortId: copy.shortId, action: "closed-session", outcome, ...(reason ? { reason } : {}),
    taskId: record.taskId })}\n`, { mode: 0o600 });
}

// Stops the idle copies the record noted, with the rows of a successful
// listing, and returns the record as written.
export async function retireCopies(deps: RunnerDeps, record: TaskRecord, rows: Record<string, unknown>[]): Promise<TaskRecord> {
  // The new copy is not adopted yet.
  if (!record.retire?.length || record.mappingPendingSince) return record;
  const keep: RetiringCopy[] = [];
  for (const copy of record.retire) {
    // Continued in place: the record still holds that session.
    if (copy.sessionId === record.sessionId || copy.shortId === record.shortId) continue;
    const row = rows.find((r) => r.id === copy.shortId);
    if (row?.sessionId !== copy.sessionId || typeof row.status !== "string") continue;
    let why = `status ${row.status}`;
    if (row.status === "idle") {
      try {
        await runClaude(deps, ["stop", copy.shortId], undefined, {kind:"operator"});
        audit(deps, record, copy, "retired-copy");
        continue;
      } catch (error) {
        why = `claude stop failed: ${String((error as Error).message ?? error).slice(0, 200)}`;
      }
    }
    const rounds = (copy.rounds ?? 0) + 1;
    if (rounds < MAX_RETIRE_ROUNDS) keep.push({ ...copy, rounds });
    else audit(deps, record, copy, "copy-kept", `${why} after ${rounds} watch rounds`);
  }
  const { retire: _retire, ...rest } = record;
  return writeTask(deps.paths, keep.length > 0 ? { ...rest, retire: keep } : rest, deps.now?.());
}
