// Issue #555. The state the PostToolUse recorder obs-handback-record.mts writes
// for a claude-obs report delivered through SubagentHandback, and that the
// SubagentStop hook obs-result-check.mts reads, plus the notice texts both
// print, so a double notice in the race between them is the same text twice.
//
// <home>/.cache/obs-result-check/<agent_id>.delivered: one line
// `<verdict>\t<tool_use_id or ->`, verdict `wrote`, `empty`, `failed` or
// `malformed <fixed problem text>`. <agent_id>.stop: one line of fixed keys the
// stop hook writes for the host measurement of the hook ordering. Neither holds
// message text, a session id or a path. Both are pruned after 24 h.
//
// Issue #571. <agent_id>.refused: one line `refused\t<tool_use_id or ->`,
// created once, exclusively, by the PreToolUse gate obs-handback-gate.mts when
// it refuses that id's first malformed handback, or (issue #950) its first
// `wrote` handback whose page lines a measured brief cannot read: one refusal
// per id in total. It is retained: prune skips it, and no hook removes it,
// because no event marks an agent id as never to
// be resumed again. Deleting it is an operator action and re-arms the gate.
//
// The home is the parent of the invoked hooks directory, the rule of
// guard-dispatch.mts, with no environment variable. Only writers create the
// directory: a read, a clear or a prune never does. Every operation is best
// effort and never throws.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  briefRecord, type BriefRecord, claudeIds, claudePages, formatBrief, joinPromotion, NO_BRIEF, NO_SESSION, type PageEvidence, parseBrief,
  promotionReason, unjoinable, unjoinedWarning, unreadableWarning,
} from "./obs-promotion-policy.mts";

export interface Delivered { verdict: string; toolUseId: string }
// null: no state. "unreadable": a state that exists but cannot be read; the two are told apart.
export type DeliveredRead = Delivered | null | "unreadable";

export interface StopTrace {
  mode: unknown;
  state: "present" | "absent" | "unreadable" | "stale";
  waited: number;
  after: "present" | "absent" | "-";
  transcript: "delivered" | "refused" | "unknown" | "none";
  branch: string;
}

const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MODES = new Set(["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"]);
const DAY_MS = 86_400_000;

export const PREFIX = "Kherep obs-result-check:";
export const FAILED_MESSAGE = `${PREFIX} claude-obs reported OBS-RESULT: failed. The Maestro reports it as a failure in this turn, never as an empty result.`;
export const stillMalformed = (problem: string): string =>
  `${PREFIX} the claude-obs result is still malformed (${problem}); the Maestro treats it as a failure.`;

// The status line format, shared by the stop hook's block reason and the gate's deny reason.
export const OBS_RESULT_FORMAT = [
  "`OBS-RESULT: wrote <n> <page ids>` with n equal to the number of numeric ids,",
  "or `OBS-RESULT: empty <reason>` or `OBS-RESULT: failed <reason>`, the reason not starting with wrote, empty or failed.",
  "Create no further pages.",
].join(" ");

export const GATE_PREFIX = "Kherep obs-handback-gate:";
const REFUSED_ONCE = "This refusal happens once; the next handback is delivered as sent and checked by the recorder.";

// Issue #950. The page line format of claude-obs.md (Result), for a session with a `measured:` brief.
export const PAGE_LINE_FORMAT = [
  "after the status line one line per written page, exactly `<id> finding=<n|-> evidence=<confirmed|assumed|refuted|superseded> <title>`,",
  "`<n>` the 1-based position of the brief finding the page files, never above the number of findings in the brief,",
  "`-` when it files none, and the label the page actually carries.",
].join(" ");

// withPages: a `measured:` brief is recorded for the session, so the one refusal also states the page line format.
export const refusedReason = (problem: string, withPages = false): string => [
  `${GATE_PREFIX} OBS-RESULT check (ROUTING.md, Session observations): the first non-empty line of your SubagentHandback message is not exactly one valid status line (${problem}).`,
  "Send the handback again with exactly one OBS-RESULT line as its first line, restated from what you actually did:",
  OBS_RESULT_FORMAT,
  ...(withPages ? [`A \`measured:\` brief is recorded for this session: ${PAGE_LINE_FORMAT}`] : []),
  REFUSED_ONCE,
].join(" ");

// Issue #950. A valid `wrote` status line whose page lines the promotion join cannot read.
export const pageLinesReason = (): string => [
  `${GATE_PREFIX} page line check (claude-obs, Result): a \`measured:\` brief is recorded for this session and not every page id of your \`OBS-RESULT: wrote\` line has a page line in the required form.`,
  `Send the handback again with the same status line and the same page list: ${PAGE_LINE_FORMAT}`,
  "Create no further pages.",
  REFUSED_ONCE,
].join(" ");

export function homeOf(invoked: string): string {
  return path.dirname(path.dirname(path.resolve(invoked)));
}

