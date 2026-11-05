import { nodeClock, type NodeClock } from "./node-clock.mts";

export const OPEN_DEADLINE_MS = 30_000;
export const PING_INTERVAL_MS = 30_000;
export const PONG_DEADLINE_MS = 45_000;
export const PONG_GRACE_MS = 5_000;
export interface WatchdogExpiry { code: "OPEN_TIMEOUT" | "PONG_TIMEOUT"; openMs: number; pongAgeMs: number; delayMs: number }
interface Options { clock?: NodeClock; sendPing(): void; expire(event: WatchdogExpiry): void }

// All deadlines are monotonic. Sends never extend a pending probe's deadline.
export function createConnectionWatchdog(options: Options) {
  const clock = options.clock ?? nodeClock, created = clock.now();
  let phase: "opening" | "idle" | "probe" | "grace" | "yield" | "stopped" = "opening";
  let opened = created, pongAt = created, due = created + OPEN_DEADLINE_MS;
  let timer: unknown;
  const arm = (delay: number): void => {
    clock.cancel(timer); due = clock.now() + delay; timer = clock.schedule(fire, delay);
  };
  const ping = (): void => { try { options.sendPing(); } catch { /* the unchanged deadline detects failed sends */ } };
  const expire = (code: WatchdogExpiry["code"]): void => {
    phase = "stopped"; clock.cancel(timer);
    const now = clock.now();
    options.expire({ code, openMs: Math.round(now - opened), pongAgeMs: Math.round(now - pongAt), delayMs: Math.round(Math.max(0, now - due)) });
  };
  function fire(): void {
    if (phase === "stopped") return;
    if (clock.now() < due) { timer = clock.schedule(fire, due - clock.now()); return; }
    if (phase === "opening") { expire("OPEN_TIMEOUT"); return; }
    if (phase === "idle") { phase = "probe"; arm(PONG_DEADLINE_MS); ping(); return; }
    if (phase === "probe") {
      // Even after sleep, send the confirmation now and start a NEW grace.
      // Comparing against a pre-sleep absolute grace would kill a healthy socket.
      phase = "grace"; arm(PONG_GRACE_MS); ping(); return;
    }
    if (phase === "grace") {
      // A timer delayed during the grace must also let already queued socket
      // callbacks run. The next timer turn is cancellable by a pong or stop.
      phase = "yield"; timer = clock.schedule(fire, 0); return;
    }
    expire("PONG_TIMEOUT");
  }
  timer = clock.schedule(fire, OPEN_DEADLINE_MS);
  return {
    open(): void {
      if (phase !== "opening") return;
      opened = clock.now(); pongAt = opened; phase = "idle"; arm(PING_INTERVAL_MS);
    },
    pong(): void {
      if (phase === "opening" || phase === "stopped") return;
      pongAt = clock.now(); phase = "idle"; arm(PING_INTERVAL_MS);
    },
    stop(): void { phase = "stopped"; clock.cancel(timer); },
  };
}
