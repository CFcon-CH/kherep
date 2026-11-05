import { parseEnvelope, PING_FRAME, PONG_FRAME } from "../protocol.mts";
import { nodeClock, type NodeClock } from "./node-clock.mts";

// Stable numeric class order in logs and doctor. Never copy an incoming label.
export const FRAME_CLASSES = ["ping", "pong", "auth", "deliver", "status", "receipt", "resolve", "command", "other", "invalid"] as const;
export interface FrameArrival { monoMs: number; wallMs: number; kind: number }
export interface IntakeNumbers {
  monoMs: number; wallMs: number; receiveMs: number; receiveWallMs: number; pongMs: number; pongWallMs: number;
  lagMs: number; maxLagMs: number; appGapMs: number; pending: number;
  rx: number[]; tx: number[]; enterMs: number[]; exitMs: number[];
}
interface Options {
  clock?: NodeClock; wall?: () => number; log(line: string): void; pending(): boolean;
  publish?(snapshot: IntakeNumbers): void;
}
const number = (value: number): number => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value)));
function kind(data: string): number {
  if (data === PING_FRAME) return 0;
  if (data === PONG_FRAME) return 1;
  const parsed = parseEnvelope(data);
  if (!parsed.ok) return 9;
  const { type, body } = parsed.envelope;
  if (type === "challenge" || type === "auth" || type === "event" && (body as { name?: unknown }).name === "auth.ok") return 2;
  if (type === "message.deliver") return 3;
  if (type === "message.status") return 4;
  if (type === "event" && (body as { name?: unknown }).name === "message.receipt" || type === "mcp.intent.receipt") return 5;
  if (type === "message.resolve.request" || type === "message.resolve.response") return 6;
  return type === "command" ? 7 : 8;
}

// Validate only the fixed numeric projection when reading untrusted daemon.json.
export function diagnosticNumbers(value: unknown): IntakeNumbers | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>, result: Record<string, number | number[]> = {};
  for (const key of ["monoMs", "wallMs", "receiveMs", "receiveWallMs", "pongMs", "pongWallMs", "lagMs", "maxLagMs", "appGapMs", "pending"]) {
    const item = row[key];
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) return;
    result[key] = item;
  }
  for (const key of ["rx", "tx", "enterMs", "exitMs"]) {
    const items = row[key];
    if (!Array.isArray(items) || items.length !== FRAME_CLASSES.length
      || !items.every(item => typeof item === "number" && Number.isSafeInteger(item) && item >= 0)) return;
    result[key] = [...items];
  }
  return result as unknown as IntakeNumbers;
}

export type IntakeDiagnostics = ReturnType<typeof createIntakeDiagnostics>;
export function createIntakeDiagnostics(options: Options) {
  const clock = options.clock ?? nodeClock, wall = options.wall ?? Date.now;
  const zeros = (): number[] => FRAME_CLASSES.map(() => 0);
  const rx = zeros(), tx = zeros(), enterMs = zeros(), exitMs = zeros();
  let receiveMs = 0, receiveWallMs = 0, pongMs = 0, pongWallMs = 0, appMs = clock.now();
  let lagMs = 0, maxLagMs = 0, due = clock.now() + 1_000, publishedAt = clock.now();
  let pendingSince: number | null = null, silent = false, sawPong = false, stopped = false;
  const lastLog = new Map<number, number>();
  const schedule = (): unknown => {
    const timer = clock.schedule(tick, 1_000); clock.unref?.(timer); return timer;
  };
  const snapshot = (): IntakeNumbers => ({ monoMs: number(clock.now()), wallMs: number(wall()), receiveMs, receiveWallMs,
    pongMs, pongWallMs, lagMs, maxLagMs, appGapMs: number(clock.now() - appMs), pending: options.pending() ? 1 : 0,
    rx: [...rx], tx: [...tx], enterMs: [...enterMs], exitMs: [...exitMs] });
  const report = (code: number, frameClass = 8, age = 0): boolean => {
    const now = clock.now();
    if (stopped || now - (lastLog.get(code) ?? -Infinity) < 60_000) return false;
    lastLog.set(code, now);
    const s = snapshot();
    options.log(`INTAKE_DIAG code=${code} class=${frameClass} mono_ms=${s.monoMs} wall_ms=${s.wallMs} age_ms=${number(age)}`
      + ` lag_ms=${lagMs} max_lag_ms=${maxLagMs} app_gap_ms=${s.appGapMs} pong_gap_ms=${number(now - pongMs)}`
      + ` pending=${s.pending} rx=${rx.join(",")} tx=${tx.join(",")} enter_ms=${enterMs[frameClass]} exit_ms=${exitMs[frameClass]}`);
    return true;
  };
  const tick = (): void => {
    if (stopped) return;
    const now = clock.now();
    lagMs = number(now - due); maxLagMs = Math.max(lagMs, maxLagMs);
    if (lagMs > 5_000) report(2);
    if (options.pending()) pendingSince ??= now;
    else { pendingSince = null; silent = false; }
    if (pendingSince !== null && now - Math.max(pendingSince, appMs) > 30_000
      && sawPong && pongMs >= pendingSince && now - pongMs <= 45_000 && !silent) {
      silent = report(3);
    }
    if (now - publishedAt >= 60_000) { publishedAt = now; options.publish?.(snapshot()); }
    due = now + 1_000; timer = schedule();
  };
  let timer = schedule();
  return {
    // Socket callbacks only update memory. No log, publish, filesystem or await.
    receive(data: string): FrameArrival {
      const arrival = { monoMs: clock.now(), wallMs: wall(), kind: kind(data) };
      receiveMs = number(arrival.monoMs); receiveWallMs = number(arrival.wallMs); rx[arrival.kind]++;
      if (arrival.kind === 1) { pongMs = receiveMs; pongWallMs = receiveWallMs; sawPong = true; }
      else if (arrival.kind !== 0) { appMs = arrival.monoMs; silent = false; }
      return arrival;
    },
    sent(data: string): void { tx[kind(data)]++; },
    async process(arrival: FrameArrival | undefined, run: () => Promise<void> | void): Promise<void> {
      if (!arrival) { await run(); return; }
      enterMs[arrival.kind] = number(clock.now());
      const age = clock.now() - arrival.monoMs;
      if (age > 30_000) report(1, arrival.kind, age);
      try { await run(); }
      finally { exitMs[arrival.kind] = number(clock.now()); }
    },
    snapshot,
    stop(): void { stopped = true; clock.cancel(timer); },
  };
}
