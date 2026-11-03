// Issues #748 and #757. Pure rules of the weekly plan-usage watcher, shared by the recorder
// (hooks/usage-record.mts, toast), the UserPromptSubmit hook (hooks/usage-watch.mts, notice)
// and the usage-band mod (band), so threshold, pace and wording cannot diverge between the
// channels. The mod carries a byte-equal copy (mods/usage-band/hooks/lib/), pinned by a test.
// Input is the documented status-line field rate_limits.seven_day {used_percentage,
// resets_at}; an absent or unparsable window is "no window", never a zero.

export const WEEK_SECONDS = 7 * 86_400;
export const THRESHOLD_PERCENT = 50;        // condition "threshold": used >= 50
export const PACE_MIN_ELAPSED_PERCENT = 10; // pace is judged only after 10 % of the window (16.8 h)
export const PACE_MARGIN_POINTS = 5;        // and only when used - elapsed >= 5 points
export type Condition = "threshold" | "pace";
export const CONDITIONS: readonly Condition[] = ["threshold", "pace"];

export interface WeeklyWindow { used: number; resetsAt: number }   // resetsAt in epoch SECONDS
export interface Verdict { used: number; resetsAt: number; elapsed: number; threshold: boolean; pace: boolean }

export interface UsageState {
  v: 1;
  window_key: string;        // String(Math.round(resetsAt / 60)): the window identity
  resets_at: number;         // epoch seconds as received
  used_percentage: number;
  elapsed_percentage: number;
  observed_at: string;       // ISO, when the recorder evaluated
  conditions: { threshold: boolean; pace: boolean };
  notified: Partial<Record<Condition, string>>;   // ISO per condition that got its toast this window
}

