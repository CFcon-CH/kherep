// Monotonic deadlines; wall time is only for correlation with existing logs.
export interface NodeClock {
  now(): number;
  schedule(run: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
  unref?(timer: unknown): void;
}

export const nodeClock: NodeClock = {
  now: () => performance.now(),
  schedule: (run, delay) => setTimeout(run, delay),
  cancel: timer => clearTimeout(timer as NodeJS.Timeout),
  unref: timer => (timer as NodeJS.Timeout).unref(),
};
