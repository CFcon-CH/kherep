import { constants as bufferConstants } from "node:buffer";
import { Readable } from "node:stream";

export type StdinReadCode = "STDIN_LIMIT_EXCEEDED" | "STDIN_READ_FAILED" | "STDIN_PREMATURE_CLOSE"
  | "STDIN_INVALID_SOURCE" | "STDIN_INVALID_OPTIONS";
export interface StdinReadOptions { maxBytes: number | null }
export interface StdinReadError extends Error { code: StdinReadCode; limitBytes?: number; systemCode?: string }

const active = new WeakSet<Readable>();
const messages: Record<StdinReadCode, string> = {
  STDIN_LIMIT_EXCEEDED: "stdin exceeds the configured byte limit",
  STDIN_READ_FAILED: "stdin could not be read",
  STDIN_PREMATURE_CLOSE: "stdin closed before EOF",
  STDIN_INVALID_SOURCE: "stdin requires an exclusive unencoded byte stream",
  STDIN_INVALID_OPTIONS: "stdin requires an explicit valid byte limit or null",
};
const systemCodes = new Set(["EACCES", "EBADF", "EIO", "EISDIR", "EINVAL", "ENOMEM", "ENOENT", "EPERM",
  "EPIPE", "ECONNRESET", "ENOSPC", "EMFILE", "ENFILE", "EAGAIN", "EINTR"]);

function failure(code: StdinReadCode, limitBytes?: number, sourceError?: unknown): StdinReadError {
  const error: StdinReadError = Object.assign(new Error(messages[code]), { code });
  if (limitBytes !== undefined) error.limitBytes = limitBytes;
  try {
    const systemCode = sourceError && typeof sourceError === "object" && "code" in sourceError ? sourceError.code : undefined;
    if (typeof systemCode === "string" && systemCodes.has(systemCode)) error.systemCode = systemCode;
  } catch { /* An opaque source error cannot replace the fixed diagnostic. */ }
  return error;
}

/** Borrow a byte stream until EOF; finite overflow drains without retaining payload. */
export async function readStdinBytes(options: StdinReadOptions, input: Readable = process.stdin): Promise<Buffer> {
  if (!options || !Object.hasOwn(options, "maxBytes") || (options.maxBytes !== null
    && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || options.maxBytes > bufferConstants.MAX_LENGTH))) {
    throw failure("STDIN_INVALID_OPTIONS");
  }
  if (!(input instanceof Readable) || input.readableEncoding !== null || input.readableObjectMode
    || active.has(input)) throw failure("STDIN_INVALID_SOURCE");
  if (input.errored) throw failure("STDIN_READ_FAILED", undefined, input.errored);
  if (input.readableEnded && input.readableLength === 0) return Buffer.alloc(0);
  if (input.destroyed || input.closed) throw failure("STDIN_PREMATURE_CLOSE");
  if (input.readableFlowing === true || input.listenerCount("data") > 0 || input.listenerCount("readable") > 0) {
    throw failure("STDIN_INVALID_SOURCE");
  }

  const limit = options.maxBytes;
  active.add(input);
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false, overflow = false, retainedBytes = 0;
    let chunks: Buffer[] = [];
    const cleanup = (): void => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      input.removeListener("close", onClose);
      active.delete(input);
      chunks = [];
    };
    const rejectRead = (error: StdinReadError): void => {
      if (settled) return;
      settled = true;
      input.pause();
      cleanup();
      reject(error);
    };
    const onData = (chunk: unknown): void => {
      if (settled || overflow) return;
      if (!(chunk instanceof Uint8Array)) return rejectRead(failure("STDIN_INVALID_SOURCE"));
      if (limit !== null && chunk.byteLength > limit - retainedBytes) {
        overflow = true;
        chunks = [];
        retainedBytes = 0;
        return;
      }
      try {
        chunks.push(Buffer.from(chunk));
        retainedBytes += chunk.byteLength;
      } catch {
        rejectRead(failure("STDIN_READ_FAILED"));
      }
    };
    const onEnd = (): void => {
      if (settled) return;
      if (overflow) return rejectRead(failure("STDIN_LIMIT_EXCEEDED", limit!));
      let result: Buffer;
      try { result = Buffer.concat(chunks, retainedBytes); }
      catch { return rejectRead(failure("STDIN_READ_FAILED")); }
      settled = true;
      cleanup();
      resolve(result);
    };
    const onError = (error: unknown): void => rejectRead(failure("STDIN_READ_FAILED", undefined, error));
    const onClose = (): void => rejectRead(failure("STDIN_PREMATURE_CLOSE"));
    try {
      input.on("end", onEnd);
      input.on("error", onError);
      input.on("close", onClose);
      input.on("data", onData);
      if (!settled) input.resume();
    } catch (error) {
      rejectRead(failure("STDIN_READ_FAILED", undefined, error));
    }
  });
}
