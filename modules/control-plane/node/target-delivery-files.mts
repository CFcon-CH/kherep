import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { renameReplacing } from "./inbox.mts";

// Cooperative owner lock must span every mutation and exact readback. Exposed
// here only for the small target core, not as a new global atomic-write policy.
export function readTargetRecord(file: string): unknown | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024
      || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0))) throw Error("unsafe target record");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function writeTargetRecord(file: string, value: unknown, create = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) throw Error("unsafe target record directory");
  const bytes = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(bytes) > 128 * 1024) throw Error("target record exceeds bound");
  if (!create && readTargetRecord(file) === null) throw Error("missing target record during transition");
  const temp = create ? file : path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (!create) renameReplacing(temp, file);
    if (fs.readFileSync(file, "utf8") !== bytes) throw Error("target record readback differs");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    // A partial exclusive-create record remains a fence, never absence.
    if (!create) fs.rmSync(temp, { force: true });
  }
}
