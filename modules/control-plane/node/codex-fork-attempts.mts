import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isMessageId } from "../protocol-messages.mts";
import { isCodexSessionId } from "./codex-sessions.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { FORK_GOAL_DETAILS, type ForkGoalDetail, type ForkGoalProof } from "./codex-fork-goal.mts";
import { writeJsonAtomic } from "./inbox.mts";

// The Codex fork reply's attempt store (issue #408, design section 2.8):
// codex-fork-attempts/<owner>/<messageId>.json, one per message, created with
// exclusive create before any process starts, so no message is ever forked
// twice, across polls and restarts. Per message the file system decides; per
// owner (one attempt in flight) the daemon's serial lane does. Attempts are
// never deleted. A malformed, foreign or unreadable record, an unexpected file
// and a store past its bound fail every read closed: nothing reads as absent.
// The fork producer (codex-fork-reply.mts) claims and advances attempts; the
// daemon recovers them at start.

export const FORK_ATTEMPT_STATES = ["launching", "running", "completed", "declined", "failed", "uncertain", "superseded"] as const;
export type ForkAttemptState = typeof FORK_ATTEMPT_STATES[number];
export const MAX_FORK_ATTEMPTS = 1_024;
// Why an attempt ended other than completed (issue #408, design section 6.1):
// the fixed codes of the fork producer and of recovery, written once.
export const FORK_ATTEMPT_REASONS = ["initialize", "cwd-mismatch", "last-turn-not-completed", "owner-goal", "goals-disabled", "goal-unknown",
  "fork-rejected", "fork-shape", "fork-goal", "server-request", "tool-item", "unsolicited-turn", "mcp-started", "hook-ran",
  "turn-interrupted", "turn-failed", "turn-timeout", "answer-invalid", "helper-exit", "close-unconfirmed", "needs-owner",
  "insufficient-context"] as const;
export type ForkAttemptReason = typeof FORK_ATTEMPT_REASONS[number];
const MAX_RECORD_BYTES = 64 * 1024;

// Immutable after the claim: attemptId to producer. Write-once: lastTurnId to
// detail. goalProof: how the fork was shown to hold no goal; detail: the fixed
// code of a failed post-fork goal check (codex-fork-goal.mts).
export interface ForkAttempt {
  version: 1; attemptId: string; owner: string; messageId: string; attemptedAt: number; policyFingerprint: string;
  producer: Record<string, unknown>; state: ForkAttemptState; updatedAt: number;
  lastTurnId?: string; forkId?: string; answer?: string; relayMessageId?: string; relayedAt?: number; reason?: ForkAttemptReason;
  goalProof?: ForkGoalProof; detail?: ForkGoalDetail;
}
export type ForkClaim = Pick<ForkAttempt, "owner" | "messageId" | "attemptedAt" | "policyFingerprint" | "producer">;
export type ForkResult = Partial<Pick<ForkAttempt, "lastTurnId" | "forkId" | "answer" | "relayMessageId" | "relayedAt" | "reason"
  | "goalProof" | "detail">>;
const WRITE_ONCE = ["lastTurnId", "forkId", "answer", "relayMessageId", "relayedAt", "reason", "goalProof", "detail"] as const;
const GOAL_PROOFS: readonly unknown[] = ["ephemeral-gate"];

// A state may be rewritten with itself to add a write-once field. Terminal
// states never change: uncertain, failed, declined and superseded never relaunch.
const NEXT: Record<ForkAttemptState, readonly ForkAttemptState[]> = {
  launching: ["launching", "running", "failed", "uncertain", "superseded"],
  running: ["running", "completed", "declined", "failed", "uncertain", "superseded"],
  completed: ["completed", "superseded"],
  declined: [], failed: [], uncertain: [], superseded: [],
};

export function forkAttemptsPath(paths: NodePaths, owner: string): string {
  if (!isCodexSessionId(owner)) throw new Error("codex session id is not a plain name");
  return path.join(paths.dir, "codex-fork-attempts", owner);
}

const time = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown): boolean => value === undefined || (typeof value === "string" && value.length > 0);

function valid(value: ForkAttempt | null, owner: string, messageId: string): value is ForkAttempt {
  return typeof value === "object" && value !== null && value.version === 1 && isMessageId(value.attemptId) && value.owner === owner
    && isMessageId(messageId) && value.messageId === messageId && time(value.attemptedAt) && time(value.updatedAt) && typeof value.policyFingerprint === "string"
    && value.policyFingerprint.length > 0 && typeof value.producer === "object" && value.producer !== null && !Array.isArray(value.producer)
    && FORK_ATTEMPT_STATES.includes(value.state) && text(value.lastTurnId) && text(value.forkId) && text(value.answer)
    && (value.relayMessageId === undefined || isMessageId(value.relayMessageId)) && (value.relayedAt === undefined || time(value.relayedAt))
    && (value.reason === undefined || FORK_ATTEMPT_REASONS.includes(value.reason))
    && (value.goalProof === undefined || GOAL_PROOFS.includes(value.goalProof))
    && (value.detail === undefined || FORK_GOAL_DETAILS.includes(value.detail))
    && (value.state !== "completed" || typeof value.answer === "string");
}

function readRecord(file: string, owner: string, messageId: string): ForkAttempt {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new Error("invalid fork attempt record");
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as ForkAttempt | null;
  if (!valid(value, owner, messageId)) throw new Error("invalid fork attempt record");
  return value;
}

