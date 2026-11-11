// Issue #706, Phase 2: the Codex liveness source against the unchanged
// judgeSession (design 3.1 and 3.3). Synthetic records, files and probes only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Holder, HolderProbe, HolderScan } from "./codex-holder-probe.mts";
import { codexLivenessSource, IDLE_WRITE_SLACK_MS, turnFor } from "./codex-liveness-source.mts";
import { markStopEnded, recordCodexSession, refreshCodexEvent, type CodexSessionRecord } from "./codex-sessions.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { judgeSession, type Observation, type SessionEvidence } from "./session-liveness.mts";

const T = Date.UTC(2026, 10, 11, 9);
const ID = "01a0db01-0000-7000-8000-0000000000a1";
const OTHER = "01a0db01-0000-7000-8000-0000000000a2";
const holder = (pid = 4242, startMs = T - 600_000): Holder => ({ pid, startMs, identity: `${pid}:${startMs / 1000}`, file: "" });

function node(t: test.TestContext, nativeQueue = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-liveness-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: true, sessions: [ID], nativeQueue } }));
  const rollout = path.join(root, `rollout-2026-11-11T09-00-00-${ID}.jsonl`);
  fs.writeFileSync(rollout, "");
  return { paths, rollout };
}

const setMtime = (file: string, ms: number) => fs.utimesSync(file, ms / 1000, ms / 1000);
const scanOf = (holders: Record<string, Holder[]>, processes = Object.values(holders).flat(), probed?: string[]): HolderScan =>
  ({ at: T, processes, holders: new Map(Object.entries(holders)), ...(probed ? { probed: new Set(probed) } : {}) });

async function observe(paths: NodePaths, probe: HolderProbe, targets = [{ runtime: "codex", sessionId: ID }], signal = new AbortController().signal) {
  return codexLivenessSource({ paths, probe, now: () => T, platform: "darwin" }).observe(targets, signal);
}
const evidence = (o: Observation<SessionEvidence[]>): SessionEvidence[] => (o.status === "value" ? o.value : []);
const verdictOf = async (paths: NodePaths, probe: HolderProbe) => judgeSession(evidence(await observe(paths, probe))[0]!, T).state;

test("held + running hook state is running; held + ended Stop is idle-loaded; held + no record is reachable-probable", async (t) => {
  const { paths, rollout } = node(t);
  const held = { ...holder(), file: rollout };
  setMtime(rollout, T - 120_000);
  const probe: HolderProbe = async () => scanOf({ [ID]: [held] });
  assert.equal(await verdictOf(paths, probe), "reachable-probable", "no record: turn unknown");
  recordCodexSession(paths, ID, undefined, T - 120_000, "default", "UserPromptSubmit");
  assert.equal(await verdictOf(paths, probe), "running");
  recordCodexSession(paths, ID, undefined, T - 120_000, "default", "Stop");
  assert.equal(await verdictOf(paths, probe), "running", "a Stop not marked ended is still the turn");
  markStopEnded(paths, ID);
  assert.equal(await verdictOf(paths, probe), "idle-loaded");
  const observation = await observe(paths, probe);
  assert.equal(observation.complete, true);
  assert.equal(observation.source, "native-holder");
  assert.match((evidence(observation)[0]!.holder as { value: { creationIdentity: string } }).value.creationIdentity, /^[A-Za-z0-9._:-]{1,128}$/);
});

test("no holder: closed without any codex process, unknown while one runs, conflict for two holders", async (t) => {
  const { paths } = node(t);
  assert.equal(await verdictOf(paths, async () => scanOf({})), "closed");
  assert.equal(await verdictOf(paths, async () => scanOf({}, [holder()])), "unknown");
  const two = await observe(paths, async () => scanOf({ [ID]: [holder(1), holder(2)] }));
  const entry = evidence(two)[0]!;
  assert.deepEqual([entry.holder?.status, entry.holder?.reasonCode], ["unknown", "conflict"]);
  assert.equal(judgeSession(entry, T).state, "unknown");
});

test("probe failure, abort and a bad scan time are unknown and never claim an absence", async (t) => {
  const { paths } = node(t);
  const failed = await observe(paths, async () => { throw new Error("synthetic"); });
  assert.deepEqual([failed.status, failed.complete, failed.reasonCode], ["unknown", false, "failed"]);
  const controller = new AbortController();
  const aborted = await observe(paths, async (_h, _c, signal) => { controller.abort(); signal.throwIfAborted(); return scanOf({}); },
    undefined, controller.signal);
  assert.deepEqual([aborted.status, aborted.reasonCode], ["unknown", "aborted"]);
  const future = await observe(paths, async () => ({ ...scanOf({}), at: T + 1 }));
  assert.equal(future.status, "unknown");
  for (const o of [failed, aborted, future]) assert.equal(JSON.stringify(o).includes("present"), false);
});

