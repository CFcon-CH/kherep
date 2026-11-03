import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { isMessageId } from "../protocol-messages.mts";
import { isCodexSessionId } from "./codex-sessions.mts";
import { outstandingNativeAttempts, targetAttemptsInState, targetQueueReconciled } from "./codex-native-attempts.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { readJson, writeJsonAtomic } from "./inbox.mts";
import { recordLockFile } from "./inbox-record-lock.mts";
import { acquireServiceOwnerFile } from "./service-drain.mts";
import { budgetOwnerProbe } from "./budget-lock.mts";

import { canonical, parseTargetGroup, targetGroupFingerprint, type TargetDeliveryGroup } from "./target-delivery-state.mts";
import { parseTargetHandle, parseTargetReservation, targetTransition, type TargetHandle, type TargetReservation } from "./target-delivery-reservation.mts";
import { readTargetRecord, writeTargetRecord } from "./target-delivery-files.mts";

interface Reservation { version: 1; owner: string; messageIds: string[]; recovered?: true }
const directory = (paths: NodePaths): string => path.join(paths.dir, "codex-native-pending");
const fileOf = (paths: NodePaths, owner: string): string => path.join(directory(paths), `${owner}.json`);
function locked<T>(paths: NodePaths, owner: string, body: () => T): T {
  if (!isCodexSessionId(owner)) throw new Error("invalid native owner");
  ensureDir(directory(paths));
  if (fs.lstatSync(directory(paths)).isSymbolicLink()) throw new Error("invalid native owner reservation directory");
  const release = acquireServiceOwnerFile(recordLockFile(directory(paths), owner), "native owner mutation held", budgetOwnerProbe());
  try {
    const result = body();
    if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("native owner mutation must be synchronous");
    return result;
  } finally { release(); }
}

// The owner reservation precedes takeTurn and every attempt write. A crash or
// unreadable/incomplete history remains a fence, never enqueue authorization.
export function reserveNativeOwner(paths: NodePaths, owner: string, messageIds: string[]): boolean {
  return locked(paths, owner, () => {
    const file = fileOf(paths, owner);
    if (fs.existsSync(file)) return false;
    const unresolved = outstandingNativeAttempts(paths, owner);
    if (unresolved.length) {
      writeJsonAtomic(file, { version: 1, owner, messageIds: unresolved, recovered: true } satisfies Reservation);
      return false;
    }
    fs.writeFileSync(file, JSON.stringify({ version: 1, owner, messageIds } satisfies Reservation), { flag: "wx", mode: 0o600 });
    return true;
  });
}

// Called only after exact Queue reconciliation or a proven no-submit path.
// Every per-ID original attempt stays durable and its group stays immutable.
export function releaseNativeOwner(paths: NodePaths, owner: string, neverSubmittedIds?: string[]): void {
  if (!isCodexSessionId(owner)) throw new Error("invalid native owner");
  try {
    if (fs.lstatSync(directory(paths)).isSymbolicLink()) throw new Error("invalid native owner reservation directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  locked(paths, owner, () => {
    const file = fileOf(paths, owner), saved = readJson<Reservation>(file);
    if (!saved) return;
    if (saved.version !== 1 || saved.owner !== owner || !Array.isArray(saved.messageIds)
      || saved.messageIds.length === 0 || saved.messageIds.length > 1_024 || !saved.messageIds.every(isMessageId)
      || new Set(saved.messageIds).size !== saved.messageIds.length) throw new Error("invalid native owner reservation");
    if (neverSubmittedIds && JSON.stringify(saved.messageIds) !== JSON.stringify(neverSubmittedIds)) return;
    if (outstandingNativeAttempts(paths, owner).length) return;
    if (!neverSubmittedIds && !saved.messageIds.every(id => fs.existsSync(path.join(paths.dir, "codex-native-attempts", owner, `${id}.json`)))) return;
    fs.unlinkSync(file);
  });
}

// Inactive shared-core entry. Existing IDs-only routes do not adopt this record.
// The durable attempt token never proves native consumer exclusion.
export function reserveTargetOwner(paths: NodePaths, groupValue: TargetDeliveryGroup): TargetHandle | null {
  const group = parseTargetGroup(groupValue), owner = group.originalId;
  return locked(paths, owner, () => {
    const file = fileOf(paths, owner);
    if (fs.existsSync(file) || outstandingNativeAttempts(paths, owner).length) return null;
    const handle: TargetHandle = { owner, groupId: group.groupId, generation: group.generation,
      groupFingerprint: targetGroupFingerprint(group), reservationId: crypto.randomUUID(), attemptToken: crypto.randomUUID() };
    writeTargetRecord(file, { version: 2, owner, handle, group, phase: "reserved", budget: null, queueId: null } satisfies TargetReservation, true);
    return Object.freeze(handle);
  });
}

// All core read/modify/write transitions use the exact same mutation mutex as
// both legacy entrypoints. A stored crash state requires its original handle.
export function withTargetReservation<T>(paths: NodePaths, expected: TargetHandle,
  body: (saved: TargetReservation, save: (next: TargetReservation) => void) => T): T {
  const handle = parseTargetHandle(expected);
  return locked(paths, handle.owner, () => {
    let saved = parseTargetReservation(readTargetRecord(fileOf(paths, handle.owner)));
    if (canonical(saved.handle) !== canonical(handle)) throw Error("target reservation token differs");
    let active = true;
    try {
      return body(saved, nextValue => {
        if (!active) throw Error("target mutation ended");
        const next = parseTargetReservation(nextValue); targetTransition(saved, next);
        writeTargetRecord(fileOf(paths, handle.owner), next); saved = next;
      });
    } finally { active = false; }
  });
}

// Core release never accepts the old IDs-only API as group/token proof.
export function releaseTargetOwner(paths: NodePaths, expected: TargetHandle, proof: "no-submit" | "reconciled"): boolean {
  return withTargetReservation(paths, expected, saved => {
    const proved = proof === "no-submit" ? saved.phase === "cancelled-before-submit" && targetAttemptsInState(paths, saved, "cancelled-before-submit")
      : proof === "reconciled" && targetQueueReconciled(paths, saved);
    if (!proved) return false;
    fs.unlinkSync(fileOf(paths, saved.owner)); return true;
  });
}

// Shared owner namespace and exact same mutation mutex for generalized routes.
// Locks are acquired in sorted UUID order; partial durable claims stay fences.
export function withNativeOwnerRecords<T>(paths: NodePaths, owners: string[], body: (file: (owner:string)=>string) => T): T {
  const ordered = [...new Set(owners)].sort();
  if (!ordered.length) throw Error("missing native owners");
  const visit = (n:number):T => n === ordered.length ? body(owner => {
    if (!ordered.includes(owner)) throw Error("unlocked native owner");
    return fileOf(paths, owner);
  }) : locked(paths, ordered[n], () => visit(n+1));
  return visit(0);
}