// One attempt, or null when none exists; any other failure throws.
export function readForkAttempt(paths: NodePaths, owner: string, messageId: string): ForkAttempt | null {
  if (!isMessageId(messageId)) throw new Error("invalid message id");
  try {
    return readRecord(path.join(forkAttemptsPath(paths, owner), `${messageId}.json`), owner, messageId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// Every attempt of an owner as one complete bounded snapshot. A missing
// directory is an empty store; a dotfile, such as a leftover temp file of an
// atomic write or a Finder .DS_Store, is skipped.
export function forkAttempts(paths: NodePaths, owner: string): ForkAttempt[] {
  const dir = forkAttemptsPath(paths, owner);
  let names: string[];
  try {
    if (!fs.lstatSync(dir).isDirectory()) throw new Error("invalid fork attempt directory");
    names = fs.readdirSync(dir).filter((name) => !name.startsWith("."));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (names.length > MAX_FORK_ATTEMPTS) throw new Error("fork attempt snapshot exceeds its bound");
  return names.sort((left, right) => Number(left > right) - Number(left < right)).map((name) => {
    const messageId = name.slice(0, -5);
    if (!name.endsWith(".json") || !isMessageId(messageId)) throw new Error("incomplete fork attempt snapshot");
    return readRecord(path.join(dir, name), owner, messageId);
  });
}

// Creates the launching record with exclusive create: the attempt, or null
// when the message already has one. Throws for a store that cannot be read
// completely or is full, and for an invalid claim.
export function claimForkAttempt(paths: NodePaths, claim: ForkClaim): ForkAttempt | null {
  const record: ForkAttempt = { version: 1, attemptId: crypto.randomUUID(), ...claim, state: "launching", updatedAt: claim.attemptedAt };
  if (!valid(record, claim.owner, claim.messageId)) throw new Error("invalid fork attempt claim");
  if (forkAttempts(paths, claim.owner).length >= MAX_FORK_ATTEMPTS) throw new Error("fork attempt store is at its bound");
  const dir = forkAttemptsPath(paths, claim.owner);
  ensureDir(dir);
  // Written in full first, then linked: the link is the exclusive create, so a
  // concurrent snapshot never sees a partial record.
  const file = path.join(dir, `${claim.messageId}.json`);
  const temp = path.join(dir, `.${claim.messageId}.json.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    fs.linkSync(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return record;
}

// Moves an attempt from the state the caller saw to the next one, adding
// write-once fields. Throws on any other current state, a transition NEXT does
// not allow, a changed write-once field, completed without an answer, and
// superseding a relayed attempt.
export function advanceForkAttempt(paths: NodePaths, owner: string, messageId: string, from: ForkAttemptState, to: ForkAttemptState,
  fields: ForkResult, now: number): ForkAttempt {
  const current = readForkAttempt(paths, owner, messageId);
  if (!current || current.state !== from) throw new Error("fork attempt is not in the expected state");
  if (!NEXT[from].includes(to)) throw new Error(`fork attempt transition ${from} -> ${to} is not allowed`);
  if (to === "superseded" && current.relayedAt !== undefined) throw new Error("a relayed fork attempt cannot be superseded");
  for (const key of WRITE_ONCE) {
    if (fields[key] !== undefined && current[key] !== undefined && fields[key] !== current[key]) throw new Error(`write-once field ${key} changed`);
  }
  const next: ForkAttempt = { ...current, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), state: to,
    updatedAt: now };
  if (to === "completed" && typeof next.answer !== "string") throw new Error("a completed fork attempt needs its answer");
  if (!valid(next, owner, messageId)) throw new Error("invalid fork attempt update");
  writeJsonAtomic(path.join(forkAttemptsPath(paths, owner), `${messageId}.json`), next);
  return next;
}

// At daemon start: no process of a previous daemon is still answering, so a
// launching or running attempt is uncertain (reason helper-exit) and never relaunches. unreadable:
// owners whose store could not be read completely; their attempts stay as they are.
export function recoverForkAttempts(paths: NodePaths, now: number): { recovered: number; unreadable: string[] } {
  const root = path.join(paths.dir, "codex-fork-attempts");
  let owners: string[];
  try {
    owners = fs.readdirSync(root).filter((name) => !name.startsWith(".")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { recovered: 0, unreadable: [] };
    throw error;
  }
  let recovered = 0;
  const unreadable: string[] = [];
  for (const owner of owners) {
    try {
      for (const attempt of forkAttempts(paths, owner)) {
        if (attempt.state !== "launching" && attempt.state !== "running") continue;
        advanceForkAttempt(paths, owner, attempt.messageId, attempt.state, "uncertain", { reason: "helper-exit" }, now);
        recovered++;
      }
    } catch {
      unreadable.push(owner);
    }
  }
  return { recovered, unreadable };
}

// Issue #408, design section 6.1: recovery at daemon start, one log line when
// it changed or could not read something; without a store it writes nothing.
export function recoverForkAttemptsAtStart(paths: NodePaths, now: number, log: (line: string) => void): void {
  try {
    const { recovered, unreadable } = recoverForkAttempts(paths, now);
    if (recovered || unreadable.length) {
      log(`kherep-node: ${recovered} Codex fork attempts marked uncertain; ${unreadable.length} owners unreadable`);
    }
  } catch (error) {
    log(`kherep-node: Codex fork attempt recovery failed: ${String((error as Error).message ?? error)}`);
  }
}
