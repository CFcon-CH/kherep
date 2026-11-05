import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { withProbeLock } from "./probe-lock.mts";

// The lock codes and the bound live in probe-lock.mts (issues #600, #602).
export { LOCK_ATTEMPTS, LOCK_HELD_CODES } from "./probe-lock.mts";

export const INTENT_TTL_MS = 30_000;
const MAX_INTENTS = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const HASH = /^[a-f0-9]{64}$/;

export interface IntentInput { sessionId: string; callId: string; syntheticNonce: string }
export interface NativeMeta { sessionId?: string; threadId?: string; callId?: string }
export interface ProbeArguments { requestId: string; syntheticNonce: string }
export interface ProbeReceipt {
  code: "binding_confirmed";
  sessionHash: string;
  threadHash: string;
  callHash: string;
  nonceHash: string;
  bindingHash: string;
}
export type ProbeCode = "invalid_input" | "missing_native_meta" | "intent_not_found" | "identity_mismatch"
  | "nonce_mismatch" | "intent_expired" | "storage_error";
export type ProbeResult = { ok: true; receipt: ProbeReceipt } | { ok: false; code: ProbeCode };

type IntentRecord = {
  version: 1;
  sessionHash: string;
  callHash: string;
  nonceHash: string;
  expiresAt: number;
  receipt?: ProbeReceipt;
};

const intentsDir = (stateDir: string): string => path.join(stateDir, "intents");
const intentFile = (stateDir: string, requestId: string): string => path.join(intentsDir(stateDir), `${requestId}.json`);
const keyFile = (stateDir: string): string => path.join(stateDir, "probe.key");

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort((left, right) => Number(left > right) - Number(left < right)).join("\0") === [...keys].sort((left, right) => Number(left > right) - Number(left < right)).join("\0");
}

function validReceipt(value: unknown): value is ProbeReceipt {
  if (!isRecord(value) || !hasExactKeys(value,
    ["code", "sessionHash", "threadHash", "callHash", "nonceHash", "bindingHash"])) return false;
  return value.code === "binding_confirmed" && [value.sessionHash, value.threadHash, value.callHash,
    value.nonceHash, value.bindingHash].every((hash) => typeof hash === "string" && HASH.test(hash));
}

function validIntent(value: unknown): value is IntentRecord {
  if (!isRecord(value) || !hasExactKeys(value, value.receipt === undefined
    ? ["version", "sessionHash", "callHash", "nonceHash", "expiresAt"]
    : ["version", "sessionHash", "callHash", "nonceHash", "expiresAt", "receipt"])) return false;
  return value.version === 1 && [value.sessionHash, value.callHash, value.nonceHash]
    .every((hash) => typeof hash === "string" && HASH.test(hash))
    && typeof value.expiresAt === "number" && Number.isSafeInteger(value.expiresAt) && value.expiresAt >= 0
    && (value.receipt === undefined || validReceipt(value.receipt));
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readKey(stateDir: string, create: boolean): Buffer {
  ensureDir(stateDir);
  const file = keyFile(stateDir);
  if (create && !fs.existsSync(file)) {
    let handle: number | undefined;
    try {
      handle = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(handle, crypto.randomBytes(32));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
    }
  }
  const key = fs.readFileSync(file);
  if (key.length !== 32) throw new Error("storage_error");
  return key;
}

function digest(key: Buffer, label: string, value: string): string {
  return crypto.createHmac("sha256", key).update(label).update("\0").update(value).digest("hex");
}

function sameHash(left: string, right: string): boolean {
  if (!HASH.test(left) || !HASH.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function writeJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
}

function readIntent(stateDir: string, requestId: string): IntentRecord | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(intentFile(stateDir, requestId), "utf8"));
    if (!validIntent(value)) throw new Error("storage_error");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function prune(stateDir: string, now: number): void {
  ensureDir(intentsDir(stateDir));
  const files = fs.readdirSync(intentsDir(stateDir)).filter((name) => UUID.test(name.slice(0, -5)) && name.endsWith(".json"));
  let malformed = false;
  for (const name of files) {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(path.join(intentsDir(stateDir), name), "utf8"));
      if (!validIntent(value)) throw new Error("storage_error");
      if (value.expiresAt <= now) fs.unlinkSync(path.join(intentsDir(stateDir), name));
    } catch (error) {
      // Issue #602: a concurrent verify removed it after the listing.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      malformed = true;
    }
  }
  if (malformed) throw new Error("storage_error");
  if (fs.readdirSync(intentsDir(stateDir)).filter((name) => name.endsWith(".json")).length >= MAX_INTENTS) {
    throw new Error("storage_error");
  }
}