test("without wake.nativeQueue no probe runs; other runtimes and invalid ids get no entry", async (t) => {
  const off = node(t, false);
  let calls = 0;
  const spy: HolderProbe = async () => { calls++; return scanOf({}); };
  const result = await observe(off.paths, spy);
  assert.deepEqual([result.status, result.source, calls], ["unknown", "unsupported", 0]);
  const on = node(t);
  const observation = await observe(on.paths, spy, [{ runtime: "claude-code", sessionId: ID }, { runtime: "codex", sessionId: "../x" },
    { runtime: "codex", sessionId: OTHER }]);
  assert.deepEqual(evidence(observation).map(e => e.sessionId), [OTHER]);
  const linux = await codexLivenessSource({ paths: on.paths, now: () => T, platform: "linux" }).observe([{ runtime: "codex", sessionId: ID }], new AbortController().signal);
  assert.equal(linux.reasonCode, "unsupported");
});

test("a scan limited to candidates gives no entry for an unprobed thread", async (t) => {
  const { paths } = node(t);
  const observation = await observe(paths, async () => scanOf({}, [holder()], [OTHER]), [{ runtime: "codex", sessionId: ID }, { runtime: "codex", sessionId: OTHER }]);
  assert.deepEqual(evidence(observation).map(e => e.sessionId), [OTHER]);
});

const rec = (fields: Partial<CodexSessionRecord>): CodexSessionRecord => ({ sessionId: ID, runtime: "codex", lastSeen: new Date(T).toISOString(), ...fields });
const at = (ms: number) => new Date(ms).toISOString();
const turn = (o: Observation<string>) => (o.status === "value" ? o.value : `unknown:${o.reasonCode}`);

test("turnFor follows the hook record table, with the rollout mtime guard at 29 s and 31 s", () => {
  const h = holder(), stop = T - 120_000;
  const stopped = rec({ lastEvent: "Stop", lastEventAt: at(stop), lastStopAt: at(stop), lastStopEnded: true });
  assert.equal(turn(turnFor(null, h, stop, T)), "unknown:missing");
  assert.equal(turn(turnFor(rec({}), h, stop, T)), "unknown:incomplete");
  assert.equal(turn(turnFor(stopped, h, stop + 29_000, T)), "idle");
  assert.equal(turn(turnFor(stopped, h, stop + IDLE_WRITE_SLACK_MS + 1_000, T)), "unknown:conflict");
  assert.equal(turn(turnFor(stopped, h, undefined, T)), "unknown:failed");
  assert.equal(turn(turnFor(stopped, holder(4242, stop + 1_000), stop, T)), "unknown:incomplete", "event older than the holder");
  assert.equal(turn(turnFor(rec({ lastEvent: "PostToolUse", lastEventAt: at(stop) }), h, stop, T)), "running");
  assert.equal(turn(turnFor(rec({ lastEvent: "Stop", lastEventAt: at(stop), lastStopAt: at(stop) }), h, stop, T)), "running");
  for (const source of ["startup", "resume", "clear", "fork"] as const) {
    assert.equal(turn(turnFor(rec({ lastEvent: "SessionStart", lastEventAt: at(stop), lastStartSource: source }), h, stop, T)), "idle", source);
  }
  assert.equal(turn(turnFor(rec({ lastEvent: "SessionStart", lastEventAt: at(stop), lastStartSource: "compact" }), h, stop, T)), "unknown:incomplete");
  assert.equal(turn(turnFor(rec({ lastEvent: "SessionStart", lastEventAt: at(stop) }), h, stop, T)), "unknown:incomplete");
  assert.equal(turn(turnFor(rec({ lastEvent: "Interrupt", lastEventAt: at(stop) }), h, stop, T)), "unknown:incomplete");
  assert.equal(turn(turnFor(rec({ lastEvent: "SessionEnd", lastEventAt: at(stop) }), h, stop, T)), "unknown:incomplete");
  assert.equal(turn(turnFor(rec({ lastEvent: "Stop", lastEventAt: at(T + 1) }), h, stop, T)), "unknown:future");
});

test("an Interrupt or SessionEnd after an ended Stop leaves a held thread reachable-probable", async (t) => {
  const { paths, rollout } = node(t);
  setMtime(rollout, T - 120_000);
  recordCodexSession(paths, ID, undefined, T - 120_000, "default", "Stop");
  markStopEnded(paths, ID);
  const probe: HolderProbe = async () => scanOf({ [ID]: [{ ...holder(), file: rollout }] });
  for (const event of ["Interrupt", "SessionEnd"] as const) {
    assert.equal(refreshCodexEvent(paths, ID, event, T - 60_000), true);
    assert.equal(await verdictOf(paths, probe), "reachable-probable", event);
  }
  fs.writeFileSync(path.join(paths.codexSessions, `${ID}.json`), "{");
  const malformed = evidence(await observe(paths, probe))[0]!;
  assert.deepEqual([malformed.turn?.status, malformed.turn?.reasonCode], ["unknown", "malformed"]);
});
