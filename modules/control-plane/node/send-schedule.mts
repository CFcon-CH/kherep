import { retryDelay } from "./backoff.mts";

// When the exchange round sends again what the Worker has not answered
// (issue #308). Outbox resends and inbox status re-reports back off: the first
// retry comes exactly SEND_RETRY_MS after the first send, so a lost answer on a
// live connection still heals within 30 s (issue #195); later ones wait
// between half and all of 30 s * 2^n, at most 10 min. The schedule belongs to
// one connection: the daemon creates a new inflight map per connection, and
// the schedule is kept beside that map, so a reconnect starts over at once.
export const SEND_RETRY_MS = 30_000;
export const SEND_RETRY_MAX_MS = 600_000;
// A directory.request younger than this after the last one this connection
// sent waits, so a burst of msg CLI calls asks the Worker once.
export const DIRECTORY_COALESCE_MS = 10_000;

// The wait after the n-th send of the same thing (n >= 1).
function resendDelay(sends: number, random: () => number = Math.random): number {
  return sends <= 1 ? SEND_RETRY_MS : retryDelay(sends - 1, { baseMs: SEND_RETRY_MS, maxMs: SEND_RETRY_MAX_MS }, random);
}

// Keys with their send count and the time they may go out again. A key that
// is not known is due at once; retain drops the keys that no longer wait for
// an answer, so the same key starts over if it comes back.
export class Retries {
  private readonly entries = new Map<string, { sends: number; dueAt: number }>();

  due(key: string, now: number): boolean {
    const entry = this.entries.get(key);
    return entry === undefined || now >= entry.dueAt;
  }

  sent(key: string, now: number, random: () => number): void {
    const sends = (this.entries.get(key)?.sends ?? 0) + 1;
    this.entries.set(key, { sends, dueAt: now + resendDelay(sends, random) });
  }

  retain(keys: Iterable<string>): void {
    const keep = new Set(keys);
    for (const key of this.entries.keys()) if (!keep.has(key)) this.entries.delete(key);
  }
}

export interface SendSchedule { outbox: Retries; reports: Retries; directorySentAt?: number }

const schedules = new WeakMap<object, SendSchedule>();

// The schedule of the connection that owns this inflight map.
export function sendSchedule(connection: object): SendSchedule {
  let schedule = schedules.get(connection);
  if (!schedule) {
    schedule = { outbox: new Retries(), reports: new Retries() };
    schedules.set(connection, schedule);
  }
  return schedule;
}

export function directoryDue(schedule: SendSchedule, now: number): boolean {
  return schedule.directorySentAt === undefined || now - schedule.directorySentAt >= DIRECTORY_COALESCE_MS;
}

// Issue #961: after authentication the outbox waits for the Worker's first
// directory answer on this connection. The node sends directory.get after
// register on the same socket, so that answer is the first sign that the
// Worker took up this connection; it narrows the race, it does not prove the
// registration. A missing or malformed answer holds the outbox at most
// OUTBOX_GATE_MS after authentication.
export const OUTBOX_GATE_MS = 10_000;
export function outboxHeld(client: { workerCapabilities: readonly string[] | null; authenticatedAt: number }, now: number): boolean {
  return client.workerCapabilities === null && now - client.authenticatedAt < OUTBOX_GATE_MS;
}
