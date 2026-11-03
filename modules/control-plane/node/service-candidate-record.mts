import type { NodePaths } from "./config.mts";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { renameReplacing } from "./inbox.mts";
import { readServiceCandidate, removeServiceCandidate, serviceRoot, writeServiceCandidate, type ServiceCandidate } from "./service-records.mts";
import type { ServiceStage } from "./service-transaction-support.mts";
import { isStopCode, stopCode } from "./service-types.mts";

export type CandidateWriter = (paths: NodePaths, value: ServiceCandidate) => void;

export function captureCandidateBytes(paths: NodePaths): Buffer | null {
  const value = readServiceCandidate(paths);
  if (!value) return null;
  const bytes = fs.readFileSync(path.join(serviceRoot(paths), "candidate.json"));
  if (JSON.stringify(JSON.parse(bytes.toString())) !== JSON.stringify(value)) throw new Error("managed service candidate changed during capture");
  return bytes;
}

export function restoreCandidateBytes(paths: NodePaths, bytes: Buffer | null): void {
  if (!bytes) { removeServiceCandidate(paths); return; }
  const file = path.join(serviceRoot(paths), "candidate.json"), temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
    renameReplacing(temp, file);
    if (!readServiceCandidate(paths) || !fs.readFileSync(file).equals(bytes)) throw new Error("managed service candidate restore differs");
  } finally { fs.rmSync(temp, { force: true }); }
}

// One durable record, not an additional journal. A failed atomic update leaves the previous phase intact.
export function persistCandidate(paths: NodePaths, value: ServiceCandidate, write: CandidateWriter = writeServiceCandidate): void {
  try {
    write(paths, value);
    if (JSON.stringify(readServiceCandidate(paths)) !== JSON.stringify(value)) throw new Error("readback differs");
  } catch {
    throw Object.assign(new Error("managed service candidate persistence failed"), { code: "RECOVERY_RECORD_PERSISTENCE_FAILED" });
  }
}

export function failedCandidate(paths: NodePaths, value: ServiceCandidate, stage: ServiceStage,
  blocker: string, cause: unknown, now: string, write?: CandidateWriter): void {
  const explicit = (cause as { stopCode?: unknown } | null)?.stopCode;
  persistCandidate(paths, { ...value, stage, blocker, stopCode: isStopCode(explicit) ? explicit : stopCode(cause), failedAt: now }, write);
}
