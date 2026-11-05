import fs from "node:fs";
import path from "node:path";

import { isSessionRef } from "../protocol-messages.mts";
import { CODEX_ACTIVE_MS } from "./codex-sessions.mts";
import { classifyExclusiveCreate } from "./lock-contention.mts";

// Busy-hint storage for issue #374. Only an authorized original-owner
// CP admission may publish. This module never reads, offers or confirms Inbox
// messages. The consumer claims metadata only, before returning a short hint.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const MAX_BYTES = 8192;
const FIELDS = ["owner", "generation", "admittedAt", "expiresAt", "policyFingerprint", "messages"];

export interface BusyHintAdmission {
  owner: string; generation: string; admittedAt: number; expiresAt: number;
  policyFingerprint: string; messages: { messageId: string; toSession: string }[];
}
export type BusyHintView = Readonly<Omit<BusyHintAdmission, "messages"> & {
  messages: readonly Readonly<BusyHintAdmission["messages"][number]>[];
}>;
type Ticket = BusyHintAdmission & { version: 1; claimed: boolean };
type Failure = "invalid" | "busy" | "failed";
export type BusyHintClaim = { status: "hint"; count: number } | { status: Failure | "empty" };

function exactFields(value: unknown, fields: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function admission(value: unknown): BusyHintAdmission | null {
  if (!exactFields(value, FIELDS) || typeof value.owner !== "string" || !UUID.test(value.owner)
    || typeof value.generation !== "string" || !UUID.test(value.generation)
    || typeof value.policyFingerprint !== "string" || !FINGERPRINT.test(value.policyFingerprint)
    || !Number.isSafeInteger(value.admittedAt) || !Number.isSafeInteger(value.expiresAt)
    || (value.admittedAt as number) < 0 || (value.expiresAt as number) <= (value.admittedAt as number)
    || (value.expiresAt as number) - (value.admittedAt as number) > CODEX_ACTIVE_MS
    || !Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 8) return null;
  const seen = new Set<string>(), messages: BusyHintAdmission["messages"] = [];
  for (const message of value.messages) {
    if (!exactFields(message, ["messageId", "toSession"]) || typeof message.messageId !== "string"
      || !UUID.test(message.messageId) || seen.has(message.messageId) || !isSessionRef(message.toSession)) return null;
    seen.add(message.messageId);
    messages.push({ messageId: message.messageId, toSession: message.toSession });
  }
  return { owner: value.owner, generation: value.generation, admittedAt: value.admittedAt as number,
    expiresAt: value.expiresAt as number, policyFingerprint: value.policyFingerprint, messages };
}

export const isBusyHintAdmission = (value: unknown): value is BusyHintAdmission => admission(value) !== null;

function readTicket(file: string): Ticket | null {
  let fd: number;
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error("ticket is not a regular file");
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("ticket is not a regular file");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0, bytes = 0;
    do {
      bytes = fs.readSync(fd, buffer, size, buffer.length - size, size);
      size += bytes;
    } while (bytes > 0 && size < buffer.length);
    if (size > MAX_BYTES) throw new Error("ticket exceeds metadata limit");
    const raw: unknown = JSON.parse(buffer.subarray(0, size).toString("utf8"));
    if (!exactFields(raw, [...FIELDS, "version", "claimed"]) || raw.version !== 1 || typeof raw.claimed !== "boolean") {
      throw new Error("invalid stored ticket");
    }
    const { version: _version, claimed, ...fields } = raw;
    const normalized = admission(fields);
    if (!normalized) throw new Error("invalid stored admission");
    return { ...normalized, version: 1, claimed };
  } finally { fs.closeSync(fd); }
}

function writeTicket(file: string, ticket: Ticket): void {
  const raw = JSON.stringify(ticket);
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("ticket exceeds metadata limit");
  const temporary = file + ".tmp";
  let created = false;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    created = true;
    try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    created = false;
  } finally {
    // Never remove a pre-existing temp file or another owner's lock.
    if (created) fs.rmSync(temporary, { force: true });
  }
}

// A held lock, or a create failing with EPERM, EACCES or EBUSY (Windows delete
// pending, issue #602), is busy at once: no wait, no stale handling; the next
// attempt retries the same authorized generation. Directory errors are failed.
function locked<T>(directory: string, owner: string, body: (file: string) => T): T | Failure {
  const file = path.join(directory, `${owner}.busy-hint.json`), lock = file + ".lock";
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "failed";
  } catch { return "failed"; }
  let fd: number;
  try { fd = fs.openSync(lock, "wx", 0o600); }
  catch (error) { return classifyExclusiveCreate(error) === "other" ? "failed" : "busy"; }
  let result: T | Failure;
  try { result = body(file); } catch { result = "failed"; }
  try { fs.closeSync(fd); fs.unlinkSync(lock); } catch { return "failed"; }
  return result;
}

function current(ticket: BusyHintAdmission, now: number): boolean {
  return Number.isSafeInteger(now) && ticket.admittedAt <= now && now < ticket.expiresAt;
}

export function publishBusyHint(directory: string, value: BusyHintAdmission, now: number):
  "published" | "unchanged" | Failure {
  const incoming = admission(value);
  if (!incoming || !current(incoming, now)) return "invalid";
  return locked(directory, incoming.owner, (file) => {
    const last = readTicket(file);
    if (last) {
      if (last.owner !== incoming.owner) return "invalid";
      if (last.generation === incoming.generation) {
        const { version: _version, claimed: _claimed, ...previous } = last;
        return JSON.stringify(previous) === JSON.stringify(incoming) ? "unchanged" : "invalid";
      }
      if (incoming.admittedAt <= last.admittedAt) return "invalid";
    }
    writeTicket(file, { ...incoming, version: 1, claimed: false });
    return "published";
  });
}

// eligible must synchronously recheck current authorization and only the ticket's
// bounded record IDs, without changing Inbox/queue/receipt state. Runtime freezing
// protects stored metadata; it cannot enforce side-effect freedom of caller code.
export function claimBusyHint(directory: string, owner: string, policyFingerprint: string, now: number,
  eligible: (ticket: BusyHintView) => number): BusyHintClaim {
  if (!UUID.test(owner) || !FINGERPRINT.test(policyFingerprint) || !Number.isSafeInteger(now)) return { status: "invalid" };
  const result = locked(directory, owner, (file): BusyHintClaim => {
    const last = readTicket(file);
    if (!last) return { status: "empty" };
    if (last.owner !== owner || last.policyFingerprint !== policyFingerprint || !current(last, now)) return { status: "invalid" };
    if (last.claimed) return { status: "empty" };
    const copy = admission({ owner: last.owner, generation: last.generation, admittedAt: last.admittedAt,
      expiresAt: last.expiresAt, policyFingerprint: last.policyFingerprint, messages: last.messages })!;
    copy.messages.forEach(Object.freeze);
    Object.freeze(copy.messages);
    Object.freeze(copy);
    const count = eligible(copy);
    if (!Number.isSafeInteger(count) || count < 0 || count > copy.messages.length) return { status: "invalid" };
    if (count === 0) return { status: "empty" };
    writeTicket(file, { ...last, claimed: true });
    return { status: "hint", count };
  });
  return typeof result === "string" ? { status: result } : result;
}
