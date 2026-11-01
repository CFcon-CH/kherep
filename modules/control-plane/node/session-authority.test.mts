import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nodePaths } from "./config.mts";
import { createAdmissionAuthority, authorityStatus, observeForAuthority, stopAuthority } from "./session-authority.mts";
import { publishSynthetic, syntheticListing } from "./session-authority-fixture.mts";
import { attachLiveness } from "./liveness-pass.mts";
import { recordingSessions, writeLocalSessions } from "./exchange-sessions.mts";
import { recordAndPublishSessions } from "./periodic-session-publication.mts";
import type { NodeClient } from "./client.mts";
import { closedReference, livenessAdmission, publishLiveness, readLivenessSnapshot, sessionVerdict, terminalReference } from "./session-lifecycle.mts";
import type { SessionEvidence, Observation } from "./session-liveness.mts";
const now = 1_000_000, target = { runtime: "codex", sessionId: "exact-owner" };
const obs = <T,>(value: T, source: Observation<T>["source"], at = now): Observation<T> => ({ status: "value", value, source, observedAt: at, complete: true, reasonCode: "observed" });
const live = (at = now): SessionEvidence => ({ ...target, holder: obs({ present: true, creationIdentity: "created-1" }, "native-holder", at), turn: obs("running", "native-turn", at) });
const rows = [{ ...target, state: "running" }];
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-authority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return nodePaths(root);
}
test("authority requires this run's real observation and coherent publication; disk/copy/foreign context deny", async t => {
  const paths = fixture(t), a = createAdmissionAuthority(paths), b = createAdmissionAuthority(paths);
  const run = (context: typeof a, listing: typeof rows) => recordingSessions(paths, async () => listing, () => {}, () => now, undefined, undefined, context)();
  publishSynthetic(paths, [live()], now, rows, a);
  assert.ok(livenessAdmission(paths, target, "queue", now, undefined, a));
  assert.equal(livenessAdmission(paths, target, "queue", now), null);
  assert.equal(livenessAdmission(paths, target, "queue", now, undefined, b), null);
  const owned = observeForAuthority(a, { observe: () => obs([live()], "native-app") }, [target], new AbortController().signal) as Observation<SessionEvidence[]>;
  await run(b, attachLiveness([...rows], owned));
  assert.equal(livenessAdmission(paths, target, "queue", now, undefined, b), null);
  await run(b, attachLiveness([...rows], { ...owned }));
  assert.equal(livenessAdmission(paths, target, "queue", now, undefined, b), null);
  await run(b, syntheticListing(b, [...rows], [live()], now));
  assert.ok(livenessAdmission(paths, target, "queue", now, undefined, b));
  stopAuthority(b); assert.equal(livenessAdmission(paths, target, "queue", now, undefined, b), null);
});
test("second-write and after-first-write abort fault the run; cache/pending/later success never regrant", async t => {
  for (const fail of ["second", "abort"] as const) await t.test(fail, async sub => {
    const paths = fixture(sub), a = createAdmissionAuthority(paths);
    publishSynthetic(paths, [live()], now, rows, a);
    assert.ok(livenessAdmission(paths, target, "queue", now, undefined, a));
    const cached = syntheticListing(a, [...rows], [live()], now);
    const controller = new AbortController(), rename = fs.renameSync;
    sub.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
      if (fail === "second" && String(args[1]) === paths.sessions) throw new Error("generated second-write failure");
      const result = Reflect.apply(rename, fs, args);
      if (fail === "abort" && String(args[1]).endsWith("session-liveness.json")) controller.abort();
      return result;
    });
    await assert.rejects(recordingSessions(paths, async () => cached, () => {}, () => now, undefined, undefined, a)(controller.signal));
    sub.mock.restoreAll();
    assert.equal(authorityStatus(a), "faulted");
    await recordingSessions(paths, async () => cached, () => {}, () => now, undefined, undefined, a)();
    let resolve!: (value: Observation<SessionEvidence[]>) => void;
    const pending = observeForAuthority(a, { observe: () => new Promise<Observation<SessionEvidence[]>>(r => { resolve = r; }) }, [target], new AbortController().signal);
    resolve(obs([live()], "native-app"));
    const late = await pending;
    await recordingSessions(paths, async () => attachLiveness([...rows], late), () => {}, () => now, undefined, undefined, a)();
    await recordingSessions(paths, async () => syntheticListing(a, [...rows], [live()], now), () => {}, () => now, undefined, undefined, a)();
    assert.equal(livenessAdmission(paths, target, "queue", now, undefined, a), null);
    const fresh = createAdmissionAuthority(paths);
    assert.equal(livenessAdmission(paths, target, "queue", now, undefined, fresh), null);
    await recordingSessions(paths, async () => syntheticListing(fresh, [...rows], [live()], now), () => {}, () => now, undefined, undefined, fresh)();
    assert.ok(livenessAdmission(paths, target, "queue", now, undefined, fresh));
  });
});
test("background publisher faults the same authority as direct listing and boot-carried CLOSED never refuses", async t => {
  const paths = fixture(t), a = createAdmissionAuthority(paths);
  const closed: SessionEvidence = { ...target, holder: obs({ present: false }, "native-holder"), app: obs("absent", "native-app") };
  publishSynthetic(paths, [closed], now, [], a);
  assert.equal(closedReference(paths, target.sessionId, now, a), true);
  assert.equal(closedReference(paths, target.sessionId, now, createAdmissionAuthority(paths)), false);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
    if (String(args[1]) === paths.sessions) throw new Error("generated background failure");
    return Reflect.apply(rename, fs, args);
  });
  const client = { sessionFrames: () => [], invalidateSessionsSnapshot: () => {} } as unknown as NodeClient;
  await assert.rejects(recordAndPublishSessions(client, paths, syntheticListing(a, [], [closed], now), () => true, () => {}, new AbortController().signal, undefined, a));
  assert.equal(authorityStatus(a), "faulted");
  assert.equal(closedReference(paths, target.sessionId, now, a), false);
});
test("saturated lifecycle ledger is independent of display slots and fences absent identities across restart", t => {
  const paths = fixture(t);
  const terminal = (id: string, state: "deleted" | "restored", generation = 1): SessionEvidence => ({ runtime: "codex", sessionId: id,
    lifecycle: obs({ state, generation }, "native-lifecycle") });
  const ledger = Array.from({ length: 512 }, (_, i) => terminal(`terminal-${i}`, "deleted"));
  publishLiveness(paths, ledger, now);
  let snapshot = publishLiveness(paths, [live()], now, rows);
  assert.equal(snapshot.tombstones.length, 512); assert.ok(snapshot.sessions.length <= 512);
  assert.equal(sessionVerdict(paths, target, now).reasonCode, "capped");
  assert.equal(sessionVerdict(paths, { runtime: "codex", sessionId: "terminal-0" }, now).state, "deleted");
  writeLocalSessions(paths, [], now);
  assert.equal(terminalReference(paths, "terminal-0", "codex", now), true);
  snapshot = publishLiveness(paths, [terminal(target.sessionId, "deleted")], now);
  assert.equal(snapshot.tombstones.length, 512);
  const fresh = createAdmissionAuthority(paths);
  publishSynthetic(paths, [live()], now, rows, fresh);
  assert.equal(livenessAdmission(paths, target, "queue", now, undefined, fresh), null);
  const restored = { ...live(), sessionId: "terminal-0", lifecycle: obs({ state: "restored" as const, generation: 2 }, "native-lifecycle") };
  publishSynthetic(paths, [restored], now, [{ ...rows[0], sessionId: "terminal-0" }], fresh);
  assert.equal(readLivenessSnapshot(paths)!.tombstones.length, 512);
  assert.ok(livenessAdmission(paths, restored, "queue", now, undefined, fresh));
  publishLiveness(paths, [terminal("terminal-0", "deleted", 1)], now);
  assert.notEqual(sessionVerdict(paths, restored, now).state, "deleted");
});
test("untrusted attached lifecycle fields consume no ledger slots", async t => {
  const paths = fixture(t), a = createAdmissionAuthority(paths);
  const fake = { ...target, lifecycle: obs({ state: "deleted" as const, generation: 1 }, "native-lifecycle") };
  await recordingSessions(paths, async () => attachLiveness([...rows], obs([fake], "native-app")), () => {}, () => now, undefined, undefined, a)();
  assert.equal(readLivenessSnapshot(paths)!.tombstones.length, 0);
  assert.equal(livenessAdmission(paths, target, "queue", now, undefined, a), null);
});

