import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type test from "node:test";

import { nodePaths } from "./config.mts";
import type { DaemonState } from "./daemon-state.mts";
import { snapshotDigests, writeServiceReceipt } from "./service-records.mts";
import { claimServiceLaunchPermit } from "./service-launch-permit.mts";
import type { ServiceFileOwner, ServiceOwnerProbe } from "./service-owner-probe.mts";
import {
  FAILED_WRITE_SNAPSHOT, STOP_NOT_ISSUED, type NativeServiceSnapshot, type ServiceAdapter, type ServiceBinding, type ServiceStopContext,
} from "./service-types.mts";

export const source = (root: string, char: string) => ({ root, commit: char.repeat(40), digest: char.repeat(64), kind: "pin" as const, verified: true });

export class FakeAdapter implements ServiceAdapter {
  readonly platform = "win32" as const;
  events: string[] = [];
  preflightCalls: Array<{ binding: ServiceBinding; expected: ServiceStopContext | undefined }> = [];
  stopCalls: Array<{ binding: ServiceBinding; expected: ServiceStopContext | undefined }> = [];
  snapshot: NativeServiceSnapshot | null;
  owned = true;
  failCandidateStart = false;
  failCandidateAfterState = false;
  candidateRunningUnknown = false;
  canonicalizeCandidate = false;
  rejectCandidateValidation = false;
  rejectExistingValidation = false;
  failWriteAfterMutation = false;
  failWriteBeforeMutation = false;
  foreignAfterWriteFailure = false;
  failCandidateHealth = false;
  failCandidateRecoveryStop = false;
  failPriorHealth = false;
  failStopBeforeEffect = false;
  stopKeepsPidAlive = false;
  startWithoutLoad = false;
  stopThrowsAfterEffect = false;
  stopFailureAfterEffect: Error | undefined; // #677: a coded stop failure after the native stop took effect
  stopUnlistsAlive = false; // #677: the native stop reports success and unlists the job; its daemon lives on
  proveStopped?: ServiceAdapter["proveStopped"]; // #677: the optional stop-proof hook; absent, the generic poll runs
  reportPid = true;
  disconnectAfterHealth = false;
  strictPreflightGeneration = false;
  strictStopGeneration = false;
  detachedSupervisor = false;
  adoptionRootAvailable = true;
  descendants = 0;
  mutateDuringPreflight = false;
  // #582 (A2 P1-A): a real legacy adoption yields a node path and a log path that differ from the installer's defaults;
  // the fixture defaults model that, so an install record is exercised with binding fields the repeated install does not know.
  adoptNodeExecutable: string;
  adoptedLogFile: string | undefined;
  state: DaemonState | null;
  oldPidAlive = true;
  candidatePidAlive = true;
  candidatePid = 42; // #582: a second candidate start in one test sets another pid, so healthy() sees a fresh daemon
  candidateDefinition = "RAW_NEW_XML"; // #582 (B-6b): a second upgrade retargets to distinct bytes, as a new pin does on a host
  readonly old: ServiceBinding;
  readonly candidate: ServiceBinding;
  constructor(old: ServiceBinding, candidate: ServiceBinding) {
    this.old = old;
    this.candidate = candidate;
    this.adoptNodeExecutable = path.join(candidate.configRoot, "legacy-runtime", "node");
    this.adoptedLogFile = old.logFile === undefined ? undefined : path.join(candidate.configRoot, "legacy-task.log");
    this.snapshot = { definition: Buffer.from("RAW_OLD_XML"), security: Buffer.from("RAW_OLD_SDDL"), running: true, pid: 41 };
    this.state = { pid: 41, startedAt: "2026-10-14T10:00:00.000Z", connectedAt: "2026-10-14T10:00:01.000Z", source: old.source };
  }
  async currentUser() { return "EXAMPLE\\operator"; }
  async read() { return this.snapshot && { ...this.snapshot, definition: Buffer.from(this.snapshot.definition), security: Buffer.from(this.snapshot.security) }; }
  async fresh() { this.events.push("fresh"); return Buffer.from("RAW_NEW_XML"); }
  async adopted() { this.events.push("adopt"); return Buffer.from("RAW_NEW_XML"); }
  async retargeted() { this.events.push("retarget"); return Buffer.from(this.candidateDefinition); }
  async adoptionNode() { return this.adoptNodeExecutable; }
  async adoptionSourceRoot() {
    if (!this.adoptionRootAvailable) throw new Error("legacy source root is unavailable");
    return this.old.source.root;
  }
  async adoptionLogFile() { return this.adoptedLogFile; }
  async freshSecurity() { return Buffer.alloc(0); }
  async validateManaged(snapshot: NativeServiceSnapshot, binding: ServiceBinding) {
    if (this.rejectExistingValidation && binding.source.commit === this.old.source.commit) throw new Error("service must have exactly one logon trigger and no other triggers");
    if (this.rejectCandidateValidation && binding.source.commit === this.candidate.source.commit) throw new Error("rejected candidate");
    if (binding.source.commit === this.candidate.source.commit
      && !["RAW_NEW_XML", "NATIVE_NEW_XML", this.candidateDefinition].includes(snapshot.definition.toString())) {
      throw new Error("wrong candidate");
    }
  }
  async processOwned(pid: number, binding: ServiceBinding, _startedAt: string, sourceRoot?: string) {
    this.events.push(`owned:${pid}${sourceRoot ? `:${sourceRoot}` : ""}`);
    if (this.disconnectAfterHealth && pid === this.candidatePid && this.state?.pid === this.candidatePid) {
      this.state = { ...this.state, disconnectedAt: "2026-10-14T11:00:02.000Z" };
    }
    if (this.failCandidateHealth && binding.source.commit === this.candidate.source.commit
      && this.events.some(event => event === "start:RAW_NEW_XML" || event === "start:NATIVE_NEW_XML")) return false;
    if (this.failPriorHealth && binding.source.commit === this.old.source.commit
      && this.events.includes("start:MANAGED_OLD_XML")) return false;
    return this.owned;
  }
  async preflightStop(binding: ServiceBinding, expected: ServiceStopContext | undefined) {
    this.events.push(`preflight:${expected?.pid ?? "gap"}`);
    this.preflightCalls.push({ binding, expected });
    if (this.strictPreflightGeneration && this.snapshot?.definition.toString() === "MANAGED_OLD_XML"
      && binding.supervisorGeneration !== this.old.supervisorGeneration) throw new Error("prior preflight generation differs");
    if (!expected && this.detachedSupervisor) throw new Error("detached managed supervisor remains");
    if (this.descendants > 0) throw new Error("STOP_BLOCKED_NATIVE_DESCENDANTS");
    if (this.mutateDuringPreflight && this.snapshot) {
      this.snapshot.definition = Buffer.from("UNEXPECTED_XML");
      this.snapshot.security = Buffer.from("UNEXPECTED_SDDL");
    }
  }
  async write(_binding: ServiceBinding, definition: Buffer, security: Buffer) {
    this.events.push(`write:${definition.toString()}`);
    if (definition.toString() === "RAW_NEW_XML" && this.failWriteBeforeMutation) {
      throw new Error("synthetic native write failed before mutation");
    }
    const candidate = definition.toString() === "RAW_NEW_XML" && this.canonicalizeCandidate;
    this.snapshot = { definition: candidate ? Buffer.from("NATIVE_NEW_XML") : Buffer.from(definition),
      security: candidate ? Buffer.from("NATIVE_NEW_SDDL") : Buffer.from(security), running: false };
    if (definition.toString() === "RAW_NEW_XML" && this.failWriteAfterMutation) {
      const associated = this.snapshot;
      if (this.foreignAfterWriteFailure) {
        this.snapshot = { definition: Buffer.from("FOREIGN_XML"), security: Buffer.from("FOREIGN_SDDL"), running: false };
      }
      const error = new Error("synthetic native security readback failure");
      Object.defineProperty(error, FAILED_WRITE_SNAPSHOT, { value: associated });
      throw error;
    }
  }
  async remove() { this.events.push("remove"); this.snapshot = null; }
  async stop(binding: ServiceBinding, expected: ServiceStopContext | undefined) {
    this.events.push("stop");
    this.stopCalls.push({ binding, expected });
    if (this.failStopBeforeEffect) throw Object.assign(new Error("synthetic stop failure before effect"), { code: STOP_NOT_ISSUED });
    if (this.stopThrowsAfterEffect) throw new Error("synthetic stop failure after the native stop took effect");
    if (this.stopFailureAfterEffect) throw this.stopFailureAfterEffect;
    if (this.stopKeepsPidAlive) return;
    if (this.stopUnlistsAlive) { if (this.snapshot) { this.snapshot.running = false; delete this.snapshot.pid; } return; }
    if (this.failCandidateRecoveryStop && binding.source.commit === this.candidate.source.commit && expected?.pid === this.candidatePid) {
      throw new Error("synthetic candidate stop failure");
    }
    if (this.strictStopGeneration && this.snapshot?.definition.toString() === "MANAGED_OLD_XML"
      && binding.supervisorGeneration !== this.old.supervisorGeneration) {
      throw new Error("candidate supervisor generation differs");
    }
    if (this.snapshot) { this.snapshot.running = false; delete this.snapshot.pid; }
    if (expected?.pid === this.candidatePid) this.candidatePidAlive = false;
    else this.oldPidAlive = false;
  }
  async start(binding: ServiceBinding) {
    if (binding.platform === "win32" && binding.supervisorGeneration) {
      assert.equal(claimServiceLaunchPermit(nodePaths(binding.configRoot), binding), true,
        "native start receives one exact generation-bound permit");
    }
    const definition = this.snapshot?.definition.toString();
    this.events.push(`start:${definition}`);
    if ((definition === "RAW_NEW_XML" || definition === "NATIVE_NEW_XML" || definition === this.candidateDefinition) && this.failCandidateStart) {
      if (this.snapshot && this.candidateRunningUnknown) this.snapshot.running = "unknown";
      if (this.failCandidateAfterState) {
        if (this.snapshot) this.snapshot.running = true;
        this.oldPidAlive = false;
        this.candidatePidAlive = true;
        this.state = { pid: this.candidatePid, startedAt: "2026-10-14T11:00:00.000Z", connectedAt: "2026-10-14T11:00:01.000Z",
          source: this.candidate.source, service: { name: this.candidate.serviceName, platform: "win32", taskPath: this.candidate.taskPath } };
      }
      throw new Error("synthetic start failure");
    }
    const candidate = definition === "RAW_NEW_XML" || definition === "NATIVE_NEW_XML" || definition === this.candidateDefinition;
    this.oldPidAlive = !candidate;
    this.candidatePidAlive = candidate;
    this.state = candidate
      ? { pid: this.candidatePid, startedAt: "2026-10-14T11:00:00.000Z", connectedAt: "2026-10-14T11:00:01.000Z", source: this.candidate.source,
        service: { name: this.candidate.serviceName, platform: "win32", taskPath: this.candidate.taskPath } }
      : { pid: 41, startedAt: "2026-10-14T10:00:00.000Z", connectedAt: "2026-10-14T10:00:01.000Z", source: this.old.source,
        ...(definition === "MANAGED_OLD_XML" ? { service: { name: this.old.serviceName, platform: "win32" as const, taskPath: this.old.taskPath } } : {}) };
    if (this.snapshot && !this.startWithoutLoad) {
      this.snapshot.running = true;
      if (this.reportPid) this.snapshot.pid = this.state.pid;
    }
  }
}