function validRaw(value: string): boolean {
  return value.length > 0 && value.length <= 512;
}

export function createIntent(stateDir: string, input: IntentInput, now: number = Date.now()): { requestId: string } {
  if (!validRaw(input.sessionId) || !validRaw(input.callId) || !NONCE.test(input.syntheticNonce)) {
    throw new Error("invalid_input");
  }
  return withProbeLock(stateDir, "create", () => {
    const key = readKey(stateDir, true);
    prune(stateDir, now);
    const requestId = crypto.randomUUID();
    writeJson(intentFile(stateDir, requestId), {
      version: 1,
      sessionHash: digest(key, "session", input.sessionId),
      callHash: digest(key, "call", input.callId),
      nonceHash: digest(key, "nonce", input.syntheticNonce),
      expiresAt: now + INTENT_TTL_MS,
    } satisfies IntentRecord);
    return { requestId };
  });
}

export function verifyIntent(stateDir: string, args: ProbeArguments, meta: NativeMeta,
  now: number = Date.now()): ProbeResult {
  if (!UUID.test(args.requestId) || !NONCE.test(args.syntheticNonce)) return { ok: false, code: "invalid_input" };
  if (!meta.sessionId || !meta.threadId || !meta.callId
    || !validRaw(meta.sessionId) || !validRaw(meta.threadId) || !validRaw(meta.callId)) {
    return { ok: false, code: "missing_native_meta" };
  }
  try {
    const key = readKey(stateDir, false);
    return withProbeLock(stateDir, args.requestId, () => {
      const record = readIntent(stateDir, args.requestId);
      if (!record) return { ok: false, code: "intent_not_found" };
      if (record.expiresAt <= now) {
        // Issue #602: a concurrent prune may have removed it already.
        try { fs.unlinkSync(intentFile(stateDir, args.requestId)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        return { ok: false, code: "intent_expired" };
      }
      const sessionHash = digest(key, "session", meta.sessionId!);
      const callHash = digest(key, "call", meta.callId!);
      const threadHash = digest(key, "thread", meta.threadId!);
      const nonceHash = digest(key, "nonce", args.syntheticNonce);
      if (!sameHash(record.sessionHash, sessionHash) || !sameHash(record.callHash, callHash)) {
        return { ok: false, code: "identity_mismatch" };
      }
      if (!sameHash(record.nonceHash, nonceHash)) return { ok: false, code: "nonce_mismatch" };
      if (record.receipt) {
        if (!sameHash(record.receipt.threadHash, threadHash)) {
          return { ok: false, code: "identity_mismatch" };
        }
        const bindingHash = digest(key, "binding",
          `${args.requestId}\0${sessionHash}\0${threadHash}\0${callHash}\0${nonceHash}`);
        if (!sameHash(record.receipt.sessionHash, sessionHash)
          || !sameHash(record.receipt.callHash, callHash)
          || !sameHash(record.receipt.nonceHash, nonceHash)
          || !sameHash(record.receipt.bindingHash, bindingHash)) throw new Error("storage_error");
        return { ok: true, receipt: record.receipt };
      }
      const receipt: ProbeReceipt = {
        code: "binding_confirmed", sessionHash, threadHash, callHash, nonceHash,
        bindingHash: digest(key, "binding", `${args.requestId}\0${sessionHash}\0${threadHash}\0${callHash}\0${nonceHash}`),
      };
      writeJson(intentFile(stateDir, args.requestId), { ...record, receipt });
      return { ok: true, receipt };
    });
  } catch {
    return { ok: false, code: "storage_error" };
  }
}