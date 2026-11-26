import type { TaskControlEventBody, TaskControlExecuteBody, TaskControlResultBody } from "../protocol-task-control.mts";
import type { NodePaths } from "./config.mts";
import type { InboxRecord } from "./inbox.mts";
import {
  beginOperation, completeOperation, ensureDeliveryRegistrations, pendingControlQueries, pendingControlSubmits, pendingRegistrations,
  pendingResults, recoverOperation,
} from "./task-control-store.mts";

export interface TaskControlSender {
  sendTaskControl(body: TaskControlEventBody): string[];
}

export async function handleTaskControlExecute(paths: NodePaths, body: TaskControlExecuteBody,
  run: (body: TaskControlExecuteBody) => Promise<TaskControlResultBody>, now: number = Date.now()): Promise<void> {
  const begun = beginOperation(paths, body, now);
  if (begun.kind !== "execute") return;
  let result: TaskControlResultBody;
  try {
    result = await run(body);
  } catch {
    recoverOperation(paths, body.operationId, now);
    return;
  }
  completeOperation(paths, body.operationId, result, now);
}

const BATCH_SIZE = 32;
type Lane = "register" | "submit" | "result" | "query";
const cursors = new Map<string, Partial<Record<Lane, string>>>();

function fairBatch<T>(paths: NodePaths, lane: Lane, values: T[], identity: (value: T) => string): T[] {
  if (values.length === 0) return [];
  const ordered = values.slice().sort((left, right) => identity(left).localeCompare(identity(right)));
  const state = cursors.get(paths.taskControl) ?? {};
  const prior = state[lane];
  let start = 0;
  if (prior) {
    const exact = ordered.findIndex((value) => identity(value) === prior);
    const next = exact >= 0 ? exact + 1 : ordered.findIndex((value) => identity(value) > prior);
    start = next >= 0 && next < ordered.length ? next : 0;
  }
  const batch = Array.from({ length: Math.min(BATCH_SIZE, ordered.length) },
    (_, offset) => ordered[(start + offset) % ordered.length]!);
  state[lane] = identity(batch.at(-1)!);
  cursors.set(paths.taskControl, state);
  return batch;
}

export function pollTaskControl(client: TaskControlSender, paths: NodePaths, inflight: Set<string>,
  send: (frame: string) => boolean, now: number = Date.now(), enabled = true, records?: InboxRecord[]): void {
  if (!enabled) return;
  ensureDeliveryRegistrations(paths, now, records);
  const durable = (body: TaskControlEventBody, key: string): void => {
    if (inflight.has(key)) return;
    const frames = client.sendTaskControl(body);
    if (frames.length > 0 && frames.every(send)) inflight.add(key);
  };
  for (const body of fairBatch(paths, "register", pendingRegistrations(paths, now), (item) => item.registrationId)) {
    durable(body, `register:${body.registrationId}`);
  }
  for (const body of fairBatch(paths, "submit", pendingControlSubmits(paths), (item) => item.requestId)) {
    durable(body, `submit:${body.requestId}`);
  }
  for (const body of fairBatch(paths, "result", pendingResults(paths), (item) => item.operationId)) {
    durable(body, `result:${body.operationId}`);
  }
  // A pending operation can finish without reconnecting. Query it on each
  // serialized exchange round; the request id is stable and Worker reads are idempotent.
  for (const body of fairBatch(paths, "query", pendingControlQueries(paths), (item) => item.requestId)) {
    for (const frame of client.sendTaskControl(body)) send(frame);
  }
}
