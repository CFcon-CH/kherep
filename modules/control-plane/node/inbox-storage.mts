import fs from "node:fs";
import path from "node:path";
import { isMessageId } from "../protocol-messages.mts";
import { boundRecordValid } from "./message-owner.mts";
import { readSelected, reject } from "./inbox-selected-read.mts";
import type { InboxRecord } from "./inbox.mts";

export const BOUND_NAMESPACE = "bound-v1";
const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === "ENOENT";
function stat(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); } catch (e) { if (missing(e)) return null; throw e; }
}
function directory(dir: string): fs.Stats | null {
  const s = stat(dir);
  if (s && (!s.isDirectory() || s.isSymbolicLink())) throw new Error("invalid inbox directory");
  return s;
}
function same(a: fs.Stats | null, b: fs.Stats | null): boolean {
  return a === null ? b === null : b !== null && a.dev === b.dev && a.ino === b.ino;
}
function parents(dir: string): [fs.Stats | null, fs.Stats | null] {
  const root = directory(dir);
  return [root, root ? directory(path.join(dir, BOUND_NAMESPACE)) : null];
}
function unchanged(dir: string, before: ReturnType<typeof parents>): void {
  const after = parents(dir);
  if (!before.every((s, i) => same(s, after[i]))) throw new Error("inbox directory changed");
}
function valid(record: InboxRecord, id: string, bound: boolean): void {
  if (record && record.messageId !== id) reject("mismatch");
  if (!record || !boundRecordValid(record)
    || Object.hasOwn(record, "binding") !== bound) throw new Error("invalid inbox record location or binding");
}
export interface InboxLocation { file: string; bound: boolean; stat: fs.Stats; record: InboxRecord }
// This selected operation never lists any directory or inspects another ID.
export function locateInboxRecord(dir: string, id: string, cached?: InboxLocation): InboxLocation | null {
  if (!isMessageId(id)) throw new Error("invalid message id");
  const before = parents(dir);
  if (!before[0]) return null;
  const flat = path.join(dir, `${id}.json`), bound = path.join(dir, BOUND_NAMESPACE, `${id}.json`);
  const a = stat(flat), b = before[1] ? stat(bound) : null;
  if (a && b) throw new Error("duplicate inbox record");
  let result: InboxLocation | null = null;
  if (a || b) {
    const file = b ? bound : flat;
    const original = (b ?? a)!;
    const cachedStat = cached?.stat;
    const record = cached && cached.file === file && cachedStat && same(cachedStat, original)
      && cachedStat.size === original.size && cachedStat.mtimeMs === original.mtimeMs && cachedStat.ctimeMs === original.ctimeMs
      ? cached.record : readSelected(file) as InboxRecord;
    valid(record, id, !!b);
    const current = fs.lstatSync(file);
    if (!same(original, current) || original.size !== current.size || original.mtimeMs !== current.mtimeMs
      || original.ctimeMs !== current.ctimeMs) throw new Error("inbox record changed");
    result = { file, bound: !!b, stat: current, record };
  }
  unchanged(dir, before);
  return result;
}
export function readInboxRecord(dir: string, id: string): InboxRecord | null {
  return locateInboxRecord(dir, id)?.record ?? null;
}
// Listings are one O(N) syscall; name validation and bounded body reads are
// separate yielded steps. No mutation is authorized until full preflight ends.
function* inboxRecordIdSteps(dir: string): Generator<void, { ids: string[]; boundIds: string[] }> {
  yield;
  const before = parents(dir), ids: string[] = [], boundIds: string[] = [], seen = new Set<string>();
  if (!before[0]) return { ids, boundIds };
  yield;
  const names = fs.readdirSync(dir);
  for (const name of names) {
    yield;
    if (/^bound-v/.test(name) && name !== BOUND_NAMESPACE) throw new Error("unsupported inbox namespace");
    const id = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (isMessageId(id)) { ids.push(id); seen.add(id); }
  }
  if (before[1]) {
    yield;
    const names = fs.readdirSync(path.join(dir, BOUND_NAMESPACE));
    for (const name of names) {
      yield;
      if (/^\..+\.tmp$/.test(name)) {
        const s = fs.lstatSync(path.join(dir, BOUND_NAMESPACE, name));
        if (!s.isFile() || s.nlink !== 1) throw new Error("invalid inbox temporary file");
        continue;
      }
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!isMessageId(id)) throw new Error("invalid bound namespace entry");
      if (seen.has(id)) throw new Error("duplicate inbox record");
      seen.add(id); ids.push(id); boundIds.push(id);
    }
  }
  unchanged(dir, before);
  return { ids, boundIds };
}
function drainStorage<T>(steps: Generator<void, T>): T {
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
// Generic UUID enumeration retains its bound-only body validation contract.
export function inboxRecordIds(dir: string): string[] {
  const before = parents(dir);
  const { ids, boundIds } = drainStorage(inboxRecordIdSteps(dir));
  for (const id of boundIds) locateInboxRecord(dir, id);
  unchanged(dir, before);
  return ids;
}
export function* inboxRecordLocationSteps(dir: string): Generator<void, InboxLocation[]> {
  yield;
  const before = parents(dir);
  const { ids } = yield* inboxRecordIdSteps(dir);
  const locations: InboxLocation[] = [];
  for (const id of ids) {
    yield;
    const location = locateInboxRecord(dir, id);
    if (location) locations.push(location);
  }
  unchanged(dir, before);
  return locations;
}
export function inboxRecordLocations(dir: string): InboxLocation[] {
  return drainStorage(inboxRecordLocationSteps(dir));
}
// Caller holds the common root UUID lock. Never migrate or downgrade a body.
export function recordWriteLocation(dir: string, id: string, next: InboxRecord): string {
  const bound = Object.hasOwn(next, "binding");
  valid(next, id, bound);
  const before = parents(dir);
  if (!before[0]) throw new Error("missing inbox directory");
  if (fs.readdirSync(dir).some(n => /^bound-v/.test(n) && n !== BOUND_NAMESPACE)) throw new Error("unsupported inbox namespace");
  const current = locateInboxRecord(dir, id);
  if (current && (current.bound !== bound || JSON.stringify(current.record.binding) !== JSON.stringify(next.binding)
    || bound && (current.record.toSession !== next.toSession || JSON.stringify(current.record.from) !== JSON.stringify(next.from)))) {
    throw new Error("bound owner cannot change");
  }
  unchanged(dir, before);
  if (bound && !before[1]) fs.mkdirSync(path.join(dir, BOUND_NAMESPACE), { mode: 0o700 });
  const checked = parents(dir);
  const file = path.join(dir, ...(bound ? [BOUND_NAMESPACE] : []), `${id}.json`);
  locateInboxRecord(dir, id);
  unchanged(dir, checked);
  return file;
}
export interface BindingStorageSnapshot { ready: boolean; generation: number }
export interface BindingStorage {
  snapshot(): BindingStorageSnapshot;
  ready(): boolean;
  fault(): void;
  recheck(): boolean;
}
// Readiness describes local storage capability only. A fault latches until a
// real layout/access round succeeds; status/receipt paths cannot recover it.
export function createBindingStorage(dir: string): BindingStorage {
  let ready = false, generation = 0;
  const fault = (): void => { ready = false; generation++; };
  const recheck = (): boolean => {
    const previous = ready;
    let scratch: string | undefined, renamed: string | undefined;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      parents(dir);
      const bound = path.join(dir, BOUND_NAMESPACE);
      if (!directory(bound)) fs.mkdirSync(bound, { mode: 0o700 });
      inboxRecordLocations(dir);
      // An unready attempt must establish write/read/rename capability too.
      if (!ready) {
        const before = parents(dir);
        scratch = path.join(bound, `.storage-${process.pid}-${Date.now()}.tmp`);
        renamed = `${scratch}.checked.tmp`;
        fs.writeFileSync(scratch, "storage-v1", { flag: "wx", mode: 0o600 });
        if (fs.readFileSync(scratch, "utf8") !== "storage-v1") throw new Error("storage check failed");
        fs.renameSync(scratch, renamed);
        unchanged(dir, before);
      }
      ready = true;
    } catch { ready = false; }
    finally {
      for (const file of [scratch, renamed]) if (file) {
        try { fs.rmSync(file, { force: true }); } catch { ready = false; }
      }
    }
    if (previous !== ready) generation++;
    return ready;
  };
  recheck();
  return { ready: () => ready, snapshot: () => ({ ready, generation }), fault, recheck };
}
