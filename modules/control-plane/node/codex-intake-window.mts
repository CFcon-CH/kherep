import { parseEnvelope } from "../protocol.mts";
import { isMessageDeliverBody, isMessageReceiptBody, isMessageStatusBody } from "../protocol-messages.mts";
import { isMcpIntentReceiptBody } from "../protocol-mcp.mts";
import type { FrameArrival, IntakeDiagnostics } from "./intake-diagnostics.mts";
import type { NodeClient } from "./client.mts";
import { CODEX_ACTIVE_MS, readCodexSession } from "./codex-sessions.mts";
import type { NodePaths } from "./config.mts";
import { DAEMON_RECORD_LOCK_WAIT_MS, runRecordLockRound } from "./inbox-record-lock.mts";
import { readPolicy, type NodePolicy } from "./policy.mts";

interface Options {
  client: NodeClient;
  paths: NodePaths;
  policyFile: string;
  policy: NodePolicy;
  connected: () => boolean;
  send: (frame: string) => boolean;
  exchange: () => void;
  queue: () => void;
  defer: (data: string, arrival?: FrameArrival) => void;
  diagnostics?: IntakeDiagnostics;
  // Called once with each frame the window itself hands to onFrame (issue #487 D1).
  handled: (data: string) => void;
  log: (message: string) => void;
}

export interface CodexIntakeWindow {
  frame(data: string, arrival?: FrameArrival): boolean;
  tick(): void;
  close(): void;
  drain(): Promise<void>;
}

// Only open around the awaited Codex intake, after all previous frames have
// been published. No command/authentication may execute on this window.
// Accepted callbacks run synchronously inside onFrame; drain their publication
// before returning the main lane to any other frame allocator.
export function codexIntakeWindow(options: Options): CodexIntakeWindow {
  let closed = false;
  let pending = Promise.resolve();
  let tickPending = false;
  const policy = JSON.stringify(options.policy);
  function eligible(): boolean {
    if (closed) return false;
    if (!options.connected() || !options.client.authenticated
      || JSON.stringify(readPolicy(options.policyFile, true)) !== policy) closed = true;
    return !closed;
  }
  function admittedFrame(data: string): boolean {
    const parsed = parseEnvelope(data);
    if (!parsed.ok) return false;
    const { type, body } = parsed.envelope;
    if (type === "event") return isMessageReceiptBody(body);
    if (type === "message.status") return isMessageStatusBody(body);
    if (type === "mcp.intent.receipt") return isMcpIntentReceiptBody(body);
    if (type !== "message.deliver" || !isMessageDeliverBody(body)) return false;
    // Only positively recorded full Codex IDs. Aliases, unknown targets and
    // Claude messages keep their previous ordering on the main lane.
    try {
      const session = readCodexSession(options.paths, body.toSession);
      return session?.runtime === "codex" && session.sessionId === body.toSession
        && Date.now() - Date.parse(session.lastSeen) <= CODEX_ACTIVE_MS;
    }
    catch { return false; }
  }
  function enqueue(run: () => Promise<void>): void {
    pending = pending.then(() => runRecordLockRound(DAEMON_RECORD_LOCK_WAIT_MS, run)).catch((error: unknown) => {
      closed = true;
      options.log(`kherep-node: Codex intake peer progress failed: ${String(error)}`);
    });
  }
  return {
    frame(data: string, arrival?: FrameArrival): boolean {
      if (!eligible() || !admittedFrame(data)) return false;
      enqueue(async () => {
        if (!eligible()) { options.defer(data, arrival); return; }
        // Once admitted, publish its result even if policy changes afterwards.
        // A closed socket gets no ACK: the Worker retains its durable message.
        const process = async (): Promise<void> => {
          options.handled(data);
          const frames = await options.client.onFrame(data);
          for (const frame of frames) if (!options.send(frame)) break;
          if (eligible()) options.queue();
        };
        if (options.diagnostics) await options.diagnostics.process(arrival, process);
        else await process();
      });
      return true;
    },
    tick(): void {
      if (tickPending || !eligible()) return;
      tickPending = true;
      enqueue(async () => {
        try {
          if (!eligible()) return;
          options.exchange();
          if (eligible()) options.queue();
        } finally { tickPending = false; }
      });
    },
    close(): void { closed = true; },
    async drain(): Promise<void> { closed = true; await pending; },
  };
}
