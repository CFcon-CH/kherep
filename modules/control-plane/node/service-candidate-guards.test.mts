// #582: the candidate record is trusted only while it is exactly true; its stop reason travels as one fixed code.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { safeServiceFailure } from "./service-cli.mts";
import {
  candidateFile, caught, failedFreshInstall, failedUpgrade, noPath, readRecord, secondCall, staleDrain, status, tamper, why, world, type Harness,
} from "./service-candidate-fixture.mts";
import * as records from "./service-records.mts";
import { activateManagedService, readServiceReceipt, rollbackManagedService } from "./service-transaction.mts";
import * as support from "./service-transaction-support.mts";
import * as types from "./service-types.mts";
import { seedManaged, setup } from "./service-transaction-fixture.mts";
import type { ServiceBinding } from "./service-types.mts";

const backupJson = (h: Harness, id: string): string => path.join(records.serviceRoot(h.paths), "backups", id, "backup.json");
const verbs = (h: Harness) => ({
  upgrade: () => activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps),
  rollback: () => rollbackManagedService({ binding: h.candidate }, h.deps),
});
const DRIFT = { upgrade: "managed service definition drifted from its receipt", rollback: "current managed service drifted from its receipt" };
const INVALID = { upgrade: "managed service candidate record is invalid", rollback: "managed service candidate record is invalid" };
const UNBOUND = { upgrade: "managed service candidate record does not bind to the receipt", rollback: "rollback backup is unavailable for this service" };
// A backup of the receipt's own bytes, optionally naming another receipt or holding other bytes.
const otherBackup = (h: Harness, definition: string, receipt: records.ServiceReceipt): string => records.saveServiceBackup(h.paths,
  { definition: Buffer.from(definition), security: Buffer.from("PRESERVED_SDDL"), running: true },
  { receipt, priorSource: h.old.source, now: "2026-10-14T12:00:00.000Z" }).id;

const ROWS: Array<[string, (h: Harness) => void, Record<"upgrade" | "rollback", string>]> = [
  ["tampered digest", h => tamper(h, r => { r.definitionDigest = "f".repeat(64); }), DRIFT],
  ["foreign serviceName", h => tamper(h, r => { r.binding = { ...(r.binding as ServiceBinding), serviceName: "OtherNode" }; }), DRIFT],
  ["foreign workspace", h => tamper(h, r => { r.binding = { ...(r.binding as ServiceBinding), workspace: path.join(h.paths.dir, "other") }; }), DRIFT],
  ["stopCode is a message", h => tamper(h, r => { r.stopCode = "synthetic candidate stop failure"; }), INVALID],
  ["invalid JSON", h => fs.writeFileSync(candidateFile(h), "{\"binding\":{\"workspace\":\"/Users/x582leak/ws\""), INVALID],
  ["upgrade record without backupId", h => tamper(h, r => { delete r.backupId; }), INVALID],
  ["prior with other digests", h => {
    const id = otherBackup(h, "OTHER_XML", readServiceReceipt(h.paths)!);
    tamper(h, r => { r.backupId = id; });
  }, UNBOUND],
  ["prior naming another receipt", h => {
    const id = otherBackup(h, "MANAGED_OLD_XML", { ...readServiceReceipt(h.paths)!, activatedAt: "2026-10-14T09:00:00.000Z" });
    tamper(h, r => { r.backupId = id; });
  }, UNBOUND],
  ["missing backup dir", h => tamper(h, r => { r.backupId = "20261014120000-00000000-0000-4000-8000-000000000000"; }), UNBOUND],
  ["corrupt backup.json", h => fs.writeFileSync(backupJson(h, readRecord(h)!.backupId!), "garbage /Users/x582leak"), UNBOUND],
];

