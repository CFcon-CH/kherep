// #838 A4: service/last-failure.json is written on every failed upgrade or rollback, removed on success, shown by
// `service status` and `doctor`, and never read by a decision path. The node state is off, drain-blocked or running.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { daemonStateFile } from "./daemon-state.mts";
import { checkManagedService } from "./doctor-service.mts";
import { runService, safeServiceFailure, serviceErrorLine } from "./service-cli.mts";
import { caught, staleDrain, status, type Harness } from "./service-candidate-fixture.mts";
import { beginServiceDrain } from "./service-drain.mts";
import { lastFailureOf, readServiceLastFailure, writeServiceLastFailure } from "./service-last-failure.mts";
import { serviceRoot } from "./service-records.mts";
import { activateManagedService } from "./service-transaction.mts";
import { seedManaged, setup } from "./service-transaction-fixture.mts";
import type { ServiceAdapter } from "./service-types.mts";
import { nativeCallFailure, withNativeFailure } from "./service-windows-invoke.mts";

const LEAK = "/Users/x838leak/AppData KherepNode S-1-5-21-838";
const file = (h: Harness) => path.join(serviceRoot(h.paths), "last-failure.json");
const coded = (code: string) => Object.assign(new Error(LEAK), { code, familyUnproven: true });

async function cli(t: test.TestContext) {
  const h = setup(t);
  seedManaged(h);
  await activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps);
  h.adapter.events.length = 0;
  fs.writeFileSync(h.paths.config, JSON.stringify({ version: 1, nodeId: crypto.randomUUID() }));
  const { paths: _paths, adapter: _adapter, ...lifecycle } = h.deps;
  const rollback = () => runService(["rollback"], { root: path.dirname(h.paths.dir), adapterFor: () => h.adapter as unknown as ServiceAdapter, lifecycle });
  return { h, rollback };
}
const quiet = async <T,>(run: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => {};
  try { return await run(); } finally { console.log = log; }
};

