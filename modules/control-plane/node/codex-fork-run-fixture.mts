import fs from "node:fs";
import type test from "node:test";

import { fakeAppServer, FORK_OWNER, type ForkScenario } from "./codex-fork-fixture.mts";
import { FORK_FEATURE_KEYS, runForkAttempt, type ForkRunInput } from "./codex-fork-process.mts";
import type { CodexDeps } from "./codex-process.mts";
import type { QueueProducerIdentity } from "./codex-queue-binding.mts";
import type { InboxRecord } from "./inbox.mts";
import { withServiceAdmission } from "./service-drain.mts";
import { taskNode, testServiceOwner, T0 } from "./task-fixture.mts";

// Issue #408, PR 3: one runForkAttempt against the fake app-server, with short
// step timeouts and an active service admission of this test process.

export const PRODUCER: QueueProducerIdentity = { codexExecutable: "/synthetic/bin/codex", launchFile: "/synthetic/bin/codex", launchPrefix: [],
  approvedFiles: [{ path: "/synthetic/bin/codex", realpath: "/synthetic/bin/codex", sha256: "b".repeat(64) }],
  resolvedCodexHome: "/synthetic/codex-home", route: "local" };
export const MESSAGE = "40800001-0000-4000-8000-000000000001";
export const RECORD: InboxRecord = { messageId: MESSAGE, from: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer" },
  toSession: FORK_OWNER, text: "Is the build green?", inReplyTo: "40800000-0000-4000-8000-000000000009",
  createdAt: new Date(T0).toISOString(), receivedAt: new Date(T0).toISOString(), state: "accepted" };
export const FAST = { initializeMs: 200, requestMs: 200, forkMs: 200, turnMs: 300, interruptMs: 100, graceMs: 30 };

export async function runFork(t: test.TestContext, scenario: Partial<ForkScenario> = {}, extra: Partial<ForkRunInput> = {},
  codex: CodexDeps = {}) {
  const node = taskNode(t);
  const cwd = fs.realpathSync.native(node.workspace);
  const app = fakeAppServer({ cwd, ...scenario });
  const running: string[][] = [], logs: string[] = [];
  let unconfirmed = 0;
  const outcome = await withServiceAdmission(node.paths, (admission) => runForkAttempt({ codex: { spawn: app.spawn as never,
    killGroup: app.killGroup, platform: "darwin", onUnconfirmedShutdown: () => { unconfirmed++; }, ...codex } }, {
    owner: FORK_OWNER, cwd, producer: PRODUCER, features: new Set(FORK_FEATURE_KEYS), mcpNames: ["synthetic_probe"], record: RECORD,
    maxAnswerBytes: 4096, admission, continueAllowed: () => true, stillAccepted: () => true, running: (lastTurnId, forkId, proof) => { running.push([lastTurnId, forkId, proof]); },
    log: (line) => { logs.push(line); }, timeouts: FAST, ...extra }), testServiceOwner);
  const run = app.runs[0]!;
  const methods = (): string[] => run.requests.filter((r) => r.method).map((r) => r.method!);
  return { outcome, app, run, methods, running, logs, unconfirmed: () => unconfirmed, paths: node.paths, cwd };
}
