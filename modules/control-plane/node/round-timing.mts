import os from "node:os";

// Issue #1012: per-step timing of the daemon's exchange round, so a slow event
// loop can be attributed. A round that took ROUND_SLOW_MS or more writes one line:
//   kherep-node: round slow total_ms=6713 sync_ms=6650 cpu_ms=1840 host_busy_pct=97 skipped=0 steps=storage:310/170,
//   policy:2+0/0,registration:0/0,inbox:25/16,claude-progress:50/16,codex-progress:24/0,exchange:20/0,tasks:1/0,
//   task-control:720/330,mcp-intents:3+0/0,codex-inbound:300+12/170,codex-queue:420/200   (one line in the log)
// total_ms: wall time of the round. sync_ms: the steps' synchronous parts added up. cpu_ms: process CPU over the
// round. host_busy_pct: busy share of all cores over the round from os.cpus(), or unknown. skipped: slow rounds not
// logged since the previous line. steps: each step that ran, in ROUND_STEPS order, as name:sync/cpu, or
// name:sync+rest/cpu for a step that returned a promise (rest: the ms from its first suspension until it settled).
// Reading it: host busy near 100 with cpu_ms far below sync_ms and every step stretched is host CPU starvation; host
// busy low with one step dominating and its cpu near its sync is that step's CPU-bound scan; the same with its cpu far
// below its sync is a file system wait in that step; a large +rest with a small sync is an awaited child, the loop free.
// Limit: rest is everything after a step's first suspension, so synchronous work in a continuation is counted there.
// Metadata only: the step names are the fixed literals below and every value is a number (issue #706 rule).

export const ROUND_SLOW_MS = 2_000; // the exchange cadence
export const ROUND_ALWAYS_MS = 5_000; // from here every slow round logs
export const ROUND_LOG_SPACING_MS = 30_000; // below ROUND_ALWAYS_MS at most one line per spacing
export const ROUND_STEPS = ["storage", "policy", "registration", "inbox", "claude-progress", "codex-progress",
  "exchange", "tasks", "task-control", "mcp-intents", "codex-inbound", "codex-queue"] as const;
export type RoundStep = typeof ROUND_STEPS[number];
export interface RoundTimer { step<T>(name: RoundStep, run: () => T): T; finish(): void }
export const untimed: RoundTimer = { step: (_name, run) => run(), finish: () => {} };
export interface RoundTimingOptions {
  slowMs?: number; alwaysMs?: number; spacingMs?: number;
  now?: () => number; // monotonic ms
  cpu?: () => number; // process user+system ms
  host?: () => { idle: number; total: number }; // os.cpus() times summed over all cores, ms
}

// user+nice+sys+idle; irq is left out because on Windows it is part of sys.
function hostTimes(): { idle: number; total: number } {
  let idle = 0, total = 0;
  for (const { times } of os.cpus()) { idle += times.idle; total += times.user + times.nice + times.sys + times.idle; }
  return { idle, total };
}
const processCpu = (): number => { const { user, system } = process.cpuUsage(); return (user + system) / 1_000; };
const ms = (value: number): number => Math.max(0, Math.round(value)) || 0;
const thenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function";

export function roundTiming(log: (line: string) => void, options: RoundTimingOptions = {}): { begin(): RoundTimer } {
  const slowMs = options.slowMs ?? ROUND_SLOW_MS, alwaysMs = options.alwaysMs ?? ROUND_ALWAYS_MS;
  const spacingMs = options.spacingMs ?? ROUND_LOG_SPACING_MS;
  const now = options.now ?? (() => performance.now()), cpu = options.cpu ?? processCpu, host = options.host ?? hostTimes;
  let lastLine = -Infinity, skipped = 0; // across rounds
  return { begin(): RoundTimer {
    const begun = now(), cpuBegun = cpu(), hostBegun = host();
    const steps = new Map<RoundStep, { sync: number; rest: number; cpu: number; async: boolean }>();
    let finished = false;
    const record = (name: RoundStep, sync: number, rest: number, cpuMs: number, async: boolean): void => {
      const step = steps.get(name) ?? { sync: 0, rest: 0, cpu: 0, async: false };
      steps.set(name, { sync: step.sync + sync, rest: step.rest + rest, cpu: step.cpu + cpuMs, async: step.async || async });
    };
    return {
      step<T>(name: RoundStep, run: () => T): T {
        const started = now(), cpuStarted = cpu();
        let result: T;
        try { result = run(); } catch (error) {
          record(name, now() - started, 0, cpu() - cpuStarted, false);
          throw error;
        }
        const returned = now();
        if (!thenable(result)) {
          record(name, returned - started, 0, cpu() - cpuStarted, false);
          return result;
        }
        return Promise.resolve(result).finally(() => record(name, returned - started, now() - returned, cpu() - cpuStarted, true)) as T;
      },
      finish(): void {
        if (finished) return;
        finished = true;
        const ended = now(), total = ended - begun;
        if (total < slowMs) return;
        if (total < alwaysMs && ended - lastLine < spacingMs) { skipped++; return; }
        lastLine = ended;
        const sampled = host(), idle = sampled.idle - hostBegun.idle, all = sampled.total - hostBegun.total;
        const busy = all > 0 ? String(Math.min(100, ms(100 * (1 - idle / all)))) : "unknown";
        let sync = 0;
        for (const step of steps.values()) sync += step.sync;
        const list = ROUND_STEPS.flatMap((name) => {
          const step = steps.get(name);
          return step ? [`${name}:${ms(step.sync)}${step.async ? `+${ms(step.rest)}` : ""}/${ms(step.cpu)}`] : [];
        });
        log(`kherep-node: round slow total_ms=${ms(total)} sync_ms=${ms(sync)} cpu_ms=${ms(cpu() - cpuBegun)}`
          + ` host_busy_pct=${busy} skipped=${skipped} steps=${list.join(",")}`);
        skipped = 0;
      },
    };
  } };
}
