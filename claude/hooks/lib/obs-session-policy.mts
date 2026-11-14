// Issue #922. claude-obs takes the session id only from the brief
// (claude/agents/claude-obs.md, Labels and origin), and nothing put it there:
// most Claude observation pages had no session-<id> label. The PreToolUse
// payload carries session_id, so the dispatch guard requires it as the first
// non-empty line of the brief, exactly `Session id: <id>`. A stateless deny,
// like OBS_BRIEF_FORMAT; the brief is never rewritten (no updatedInput).
//
// The payload id wins: a brief naming another id is denied. A payload without
// a usable id skips the check (fail open), so claude-obs writes "not given"
// instead of an invented label. Pure: no I/O, and a reason never quotes the
// brief. Line 1 of the reason carries no id, because the denied-call journal
// keeps only that line (lib/denial-journal.mts redactReason).

const SESSION_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

export const OBS_BRIEF_SESSION =
  "Observation brief session: the first line of the brief must be the session id line of this dispatching session.";
const RETRY = "Put that line first, unchanged, and dispatch again with the same findings.";

// The first line with content, trailing whitespace (and a CR) removed.
function firstLine(brief: string): string {
  return brief.split("\n").find((line) => line.trim() !== "")?.trimEnd() ?? "";
}

export function observationSessionIssue(brief: string, sessionId: unknown): string | null {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  const line = `Session id: ${sessionId}`;
  return firstLine(brief) === line ? null : `${OBS_BRIEF_SESSION}\n${line}\n${RETRY}`;
}
