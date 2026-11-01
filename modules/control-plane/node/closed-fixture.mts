import { createAdmissionAuthority } from "./session-authority.mts";
import { publishSynthetic } from "./session-authority-fixture.mts";
import fs from "node:fs";
import { publishLiveness } from "./session-lifecycle.mts";
import path from "node:path";
import type test from "node:test";

import type { SessionInfo } from "../protocol.mts";
import { TURN_SPACING_MS } from "./autonomy.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { SESSIONS_INTERVAL_MS } from "./daemon.mts";
import { writeLocalSessions } from "./exchange.mts";
import { storeMessage } from "./inbox.mts";
import { CLOSED_AFTER_MISSES, readKnownSessions, rememberSessions } from "./known-sessions.mts";
import { WORKING_SETTLE_MS } from "./run-progress.mts";
import type { ExecOptions } from "./sessions.mts";
import { T0, taskNode } from "./task-fixture.mts";
import { listTasks, writeTask, type TaskRecord } from "./task-records.mts";
import { watchTasks } from "./task-watch.mts";

// Shared fixture of the closed-session tests (issues #102, #105): a task node whose
// policy accepts every sender and enables resumeClosed, with one Claude
// session listed an hour ago and missing from the listing taken now. Issue
// #389: one listing without a session no longer closes it; the fixture records
// the misses explicitly, by default CLOSED_AFTER_MISSES periodic listings
// (SESSIONS_INTERVAL_MS apart, the last at T0). #706 adds independent fresh
// exact app/holder absence; neither misses nor policy alone authorize fallback.

export const SESSION = "1f0e2c9a-6d0b-4c11-9f39-2a77c1d4e8b5";
export const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer-1" };
export const ACCEPT_ALL = { accept: [{ session: "*", from: ["*"] }] };
let counter = 0;

export type Node = ReturnType<typeof taskNode> & { livenessAuthority?: ReturnType<typeof createAdmissionAuthority> };

export function closedNode(t: test.TestContext, sessions: Record<string, unknown> = {}, messaging: Record<string, unknown> = {},
  misses: number = CLOSED_AFTER_MISSES) {
  const base = taskNode(t, { delegate: { accept: true }, ...sessions }, { messaging: { ...ACCEPT_ALL, resumeClosed: true, ...messaging } });
  const livenessAuthority = createAdmissionAuthority(base.paths);
  const node = { ...base, livenessAuthority, deps: () => ({ ...base.deps(), livenessAuthority }) };
  rememberSessions(node.paths, [{ sessionId: SESSION, runtime: "claude-code", state: "idle", name: "review",
    cwd: path.join(node.workspace, "repo") }], T0 - 3_600_000);
  missListings(node, misses);
  return node;
}

// count successful listings that show only listed, spacing apart, the last at
// end, which is also written to sessions.json.
export function missListings(node: Node, count: number, end: number = T0, spacing: number = SESSIONS_INTERVAL_MS,
  listed: SessionInfo[] = []): void {
  for (let i = count - 1; i >= 0; i--) rememberSessions(node.paths, listed, end - i * spacing);
  const targets = readKnownSessions(node.paths).filter(s => !listed.some(v => v.runtime === s.runtime && v.sessionId === s.sessionId));
  publishSynthetic(node.paths, targets.map(({ runtime, sessionId }) => ({ runtime, sessionId,
    holder: { status: "value" as const, value: { present: false }, source: "native-holder" as const, observedAt: end, complete: true, reasonCode: "observed" as const },
    app: { status: "value" as const, value: "absent" as const, source: "native-app" as const, observedAt: end, complete: true, reasonCode: "observed" as const },
  })), end, listed, node.livenessAuthority);
  writeLocalSessions(node.paths, listed, end);
}

// A session listed once and then missing from CLOSED_AFTER_MISSES periodic
// listings, the last at end: closed (issue #389).
export function closedSince(node: Node, session: SessionInfo, end: number = T0): void {
  rememberSessions(node.paths, [session], end - CLOSED_AFTER_MISSES * SESSIONS_INTERVAL_MS);
  missListings(node, CLOSED_AFTER_MISSES, end);
}

// An accepted message that arrived before the listing.
export function deliver(node: Node, extra: { toSession?: string; depth?: number; text?: string; from?: typeof PEER; inReplyTo?: string } = {}): string {
  const id = `c105ed${(++counter).toString(16).padStart(2, "0")}-0000-4000-8000-000000000000`;
  storeMessage(node.paths.inbox, { messageId: id, from: extra.from ?? PEER, toSession: extra.toSession ?? SESSION,
    text: extra.text ?? "are the tests green?", createdAt: new Date(T0).toISOString(),
    ...(extra.inReplyTo ? { inReplyTo: extra.inReplyTo } : {}) }, T0 - 5_000, extra.depth ?? 0);
  return id;
}

export const audits = (node: Node): Record<string, unknown>[] => {
  const file = path.join(node.paths.dir, "wake.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
};

// Issue #197: a watch round once the intercom turn still works after the
// settle time. That is progress, but no read receipt (issue #308).
export async function turnProgress(node: Node): Promise<void> {
  node.tick(WORKING_SETTLE_MS);
  await watchTasks(node.deps());
}

// Issue #308: a watch round once the intercom turn finished, which delivers
// the messages its start carried.
export async function turnDone(node: Node): Promise<void> {
  for (const row of node.rows) row.state = "done";
  await watchTasks(node.deps());
}

// Issue #109: a resumed intercom session continued as a copy under a new id.
export const COPY = "c0ffee00-0000-4000-8000-000000000109";

// An ended intercom session and a second message from its sender.
export async function endedIntercom(node: Node): Promise<{ task: TaskRecord; id: string }> {
  deliver(node);
  await deliverToClosed(node.deps());
  // Its turn finished: the watch round delivers the message it carried (issue #308).
  await turnDone(node);
  const [task] = listTasks(node.paths);
  writeTask(node.paths, { ...task, state: "done" });
  node.tick(TURN_SPACING_MS * 2);
  missListings(node, CLOSED_AFTER_MISSES, T0 + TURN_SPACING_MS * 2);
  return { task, id: deliver(node, { text: "and the lint?" }) };
}

// A fake claude whose resume continues as a copy, listed (or, with listed
// false, missing from the listing until the watch round).
export function copyingExec(node: Node, note: boolean, seen: (record: TaskRecord) => void) {
  const base = node.deps();
  let listed = true;
  const exec = async (file: string, args: string[], options: ExecOptions): Promise<string> => {
    if (args[0] === "agents" && !listed) throw new Error("the listing failed");
    if (args[0] !== "--resume") return base.exec!(file, args, options);
    node.calls.push({ file, args, options });
    seen(listTasks(node.paths)[0]);
    node.rows.push({ id: "c0ffee01", sessionId: COPY, state: "working", kind: "background", cwd: options.cwd });
    return `${note ? "note: continuing as a copy\n" : ""}backgrounded · c0ffee01\n`;
  };
  return { deps: { ...base, exec }, unlist: () => { listed = false; }, relist: () => { listed = true; } };
}
