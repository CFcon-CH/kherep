import { isCommandBody, parseEnvelope } from "../protocol.mts";
import { isMessageDeliverBody } from "../protocol-messages.mts";
import { isTaskControlExecuteBody } from "../protocol-task-control.mts";
import type { FrameArrival, IntakeDiagnostics } from "./intake-diagnostics.mts";
import type { NodeClient } from "./client.mts";
import { getMessage } from "./inbox.mts";
import { runRecordLockRound } from "./inbox-record-lock.mts";
import { loadPolicy } from "./policy.mts";

// Issue #441: the daemon's frame lane awaits runtime work (CLI calls of up to
// 60 s each), and a message.deliver frame queued behind it waited for all of
// it. Deliveries of an authenticated connection now run on an intake lane of
// their own with exactly the body the frame lane ran for them: a policy
// refresh, the client's onDeliver (policy acceptance, store, one status frame,
// no answer when the store fails) and the publication of its frames.
//
// Both lanes, and the time an item waited, ran or a store took, are logged only when slow:
// envelope types, command names, task-control actions and message ids, never
// bodies, session names or text.

export const SLOW_LANE_MS = 5_000;
export const INTAKE_SLOW_MS = 60_000;
export interface LaneOptions { slowLaneMs?: number; intakeSlowMs?: number }

const seconds = (ms: number): string => (ms / 1000).toFixed(1);
const label = (value: unknown): string => String(value).replace(/[^\w.:-]/g, "_").slice(0, 64);

// The log kind of an inbound frame, parsed only for an item that was slow.
export function frameKind(data: string): string {
  const parsed = parseEnvelope(data);
  if (!parsed.ok) return "frame:invalid";
  const { type, body } = parsed.envelope;
  if (type === "command") return isCommandBody(body) ? `command:${label(body.command)}` : "command:invalid";
  if (type === "event" && isTaskControlExecuteBody(body)) return `task-control:${label(body.action)}`;
  if (type === "event" && (body as { name?: unknown }).name === "auth.ok") return "auth";
  return `frame:${label(type)}`;
}

// enqueuedAt: when the item was put on the lane (issue #487); its wait behind
// earlier items is logged when it exceeds the same threshold as the run time.
export type LaneTimer = (lane: string, kind: string | (() => string), run: () => Promise<void> | void, enqueuedAt?: number) => Promise<void>;

export function laneTimer(log: (line: string) => void, slowMs = SLOW_LANE_MS, now: () => number = Date.now): LaneTimer {
  return async (lane, kind, run, enqueuedAt) => {
    const started = now();
    const waited = enqueuedAt === undefined ? 0 : started - enqueuedAt;
    try {
      await run();
    } finally {
      const took = now() - started;
      // The kind is parsed only for a slow item.
      const item = (): string => `kherep-node: lane ${lane} item ${typeof kind === "function" ? kind() : kind}`;
      if (took > slowMs) log(`${item()} took ${seconds(took)} s${waited > slowMs ? `, waited ${seconds(waited)} s` : ""}`);
      else if (waited > slowMs) log(`${item()} waited ${seconds(waited)} s, took ${seconds(took)} s`);
    }
  };
}

// Issue #627: each lane item of the daemon is a round of record lock waits
// that together stay within ms (inbox-record-lock.mts runRecordLockRound).
export function lockRounds(timed: LaneTimer, ms: number): LaneTimer {
  return (lane, kind, run, enqueuedAt) => timed(lane, kind, () => runRecordLockRound(ms, run), enqueuedAt);
}

// The then-callback of a lane item, stamped with the time it was enqueued.
export function enqueued(timed: LaneTimer, lane: string, kind: string | (() => string), run: () => Promise<void> | void,
  now: () => number = Date.now): () => Promise<void> {
  const at = now();
  return () => timed(lane, kind, run, at);
}

// What the intake lane needs of the connection a frame arrived on.
export interface IntakeConnection {
  live(): boolean;
  send(frame: string): boolean;
  publishRegistration(frames: string[]): boolean;
}

interface IntakeOptions {
  client: NodeClient;
  policyFile: string;
  inbox: string;
  log: (line: string) => void;
  timed: LaneTimer;
  intakeSlowMs?: number;
  diagnostics?: IntakeDiagnostics;
}

// One lane per daemon, spanning reconnects like the frame lane.
export function intakeLane(options: IntakeOptions): (data: string, arrivedAt: number, connection: IntakeConnection, arrival?: FrameArrival) => void {
  let lane = Promise.resolve();
  return (data, arrivedAt, connection, arrival) => {
    lane = lane.then(() => options.timed("intake", "intake:deliver", () => {
      const process = async (): Promise<void> => {
        if (!connection.live()) return;
        const refreshed = await options.client.refreshPolicy(loadPolicy(options.policyFile));
        if (!connection.live()) return;
        connection.publishRegistration(refreshed);
        const frames = await options.client.onFrame(data, connection.live());
        for (const frame of frames) if (!connection.send(frame)) break;
        logSlowIntake(options, data, arrivedAt);
      };
      return options.diagnostics ? options.diagnostics.process(arrival, process) : process();
    }, arrivedAt)).catch((error: unknown) => options.log(`kherep-node: message intake failed: ${String(error)}`));
  };
}

// A message stored on this arrival long after the control plane accepted it
// (createdAt): the total and the part spent between socket arrival and store.
// A large total with a small lane wait points upstream (Worker, socket).
function logSlowIntake(options: IntakeOptions, data: string, arrivedAt: number): void {
  const slowMs = options.intakeSlowMs ?? INTAKE_SLOW_MS;
  const parsed = parseEnvelope(data);
  if (!parsed.ok || !isMessageDeliverBody(parsed.envelope.body)) return;
  const body = parsed.envelope.body;
  if (!(Date.now() - Date.parse(body.createdAt) > slowMs)) return;
  let record: ReturnType<typeof getMessage>;
  try { record = getMessage(options.inbox, body.messageId); } catch { return; }
  if (!record) return; // not stored
  const receivedAt = Date.parse(record.receivedAt);
  if (!(receivedAt >= arrivedAt)) return; // stored by an earlier arrival
  const total = receivedAt - Date.parse(record.createdAt);
  if (!(total > slowMs)) return;
  const seconds = (ms: number): string => (ms / 1000).toFixed(1);
  options.log(`kherep-node: message ${body.messageId} stored ${seconds(total)} s after control-plane accept (lane wait ${seconds(receivedAt - arrivedAt)} s)`);
}
