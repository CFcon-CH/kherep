import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { nodePaths } from "./config.mts";
import { defaultServiceName, parseServiceCommand, runService, safeServiceFailure } from "./service-cli.mts";
import { SERVICE_DRAIN_BLOCKED, serviceDrainFile, type ServiceOwnerProbe } from "./service-drain.mts";
import { snapshotDigests } from "./service-records.mts";
import type { ServiceAdapter, ServiceBinding } from "./service-types.mts";

test("service install parses an explicit adopted nested Windows task", () => {
  const workspace = path.resolve("workspace");
  const source = path.resolve("source");
  assert.deepEqual(parseServiceCommand(["install", "--workspace", workspace, "--source", source,
    "--service-name", "Node", "--task-path", "\\Kherep\\", "--adopt"]),
  { action: "install", workspace, source, serviceName: "Node", taskPath: "\\Kherep\\", adopt: true, explicitServiceName: true });
  assert.deepEqual(parseServiceCommand(["install", "--workspace", workspace, "--service-name", "\\Kherep\\Node", "--adopt"]),
    { action: "install", workspace, serviceName: "\\Kherep\\Node", adopt: true, explicitServiceName: true });
});

test("fresh services use neutral platform defaults", () => {
  assert.equal(defaultServiceName("darwin"), "org.kherep.node");
  assert.equal(defaultServiceName("win32"), "KherepNode");
});

test("service failures expose only a fixed code and measured recovery", () => {
  const raw = "private native stderr with environment and definition";
  const report = safeServiceFailure({ code: "SERVICE_ACTIVATION_FAILED", recovery: "unknown", message: raw });
  assert.deepEqual(report, { ok: false, code: "SERVICE_ACTIVATION_FAILED", recovery: "unknown" });
  assert.equal(JSON.stringify(report).includes(raw), false);
  assert.equal(safeServiceFailure({ code: "EPERM", recovery: "unknown", message: raw }), null);
});

test("service upgrade, status and rollback refuse options outside their contract", () => {
  const source = path.resolve("source");
  assert.deepEqual(parseServiceCommand(["upgrade", "--source", source]), { action: "upgrade", source });
  assert.deepEqual(parseServiceCommand(["status"]), { action: "status" });
  assert.deepEqual(parseServiceCommand(["rollback"]), { action: "rollback" });
  assert.throws(() => parseServiceCommand(["upgrade", "--workspace", path.resolve("work")]), /usage/);
  assert.throws(() => parseServiceCommand(["status", "--adopt"]), /usage/);
  assert.throws(() => parseServiceCommand(["install"]), /workspace/);
});