test("T4/B-3: a record that is not exactly true refuses both verbs with a fixed text and changes nothing", async (t) => {
  for (const [name, edit, expected] of ROWS) {
    for (const verb of ["upgrade", "rollback"] as const) {
      const { h } = await failedUpgrade(t);
      staleDrain(h);
      edit(h);
      const before = world(h);
      const message = await why(verbs(h)[verb]());
      assert.equal(message, expected[verb], `${name} / ${verb}`);
      assert.ok(noPath(message), `${name} / ${verb}: no path`);
      assert.equal(world(h), before, `${name} / ${verb}: world unchanged`);
    }
  }
});

test("B-4: a garbage record beside a matching receipt leaves a healthy node usable", async (t) => {
  const h = setup(t);
  seedManaged(h);
  fs.writeFileSync(candidateFile(h), "/Users/x582leak/Library");
  const s = await status(h);
  assert.equal(s.report.ok, true);
  assert.equal(s.report.candidate, "invalid");
  assert.equal(s.text.includes("x582leak"), false);
  assert.equal(await why(activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps)), "resolved");
  assert.equal(fs.existsSync(candidateFile(h)), false);
});

const MAPPED: Array<[string, string, string]> = [
  ["STOP_BLOCKED_NATIVE_DESCENDANTS", "STOP_BLOCKED_NATIVE_DESCENDANTS", "service-platform-mac.mts"],
  ["STOP_BLOCKED_NATIVE_DESCENDANTS", "STOP_BLOCKED_NATIVE_DESCENDANTS", "service-windows-quiescence.mts"],
  ["STOP_UNKNOWN_DESCENDANTS", "STOP_UNKNOWN_DESCENDANTS", "service-platform-mac.mts"],
  ["launchctl could not prove the selected service stopped", "STOP_NATIVE_REFUSED", "service-platform-mac.mts"],
  ["Scheduled Task operation failed for the selected task", "STOP_NATIVE_REFUSED", "service-windows-invoke.mts"],
  ["managed service verification timed out", "STOP_UNPROVEN_TIMEOUT", "service-lifecycle.mts"],
  ["selected LaunchAgent process is unavailable", "STOP_PROCESS_UNAVAILABLE", "service-platform-mac-stop.mts"],
  ["LaunchAgent loaded pid does not match selected process", "STOP_IDENTITY_MISMATCH", "service-platform-mac-native.mts"],
  ["LaunchAgent loaded definition does not match selected definition", "STOP_IDENTITY_MISMATCH", "service-platform-mac-native.mts"],
  ["LaunchAgent loaded identity changed during stop preflight", "STOP_IDENTITY_MISMATCH", "service-platform-mac-stop.mts"],
];

test("T4(e)/B-7: a stop failure maps to one allowlisted code by its exact message", () => {
  for (const [message, code, file] of MAPPED) {
    assert.equal(types.stopCode(new Error(message)), code, message);
    assert.ok(fs.readFileSync(new URL(file, import.meta.url), "utf8").includes(`"${message}"`), `${message} is written in ${file}`);
  }
  for (const other of [new Error("ENOENT: realpath '/Users/x582leak/x.plist'"), new Error("managed service verification timed out; x"),
    "managed service verification timed out", undefined]) assert.equal(types.stopCode(other), "STOP_FAILED_OTHER");
  assert.deepEqual([...types.STOP_CODES].sort(), ["STOP_BLOCKED_NATIVE_DESCENDANTS", "STOP_FAILED_OTHER", "STOP_IDENTITY_MISMATCH",
    "STOP_NATIVE_REFUSED", "STOP_PROCESS_UNAVAILABLE", "STOP_UNKNOWN_DESCENDANTS", "STOP_UNLISTED_ALIVE", "STOP_UNPROVEN_TIMEOUT"]);
});

