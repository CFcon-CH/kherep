// Minimal reader for the tar stream `git archive --format=tar` writes (ustar
// headers, pax extended and global headers). It never touches the file system,
// so a symlink in the archive is reported instead of being created or copied.

export interface TarEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  mode: number;
  data: Buffer;
}

const BLOCK = 512;

function text(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function octal(header: Buffer, start: number, length: number): number {
  const value = text(header, start, length).trim();
  if (!/^[0-7]*$/.test(value)) throw new Error("Invalid tar header number");
  return value ? Number.parseInt(value, 8) : 0;
}

function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error("Invalid pax record");
    const length = Number(data.subarray(offset, space).toString("ascii"));
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.length
      || data[offset + length - 1] !== 0x0a) throw new Error("Invalid pax record");
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals === -1) throw new Error("Invalid pax record");
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

function safePath(name: string): string {
  const trimmed = name.replace(/(?<!\/)\/+$/, "");
  const parts = trimmed.split("/");
  // Backslashes and colons would act as separators or streams on Windows.
  if (!trimmed || trimmed.startsWith("/") || /[\\:]/.test(trimmed)
    || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Unsafe path in archive");
  }
  return trimmed;
}

function entryType(flag: string): TarEntry["type"] {
  if (flag === "0" || flag === "\0" || flag === "") return "file";
  if (flag === "5") return "directory";
  if (flag === "2") return "symlink";
  return "other";
}

export function readTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let pending = new Map<string, string>();
  let offset = 0;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const data = archive.subarray(offset + BLOCK, offset + BLOCK + size);
    if (data.length !== size) throw new Error("Truncated tar entry");
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    const flag = String.fromCharCode(header[156]);
    if (flag === "g") continue;
    if (flag === "x") { pending = paxRecords(data); continue; }
    const prefix = text(header, 257, 6).startsWith("ustar") ? text(header, 345, 155) : "";
    const base = text(header, 0, 100);
    const name = pending.get("path") ?? (prefix ? `${prefix}/${base}` : base);
    pending = new Map();
    entries.push({ path: safePath(name), type: entryType(flag), mode: octal(header, 100, 8), data });
  }
  return entries;
}