test("first-saturation lifecycle write failure leaves old files but no authority in either run", async t => {
  const paths = fixture(t), a = createAdmissionAuthority(paths);
  const history = Array.from({ length: 511 }, (_, i): SessionEvidence => ({ runtime: "codex", sessionId: `prior-${i}`,
    lifecycle: obs({ state: "deleted", generation: 1 }, "native-lifecycle") }));
  publishSynthetic(paths, [...history, live()], now, rows, a);
  assert.ok(livenessAdmission(paths, target, "queue", now, undefined, a));
  const old = [fs.readFileSync(paths.sessions), fs.readFileSync(path.join(paths.dir, "session-liveness.json"))];
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
    if (String(args[1]).endsWith("session-liveness.json")) throw new Error("generated first-saturation failure");
    return Reflect.apply(rename, fs, args);
  });
  const terminal: SessionEvidence = { runtime: "codex", sessionId: "new-512th", lifecycle: obs({ state: "deleted", generation: 1 }, "native-lifecycle") };
  await assert.rejects(recordingSessions(paths, async () => syntheticListing(a, [...rows], [live(), terminal], now), () => {}, () => now, undefined, undefined, a)());
  assert.deepEqual([fs.readFileSync(paths.sessions), fs.readFileSync(path.join(paths.dir, "session-liveness.json"))], old);
  assert.equal(livenessAdmission(paths, target, "queue", now + 2, undefined, a), null);
  assert.equal(livenessAdmission(paths, target, "queue", now + 2, undefined, createAdmissionAuthority(paths)), null);
});
test("unsupported, incomplete, stale, future and duplicate current-run observations cannot grant", async t => {
  for (const reason of ["unsupported", "incomplete", "stale", "future", "duplicate"] as const) await t.test(reason, async sub => {
    const paths = fixture(sub), a = createAdmissionAuthority(paths);
    const at = reason === "stale" ? now - 60_001 : reason === "future" ? now + 1 : now;
    const observation = obs(reason === "duplicate" ? [live(at), live(at)] : [live(at)], reason === "unsupported" ? "unsupported" : "native-app", at);
    if (reason === "incomplete") observation.complete = false;
    const owned = await observeForAuthority(a, { observe: () => observation }, [target], new AbortController().signal);
    await recordingSessions(paths, async () => attachLiveness([...rows], owned), () => {}, () => now, undefined, undefined, a)();
    assert.equal(livenessAdmission(paths, target, "queue", now, undefined, a), null);
  });
});

