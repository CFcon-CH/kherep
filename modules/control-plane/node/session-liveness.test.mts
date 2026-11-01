import { createAdmissionAuthority } from "./session-authority.mts";
import { publishSynthetic, syntheticListing } from "./session-authority-fixture.mts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nodePaths } from "./config.mts";
import { closedSession, rememberSessions } from "./known-sessions.mts";
import { mapClaudeAgents } from "./sessions.mts";

test("legacy busy, approval waiting and idle have truthful normalized states", () => {
  assert.deepEqual(mapClaudeAgents(["busy", "waiting", "idle"].map((status) => ({ sessionId: `full-${status}`, status })))?.map(s => s.state),
    ["running", "reachable-probable", "idle-loaded"]);
});

test("repeated complete listing misses never prove closure", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-liveness-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  rememberSessions(paths, [{ sessionId: "full-id", runtime: "codex", state: "unknown" }], 1_000);
  for (let i = 1; i < 5; i++) rememberSessions(paths, [], 1_000 + i * 60_000);
  assert.equal(closedSession(paths, "full-id"), false);
});

import { autonomousEligibility, directoryVisibility, judgeSession, type Observation, type SessionEvidence } from "./session-liveness.mts";
import { livenessAdmission, livenessFile, publishLiveness, readLivenessSnapshot, sessionVerdict, terminalReference } from "./session-lifecycle.mts";
import { attachLiveness, createLivenessPass, LIVENESS_INTERVAL_MS } from "./liveness-pass.mts";
import { recordingSessions, writeLocalSessions } from "./exchange-sessions.mts";
import { getMessage, storeMessage, refuseUndeliverable } from "./inbox.mts";
const now = 1_000_000;
const target = { runtime: "codex", sessionId: "full-id" };
const obs = <T,>(value: T, source: Observation<T>["source"], at = now): Observation<T> =>
  ({ status: "value", value, source, observedAt: at, complete: true, reasonCode: "observed" });
