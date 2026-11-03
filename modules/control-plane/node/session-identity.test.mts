import assert from "node:assert/strict";
import test from "node:test";
import { listSessions } from "./sessions.mts";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test("I01: current Claude listing carries identity independently of native liveness", async () => {
  const rows = await listSessions({ findClaude: () => "/synthetic/claude", exec: async () => JSON.stringify([{ sessionId: A, status: "unknown" }]), now: () => 1000 });
  assert.deepEqual((rows[0] as unknown as Record<string, unknown>).canonicalIdentity, { version: 1, source: "claude-list", runtime: "claude-code", sessionId: A, observedAt: 1000, lifecycleGeneration: 0 });
  assert.equal(rows[0].state, "unknown");
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nodePaths } from "./config.mts";
import { listCodexSessions, recordCodexSession } from "./codex-sessions.mts";
import { identityFromCodexRecord, identitySnapshotOf } from "./session-identity.mts";
import { recordingSessions } from "./exchange-sessions.mts";
import { createAdmissionAuthority } from "./session-authority.mts";
import { syntheticListing } from "./session-authority-fixture.mts";
import { livenessFile, publishLiveness, readLivenessSnapshot } from "./session-lifecycle.mts";
import type { SessionInfo } from "../protocol.mts";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = 100_000_000;
const proofRow = (): SessionInfo => ({ sessionId: A, runtime: "codex", state: "unknown", canonicalIdentity: identityFromCodexRecord({ sessionId: A, runtime: "codex", lastSeen: new Date(NOW).toISOString() }, `${A}.json`, NOW) });
function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "727-identity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return nodePaths(dir);
}
test("I02 I03 I04: Codex attestation requires exact source fields, never mtime", t => {
  const paths = fixture(t); recordCodexSession(paths, A, undefined, NOW);
  assert.ok(listCodexSessions(paths, NOW)[0].canonicalIdentity);
  const record = { sessionId: A, runtime: "codex", lastSeen: new Date(NOW).toISOString() };
  for (const delta of [{ runtime: "claude-code" }, { sessionId: "alias" }, { lastSeen: "bad" }, { lastSeen: new Date(NOW + 1).toISOString() }, { lastSeen: new Date(NOW - 43_200_001).toISOString() }]) {
    assert.equal(identityFromCodexRecord({ ...record, ...delta }, `${A}.json`, NOW), undefined);
  }
  assert.equal(identityFromCodexRecord(record, `${B}.json`, NOW), undefined);
  fs.writeFileSync(path.join(paths.codexSessions, `${A}.json`), JSON.stringify({ ...record, lastSeen: "bad" }));
  fs.utimesSync(path.join(paths.codexSessions, `${A}.json`), NOW / 1000, NOW / 1000);
  const display = listCodexSessions(paths, NOW);
  assert.equal(display.length, 1); assert.equal(display[0].canonicalIdentity, undefined);
});
test("I04: duplicate raw Claude IDs and conflicting source runtime cannot attest", async () => {
  for (const rows of [[{ sessionId: A, status: "unknown" }, { sessionId: A, status: "unknown" }], [{ sessionId: A, status: "unknown", runtime: "codex" }]]) {
    const result = await listSessions({ findClaude: () => "/synthetic/claude", exec: async () => JSON.stringify(rows), now: () => NOW });
    assert.ok(result.every(s => !s.canonicalIdentity));
  }
});
test("I05: task-only has no proof; exact current hook join preserves proof and label", async t => {
  const paths = fixture(t); fs.mkdirSync(paths.tasks, { recursive: true });
  fs.writeFileSync(path.join(paths.tasks, `${B}.json`), JSON.stringify({ taskId: B, runtime: "codex", sessionId: A, name: "task-a", cwd: "/synthetic/task", state: "running", updatedAt: new Date(NOW).toISOString() }));
  const list = () => listSessions({ paths, findClaude: () => null, now: () => NOW });
  const only = await list(); assert.equal(only[0]?.sessionId, A); assert.equal(only[0]?.canonicalIdentity, undefined);
  recordCodexSession(paths, A, undefined, NOW);
  const joined = await list(); assert.equal(joined.length, 1); assert.ok(joined[0].canonicalIdentity); assert.equal(joined[0].name, "task-a");
});
test("I06: retained-only identities lose proof; failed listings never publish a new header", async t => {
  const paths = fixture(t); let listed = [proofRow()];
  const record = recordingSessions(paths, async () => listed, () => {}, () => NOW);
  const first = await record(); assert.ok(first[0].canonicalIdentity); assert.equal(identitySnapshotOf(first)?.generation, 1);
  listed = []; const retained = await record(); assert.equal(retained[0].canonicalIdentity, undefined);
  const failed = recordingSessions(paths, async () => { throw new Error("synthetic failure"); }, () => {}, () => NOW);
  await assert.rejects(failed()); assert.equal(readLivenessSnapshot(paths)?.generation, 2);
});
test("I07 I08: accepted terminal ledger denies proof and restore generation survives normalization", async t => {
  const paths = fixture(t), authority = createAdmissionAuthority(paths); let generation = 1; let state: "archived" | "restored" = "archived";
  const record = recordingSessions(paths, async () => syntheticListing(authority, [proofRow()], [{ runtime: "codex", sessionId: A,
    lifecycle: { status: "value", value: { state, generation }, observedAt: NOW, complete: true, source: "native-lifecycle", reasonCode: "observed" } }], NOW), () => {}, () => NOW, undefined, undefined, authority);
  assert.deepEqual(await record(), []);
  generation = 2; state = "restored";
  const restored = await record(); assert.equal(restored[0].canonicalIdentity?.lifecycleGeneration, 2);
  const next = recordingSessions(paths, async () => [proofRow()], () => {}, () => NOW);
  assert.equal((await next())[0].canonicalIdentity?.lifecycleGeneration, 2);
  state = "archived"; generation = 2; assert.equal((await record())[0].canonicalIdentity, undefined, "conflicting same generation cannot attest");
});
test("I09: either publication write failure or stop abort emits no attested envelope", async t => {
  for (const which of ["first", "second", "abort"] as const) {
    const paths = fixture(t); fs.mkdirSync(paths.dir, { recursive: true });
    if (which === "first") fs.mkdirSync(livenessFile(paths));
    if (which === "second") fs.mkdirSync(paths.sessions);
    const controller = new AbortController();
    const record = recordingSessions(paths, async () => { if (which === "abort") controller.abort(); return [proofRow()]; }, () => {}, () => NOW);
    await assert.rejects(record(controller.signal));
  }
});


test("I07 S01: capped source identity has no proof and UNKNOWN attestation grants no native route", async t => {
  const { markUnseen } = await import("./known-sessions.mts");
  const { livenessAdmission } = await import("./session-lifecycle.mts");
  const paths = fixture(t);
  const record = recordingSessions(paths, async () => markUnseen([proofRow()], ["*"]), () => {}, () => NOW);
  const capped = await record(); assert.equal(capped[0].canonicalIdentity, undefined);
  for (const route of ["queue", "wake", "target-resume", "closed-fallback"] as const) assert.equal(livenessAdmission(paths, proofRow(), route, NOW), null);
});
