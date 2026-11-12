import fs from "node:fs";
import path from "node:path";

import type { NodePaths } from "./config.mts";
import { writeJsonAtomic } from "./inbox.mts";
import { serviceRoot } from "./service-records.mts";
import { SERVICE_STAGES, type ServiceStage } from "./service-transaction-support.mts";
import { isStopCode, type StopCode } from "./service-types.mts";
import { nativeFailure, safeNativeFailure, type NativeFailure } from "./service-windows-invoke.mts";

// #838 A4: service/last-failure.json names why the last upgrade or rollback failed: codes, times and a commit only,
// mode 0600. It is DISPLAY-ONLY. `service status` and `doctor` print it; no upgrade, rollback, drain, admission or
// recovery path reads it (service-last-failure-guard.test.mts). A failure before any mutation has no stage and no
// recovery. It is removed by the next successful upgrade or rollback.
export interface ServiceLastFailure {
  version: 1;
  command: "upgrade" | "rollback";
  failedAt: string;
  commit?: string;
  stage?: ServiceStage;
  blocker?: string;
  stopCode?: StopCode;
  recovery?: "restored" | "unknown";
  native?: NativeFailure;
  writeAttempted: boolean;
  drainRetained: boolean;
}

const file = (paths: NodePaths): string => path.join(serviceRoot(paths), "last-failure.json");
const ISO_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const BLOCKER = /^RECOVERY_[A-Z_]{1,40}$/;
const KEYS = ["version", "command", "failedAt", "commit", "stage", "blocker", "stopCode", "recovery", "native", "writeAttempted", "drainRetained"];

// Only fixed, pattern-checked fields are taken from the failure; its message is never read.
export function lastFailureOf(command: ServiceLastFailure["command"], error: unknown, now: Date, commit?: string): ServiceLastFailure {
  const value = (error && typeof error === "object" ? error : {}) as Record<string, unknown>;
  const native = nativeFailure(error);
  return { version: 1, command, failedAt: now.toISOString(),
    ...(typeof commit === "string" && COMMIT.test(commit) ? { commit } : {}),
    ...(typeof value.stage === "string" && (SERVICE_STAGES as readonly string[]).includes(value.stage) ? { stage: value.stage as ServiceStage } : {}),
    ...(typeof value.blocker === "string" && BLOCKER.test(value.blocker) ? { blocker: value.blocker } : {}),
    ...(isStopCode(value.stopCode) ? { stopCode: value.stopCode } : {}),
    ...(value.recovery === "restored" || value.recovery === "unknown" ? { recovery: value.recovery } : {}),
    ...(native ? { native } : {}),
    writeAttempted: value.writeAttempted === true, drainRetained: value.drainRetained === true };
}

function valid(value: unknown): value is ServiceLastFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => KEYS.includes(key)) && item.version === 1
    && (item.command === "upgrade" || item.command === "rollback")
    && typeof item.failedAt === "string" && ISO_INSTANT.test(item.failedAt) && Number.isFinite(Date.parse(item.failedAt))
    && (item.commit === undefined || (typeof item.commit === "string" && COMMIT.test(item.commit)))
    && (item.stage === undefined || (SERVICE_STAGES as readonly unknown[]).includes(item.stage))
    && (item.blocker === undefined || (typeof item.blocker === "string" && BLOCKER.test(item.blocker)))
    && (item.stopCode === undefined || isStopCode(item.stopCode))
    && (item.recovery === undefined || item.recovery === "restored" || item.recovery === "unknown")
    && (item.native === undefined || JSON.stringify(safeNativeFailure(item.native)) === JSON.stringify(item.native))
    && typeof item.writeAttempted === "boolean" && typeof item.drainRetained === "boolean";
}

export function writeServiceLastFailure(paths: NodePaths, record: ServiceLastFailure): void {
  if (!valid(record)) throw new Error("service last-failure record is invalid");
  fs.mkdirSync(serviceRoot(paths), { recursive: true, mode: 0o700 });
  writeJsonAtomic(file(paths), record);
  if (process.platform !== "win32") fs.chmodSync(file(paths), 0o600);
}

export function removeServiceLastFailure(paths: NodePaths): void { fs.rmSync(file(paths), { force: true }); }

// Display only: null when absent, "invalid" for anything else that is not exactly the fixed shape.
export function readServiceLastFailure(paths: NodePaths): ServiceLastFailure | null | "invalid" {
  let text: string;
  try { text = fs.readFileSync(file(paths), "utf8"); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "invalid";
  }
  try { const value = JSON.parse(text) as unknown; return valid(value) ? value : "invalid"; } catch { return "invalid"; }
}
