import { recordLocalLabels, policyStamp } from "./session-labels.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type test from "node:test";

import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { recordSent, writeLocalSessions, writeOutbox, type OutboxRecord } from "./exchange.mts";
import type { RunMode } from "./headless-mode.mts";
import { storeMessage } from "./inbox.mts";
import type { LaunchVerdict } from "./launch-mode.mts";
import { writeRequest, type TaskRequestRecord } from "./task-records.mts";
import { listenerDir, runWake, wakeAudit, type WakeDeps } from "./wake-hook.mts";

// Shared fixture of the wake listener tests (wake-hook.test.mts,
// wake-guards.test.mts): a throwaway node directory, a fake clock and sleep.

export const PEER = "00000000-0000-4000-8000-0000000000cc";
export const SELF = "00000000-0000-4000-8000-0000000000ee";
export const SECRET = "peer text that must never reach the audit";
export const T0 = Date.UTC(2026, 8, 25, 12);
export const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

// An enrolled node whose policy wakes "review", or has the given wake section
// (absent when options.wake is present but undefined).
export function setup(t: test.TestContext, options: { wake?: unknown; enrolled?: boolean; observationAt?: number } = {}) {
  const wake = "wake" in options ? options.wake : { enabled: true, sessions: ["review"] };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-wake-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  if (options.enrolled ?? true) {
    writeLocalSessions(paths, [{ sessionId: SELF, runtime: "claude-code", state: "idle", name: "review" }]);
    writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.invalid", nodeId: "00000000-0000-4000-8000-0000000000aa",
      name: "n", publicKey: "", privateKeyFile: "", policyFile: paths.policy, enrolledAt: new Date(T0).toISOString() });
    fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], ...(wake === undefined ? {} : { wake }) }));
    const observedAt=options.observationAt??T0;
    recordLocalLabels(paths,[{sessionId:SELF,runtime:"claude-code",state:"idle-loaded",name:"review",canonicalIdentity:{version:1,source:"claude-list",runtime:"claude-code",sessionId:SELF,observedAt,lifecycleGeneration:0}}],observedAt,true,policyStamp(paths));
  }
  return { root, paths };
}

export function arrive(paths: NodePaths, n: number, at: number, toSession = "review", depth = 0): string {
  storeMessage(paths.inbox, { messageId: id(n), from: { nodeId: PEER, session: "build" }, toSession, text: `${SECRET} ${n}`,
    createdAt: new Date(at).toISOString() }, at, depth);
  return id(n);
}

// Reply grant (issue #253): a message this node sent from SELF ("review") to
// PEER an hour before T0, in sent/ with the given state, and a reply to it.
export const ORIGINAL = id(0x500);
export function sentOriginal(paths: NodePaths, overrides: Partial<OutboxRecord> = {},
  state: Parameters<typeof recordSent>[2] = "accepted", messageId = ORIGINAL): string {
  writeOutbox(paths, { messageId, fromSession: "review", fromSessionId: SELF, to: { nodeId: PEER, session: "build" }, text: "question",
    createdAt: new Date(T0 - 3_600_000).toISOString(), depth: 0, ...overrides });
  recordSent(paths, messageId, state, undefined, T0);
  return messageId;
}
export function arriveReply(paths: NodePaths, n: number, at: number, options: { from?: string; depth?: number; toSession?: string } = {}): string {
  storeMessage(paths.inbox, { messageId: id(n), from: { nodeId: options.from ?? PEER, session: "build" }, toSession: options.toSession ?? "review",
    text: `${SECRET} ${n}`, inReplyTo: ORIGINAL, createdAt: new Date(at).toISOString() }, at, options.depth ?? 1);
  return id(n);
}

// Task message grant (issue #264): a task request SELF ("review") sent an hour
// before T0, dispatched as REQUESTED_TASK on PEER, and a message of that task.
export const REQUESTED_TASK = id(0x600);
export function dispatchedRequest(paths: NodePaths, overrides: Partial<TaskRequestRecord> = {}): string {
  const request: TaskRequestRecord = { requestId: id(0x601), title: "intercom: claude@n", text: "question", requirements: { runtime: "claude", node: PEER },
    directive: "Yes, start a new session", requestedBy: "review", requestedBySessionId: SELF, label: "intercom: claude@n",
    createdAt: new Date(T0 - 3_600_000).toISOString(), state: "dispatched", taskId: REQUESTED_TASK, nodeId: PEER, ...overrides };
  writeRequest(paths, request);
  return request.requestId;
}
export function arriveTaskMessage(paths: NodePaths, n: number, at: number, options: { from?: string; taskId?: string } = {}): string {
  storeMessage(paths.inbox, { messageId: id(n), from: { nodeId: options.from ?? PEER, session: "task-00000000" }, toSession: "review",
    text: `${SECRET} ${n}`, taskId: options.taskId ?? REQUESTED_TASK, createdAt: new Date(at).toISOString() }, at, 0);
  return id(n);
}

export interface ListenOptions {
  start?: number; tick?: (clock: number) => void; maxWaitMs?: number; event?: string; mode?: string | null; token?: string;
  parentAlive?: () => boolean; source?: string; launch?: (cwd: unknown) => Promise<LaunchVerdict>;
  transcript?: string; readTranscript?: (transcriptPath: unknown) => string | undefined; runMode?: () => Promise<RunMode>;
}

// A listener on a fake clock; tick(clock) runs after each sleep, before the poll.
// The Stop input carries stop_hook_active true in a turn a Stop hook continued,
// the woken turn included; the listener arms all the same. mode null leaves
// permission_mode out, as a SessionStart input does. The settings and launch
// flags check (launch-mode.mts) finds no bypass unless launch says otherwise,
// and the session runs interactive (headless-mode.mts) unless runMode says so.
export function listen(paths: NodePaths, options: ListenOptions = {}) {
  let clock = options.start ?? T0;
  const deps: WakeDeps = {
    paths, pid: 4242, maxWaitMs: options.maxWaitMs ?? 60_000, now: () => clock, parentAlive: options.parentAlive ?? (() => true),
    sleep: async (ms) => { clock += ms; options.tick?.(clock); }, ...(options.token ? { token: () => options.token as string } : {}),
    launchMode: options.launch ?? (async () => "ok"), runMode: options.runMode ?? (async () => "interactive"),
    ...(options.readTranscript ? { transcriptMode: options.readTranscript } : {}),
  };
  return runWake({ session_id: SELF, hook_event_name: options.event ?? "Stop", stop_hook_active: true, cwd: paths.dir,
    ...(options.mode === null ? {} : { permission_mode: options.mode ?? "default" }),
    ...(options.source === undefined ? {} : { source: options.source }),
    ...(options.transcript === undefined ? {} : { transcript_path: options.transcript }) }, deps);
}

export const auditLines = (paths: NodePaths) =>
  fs.existsSync(wakeAudit(paths)) ? fs.readFileSync(wakeAudit(paths), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
export const lockFile = (paths: NodePaths) => path.join(listenerDir(paths), `${SELF}.json`);