export function seedManaged(h: ReturnType<typeof setup>): void {
  h.adapter.snapshot = { definition: Buffer.from("MANAGED_OLD_XML"), security: Buffer.from("PRESERVED_SDDL"), running: true, pid: 41 };
  h.adapter.state = { pid: 41, startedAt: "2026-10-14T10:00:00.000Z", connectedAt: "2026-10-14T10:00:01.000Z",
    source: h.old.source, service: { name: h.old.serviceName, platform: h.old.platform, taskPath: h.old.taskPath } };
  writeServiceReceipt(h.paths, { version: 1, binding: h.old, ...snapshotDigests(h.adapter.snapshot), activatedAt: "2026-10-14T10:00:02.000Z" });
}

export function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-service-transaction-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const common = { serviceName: "KherepNode", taskPath: "\\Kherep\\", platform: "win32" as const,
    workspace: path.join(root, "workspace"), configRoot: root, nodeExecutable: process.execPath,
    logFile: path.join(root, "legacy-daemon.log"), supervisorGeneration: "11111111-1111-4111-8111-111111111111" };
  const old = { ...common, source: source(path.join(root, "old-pin"), "a") };
  const candidate = { ...common, source: source(path.join(root, "new-pin"), "b") };
  for (const pin of [old.source.root, candidate.source.root]) fs.mkdirSync(pin, { recursive: true });
  const adapter = new FakeAdapter(old, candidate);
  let sourceValid = true;
  let generation = 0;
  let controller: ServiceFileOwner = { version: 1, pid: 4242, startedAt: "2026-10-14T09:00:00.000Z", owner: "synthetic-controller" };
  const ownerKey = (o: ServiceFileOwner) => JSON.stringify([o.pid, o.startedAt, o.owner]);
  const owners = new Map<string, boolean | "unknown">([[ownerKey(controller), true]]);
  const ownerProbe: ServiceOwnerProbe = { current: () => controller, active: o => owners.get(ownerKey(o)) ?? "unknown" };
  const deps = { paths, adapter, readDaemonState: () => adapter.state,
    pidAlive: (pid: unknown) => (pid === adapter.candidatePid && adapter.candidatePidAlive) || (pid === 41 && adapter.oldPidAlive),
    sleep: async () => {}, timeoutMs: 50,
    ownerProbe, verifySource: () => sourceValid };
  return { paths, old, candidate, adapter, deps, setSourceValid: (value: boolean) => { sourceValid = value; },
    setControllerState: (value: boolean | "unknown") => { owners.set(ownerKey(controller), value); },
    advanceController: () => {
      owners.set(ownerKey(controller), false);
      controller = { ...controller, startedAt: new Date(Date.parse("2026-10-14T09:00:00.000Z") + ++generation).toISOString() };
      owners.set(ownerKey(controller), true);
    } };
}