test("T4(e)/B-7: a stop error that carries a home path reaches no record, CLI failure or status", async (t) => {
  const { h, failure } = await failedUpgrade(t, g => {
    const original = g.adapter.stop.bind(g.adapter);
    g.adapter.stop = async (binding, expected) => {
      if (!g.adapter.failCandidateRecoveryStop || expected?.pid !== 42) return original(binding, expected);
      g.adapter.events.push("stop");
      throw new Error("ENOENT: realpath '/Users/x582leak/Library/LaunchAgents/x.plist'");
    };
  });
  assert.equal(readRecord(h)?.stopCode, "STOP_FAILED_OTHER");
  const recordText = fs.readFileSync(candidateFile(h), "utf8");
  // The record's binding carries the host's own paths (under /Users on a macOS runner); everything else carries none.
  const { binding: _binding, ...unbound } = readRecord(h)!;
  for (const text of [recordText, JSON.stringify(safeServiceFailure(failure)), (await status(h)).text]) assert.equal(text.includes("x582leak"), false);
  for (const text of [JSON.stringify(unbound), JSON.stringify(safeServiceFailure(failure)), (await status(h)).text]) {
    assert.equal(text.includes("/Users"), false, text);
  }
});

const BAD_INSTANTS = ["14 Oct 2026 (/Users/x582leak)", "2026-10-14T11:00:00.000Z x582leak", "2026-10-14"];
test("B-12: writeServiceCandidate accepts failedAt only in the toISOString() shape", (t) => {
  const h = setup(t);
  const record: records.ServiceCandidate = { version: 1, binding: h.candidate, definitionDigest: "1".repeat(64), securityDigest: "2".repeat(64),
    backupId: "20261014110000-00000000-0000-4000-8000-000000000000", command: "upgrade", stage: "health",
    blocker: "RECOVERY_CANDIDATE_LOADED", stopCode: "STOP_FAILED_OTHER", failedAt: new Date().toISOString() };
  for (const failedAt of BAD_INSTANTS) {
    assert.throws(() => records.writeServiceCandidate(h.paths, { ...record, failedAt }), /^Error: managed service candidate record is invalid$/);
  }
  records.writeServiceCandidate(h.paths, record);
  assert.deepEqual(records.readServiceCandidate(h.paths), record);
});

test("B-12: a record tampered to another instant shape is reported invalid", async (t) => {
  const { h } = await failedUpgrade(t);
  for (const failedAt of BAD_INSTANTS) {
    tamper(h, r => { r.failedAt = failedAt; });
    const s = await status(h);
    assert.equal(s.report.candidate, "invalid", failedAt);
    assert.equal(s.text.includes("x582leak"), false);
  }
});

test("B-13: a backup written with another key order still binds", async (t) => {
  const { h } = await failedUpgrade(t);
  const record = readRecord(h)! as records.ServiceCandidate;
  const reversed = (value: unknown): unknown => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reversed((value as Record<string, unknown>)[key])])) : value;
  const backup = JSON.parse(fs.readFileSync(backupJson(h, record.backupId!), "utf8")) as Record<string, unknown>;
  fs.writeFileSync(backupJson(h, record.backupId!), JSON.stringify(reversed(backup)));
  assert.notEqual(JSON.stringify((reversed(backup) as { priorReceipt: unknown }).priorReceipt), JSON.stringify(readServiceReceipt(h.paths)));
  assert.ok(support.recordedPriorBackup(h.paths, record, readServiceReceipt(h.paths)));
  assert.equal((await status(h)).report.candidate?.prior, "recorded");
});

test("B-6: a failed rollback over the record writes no record for the receipt's own bytes", async (t) => {
  const { h } = await failedUpgrade(t);
  staleDrain(h);
  const first = fs.readFileSync(candidateFile(h), "utf8");
  h.adapter.failPriorHealth = true;
  const original = h.adapter.stop.bind(h.adapter);
  h.adapter.stop = async (binding, expected) => { await original(binding, expected); if (expected?.pid === 42) h.adapter.stopKeepsPidAlive = true; };
  const failure = await caught(rollbackManagedService({ binding: h.candidate }, h.deps));
  assert.equal(failure.code, "SERVICE_ROLLBACK_FAILED");
  assert.equal(failure.stage, "health");
  assert.equal(failure.blocker, "RECOVERY_CANDIDATE_LOADED");
  assert.equal(h.adapter.snapshot?.definition.toString(), "MANAGED_OLD_XML");
  assert.equal(h.adapter.snapshot?.running, true);
  assert.equal(fs.readFileSync(candidateFile(h), "utf8"), first, "the T1 record is not rewritten");
  const s = await status(h);
  assert.equal(s.report.definition, "match");
  assert.equal(s.report.candidate, "stale");
});