function finite(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function resetSeconds(value: unknown): number | null {
  const n = finite(value);
  if (n !== null) return n > 1e12 ? n / 1000 : n;
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

export function parseWindow(used: unknown, resetsAt: unknown): WeeklyWindow | null {
  const u = finite(used);
  const r = resetSeconds(resetsAt);
  return u === null || r === null ? null : { used: u, resetsAt: r };
}

export function evaluate(window: WeeklyWindow, nowMs: number): Verdict {
  const start = window.resetsAt - WEEK_SECONDS;
  const raw = (nowMs / 1000 - start) / WEEK_SECONDS * 100;
  const elapsed = Math.min(100, Math.max(0, raw));
  return {
    used: window.used,
    resetsAt: window.resetsAt,
    elapsed,
    threshold: window.used >= THRESHOLD_PERCENT,
    pace: elapsed >= PACE_MIN_ELAPSED_PERCENT && window.used - elapsed >= PACE_MARGIN_POINTS,
  };
}

export function windowKey(resetsAt: number): string {
  return String(Math.round(resetsAt / 60));
}

function parts(epochSeconds: number, options: Intl.DateTimeFormatOptions, timeZone?: string): Record<string, string> {
  const out: Record<string, string> = {};
  const format = new Intl.DateTimeFormat("en-GB", { ...options, hour12: false, timeZone });
  for (const part of format.formatToParts(new Date(epochSeconds * 1000))) out[part.type] = part.value;
  return out;
}

// "Thu 06 Nov 09:00" in the host's zone by default (house rule: local time, never UTC).
export function formatLocal(epochSeconds: number, timeZone?: string): string {
  const p = parts(epochSeconds, { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }, timeZone);
  return `${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute}`;
}

function clock(epochSeconds: number, timeZone?: string): string {
  const p = parts(epochSeconds, { hour: "2-digit", minute: "2-digit" }, timeZone);
  return `${p.hour}:${p.minute}`;
}

const pct = (n: number) => `${Math.round(n)}%`;

export function toastText(v: Verdict, condition: Condition, timeZone?: string): { title: string; body: string } {
  const resets = `Resets ${formatLocal(v.resetsAt, timeZone)}.`;
  if (condition === "threshold") {
    return {
      title: "Claude weekly budget: half used",
      body: `${pct(v.used)} of the 7-day plan budget used after ${pct(v.elapsed)} of the window. ${resets}`,
    };
  }
  return {
    title: "Claude weekly usage ahead of pace",
    body: `${pct(v.used)} used after ${pct(v.elapsed)} of the 7-day window. ${resets}`,
  };
}

// The cached state judged at `now`: null when the window is over. A condition counts only
// when the recorder recorded it and it still holds at `now` (elapsed is re-derived; the
// cached elapsed is informational), so no text ever contradicts itself.
function judge(state: UsageState, nowMs: number): { v: Verdict; threshold: boolean; pace: boolean } | null {
  if (state.resets_at * 1000 <= nowMs) return null;
  const v = evaluate({ used: state.used_percentage, resetsAt: state.resets_at }, nowMs);
  return { v, threshold: state.conditions.threshold && v.threshold, pace: state.conditions.pace && v.pace };
}

function clauses(threshold: boolean, pace: boolean): string[] {
  return [...(threshold ? ["half of the budget is gone"] : []), ...(pace ? ["usage runs ahead of the week"] : [])];
}

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// The shared sentence of the model's and the person's notice; "" when silent.
function noticeSentence(state: UsageState, nowMs: number, timeZone?: string): string {
  const j = judge(state, nowMs);
  if (!j || (!j.threshold && !j.pace)) return "";
  const observed = Date.parse(state.observed_at);
  const reading = Number.isFinite(observed) ? `reading from ${clock(observed / 1000, timeZone)}, ` : "";
  return `${pct(j.v.used)} used, ${pct(j.v.elapsed)} of the 7-day window elapsed (${reading}resets ${formatLocal(state.resets_at, timeZone)}). ${capitalised(clauses(j.threshold, j.pace).join("; "))}.`;
}

// The hook text for the model. Silent when the window is over or no condition holds.
export function noticeText(state: UsageState, nowMs: number, timeZone?: string): string {
  const sentence = noticeSentence(state, nowMs, timeZone);
  if (!sentence) return "";
  return [
    `[usage-watch] Weekly Claude plan budget: ${sentence}`,
    "Spend sparingly until the reset: fewer and smaller delegations, cheaper models where the task allows, no speculative fan-out.",
  ].join("\n");
}

// Issue #757. One line for the person (systemMessage): the same gate and facts, no
// guidance sentence, no prefix, local times. "" when silent.
export function userNotice(state: UsageState, nowMs: number, timeZone?: string): string {
  const sentence = noticeSentence(state, nowMs, timeZone);
  return sentence ? `Weekly Claude budget: ${sentence}` : "";
}

export const STALE_AFTER_MS = 6 * 3_600_000;
export interface BandView { text: string; level: "calm" | "pace" | "threshold"; stale: boolean }

// Issue #757. The band above the prompt, from the file's state at "now"; null draws nothing.
// An unreadable reading time counts as stale.
export function bandView(state: UsageState, nowMs: number, timeZone?: string): BandView | null {
  const j = judge(state, nowMs);
  if (!j) return null;
  const observed = Date.parse(state.observed_at);
  const stale = !Number.isFinite(observed) || nowMs - observed > STALE_AFTER_MS;
  const reading = Number.isFinite(observed) ? ` · reading ${clock(observed / 1000, timeZone)}` : "";
  const said = clauses(j.threshold, j.pace).join("; ");
  let level: BandView["level"] = "calm";
  if (j.threshold) level = "threshold";
  else if (j.pace) level = "pace";
  return {
    text: `Weekly Claude budget ${pct(j.v.used)} used · ${pct(j.v.elapsed)} of the week elapsed · resets ${formatLocal(state.resets_at, timeZone)}${reading}${stale ? " (stale)" : ""}${said ? `: ${said}` : ""}`,
    level,
    stale,
  };
}

// state.json as the recorder wrote it; anything else (missing, malformed, other version,
// non-finite numbers) is null, which callers treat as "no cached window".
export function parseState(text: string | null): UsageState | null {
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  const conditions = s.conditions as Record<string, unknown> | undefined;
  const notified = s.notified;
  if (s.v !== 1 || typeof s.window_key !== "string" || typeof s.observed_at !== "string") return null;
  if (![s.resets_at, s.used_percentage, s.elapsed_percentage].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if (!conditions || typeof conditions.threshold !== "boolean" || typeof conditions.pace !== "boolean") return null;
  if (!notified || typeof notified !== "object" || Array.isArray(notified)) return null;
  return value as UsageState;
}