export function validId(value: unknown): string | null {
  return typeof value === "string" && AGENT_ID.test(value) ? value : null;
}

export function stateDir(home: string): string {
  return path.join(home, ".cache", "obs-result-check");
}

function writeLine(home: string, name: string, line: string): void {
  try {
    const dir = stateDir(home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, name), line, { mode: 0o600 });
  } catch {
    // Best effort: the caller's notice does not depend on the state.
  }
}

export function recordDelivered(home: string, id: string, verdict: string, toolUseId: unknown): void {
  const key = typeof toolUseId === "string" && TOOL_USE_ID.test(toolUseId) ? toolUseId : "-";
  writeLine(home, `${id}.delivered`, `${verdict}\t${key}\n`);
}

export function readDelivered(home: string, id: string): DeliveredRead {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(stateDir(home), `${id}.delivered`), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
  const match = /^([^\t\n]+)\t([^\t\n]+)\n?$/.exec(raw);
  return match ? { verdict: match[1]!, toolUseId: match[2]! } : "unreadable";
}

export function clearDelivered(home: string, id: string): void {
  try {
    fs.unlinkSync(path.join(stateDir(home), `${id}.delivered`));
  } catch {
    // Absent already, or not ours to remove.
  }
}

export type Refused = "created" | "exists" | "failed";

// The once-only marker of the PreToolUse gate (issue #571). Created exclusively (O_EXCL):
// the first caller sees "created", every later one "exists", any other failure is "failed".
// It is never removed by a hook: prune() skips it (see there).
export function markRefused(home: string, id: string, toolUseId: unknown): Refused {
  let fd: number;
  try {
    const dir = stateDir(home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fd = fs.openSync(path.join(dir, `${id}.refused`), "wx", 0o600);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "failed";
  }
  try {
    const key = typeof toolUseId === "string" && TOOL_USE_ID.test(toolUseId) ? toolUseId : "-";
    fs.writeSync(fd, `refused\t${key}\n`);
  } catch {
    // The marker exists; its content is a convenience for the host measurement.
  } finally {
    fs.closeSync(fd);
  }
  return "created";
}

// Every regular file older than maxAgeMs, except the gate's .refused markers (issue #571, retained).
export function prune(home: string, maxAgeMs = DAY_MS): void {
  const dir = stateDir(home);
  let names: string[];
  try {
    if (!fs.lstatSync(dir).isDirectory()) return; // a linked state directory is not followed
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const limit = Date.now() - maxAgeMs;
  for (const name of names) {
    try {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !name.endsWith(".refused") && stat.mtimeMs < limit) fs.unlinkSync(file);
    } catch {
      // Raced by another stop hook, or not removable: the next prune tries again.
    }
  }
}

// Issue #731 PR-B. Session-keyed state of the promotion join. <session_id>.brief:
// the one formatBrief line (integers only) the dispatch guard writes after it
// allowed an observation dispatch. <session_id>.promote.<pid>.<hex>: one line of
// comma-separated numeric page ids, one file per join, written through a .tmp
// file renamed into place; the parent Stop hook claims every pending file of the
// session by renaming it to <file>.<pid>.claim. <agent_id>.<key>.joined: empty,
// created once by the hook that joined that result. The session id is the
// payload's, of the shape obs-session-policy.mts accepts; anything else keeps
// no state. prune() removes every one of these files after 24 h.
const SESSION_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const PAGE_IDS = /^\d{1,30}(?:,\d{1,30})*\n?$/;
const byNumber = (a: string, b: string) => (a.length - b.length) || a.localeCompare(b);

export function validSession(value: unknown): string | null {
  return typeof value === "string" && SESSION_ID.test(value) ? value : null;
}

// Never throws: recording a brief must never turn an allowed dispatch into a deny.
// The home may be given as a function, so that its derivation is covered too.
export function recordBrief(home: string | (() => string), sessionId: unknown, brief: string): void {
  try {
    const id = validSession(sessionId);
    if (id) writeLine(typeof home === "string" ? home : home(), `${id}.brief`, formatBrief(briefRecord(brief)));
  } catch {
    // No brief: the join then warns instead of promoting.
  }
}

// null: no usable brief (absent, unreadable or not one formatBrief line).
export function readBrief(home: string, id: string): BriefRecord | null {
  try {
    return parseBrief(fs.readFileSync(path.join(stateDir(home), `${id}.brief`), "utf8"));
  } catch {
    return null;
  }
}

// Issue #950. The session's brief when it marks a finding measured, else null.
function measuredBrief(home: string, sessionId: unknown): BriefRecord | null {
  const id = validSession(sessionId);
  const brief = id ? readBrief(home, id) : null;
  return brief?.measured.length ? brief : null;
}

export function hasMeasuredBrief(home: string, sessionId: unknown): boolean {
  return measuredBrief(home, sessionId) !== null;
}

// True when the session has a measured brief and a page id of the message's
// status line has no page line the join can read. Never throws: every step
// reads best effort or parses a string.
export function pageLinesUnreadable(home: string, sessionId: unknown, message: string): boolean {
  return joinPromotion(measuredBrief(home, sessionId), claudeIds(message), claudePages(message)).unreadable.length > 0;
}

// The ids of one pending file; none for a file that is unreadable or not one id line.
function readIds(file: string): string[] {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return PAGE_IDS.test(raw) ? raw.trim().split(",") : [];
  } catch {
    return [];
  }
}

