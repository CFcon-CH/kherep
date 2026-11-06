// Issue #326. claude-obs starts its final message with exactly one status line
// (claude/agents/claude-obs.md, Result): `OBS-RESULT: wrote <n> <page ids>`,
// `OBS-RESULT: empty <reason>` or `OBS-RESULT: failed <reason>`. A result once
// read `OBS-RESULT: failed wrote 4 pages: 1,2,3,4`, which is neither. The
// SubagentStop hook obs-result-check.mts applies this check.
//
// - The first non-empty line is the status line, and no other line starts
//   with `OBS-RESULT:`.
// - wrote: n is a positive integer without a leading zero, the ids are numeric
//   (separated by commas or whitespace), and there are exactly n of them.
// - empty and failed: a non-empty reason whose first word is no status word.
//
// Pure: no I/O, and a problem is a fixed text that never quotes the message.

export type ObsStatus = "wrote" | "empty" | "failed";
export type ObsCheck = { status: ObsStatus } | { problem: string };

const STATUS_LINE = /^OBS-RESULT:[ \t]+(wrote|empty|failed)(?:[ \t]+(.*))?$/;
const STATUS_WORDS = new Set(["wrote", "empty", "failed"]);

function wroteProblem(rest: string): string | null {
  const [count = "", ...ids] = rest.split(/[\s,]+/).filter(Boolean);
  if (!/^[1-9]\d*$/.test(count)) return "wrote needs a positive count";
  if (!ids.every((id) => /^\d+$/.test(id))) return "wrote ids are not numeric";
  return ids.length === Number(count) ? null : "wrote count differs from the number of ids";
}

function reasonProblem(status: ObsStatus, rest: string): string | null {
  const first = rest.trim().split(/\s+/)[0];
  if (!first) return `${status} needs a reason`;
  const word = first.replace(/^\W+|(?<!\W)\W+$/g, "").toLowerCase();
  return STATUS_WORDS.has(word) ? `${status} reason starts with a status word` : null;
}

export function checkObsResult(message: string): ObsCheck {
  const lines = message.split(/\r?\n/);
  const first = lines.find((line) => line.trim()) ?? "";
  const match = STATUS_LINE.exec(first.trim());
  if (!match) return { problem: "the first non-empty line is no OBS-RESULT status line" };
  // Only lines that start a status count: a page title may name OBS-RESULT.
  if (lines.filter((line) => line.trim().startsWith("OBS-RESULT:")).length > 1) {
    return { problem: "more than one OBS-RESULT line" };
  }
  const status = match[1] as ObsStatus;
  const rest = match[2] ?? "";
  const problem = status === "wrote" ? wroteProblem(rest) : reasonProblem(status, rest);
  return problem ? { problem } : { status };
}
