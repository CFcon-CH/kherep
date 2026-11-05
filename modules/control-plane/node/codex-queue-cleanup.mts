import type { NodePaths } from "./config.mts";
import { getMessage } from "./inbox.mts";
import {
  listQueueBindings, removeQueueBinding, type QueueBinding, type QueueProducerIdentity,
} from "./codex-queue-binding.mts";

export interface QueueRow { id: string; input: unknown }
export interface QueuePage { data: QueueRow[]; nextCursor: string | null }
export interface NativeQueueClient {
  list(owner: string, cursor?: string): Promise<QueuePage>;
  delete(owner: string, queueId: string): Promise<{ deleted: boolean }>;
  close(): Promise<void>;
}

export class NativeQueueShutdownError extends Error {
  readonly whenStopped?: Promise<void>;
  constructor(whenStopped?: Promise<void>, options?: ErrorOptions) {
    super("Codex queue cleanup shutdown failed", options);
    this.name = "NativeQueueShutdownError";
    this.whenStopped = whenStopped;
  }
}

interface CleanupOptions {
  timeoutMs?: number; maxPages?: number; owner?: string;
  candidates?: QueueBinding[];
  retire?: (binding: QueueBinding, matchedInput: boolean) => boolean | void;
  authorized?: () => boolean;
}
interface CompleteList { complete: boolean; rows: QueueRow[] }
type OpenQueueClient = (opened: (client: NativeQueueClient) => void) => Promise<NativeQueueClient>;

export function sameIdentity(expected: QueueProducerIdentity, actual: QueueProducerIdentity): boolean {
  return expected.route === "local" && actual.route === "local"
    && expected.codexExecutable === actual.codexExecutable && expected.launchFile === actual.launchFile
    && expected.resolvedCodexHome === actual.resolvedCodexHome
    && expected.launchPrefix.length === actual.launchPrefix.length
    && expected.launchPrefix.every((value, index) => value === actual.launchPrefix[index])
    && exactValue(expected.approvedFiles, actual.approvedFiles);
}

function exactValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => exactValue(item, right[index]));
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  const a = Object.keys(left).sort((leftText, rightText) => Number(leftText > rightText) - Number(leftText < rightText));
  const b = Object.keys(right).sort((leftText, rightText) => Number(leftText > rightText) - Number(leftText < rightText));
  return a.length === b.length && a.every((key, index) => key === b[index]
    && exactValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function delivered(paths: NodePaths, binding: QueueBinding): boolean {
  return binding.admissionComplete === true && binding.admissionMessageIds.every((id) => {
    const record = getMessage(paths.inbox, id);
    return record?.messageId === id && record.toSession === binding.owner && record.state === "delivered";
  });
}

export function deliveredQueueBindings(paths: NodePaths, owner: string): QueueBinding[] {
  return listQueueBindings(paths).filter((binding) => binding.owner === owner && delivered(paths, binding));
}

async function completeList(client: NativeQueueClient, owner: string, maxPages: number,
  active: () => boolean): Promise<CompleteList> {
  const rows: QueueRow[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    if (!active()) return { complete: false, rows };
    const result = await client.list(owner, cursor);
    if (!active() || !Array.isArray(result.data)) return { complete: false, rows };
    rows.push(...result.data);
    if (result.nextCursor === null) return { complete: true, rows };
    if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) {
      return { complete: false, rows };
    }
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  return { complete: false, rows };
}

async function cleanup(paths: NodePaths, current: QueueProducerIdentity, open: OpenQueueClient,
  maxPages: number, active: () => boolean, opened: (client: NativeQueueClient) => void,
  options: CleanupOptions): Promise<{ removed: number; kept: number }> {
  const bindings = options.candidates ?? listQueueBindings(paths);
  const owner = options.owner;
  const authorized = options.authorized ?? (() => true);
  const retire = options.retire ?? ((binding: QueueBinding) => removeQueueBinding(paths, binding.queuedSubmissionId));
  const candidates = bindings.filter((binding) => (owner === undefined || binding.owner === owner)
    && authorized() && sameIdentity(binding.producer, current) && delivered(paths, binding));
  if (candidates.length === 0) return { removed: 0, kept: bindings.length };
  let removed = 0;
  const client = await open(opened);
  opened(client);
  try {
    for (const binding of candidates) {
      if (!active() || !authorized()) break;
      const before = await completeList(client, binding.owner, maxPages, active);
      if (!active() || !before.complete) continue;
      const matches = before.rows.filter((row) => row.id === binding.queuedSubmissionId);
      if (matches.length === 0) {
        if (!active() || !authorized()) continue;
        if (retire(binding, false) !== false) removed++;
        continue;
      }
      if (matches.length !== 1 || !exactValue(matches[0]!.input, binding.expectedInput)) continue;
      if (!active() || !authorized() || !delivered(paths, binding)) continue;
      const response = await client.delete(binding.owner, binding.queuedSubmissionId);
      if (!active() || response.deleted !== true) continue;
      const after = await completeList(client, binding.owner, maxPages, active);
      if (active() && after.complete && !after.rows.some((row) => row.id === binding.queuedSubmissionId)) {
        if (retire(binding, true) !== false) removed++;
      }
    }
  } finally {
    if (active()) await client.close();
  }
  return { removed, kept: bindings.length - removed };
}

export async function cleanupOwnedQueues(paths: NodePaths, current: QueueProducerIdentity,
  open: OpenQueueClient, options: CleanupOptions = {}): Promise<{ removed: number; kept: number }> {
  const bindings = options.candidates ?? listQueueBindings(paths);
  const timeoutMs = options.timeoutMs ?? 5_000;
  let active = true;
  let timer: NodeJS.Timeout | undefined;
  let client: NativeQueueClient | undefined;
  let timeoutClose: Promise<void> = Promise.resolve();
  const work = cleanup(paths, current, open, options.maxPages ?? 32, () => active,
    (opened) => { client = opened; }, options);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        active = false;
        timeoutClose = Promise.resolve().then(() => client?.close());
        const timedOut = (): void => reject(new Error("Codex queue cleanup timed out"));
        void timeoutClose.then(timedOut, timedOut);
      }, timeoutMs); }),
    ]);
  } catch (error) {
    if (!active) {
      let shutdownFailure: unknown;
      await timeoutClose.catch((failure: unknown) => { shutdownFailure = failure; });
      if (client) await work.catch(() => {});
      if (shutdownFailure) {
        if (shutdownFailure instanceof NativeQueueShutdownError) throw shutdownFailure;
        throw new NativeQueueShutdownError(undefined, { cause: shutdownFailure });
      }
    }
    if (error instanceof NativeQueueShutdownError) throw error;
    return { removed: 0, kept: bindings.length };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