const loaded = (at = now): SessionEvidence => ({ ...target, holder: obs({ present: true, creationIdentity: "pid-42-created-100" }, "native-holder", at),
  loaded: obs(true, "native-app", at), turn: obs("idle", "native-turn", at) });
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-liveness-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return nodePaths(root);
}
test("exact CLI holder wins over absent Desktop; PID alone and approval wait cannot authorize", () => {
  const e = { ...loaded(), app: obs("absent" as const, "native-app"), turn: obs("running" as const, "native-turn") };
  assert.equal(judgeSession(e, now).state, "running");
  assert.equal(judgeSession({ ...e, holder: obs({ present: true }, "native-holder") }, now).state, "unknown");
  const waiting = judgeSession({ ...loaded(), turn: obs("approval-waiting", "native-turn") }, now);
  assert.equal(waiting.state, "reachable-probable");
  for (const route of ["queue", "wake", "target-resume", "closed-fallback"] as const) assert.equal(autonomousEligibility(waiting, route), false);
});
test("missing, stale, future, failed, capped and absent coverage stay unknown", () => {
  assert.equal(judgeSession(target, now).state, "unknown");
  for (const reasonCode of ["failed", "capped", "aborted", "incomplete"] as const) {
    const v = judgeSession({ ...target, app: { status: "unknown", observedAt: now, complete: false, source: "native-app", reasonCode } }, now);
    assert.equal(v.state, "unknown"); assert.equal(v.reasonCode, reasonCode);
  }
  assert.equal(judgeSession(loaded(now - 60_001), now).reasonCode, "stale");
  assert.equal(judgeSession(loaded(now + 1), now).reasonCode, "future");
  assert.equal(judgeSession({ ...target, holder: obs({ present: false }, "native-holder"), app: obs("absent", "native-app") }, now).state, "closed");
  assert.equal(judgeSession({ ...target, app: obs("absent", "native-app") }, now).state, "unknown");
});
test("archive tombstone survives stale hooks, name reuse, long misses; only newer restore clears it", (t) => {
  const paths = fixture(t);
  publishLiveness(paths, [{ ...target, lifecycle: obs({ state: "archived", generation: 2 }, "native-lifecycle") }], now);
  assert.equal(directoryVisibility(sessionVerdict(paths, target, now)), false);
  publishLiveness(paths, [{ ...target, hook: obs(true, "hook") }], now);
  assert.equal(sessionVerdict(paths, target, now).state, "archived");
  publishLiveness(paths, [], now + 62 * 86400_000);
  assert.equal(sessionVerdict(paths, target, now + 62 * 86400_000).state, "archived");
  assert.equal(terminalReference(paths, "reused-name", undefined, now), false);
  publishLiveness(paths, [{ ...loaded(), lifecycle: obs({ state: "restored", generation: 2 }, "native-lifecycle") }], now);
  assert.equal(sessionVerdict(paths, target, now).state, "unknown", "contemporaneous exact holder conflicts with tombstone");
  publishLiveness(paths, [{ ...loaded(), lifecycle: obs({ state: "restored", generation: 3 }, "native-lifecycle") }], now);
  assert.equal(sessionVerdict(paths, target, now).state, "idle-loaded");
});
test("snapshot generation fences awaited admission and metadata output excludes untrusted fields", async (t) => {
  const paths = fixture(t);
  const authority = publishSynthetic(paths, [loaded()], now, [{ ...target, state: "idle-loaded" }]);
  const generation = livenessAdmission(paths, target, "queue", now, undefined, authority);
  assert.ok(generation);
  await Promise.resolve();
  publishLiveness(paths, [{ ...target, lifecycle: obs({ state: "deleted", generation: 1 }, "native-lifecycle") }], now);
  let launched = 0;
  if (livenessAdmission(paths, target, "queue", now, generation, authority) !== null) launched++;
  assert.equal(launched, 0);
  publishLiveness(paths, [{ ...target, body: "never persist", argv: ["secret"], nativeError: "unsafe" } as SessionEvidence], now);
  assert.doesNotMatch(fs.readFileSync(livenessFile(paths), "utf8"), /body|argv|secret|nativeError|unsafe/);
  fs.writeFileSync(livenessFile(paths), '{"version":1,"generation":2,"sessions":[],"tombstones":[],"body":"bad"}');
  assert.equal(readLivenessSnapshot(paths), null);
  assert.equal(livenessAdmission(paths, target, "queue", now), null);
});
test("five-minute pass coalesces overlap, cache preserves evidence age, stop drains and aborts", async (t) => {
  let clock = now; let calls = 0; let release!: () => void; let signal!: AbortSignal;
  const pass = createLivenessPass({ observe: async (_targets, s) => {
    calls++; signal = s;
    await new Promise<void>(r => { release = r; });
    return obs([loaded()], "native-app");
  } }, () => clock);
  const a = pass.observe([target]); const b = pass.observe([target]); assert.equal(a, b);
  release(); const value = await a;
  assert.equal(calls, 1);
  clock += 60_001;
  const cached = await pass.observe([target]); assert.equal(cached, value);
  const paths = fixture(t); pass.publish(paths, [target], cached);
  assert.equal(sessionVerdict(paths, target, clock).state, "unknown");
  clock += LIVENESS_INTERVAL_MS;
  const pending = pass.observe([target]);
  const stopped = pass.stop(); assert.equal(signal.aborted, true);
  release(); assert.equal((await pending).reasonCode, "aborted"); await stopped;
  assert.equal(calls, 2);
});
test("partial and failed passes preserve truthful rows, terminal refs refuse under locked record check", async (t) => {
  const paths = fixture(t);
  let clock = now;
  const list = async () => attachLiveness([{ ...target, state: "active" }], obs([loaded()], "native-app", clock));
  const record = recordingSessions(paths, list, () => {}, () => clock);
  assert.equal((await record())[0].state, "idle-loaded");
  clock += 60_001;
  const partial = recordingSessions(paths, async () => attachLiveness([], { status: "unknown", observedAt: clock,
    complete: false, source: "unsupported", reasonCode: "failed" }), () => {}, () => clock);
  assert.equal((await partial())[0].state, "unknown");
  const messageId = "00000000-0000-4000-8000-000000000001";
  storeMessage(paths.inbox, { messageId, from: { nodeId: "00000000-0000-4000-8000-000000000002", session: "sender" },
    toSession: target.sessionId, createdAt: new Date(now).toISOString(), text: "generated fixture" }, now);
  assert.deepEqual(refuseUndeliverable(paths.inbox, [], now + 2 * 3600_000), []);
  assert.equal(getMessage(paths.inbox, messageId)?.state, "accepted");
  publishLiveness(paths, [{ ...target, lifecycle: obs({ state: "deleted", generation: 1 }, "native-lifecycle", clock) }], clock);
  writeLocalSessions(paths, [], clock);
  assert.deepEqual(refuseUndeliverable(paths.inbox, [], clock, undefined, undefined, ref => terminalReference(paths, ref, undefined, clock)), [messageId]);
  assert.equal(getMessage(paths.inbox, messageId)?.state, "refused");
});