test("B-6b: a second failed upgrade over the record rewrites it with the same backupId", async (t) => {
  const { h } = await failedUpgrade(t);
  const first = readRecord(h)!;
  const deps = { ...secondCall(h), now: () => "2099-01-01T00:00:00.000Z" };
  h.adapter.candidateDefinition = "RAW_NEW2_XML";
  h.adapter.failCandidateStart = true;
  h.adapter.failCandidateAfterState = true;
  h.adapter.failCandidateRecoveryStop = true;
  const failure = await caught(activateManagedService({ mode: "upgrade", binding: h.candidate }, deps));
  assert.equal(failure.blocker, "RECOVERY_CANDIDATE_LOADED");
  assert.equal(h.adapter.snapshot?.definition.toString(), "RAW_NEW2_XML");
  const second = readRecord(h)!;
  assert.equal(second.backupId, first.backupId);
  assert.equal(second.definitionDigest, records.snapshotDigests(h.adapter.snapshot!).definitionDigest);
  assert.ok(Date.parse(second.failedAt) > Date.parse(first.failedAt));
  assert.equal(second.stage, "start");
});

test("B-15: a record string field that is not a string makes the record invalid", async (t) => {
  const shapes: Array<[string, (value: unknown) => unknown]> = [["one-element array", value => [value]], ["number", () => 1]];
  for (const field of ["definitionDigest", "securityDigest", "backupId", "failedAt", "binding.workspace", "binding.source.commit"]) {
    for (const [shape, wrap] of shapes) {
      const { h } = await failedUpgrade(t);
      staleDrain(h);
      tamper(h, r => { // a dotted field names a nested binding value
        const keys = field.split(".");
        const owner = keys.slice(0, -1).reduce((value, key) => value[key] as Record<string, unknown>, r);
        owner[keys.at(-1)!] = wrap(owner[keys.at(-1)!]);
      });
      const name = `${field} as ${shape}`;
      assert.throws(() => records.readServiceCandidate(h.paths), /^Error: managed service candidate record is invalid$/, name);
      assert.equal((await status(h)).report.candidate, "invalid", name);
      const before = world(h);
      assert.equal(await why(verbs(h).upgrade()), INVALID.upgrade, name);
      assert.equal(world(h), before, name);
    }
  }
});

test("B-16: a record service name the CLI could not have selected makes the record invalid", async (t) => {
  const leak = "/Users/x582leak/x";
  const { h } = await failedFreshInstall(t); // no receipt: status would echo the record's name
  tamper(h, r => { r.binding = { ...(r.binding as ServiceBinding), serviceName: leak }; });
  assert.throws(() => records.readServiceCandidate(h.paths), /^Error: managed service candidate record is invalid$/);
  const s = await status(h);
  assert.deepEqual([s.exit, s.report], [0, { ok: true, managed: false, candidate: "invalid" }]);
  assert.equal(s.text.includes("x582leak"), false);
  const { serviceName: _name, taskPath: _task, logFile: _log, supervisorGeneration: _generation, ...shared } = h.candidate;
  const darwin = { ...readRecord(h)!, binding: { ...shared, platform: "darwin" as const, serviceName: "org.kherep.node" } } as records.ServiceCandidate;
  records.writeServiceCandidate(h.paths, darwin);
  assert.throws(() => records.writeServiceCandidate(h.paths, { ...darwin, binding: { ...darwin.binding, serviceName: "../escape" } }),
    /^Error: managed service candidate record is invalid$/);
});
