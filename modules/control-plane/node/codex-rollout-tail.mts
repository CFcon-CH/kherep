import fs from "node:fs";

// Issue #911: the records of a held Codex rollout written after a turn
// boundary, read backwards from the end of the file. Source contract:
// openai/codex@d659419fe7f7a9a32295ec9d1995a98f4b3f4a20, codex-rs/:
// history/src/lib.rs and history/src/rollout_payload.rs (one JSONL record is a
// timestamp plus an item tagged "type" with a payload), protocol/src/protocol.rs
// (event_msg payloads tagged "type"; task_started, turn_started on read only),
// rollout/src/recorder.rs (timestamp format, one line per record),
// rollout/src/policy.rs (persisted records) and core/src/tasks/admission.rs
// (a turn writes its start event before any other turn work).
// Parsed in this process only: type, payload.type, payload.item.type and
// timestamp are evaluated, one verdict is returned, nothing is logged or kept.
// Every failure is "unreadable", never "non-turn".

// Budget for one backward scan; exceeding it is "unreadable".
export const ROLLOUT_TAIL_BYTES = 1024 * 1024;
export type LateWrites = "non-turn" | "turn" | "unreadable";

const CHUNK_BYTES = 64 * 1024;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TURN_START: ReadonlySet<unknown> = new Set(["task_started", "turn_started"]);
// item_completed item types known to start no turn (measured in #911).
const NON_TURN_ITEMS: ReadonlySet<unknown> = new Set(["SubAgentActivity", "CommandExecution"]);

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// The whole list of records known to start no turn; any other record is a turn.
function nonTurn(row: Record<string, unknown>): boolean {
  const payload = row.payload;
  if (row.type !== "event_msg" || !object(payload)) return false;
  return payload.type === "thread_settings_applied"
    || (payload.type === "item_completed" && object(payload.item) && NON_TURN_ITEMS.has(payload.item.type));
}

// One record, newest first: its verdict, or undefined to read the next older one.
function judge(line: Buffer, boundaryMs: number, slackMs: number): LateWrites | undefined {
  if (line.length === 0) return "unreadable";
  const row: unknown = JSON.parse(line.toString("utf8"));
  if (!object(row) || typeof row.timestamp !== "string" || !TIMESTAMP.test(row.timestamp)) return "unreadable";
  const at = Date.parse(row.timestamp);
  if (!Number.isFinite(at)) return "unreadable";
  if (at <= boundaryMs) return "non-turn";
  if (row.type === "event_msg" && object(row.payload) && TURN_START.has(row.payload.type)) return "turn";
  if (at > boundaryMs + slackMs && !nonTurn(row)) return "turn";
  return undefined;
}

// The records of a held rollout written after boundaryMs: "turn" when one is
// a turn start, or later than boundaryMs + slackMs and not a known non-turn
// record. Never throws.
export function lateWrites(file: string, boundaryMs: number, slackMs: number): LateWrites {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) return "unreadable";
    let offset = stat.size, consumed = 0, pending = Buffer.alloc(0);
    while (offset > 0 && consumed < ROLLOUT_TAIL_BYTES) {
      const count = Math.min(CHUNK_BYTES, offset, ROLLOUT_TAIL_BYTES - consumed), chunk = Buffer.alloc(count);
      offset -= count;
      consumed += count;
      if (fs.readSync(fd, chunk, 0, count, offset) !== count) return "unreadable";
      pending = Buffer.concat([chunk, pending]);
      // The last record must be complete: a torn line could be a turn start.
      if (consumed === count) {
        if (pending.at(-1) !== 0x0a) return "unreadable";
        pending = pending.subarray(0, -1);
      }
      let end: number;
      while ((end = pending.lastIndexOf(0x0a)) >= 0 || (offset === 0 && pending.length > 0)) {
        const verdict = judge(pending.subarray(end + 1), boundaryMs, slackMs);
        if (verdict) return verdict;
        pending = pending.subarray(0, Math.max(end, 0));
      }
    }
    // Start of file without a verdict (a session_meta line prevents it), or the
    // budget spent with a record still open.
    return offset === 0 ? "turn" : "unreadable";
  } catch {
    return "unreadable";
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch {
      // the verdict stands; a failed close must not throw
    }
  }
}
