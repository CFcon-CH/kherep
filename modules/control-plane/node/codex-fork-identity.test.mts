import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { forkAttempts } from "./codex-fork-attempts.mts";
import { FEATURES_STDERR_WARNING, FEATURES_STDOUT_MEASURED_ROWS, FORK_OWNER, forkNode } from "./codex-fork-fixture.mts";
import { forkTestTimeouts, resetForkFeatureCache } from "./codex-fork-reply.mts";
import { FAST } from "./codex-fork-run-fixture.mts";
import { resetMcpCache } from "./codex-mcp.mts";
import { legacyForkPoll } from "./codex-fork-legacy-poll.mts";
import { codexQueueIdle } from "./codex-queue.mts";

// Issue #408, PR 3, maintainer requirement of 2026-10-16: the measured
// versions are measurement points, not pins. What counts is the binary's
// protocol: a new version or hash that answers the same way keeps working
// without any approval step; one that lacks or changes a required capability
// fails closed with a visible reason; a changed identity is checked again.

test.beforeEach(() => { resetMcpCache(); resetForkFeatureCache(); forkTestTimeouts.value = FAST; });
test.after(() => { forkTestTimeouts.value = undefined; });

const featureRuns = (f: ReturnType<typeof forkNode>): number => f.calls.filter((args) => args[0] === "features").length;

test("(a, c) a replaced binary with the same protocol keeps working, and its features are listed again", async (t) => {
  const f = forkNode(t);
  const logs: string[] = [];
  const poll = async (): Promise<void> => { legacyForkPoll(f.deps(), (line) => { logs.push(line); }); await codexQueueIdle(); };
  f.add();
  await poll();
  f.tick(60_000);
  f.add();
  await poll();
  assert.equal(featureRuns(f), 1, "the same binary is listed once within the cache window");
  // An upgrade: other bytes at the same path (say 0.160.1 to 0.160.2), the same answers.
  fs.writeFileSync(f.binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x16, 0x02]));
  f.tick(60_000);
  f.add();
  await poll();
  assert.equal(featureRuns(f), 2, "a changed identity is listed again at once");
  assert.deepEqual(forkAttempts(f.paths, FORK_OWNER).map((a) => a.state), ["completed", "completed", "completed"]);
  assert.deepEqual(logs.filter((line) => /refused/.test(line)), []);
});

test("(b) a binary without a required capability fails closed with a visible reason", async (t) => {
  const cases: [string, Parameters<typeof forkNode>[1], Record<string, unknown>][] = [
    ["no thread/turns/list", { errors: { "thread/turns/list": { code: -32601, message: "method not found" } } },
      { state: "failed", reason: "last-turn-not-completed" }],
    ["per-fork config rejected", { errors: { "thread/fork": { code: -32600, message: "unknown config key" } } },
      { state: "failed", reason: "fork-rejected" }],
    ["another goal refusal for the fork", { forkGoalReply: { error: { code: -32600, message: "goals are not available here" } } },
      { state: "failed", reason: "fork-goal", detail: "fork-goal-error" }],
    ["goal null for the fork", { forkGoalReply: { result: { goal: null } } },
      { state: "failed", reason: "fork-goal", detail: "fork-goal-null-unexpected" }],
    ["goals off on the helper", { ownerGoalReply: { error: { code: -32600, message: "goals feature is disabled" } } },
      { state: "failed", reason: "goals-disabled" }],
  ];
  for (const [name, scenario, expected] of cases) {
    resetMcpCache();
    resetForkFeatureCache();
    const f = forkNode(t, scenario);
    f.add();
    legacyForkPoll(f.deps());
    await codexQueueIdle();
    const [attempt] = forkAttempts(f.paths, FORK_OWNER);
    assert.deepEqual({ state: attempt?.state, reason: attempt?.reason, ...(attempt?.detail ? { detail: attempt.detail } : {}) }, expected, name);
  }
  const f = forkNode(t);
  f.features("", 1);
  f.add();
  const logs: string[] = [];
  for (let round = 0; round < 2; round++) {
    legacyForkPoll(f.deps(), (line) => { logs.push(line); });
    await codexQueueIdle();
  }
  assert.deepEqual(logs.filter((line) => /refused/.test(line)), ["kherep-node: Codex fork reply refused before admission: fork-features-unknown"],
    "a missing feature listing is logged once, with its code");
  assert.deepEqual(forkAttempts(f.paths, FORK_OWNER), []);
});

test("a features list with the measured rows and a stderr WARNING lets the attempt run", async (t) => {
  const f = forkNode(t);
  f.features(FEATURES_STDOUT_MEASURED_ROWS, 0, FEATURES_STDERR_WARNING);
  f.add();
  const logs: string[] = [];
  legacyForkPoll(f.deps(), (line) => { logs.push(line); });
  await codexQueueIdle();
  assert.deepEqual(forkAttempts(f.paths, FORK_OWNER).map((a) => a.state), ["completed"]);
  assert.deepEqual(logs.filter((line) => /refused/.test(line)), []);
  const config = f.app.runs[0]!.requests.find((m) => m.method === "thread/fork")!.params!.config as Record<string, unknown>;
  assert.equal(Object.keys(config).some((key) => /transcript_v2|web_search_cached|guardianv2/.test(key)), false,
    "deprecated keys outside the fork list are not emitted");
});