test("already-full ledger survives failed 513th write and still fences the absent identity on restart", async t => {
  const paths = fixture(t), a = createAdmissionAuthority(paths);
  const history = Array.from({ length: 512 }, (_, i): SessionEvidence => ({ runtime: "codex", sessionId: `full-${i}`,
    lifecycle: obs({ state: "deleted", generation: 1 }, "native-lifecycle") }));
  publishLiveness(paths, history, now); writeLocalSessions(paths, [], now);
  const old = fs.readFileSync(path.join(paths.dir, "session-liveness.json"));
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
    if (String(args[1]).endsWith("session-liveness.json")) throw new Error("generated full-ledger failure");
    return Reflect.apply(rename, fs, args);
  });
  const extra: SessionEvidence = { ...target, lifecycle: obs({ state: "deleted", generation: 1 }, "native-lifecycle") };
  await assert.rejects(recordingSessions(paths, async () => syntheticListing(a, [...rows], [extra], now), () => {}, () => now, undefined, undefined, a)());
  assert.deepEqual(fs.readFileSync(path.join(paths.dir, "session-liveness.json")), old);
  assert.equal(readLivenessSnapshot(paths)!.tombstones.length, 512);
  assert.equal(sessionVerdict(paths, target, now).reasonCode, "capped");
  assert.equal(livenessAdmission(paths, target, "queue", now, undefined, createAdmissionAuthority(paths)), null);
  assert.equal(terminalReference(paths, "full-0", "codex", now), true);
});
test("unsupported provider's self-declared lifecycle fields cannot consume durable slots", async t => {
  const paths = fixture(t), a = createAdmissionAuthority(paths);
  const forged: SessionEvidence = { ...target, lifecycle: obs({ state: "deleted", generation: 1 }, "native-lifecycle") };
  const value = await observeForAuthority(a, { observe: () => obs([forged], "unsupported") }, [target], new AbortController().signal);
  await recordingSessions(paths, async () => attachLiveness([...rows], value), () => {}, () => now, undefined, undefined, a)();
  assert.equal(readLivenessSnapshot(paths)!.tombstones.length, 0);
  assert.equal(livenessAdmission(paths, target, "queue", now, undefined, a), null);
});