test("service status rejects stopped, unauthenticated and foreign recorded daemons", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-service-status-"));
  const source = { root: path.join(root, "source"), commit: "a".repeat(40), digest: "b".repeat(64), kind: "pin" as const, verified: true };
  const binding: ServiceBinding = { platform: "win32", serviceName: "Node", taskPath: "\\Kherep", workspace: path.join(root, "work"),
    configRoot: root, nodeExecutable: process.execPath, source };
  const snapshot = { definition: Buffer.from("definition"), security: Buffer.from("security"), running: true as boolean | "unknown" };
  const adapter = { read: async () => snapshot, processOwned: async () => true } as unknown as ServiceAdapter;
  const receipt = { version: 1 as const, binding, definitionDigest: "520f405f734935644a2693e5d17cf1f92d0af54d4b75e3d5d4f32d29476842f9",
    securityDigest: "5d2d3ceb7abe552344276d47d36a8175b7aeb250a9bf0bf00e3b787df649abb5", activatedAt: new Date().toISOString() };
  const connected = { pid: 1234, startedAt: "2026-10-14T18:00:00.000Z", connectedAt: "2026-10-14T18:00:01.000Z", source,
    service: { name: binding.serviceName, platform: binding.platform, taskPath: binding.taskPath } };
  const cases = [
    { name: "stopped", running: false as const, state: connected, alive: true, owned: true },
    { name: "lost authentication", running: true as const, state: { ...connected, disconnectedAt: "2026-10-14T18:00:02.000Z" }, alive: true, owned: true },
    { name: "foreign reused pid", running: true as const, state: connected, alive: true, owned: false },
  ];
  const originalLog = console.log;
  try {
    for (const item of cases) {
      snapshot.running = item.running;
      adapter.processOwned = async () => item.owned;
      let output = "";
      console.log = value => { output = String(value); };
      const exit = await runService(["status"], { root, readReceipt: () => receipt, adapterFor: () => adapter,
        readState: () => item.state, alive: () => item.alive });
      assert.equal(exit, 1, item.name);
      const report = JSON.parse(output) as Record<string, unknown>;
      assert.equal(report.ok, false, item.name);
      assert.equal("pid" in report, false, `${item.name} must not expose a pid`);
    }
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("service failures pass only a fixed stage and recovery blocker", () => {
  const raw = "private native stderr with environment and definition";
  assert.deepEqual(safeServiceFailure({ code: "SERVICE_ROLLBACK_FAILED", recovery: "unknown", message: raw,
    stage: "prove-stopped", blocker: "RECOVERY_ABSENCE_UNPROVEN" }),
  { ok: false, code: "SERVICE_ROLLBACK_FAILED", recovery: "unknown", stage: "prove-stopped", blocker: "RECOVERY_ABSENCE_UNPROVEN" });
  const dropped = safeServiceFailure({ code: "SERVICE_ROLLBACK_FAILED", recovery: "restored", message: raw,
    stage: raw, blocker: `RECOVERY_ ${raw}` });
  assert.deepEqual(dropped, { ok: false, code: "SERVICE_ROLLBACK_FAILED", recovery: "restored" });
  assert.equal(JSON.stringify(dropped).includes(raw), false);
  assert.equal(safeServiceFailure({ code: "SERVICE_ACTIVATION_FAILED", recovery: "unknown", blocker: "ENOENT" })?.blocker, undefined);
});

test("service status reports a stale drain and its recovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-service-drain-status-"));
  const source = { root: path.join(root, "source pin"), commit: "a".repeat(40), digest: "b".repeat(64), kind: "pin" as const, verified: true };
  const binding: ServiceBinding = { platform: "win32", serviceName: "Node", taskPath: "\\Kherep", workspace: path.join(root, "work"),
    configRoot: root, nodeExecutable: process.execPath, source };
  const snapshot = { definition: Buffer.from("definition"), security: Buffer.from("security"), running: true as boolean | "unknown" };
  const adapter = { read: async () => snapshot, processOwned: async () => true } as unknown as ServiceAdapter;
  const receipt = { version: 1 as const, binding, ...snapshotDigests(snapshot), activatedAt: new Date().toISOString() };
  const state = { pid: 1234, startedAt: "2026-10-14T18:00:00.000Z", connectedAt: "2026-10-14T18:00:01.000Z", source,
    service: { name: binding.serviceName, platform: binding.platform, taskPath: binding.taskPath } };
  const owner = { version: 1 as const, pid: 4321, startedAt: "2026-10-14T18:05:00.000Z", owner: "operator" };
  let ownerActive: boolean | "unknown" = false;
  const ownerProbe: ServiceOwnerProbe = { current: () => owner, active: () => ownerActive };
  let alive = true;
  const originalLog = console.log;
  const status = async (): Promise<{ exit: number; report: Record<string, unknown> }> => {
    let output = "";
    console.log = value => { output = String(value); };
    const exit = await runService(["status"], { root, readReceipt: () => receipt, adapterFor: () => adapter,
      readState: () => state, alive: () => alive, ownerProbe });
    return { exit, report: JSON.parse(output) as Record<string, unknown> };
  };
  try {
    const clean = await status();
    assert.equal(clean.exit, 0);
    assert.equal(clean.report.drain, "none");
    assert.equal("recovery" in clean.report, false);
    const drain = serviceDrainFile(nodePaths(root));
    fs.mkdirSync(path.dirname(drain), { recursive: true });
    fs.writeFileSync(drain, JSON.stringify(owner), { mode: 0o600 });
    const stale = await status();
    assert.equal(stale.exit, 1);
    assert.equal(stale.report.ok, false);
    assert.equal(stale.report.drain, "stale");
    assert.equal(stale.report.recovery, `kherep-node service upgrade --source <clean checkout> reclaims the stale drain (installed source ${source.commit})`);
    assert.equal(JSON.stringify(stale.report).includes(String(owner.pid)), false, "the drain owner pid is not reported");
    assert.equal(JSON.stringify(stale.report).includes(root), false, "status prints no local path");
    ownerActive = "unknown";
    const unverified = await status();
    assert.equal(unverified.report.ok, false);
    assert.equal(unverified.report.drain, "unknown");
    assert.match(String(unverified.report.recovery), /drain owner cannot be verified; inspect the service\/drain owner file/);
    assert.doesNotMatch(String(unverified.report.recovery), /upgrade/);
    fs.rmSync(drain);
    snapshot.running = false;
    alive = false;
    const stopped = await status();
    assert.equal(stopped.report.ok, false);
    assert.equal(stopped.report.recovery, `kherep-node service upgrade --source <clean checkout> (installed source ${source.commit})`);
    assert.equal(JSON.stringify(stopped.report).includes(root), false);
    assert.equal("pid" in stopped.report, false);
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("service status names a blocked Windows daemon start only for stale or unknown drains without a live daemon", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-service-blocked-status-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = { root: path.join(root, "pin"), commit: "a".repeat(40), digest: "b".repeat(64), kind: "pin" as const, verified: true };
  const binding: ServiceBinding = { platform: "win32", serviceName: "Node", taskPath: "\\Kherep", workspace: path.join(root, "work"),
    configRoot: root, nodeExecutable: process.execPath, source };
  const snapshot = { definition: Buffer.from("definition"), security: Buffer.from("security"), running: true as boolean | "unknown" };
  const adapter = { read: async () => snapshot, processOwned: async () => true } as unknown as ServiceAdapter;
  const receipt = { version: 1 as const, binding, ...snapshotDigests(snapshot), activatedAt: "2026-10-14T18:00:00.000Z" };
  const state = { pid: 1234, startedAt: "2026-10-14T18:00:00.000Z", connectedAt: "2026-10-14T18:00:01.000Z", source,
    service: { name: binding.serviceName, platform: binding.platform, taskPath: binding.taskPath } };
  const owner = { version: 1 as const, pid: 987654, startedAt: "2026-10-14T18:05:00.000Z", owner: "synthetic-owner" };
  const drain = serviceDrainFile(nodePaths(root));
  fs.mkdirSync(path.dirname(drain), { recursive: true });
  const recoveries: Partial<Record<string, string>> = {
    stale: `kherep-node service upgrade --source <clean checkout> reclaims the stale drain (installed source ${source.commit})`,
    unknown: "the service drain owner cannot be verified; inspect the service/drain owner file",
  };
  const cases: Array<[string, ServiceBinding["platform"], boolean | "unknown", "none" | "stale" | "unknown" | "active", "none" | "dead" | "live", boolean]> = [
    ["stale without state", "win32", true, "stale", "none", true],
    ["unknown without state", "win32", true, "unknown", "none", true],
    ["stale dead daemon", "win32", true, "stale", "dead", true],
    ["unknown dead daemon", "win32", true, "unknown", "dead", true],
    ["no drain", "win32", true, "none", "none", false],
    ["active upgrade", "win32", true, "active", "none", false],
    ["live daemon", "win32", true, "stale", "live", false],
    ["stopped task", "win32", false, "stale", "none", false],
    ["unknown task", "win32", "unknown", "stale", "none", false],
    ["darwin", "darwin", true, "stale", "none", false],
  ];
  const originalLog = console.log;
  try {
    for (const [name, platform, running, expectedDrain, daemon, blocked] of cases) {
      binding.platform = platform; snapshot.running = running;
      fs.rmSync(drain, { force: true });
      if (expectedDrain !== "none") fs.writeFileSync(drain, JSON.stringify(owner), { mode: 0o600 });
      let output = "";
      console.log = value => { output = String(value); };
      const exit = await runService(["status"], { root, readReceipt: () => receipt, adapterFor: () => adapter,
        readState: () => daemon === "none" ? null : state, alive: () => daemon === "live",
        ownerProbe: { current: () => owner, active: () => expectedDrain === "unknown" ? "unknown" : expectedDrain === "active" } });
      const report = JSON.parse(output) as Record<string, unknown>;
      assert.equal(exit, 1, name);
      assert.equal(report.ok, false, name);
      assert.equal(report.running, running, name);
      assert.equal(report.drain, expectedDrain, name);
      assert.equal("daemonStart" in report, blocked, name);
      assert.equal(report.daemonStart, blocked ? SERVICE_DRAIN_BLOCKED : undefined, name);
      assert.equal(report.recovery, recoveries[expectedDrain], name);
      assert.equal(output.includes(String(owner.pid)), false, name);
      assert.equal(output.includes(owner.owner), false, name);
    }
  } finally { console.log = originalLog; }
});
