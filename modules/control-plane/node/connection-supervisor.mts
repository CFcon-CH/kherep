import { nodeClock, type NodeClock } from "./node-clock.mts";
import type { SocketErrorClass } from "./round-tally.mts";

interface CloseInfo { code: number; wasClean?: boolean; error?: SocketErrorClass | "none" }
interface Options {
  clock?: NodeClock; connect(): void; reset(): void; disconnected(): void; finish(): void;
  delay(): number; log(line: string): void;
}
export interface ConnectionGeneration { current(): boolean; retireConnection(info: CloseInfo): void }

// One owner of retirement/retry. Invalidate synchronously, before any cleanup
// that can cause a reentrant close event. Never wait for the socket's close.
export function createConnectionSupervisor(options: Options) {
  const clock = options.clock ?? nodeClock;
  let active: ConnectionGeneration | null = null, retry: unknown, stopped = false;
  return {
    begin(cleanup: () => void): ConnectionGeneration {
      const connection: ConnectionGeneration = {
        current: () => active === connection && !stopped,
        retireConnection(info) {
          if (active !== connection) return;
          active = null;
          cleanup(); options.reset(); options.disconnected();
          if (stopped) { options.finish(); return; }
          if (info.code === 4403 || info.code === 4409) {
            stopped = true;
            options.log(info.code === 4403
              ? "kherep-node: the control plane refused this node (unknown or revoked); stopping"
              : "kherep-node: another connection replaced this daemon for the same node; stopping");
            options.finish(); return;
          }
          const delay = options.delay();
          options.log(`kherep-node: disconnected (${info.code}, clean=${info.wasClean === true}, error:${info.error ?? "none"}); reconnecting in ${Math.round(delay / 1000)} s`);
          retry = clock.schedule(() => { retry = undefined; if (!stopped) options.connect(); }, delay);
        },
      };
      active = connection;
      return connection;
    },
    stop(): void {
      stopped = true; clock.cancel(retry); retry = undefined;
      if (active) active.retireConnection({ code: 1000, wasClean: true });
      else options.finish();
    },
  };
}
