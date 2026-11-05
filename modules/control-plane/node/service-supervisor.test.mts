import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decodeSupervisorBinding, encodeSupervisorBinding } from "./service-supervisor-data.mts";
import {
  RESTART_DELAY_MS, openSupervisorLog, startWindowsServiceSupervisor, validateSupervisorRuntime,
} from "./service-supervisor.mts";
import type { ServiceBinding } from "./service-types.mts";

const source = { root: String.raw`C:\Pins\source`, commit: "a".repeat(40), digest: "b".repeat(64),
  kind: "pin" as const, verified: true };
const binding: ServiceBinding = { serviceName: "Kherep Node", taskPath: "\\Kherep\\", platform: "win32",
  workspace: String.raw`C:\Workspace`, configRoot: String.raw`C:\Config`, nodeExecutable: String.raw`C:\Node\node.exe`,
  logFile: String.raw`C:\Logs\daemon.log`, supervisorGeneration: "22222222-2222-4222-8222-222222222222", source };

test("supervisor payload accepts only bounded service binding data", () => {
  const encoded = encodeSupervisorBinding(binding);
  assert.deepEqual(decodeSupervisorBinding(encoded), binding);
  const foreign = Buffer.from(JSON.stringify({ version: 1, binding, command: "cmd.exe" })).toString("base64");
  assert.throws(() => decodeSupervisorBinding(foreign), /payload schema/);
  assert.throws(() => decodeSupervisorBinding("A".repeat(20_000)), /payload size/);
  assert.throws(() => encodeSupervisorBinding({ ...binding, logFile: undefined }), /log file/);
});

test("supervisor runtime rejects source, executable, and inherited Node environment drift", () => {
  const runtime = { nodeExecutable: binding.nodeExecutable, sourceRoot: binding.source.root, env: { LANG: "C" },
    captureSource: () => binding.source };
  assert.doesNotThrow(() => validateSupervisorRuntime(binding, runtime));
  assert.throws(() => validateSupervisorRuntime(binding, { ...runtime, env: { Node_Options: "--import=foreign" } }),
    /execution-affecting/);
  assert.throws(() => validateSupervisorRuntime(binding, { ...runtime, nodeExecutable: String.raw`C:\Other\node.exe` }),
    /Node executable/);
  assert.throws(() => validateSupervisorRuntime(binding, { ...runtime,
    captureSource: () => ({ ...binding.source, digest: "c".repeat(64) }) }), /source identity/);
});

test("supervisor requires its one-use permit for an initial start under drain and waits before restart", async () => {
  class Child extends EventEmitter { killCalls = 0; kill() { this.killCalls++; return true; } }
  const children: Child[] = [];
  const sleeps: number[] = [];
  const drains = [true, true, false];
  const permits = [true, false];
  const spawns: Array<{ executable: string; args: string[]; options: Record<string, unknown> }> = [];
  let verifies = 0;
  const supervisor = startWindowsServiceSupervisor(binding, {
    openLog: () => 77,
    closeLog: () => {},
    reportStartFailure: () => {},
    verifySource: () => { verifies++; },
    drainActive: () => drains.shift() ?? false,
    claimPermit: () => permits.shift() ?? false,
    sleep: async milliseconds => { sleeps.push(milliseconds); },
    spawnChild: (executable, args, options) => {
      spawns.push({ executable, args, options: options as Record<string, unknown> });
      const child = new Child(); children.push(child); return child;
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spawns.length, 1, "the first child uses the exact transaction permit while the drain exists");
  assert.deepEqual(spawns[0].options.stdio, ["ignore", 77, 77]);
  assert.equal(spawns[0].options.shell, false);
  assert.equal(spawns[0].options.detached, false);
  children[0].emit("error", new Error("synthetic"));
  children[0].emit("close", 7);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spawns.length, 2, "error plus close schedules only one replacement");
  assert.deepEqual(sleeps, [RESTART_DELAY_MS, 100]);
  assert.equal(verifies, 2, "the immutable source is checked before every child start");
  await supervisor.stop();
});

test("supervisor log is append-only and rejects a non-regular target", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-supervisor-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "daemon.log");
  fs.writeFileSync(file, "before\n");
  const fd = openSupervisorLog(file);
  fs.writeSync(fd, "after\n");
  fs.closeSync(fd);
  assert.equal(fs.readFileSync(file, "utf8"), "before\nafter\n");
  assert.throws(() => openSupervisorLog(root), /regular file/);
});