// One new file per join, never a merge: a Stop that claims while a join writes
// can then never see ids twice, and two joins never overwrite each other. The
// line is written beside its name and renamed into place, so a claim never
// reads half a file.
function writePromote(home: string, id: string, hits: readonly string[]): void {
  const dir = stateDir(home), file = path.join(dir, `${id}.promote.${process.pid}.${randomBytes(6).toString("hex")}`), temp = `${file}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, `${[...hits].sort(byNumber).join(",")}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    try { fs.unlinkSync(temp); } catch { /* best effort; prune removes a leftover */ }
  }
}

// The key a result is joined under: its tool_use_id when valid, else the first
// 16 hex digits of the SHA-256 of its trimmed status line (a final message, a
// Codex receipt), so a repeated status line is the same result.
export function joinKey(toolUseId: unknown, message: string): string {
  if (typeof toolUseId === "string" && TOOL_USE_ID.test(toolUseId)) return toolUseId;
  const status = message.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  return `s${createHash("sha256").update(status).digest("hex").slice(0, 16)}`;
}

// Issue #731 PR-B. The first hook that joins a result creates
// <agent_id>.<key>.joined exclusively; a second join of the same result (the
// other Claude join site, a resumed agent, a repeated SubagentStop) is skipped,
// so a consumed promotion is never written again. Only without a valid agent
// id, or when the marker cannot be written, does the join run unguarded.
export function claimJoin(home: string, agentId: string | null, key: string): boolean {
  if (!agentId) return true;
  try { fs.mkdirSync(stateDir(home), { recursive: true, mode: 0o700 }); } catch { /* the open below reports it */ }
  try {
    fs.closeSync(fs.openSync(path.join(stateDir(home), `${agentId}.${key}.joined`), "wx", 0o600));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EEXIST";
  }
}

// The result side of the join. Writes the hits for the session and returns the
// warning for the operator, or null. Never throws. Without a session id or a
// recorded brief, the pages that could be a hit get the unjoined warning; a
// brief without a measured finding is silent. claim (claimJoin) runs only when
// there are hits to write, so a result without one leaves no join marker.
export function recordPromotion(home: string, sessionId: unknown, ids: readonly string[], pages: ReadonlyMap<string, PageEvidence>,
  claim: () => boolean = () => true): string | null {
  const id = validSession(sessionId);
  const brief = id ? readBrief(home, id) : null;
  if (!id || !brief) {
    const open = unjoinable(ids, pages);
    return open.length ? unjoinedWarning(open, id ? NO_BRIEF : NO_SESSION) : null;
  }
  const { hits, unreadable } = joinPromotion(brief, ids, pages);
  if (hits.length && claim()) writePromote(home, id, hits);
  return unreadable.length ? unreadableWarning(unreadable) : null;
}

// The parent Stop hook's side: one fixed reason for every pending file of the
// session, or null. A successful rename to this process's .claim file is
// ownership, so each written file is delivered at most once; the claimed copies
// are read, their ids de-duplicated and sorted, and removed. Never throws.
export function pendingPromotion(home: string, sessionId: unknown): string | null {
  const id = validSession(sessionId);
  if (!id) return null;
  const dir = stateDir(home);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null; // no state directory: nothing pending
  }
  const pending = new RegExp(`^${id}\\.promote(?:\\.\\d+\\.[0-9a-f]+)?$`);
  const ids = new Set<string>();
  for (const name of names.filter((entry) => pending.test(entry))) {
    const claim = path.join(dir, `${name}.${process.pid}.claim`);
    try {
      fs.renameSync(path.join(dir, name), claim);
    } catch {
      continue; // another Stop claimed it
    }
    for (const page of readIds(claim)) ids.add(page);
    try { fs.unlinkSync(claim); } catch { /* not a file; prune leaves it to the operator */ }
  }
  return ids.size ? promotionReason([...ids].sort(byNumber)) : null;
}

export function writeStopTrace(home: string, id: string, trace: StopTrace): void {
  const mode = trace.mode === undefined ? "-" : MODES.has(trace.mode as string) ? trace.mode : "other";
  writeLine(home, `${id}.stop`, `mode=${mode} state=${trace.state} waited=${Math.round(trace.waited)} `
    + `after=${trace.after} transcript=${trace.transcript} branch=${trace.branch}\n`);
}
