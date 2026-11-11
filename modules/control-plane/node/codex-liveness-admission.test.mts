// Issue #706, Phase 2: the daemon's own composition (createLivenessPass ->
// attachLiveness -> recordingSessions -> pollCodexQueue) with the real Codex
// liveness source and a fake holder probe. Synthetic ids and files only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeCodexBin, codexNode } from "./codex-fixture.mts";
import type { HolderProbe } from "./codex-holder-probe.mts";
import { codexLivenessSource } from "./codex-liveness-source.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { listCodexSessions, markStopEnded, recordCodexSession } from "./codex-sessions.mts";
import { recordingSessions } from "./exchange-sessions.mts";
import { getMessageProgress, storeMessage } from "./inbox.mts";
import { attachLiveness, createLivenessPass } from "./liveness-pass.mts";
import { createAdmissionAuthority } from "./session-authority.mts";
import { livenessAdmission, sessionVerdict } from "./session-lifecycle.mts";
import { T0 } from "./task-fixture.mts";

const OWNER = "01a0db01-0000-7000-8000-000000000001";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "public-synthetic-peer" };
const ROLLOUT = `rollout-2026-11-11T09-00-00-${OWNER}.jsonl`;

function setup(t: test.TestContext, options: { nativeQueue?: boolean; probe?: HolderProbe } = {}) {
  const fake = fakeCodexBin(t);
  const node = codexNode(t, {}, { findCodex: () => fake.file });
  const home = path.join(node.root, "synthetic-owner-home");
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  const rollout = path.join(home, "sessions", ROLLOUT);
  fs.writeFileSync(rollout, "");
  fs.utimesSync(rollout, T0 / 1000, T0 / 1000);
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8"));
  policy.wake = { enabled: true, sessions: [OWNER], nativeQueue: options.nativeQueue ?? true };
  fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
  let clock = T0;
  recordCodexSession(node.paths, OWNER, node.workspace, T0, "default", "Stop");
  markStopEnded(node.paths, OWNER);
  const probes: number[] = [];
  const holder = { pid: 4242, startMs: T0 - 60_000, identity: `4242:${(T0 - 60_000) / 1000}` };
  const probe: HolderProbe = options.probe ?? (async () => {
    probes.push(clock);
    return { at: clock, processes: [holder], holders: new Map([[OWNER, [{ ...holder, file: rollout }]]]) };
  });
  const source = codexLivenessSource({ paths: node.paths, home, probe, now: () => clock, platform: "darwin" });
  const authority = createAdmissionAuthority(node.paths);
  // The same composition as daemon.mts.
  const pass = createLivenessPass(source, () => clock, authority, source.intervalMs);
  const list = async () => {
    const rows = listCodexSessions(node.paths, clock);
    return attachLiveness(rows, await pass.observe(rows.map(r => ({ runtime: r.runtime, sessionId: r.sessionId }))));
  };
  const publish = () => recordingSessions(node.paths, list, () => {}, () => clock, undefined, undefined, authority)();
  const deps = () => ({ ...node.deps({ findCodex: () => fake.file, home, queueTimeoutMs: 10_000 }), livenessAuthority: authority, now: () => clock });
  const add = (n: number) => {
    const id = `7060000${n}-0000-4000-8000-000000000001`;
    storeMessage(node.paths.inbox, { messageId: id, from: PEER, toSession: OWNER, text: "x", createdAt: new Date(clock).toISOString() }, clock);
    return id;
  };
  const poll = async () => { pollCodexQueue(deps()); await codexQueueIdle(); };
  const attempt = (id: string) => path.join(node.paths.dir, "codex-native-attempts", OWNER, `${id}.json`);
  const verdict = () => sessionVerdict(node.paths, { runtime: "codex", sessionId: OWNER }, clock).state;
  const admits = () => livenessAdmission(node.paths, { runtime: "codex", sessionId: OWNER }, "queue", clock, undefined, authority) !== null;
  return { node, fake, publish, add, poll, attempt, verdict, admits, probes, tick: (ms: number) => { clock += ms; } };
}

test("B: a held, idle thread reads idle-loaded and the native Queue route submits codex queue", async (t) => {
  const s = setup(t);
  await s.publish();
  const id = s.add(2);
  await s.poll();
  assert.equal(s.verdict(), "idle-loaded");
  assert.equal(s.fake.runs().length, 1);
  assert.deepEqual(s.fake.runs()[0]!.argv.slice(0, 3), ["queue", "--thread", OWNER]);
  assert.equal(JSON.parse(fs.readFileSync(s.attempt(id), "utf8")).state, "submitted");
});

test("C: every 60 s listing tick observes again, so admission stays open on each tick", async (t) => {
  const s = setup(t);
  await s.publish();
  for (let tick = 1; tick <= 5; tick++) {
    s.tick(60_001); // the next SESSIONS_INTERVAL_MS tick
    await s.publish();
    assert.equal(s.verdict(), "idle-loaded", `tick ${tick}`);
    assert.equal(s.admits(), true, `tick ${tick}`);
  }
  assert.equal(s.probes.length, 6, "one probe per tick");
  const id = s.add(3);
  await s.poll();
  assert.equal(s.fake.runs().length, 1);
  assert.equal(JSON.parse(fs.readFileSync(s.attempt(id), "utf8")).state, "submitted");
});

test("a node without wake.nativeQueue runs no probe and keeps every Codex session unknown", async (t) => {
  let probed = 0;
  const s = setup(t, { nativeQueue: false, probe: async () => { probed++; throw new Error("must not run"); } });
  await s.publish();
  s.tick(60_001);
  await s.publish();
  assert.equal(probed, 0);
  assert.equal(s.verdict(), "unknown");
});

test("a failed probe is unknown, submits nothing and marks the message awaiting-user-turn", async (t) => {
  const s = setup(t, { probe: async () => { throw new Error("synthetic failure"); } });
  await s.publish();
  const id = s.add(4);
  await s.poll();
  assert.equal(s.verdict(), "unknown");
  assert.equal(s.fake.runs().length, 0);
  assert.equal(fs.existsSync(s.attempt(id)), false);
  const progress = getMessageProgress(s.node.paths.inbox, id);
  assert.deepEqual([progress?.phase, progress?.code], ["waiting", "awaiting-user-turn"]);
});