const blockedLine = "kherep-node service supervisor: SERVICE_DRAIN_BLOCKED daemon start waits for the service drain; see kherep-node service status\n";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class DrainChild extends EventEmitter { kill() { return true; } }
function waitingSupervisor(t: test.TestContext, overrides: NonNullable<Parameters<typeof startWindowsServiceSupervisor>[1]> = {}) {
  const h = { drain: true, permit: false, reports: 0, verifies: 0, children: [] as DrainChild[],
    sleeps: [] as Array<{ milliseconds: number; resume(): void }> };
  const supervisor = startWindowsServiceSupervisor(binding, {
    openLog: () => -1, closeLog: () => {},
    drainActive: () => h.drain, claimPermit: () => h.permit,
    verifySource: () => { h.verifies++; },
    reportDrainBlocked: () => { h.reports++; },
    sleep: milliseconds => new Promise<void>(resume => { h.sleeps.push({ milliseconds, resume }); }),
    spawnChild: () => { const child = new DrainChild(); h.children.push(child); return child; },
    ...overrides,
  });
  t.after(async () => { await supervisor.stop(); for (const sleep of h.sleeps) sleep.resume(); await tick(); });
  const poll = async (milliseconds = 100) => {
    const sleep = h.sleeps.shift(); assert.ok(sleep); assert.equal(sleep.milliseconds, milliseconds);
    sleep.resume(); await tick();
  };
  return { h, supervisor, poll };
}

test("a blocked drain reports once across many polls and stop ends the supervisor", async (t) => {
  const { h, supervisor, poll } = waitingSupervisor(t);
  for (let i = 0; i < 8; i++) await poll();
  assert.equal(h.reports, 1);
  assert.equal(h.children.length, 0);
  assert.equal(h.verifies, 0);
  await supervisor.stop(); await supervisor.done;
  await poll();
  assert.equal(h.children.length, 0);
  assert.equal(h.verifies, 0);
  assert.equal(h.reports, 1);
});

for (const permit of [true, false]) test(permit ? "a first-check permit skips the drain report" : "no drain skips the drain report", async (t) => {
  const { h } = waitingSupervisor(t, { drainActive: () => permit, claimPermit: () => permit });
  assert.equal(h.reports, 0);
  assert.equal(h.children.length, 1);
  assert.equal(h.verifies, 1);
  assert.equal(h.sleeps.length, 0);
});

test("a drain ending during the wait reports once then spawns", async (t) => {
  const { h, poll } = waitingSupervisor(t);
  await poll(); h.drain = false; await poll();
  assert.equal(h.reports, 1);
  assert.equal(h.children.length, 1);
  assert.equal(h.verifies, 1);
});

test("a second drain wait after daemon close reports once more", async (t) => {
  const { h, poll } = waitingSupervisor(t);
  h.drain = false; await poll();
  assert.equal(h.reports, 1);
  h.drain = true; h.children[0].emit("close", 0);
  await poll(RESTART_DELAY_MS);
  for (let i = 0; i < 4; i++) await poll();
  assert.equal(h.reports, 2);
  assert.equal(h.children.length, 1);
  h.drain = false; await poll();
  assert.equal(h.reports, 2);
  assert.equal(h.children.length, 2);
});

test("a throwing drain reporter leaves the wait and subsequent start intact", async (t) => {
  let attempts = 0;
  const { h, poll } = waitingSupervisor(t, { reportDrainBlocked: () => { attempts++; throw new Error("synthetic"); } });
  for (let i = 0; i < 4; i++) await poll();
  assert.equal(attempts, 1);
  assert.equal(h.children.length, 0);
  assert.equal(h.verifies, 0);
  h.drain = false; await poll();
  assert.equal(h.children.length, 1);
  assert.equal(h.verifies, 1);
});

test("the default drain reporter writes exactly one fixed line to the supervisor log", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-supervisor-drain-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "daemon.log");
  const fd = openSupervisorLog(file);
  const { h, supervisor, poll } = waitingSupervisor(t, { openLog: () => fd, closeLog: value => fs.closeSync(value),
    reportDrainBlocked: undefined });
  for (let i = 0; i < 4; i++) await poll();
  await supervisor.stop();
  assert.equal(fs.readFileSync(file, "utf8"), blockedLine);
  assert.equal(h.children.length, 0);
  assert.equal(h.verifies, 0);
});

test("an invalid log descriptor cannot break the default drain wait", async (t) => {
  const { h, poll } = waitingSupervisor(t, { reportDrainBlocked: undefined });
  for (let i = 0; i < 4; i++) await poll();
  assert.equal(h.children.length, 0);
  assert.equal(h.verifies, 0);
  h.drain = false; await poll();
  assert.equal(h.children.length, 1);
  assert.equal(h.verifies, 1);
});
