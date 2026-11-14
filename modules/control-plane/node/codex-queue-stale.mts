import { blockerDiagnostic, OBSERVED_STATES, type MessageDiagnostic } from "../protocol-diagnostics.mts";
import { isPlainSessionId } from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import type { CodexInboxSelector } from "./codex-queue-inbox.mts";
import { readCodexSession } from "./codex-sessions.mts";
import { progressRecords } from "./delivery-progress.mts";
import { readLocalSessions } from "./exchange-sessions.mts";
import { readJson, type InboxRecord } from "./inbox.mts";

// Issue #919: Codex threads outside the 12 h hook window (codex-sessions.mts
// CODEX_ACTIVE_MS) that a waiting message addresses. An idle-loaded one joins the
// native queue candidates; discovery here is no authorization, the producer
// re-checks with the in-process liveness authority. Any other one is parked
// with its observed state. The population is driven by waiting messages only.
export interface StaleTarget { sessionId: string; refs: string[]; state: MessageDiagnostic["observedState"] }

const observed = (state: string | undefined): MessageDiagnostic["observedState"] =>
  (OBSERVED_STATES as readonly string[]).includes(state ?? "") ? state as MessageDiagnostic["observedState"] : "unknown";

function recorded(paths: NodePaths, sessionId: string, now: number): boolean {
  try {
    const record = readCodexSession(paths, sessionId);
    const seen = Date.parse(record?.lastSeen ?? "");
    return record?.sessionId === sessionId && record.runtime === "codex" && Number.isFinite(seen) && seen <= now;
  } catch { return false; } // an unreadable record is no absence and no admission: parked
}

// Whether sessions.json carries a plain, non-task Codex row outside the window, without reading any Inbox record.
// A round with neither such a row nor an in-window candidate reads no Inbox snapshot (issue #487). A failed read is no absence.
export function codexRowsOutside(paths: NodePaths, live: string[], tasks: ReadonlySet<string>): boolean {
  try {
    const rows = readJson<{ sessions?: unknown }>(paths.sessions)?.sessions;
    return Array.isArray(rows) && rows.some((row: { runtime?: unknown; sessionId?: unknown }) => row?.runtime === "codex"
      && typeof row.sessionId === "string" && isPlainSessionId(row.sessionId) && !live.includes(row.sessionId) && !tasks.has(row.sessionId));
  } catch { return true; }
}

export function staleCodexTargets(paths: NodePaths, inbox: InboxRecord[], live: string[], tasks: ReadonlySet<string>,
  now: number): { idle: string[]; parked: StaleTarget[] } {
  const known = new Set(live);
  const wanted = new Set(inbox.filter((r) => r.state === "accepted" && !known.has(r.toSession)).map((r) => r.toSession));
  if (wanted.size === 0) return { idle: [], parked: [] };
  const rows = readLocalSessions(paths, now).filter((s) => s.runtime === "codex");
  const names = new Map<string, number>();
  for (const row of rows) if (row.name) names.set(row.name, (names.get(row.name) ?? 0) + 1);
  const idle: string[] = [], parked: StaleTarget[] = [];
  for (const row of rows) {
    if (!isPlainSessionId(row.sessionId) || known.has(row.sessionId) || tasks.has(row.sessionId)) continue;
    const refs = [row.sessionId, ...(row.name && names.get(row.name) === 1 ? [row.name] : [])].filter((ref) => wanted.has(ref));
    if (refs.length === 0) continue;
    if (row.state === "idle-loaded" && recorded(paths, row.sessionId, now)) idle.push(row.sessionId);
    else parked.push({ sessionId: row.sessionId, refs, state: observed(row.state) });
  }
  return { idle, parked };
}

export function markParked(paths: NodePaths, parked: StaleTarget[], select: CodexInboxSelector, now: number): void {
  for (const target of parked) {
    const records = select(target.refs, { sessionId: target.sessionId, runtime: "codex" }).filter((r) => r.state === "accepted");
    progressRecords(paths, records, "waiting", "awaiting-user-turn", now, undefined,
      blockerDiagnostic("target-not-idle", now, "target-progress", target.state));
  }
}