test("a failed rollback writes last-failure.json with codes, times and a commit only, mode 0600; the next success removes it", async (t) => {
  const { h, rollback } = await cli(t);
  h.adapter.stopFailureAfterEffect = withNativeFailure(coded("STOP_UNKNOWN_DESCENDANTS"),
    { call: "task-stop", outcome: "timeout", elapsedMs: 65_012, timeoutMs: 65_000 });
  await caught(rollback());
  const text = fs.readFileSync(file(h), "utf8");
  const record = JSON.parse(text);
  assert.deepEqual({ ...record, failedAt: undefined }, { version: 1, command: "rollback", failedAt: undefined, commit: h.candidate.source.commit,
    stage: "stop", blocker: "RECOVERY_ABSENCE_UNPROVEN", stopCode: "STOP_UNKNOWN_DESCENDANTS", recovery: "unknown",
    native: { call: "task-stop", outcome: "timeout", elapsedMs: 65_012, timeoutMs: 65_000 }, writeAttempted: false, drainRetained: true });
  assert.match(record.failedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(text.includes("x838leak") || text.includes(h.paths.dir), false, "no message or path");
  if (process.platform !== "win32") assert.equal(fs.statSync(file(h)).mode & 0o777, 0o600);
  const shown = await status(h);
  const { version: _version, ...shownRecord } = record;
  assert.deepEqual(shown.report.lastFailure, shownRecord, "status shows it");
  assert.equal("version" in shown.report.lastFailure, false);

  h.adapter.stopFailureAfterEffect = undefined;
  staleDrain(h);
  assert.equal(await quiet(rollback), 0);
  assert.equal(fs.existsSync(file(h)), false, "removed on success");
  assert.equal("lastFailure" in (await status(h)).report, false);
});

test("a failure before any mutation is recorded without stage or recovery and prints its named native call", async (t) => {
  const { h, rollback } = await cli(t);
  h.adapter.read = async () => { throw nativeCallFailure("task-read", { pid: 1, output: [], stdout: LEAK, stderr: LEAK, status: 1, signal: null }, 812, 30_000); };
  const error = await caught(rollback());
  assert.equal(safeServiceFailure(error), null, "a raw throw, not a service failure");
  const record = readServiceLastFailure(h.paths);
  assert.ok(record && record !== "invalid");
  assert.deepEqual({ ...record, failedAt: undefined }, { version: 1, command: "rollback", failedAt: undefined, commit: h.candidate.source.commit,
    native: { call: "task-read", outcome: "exit", exitStatus: 1, elapsedMs: 812, timeoutMs: 30_000 }, writeAttempted: false, drainRetained: false });
  const line = serviceErrorLine(error);
  assert.equal(line, `kherep-node: Scheduled Task operation failed for the selected task {"native":{"call":"task-read","outcome":"exit","exitStatus":1,"elapsedMs":812,"timeoutMs":30000}}`);
  assert.equal(serviceErrorLine(new Error("plain")), "kherep-node: plain");
});

test("a write failure of the record never changes the command's result", async (t) => {
  const { h, rollback } = await cli(t);
  fs.mkdirSync(file(h), { recursive: true }); // a directory in the record's place: the write fails
  h.adapter.stopFailureAfterEffect = coded("STOP_UNKNOWN_DESCENDANTS");
  const failure = await caught(rollback());
  assert.equal(safeServiceFailure(failure)?.code, "SERVICE_ROLLBACK_FAILED");
});

test("safeServiceFailure prints a validated native object and drops every non-allowlisted field", () => {
  const base = Object.assign(new Error(LEAK), { code: "SERVICE_ACTIVATION_FAILED", recovery: "unknown", stage: "stop" });
  Object.defineProperty(base, "native", { value: { call: "task-stop", outcome: "exit", exitStatus: 70, elapsedMs: 9, timeoutMs: 65_000,
    reason: "descendants-busy", stderr: LEAK, pid: 4242, taskName: "KherepNode" }, configurable: true });
  assert.deepEqual(safeServiceFailure(base)?.native, { call: "task-stop", outcome: "exit", exitStatus: 70, elapsedMs: 9, timeoutMs: 65_000,
    reason: "descendants-busy" });
  Object.defineProperty(base, "native", { value: { call: "task-stop", outcome: "exit", elapsedMs: 9, timeoutMs: 65_000, reason: LEAK } });
  assert.equal("native" in safeServiceFailure(base)!, false);
  assert.equal(JSON.stringify(safeServiceFailure(base)).includes("x838leak"), false);
});

test("an invalid or tampered record is shown as invalid and nothing else changes", async (t) => {
  const h = setup(t);
  seedManaged(h);
  const healthy = await status(h);
  for (const bad of ["garbage", JSON.stringify({ version: 1, command: "upgrade", failedAt: LEAK, writeAttempted: false, drainRetained: false }),
    JSON.stringify({ ...lastFailureOf("upgrade", new Error("x"), new Date()), extra: LEAK })]) {
    fs.writeFileSync(file(h), bad);
    const shown = await status(h);
    assert.equal(shown.report.lastFailure, "invalid");
    assert.equal(shown.text.includes("x838leak"), false);
    assert.deepEqual({ ...shown.report, lastFailure: undefined }, { ...healthy.report, lastFailure: undefined }, "display only");
    assert.equal(shown.exit, healthy.exit);
  }
  assert.throws(() => writeServiceLastFailure(h.paths, { ...lastFailureOf("upgrade", new Error("x"), new Date()), stage: LEAK as never }), /invalid/);
});

test("service status and doctor report the node as running, off or drain-blocked with the same states", async (t) => {
  const h = setup(t);
  seedManaged(h);
  const doctor = () => checkManagedService(h.paths, h.deps.pidAlive, h.deps.ownerProbe);
  assert.equal((await status(h)).report.node, "running");
  assert.equal(doctor().node, "off", "doctor reads the daemon state file, not yet written in this fixture");
  fs.writeFileSync(daemonStateFile(h.paths), JSON.stringify(h.adapter.state));
  assert.deepEqual(doctor(), { ok: true, managed: true, node: "running", drain: "none" });

  beginServiceDrain(h.paths, h.deps.ownerProbe);
  staleDrain(h);
  assert.equal((await status(h)).report.node, "drain-blocked");
  const blocked = doctor();
  assert.deepEqual([blocked.ok, blocked.node, blocked.drain], [false, "drain-blocked", "stale"]);
  assert.match(String(blocked.detail), /reclaims a stale drain/);

  h.adapter.oldPidAlive = false;
  h.adapter.snapshot!.running = false;
  writeServiceLastFailure(h.paths, lastFailureOf("upgrade", Object.assign(new Error(LEAK), { stage: "stop", recovery: "unknown",
    stopCode: "STOP_UNPROVEN_TIMEOUT", drainRetained: true }), new Date("2026-11-12T10:00:00.000Z"), h.candidate.source.commit));
  assert.equal((await status(h)).report.node, "off");
  const off = doctor();
  assert.deepEqual({ ...off, detail: undefined }, { ok: false, managed: true, node: "off", drain: "stale", detail: undefined,
    lastFailure: { command: "upgrade", failedAt: "2026-11-12T10:00:00.000Z", stage: "stop", stopCode: "STOP_UNPROVEN_TIMEOUT", recovery: "unknown" } });
  assert.match(String(off.detail), /daemon is not running/);
  for (const text of [String(off.detail), String(blocked.detail)]) {
    assert.equal(/[0-9]/.test(text), false, text);
    assert.equal(/[/\\]/.test(text.replaceAll("docs/INSTALLATION.md", "")), false, text);
  }
});

test("doctor reports an unmanaged node as ok without reading the service state", (t) => {
  const h = setup(t);
  assert.deepEqual(checkManagedService(h.paths, () => true, h.deps.ownerProbe), { ok: true, managed: false });
});
