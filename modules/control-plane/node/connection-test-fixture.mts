import type { NodeClock } from "./node-clock.mts";

export class FakeClock implements NodeClock {
  time = 0;
  sequence = 0;
  timers = new Map<number, { at: number; run: () => void }>();
  now = (): number => this.time;
  schedule = (run: () => void, delay: number): number => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + delay, run });
    return id;
  };
  cancel = (timer: unknown): void => { this.timers.delete(timer as number); };
  fire(): boolean {
    const due = [...this.timers].filter(([, timer]) => timer.at <= this.time)
      .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    if (!due) return false;
    this.timers.delete(due[0]); due[1].run(); return true;
  }
  advance(ms: number): void {
    const end = this.time + ms;
    while (true) {
      const at = Math.min(...[...this.timers.values()].map(timer => timer.at));
      if (at > end) break;
      this.time = at; this.fire();
    }
    this.time = end;
  }
}

export const flush = async (): Promise<void> => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