test("runtime coverage is independent and malformed native reason strings never enter metadata", (t) => {
  const paths = fixture(t);
  const native = { ...loaded(), runtime: "claude-code", sessionId: "claude-full-id" };
  publishLiveness(paths, [native, { ...target, app: { status: "unknown", observedAt: now, complete: false,
    source: "native-app", reasonCode: "raw-private-error" } } as unknown as SessionEvidence], now);
  assert.equal(sessionVerdict(paths, native, now).state, "idle-loaded");
  assert.equal(sessionVerdict(paths, target, now).reasonCode, "malformed");
  assert.doesNotMatch(fs.readFileSync(livenessFile(paths), "utf8"), /raw-private-error/);
});

test("duplicate exact identity conflicts stay unknown rather than selecting an arbitrary holder", (t) => {
  const paths = fixture(t);
  publishLiveness(paths, [loaded(), { ...target, lifecycle: obs({ state: "deleted", generation: 1 }, "native-lifecycle") }], now);
  assert.equal(sessionVerdict(paths, target, now).state, "unknown");
  assert.equal(livenessAdmission(paths, target, "queue", now), null);
});

test("a cache cannot contradict its terminal tombstone to authorize a native route", (t) => {
  const paths = fixture(t);
  const snapshot = publishLiveness(paths, [{ ...target, lifecycle: obs({ state: "deleted", generation: 4 }, "native-lifecycle") }], now);
  snapshot.sessions[0].state = "idle-loaded";
  fs.writeFileSync(livenessFile(paths), JSON.stringify(snapshot));
  assert.equal(readLivenessSnapshot(paths), null);
  assert.equal(livenessAdmission(paths, target, "queue", now), null);
});
test("a late lower-generation lifecycle event cannot undo an authoritative restore", (t) => {
  const paths = fixture(t);
  publishLiveness(paths, [{ ...loaded(), lifecycle: obs({ state: "restored", generation: 4 }, "native-lifecycle") }], now);
  publishLiveness(paths, [{ ...loaded(), lifecycle: obs({ state: "deleted", generation: 3 }, "native-lifecycle") }], now);
  assert.equal(sessionVerdict(paths, target, now).state, "idle-loaded");
});

test("failed sessions publication vetoes old and new admission and cannot return an active snapshot", async (t) => {
  const paths = fixture(t);
  const authority = createAdmissionAuthority(paths);
  const list = () => recordingSessions(paths, async () => syntheticListing(authority, [{ ...target, state: "active" }], [loaded()], now), () => {}, () => now, undefined, undefined, authority)();
  await list();
  const generation = livenessAdmission(paths, target, "queue", now, undefined, authority);
  assert.ok(generation);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
    if (String(args[1]) === paths.sessions) throw new Error("synthetic publication failure");
    return Reflect.apply(rename, fs, args);
  });
  await assert.rejects(list(), /session publication failed/);
  assert.equal(livenessAdmission(paths, target, "queue", now), null);
  assert.equal(livenessAdmission(paths, target, "queue", now, generation, authority), null);
  const { readLocalSessions } = await import("./exchange-sessions.mts");
  assert.equal(readLocalSessions(paths)[0].state, "unknown");
});

test("a stale complete coalesced observation retains the prior row as unknown", async (t) => {
  const paths = fixture(t);
  await recordingSessions(paths, async () => attachLiveness([{ ...target, state: "active" }], obs([loaded()], "native-app")), () => {}, () => now)();
  const rows = await recordingSessions(paths, async () => attachLiveness([], obs([], "native-app")), () => {}, () => now + 60_001)();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "unknown");
});
test("publication cannot choose the first of ambiguous exact metadata observations", async (t) => {
  const paths = fixture(t);
  const rows = await recordingSessions(paths, async () => attachLiveness([{ ...target, state: "active" }],
    obs([loaded(), { ...target }], "native-app")), () => {}, () => now)();
  assert.equal(rows[0].state, "unknown");
  assert.equal(livenessAdmission(paths, target, "queue", now), null);
});
