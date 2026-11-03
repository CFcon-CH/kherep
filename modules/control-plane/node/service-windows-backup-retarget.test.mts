import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { validateWindowsManaged, windowsManagedAction } from "./service-definitions.mts";
import { WindowsServiceAdapter, windowsFreshXml } from "./service-platform-windows.mts";
import { readServiceBackup, readServiceCandidate, readServiceReceipt, saveServiceBackup, serviceRoot,
  snapshotDigests, writeServiceReceipt, type ServiceCandidate } from "./service-records.mts";
import { rollbackManagedService } from "./service-rollback.mts";
import { recordedPriorBackup, receiptFor } from "./service-transaction-support.mts";
import { setup } from "./service-transaction-fixture.mts";
import type { ServiceAdapter, ServiceBinding, WindowsServiceSummary } from "./service-types.mts";

const sid = "S-1-5-21-1-2-3-1001", now = "2026-11-03T18:00:00.000Z";
const windowsOnly = { skip: process.platform !== "win32" && "requires Windows PowerShell XML-only transformation" };
const summary = (binding: ServiceBinding): WindowsServiceSummary => ({ owner: sid, logonType: "InteractiveToken",
  runLevel: "LeastPrivilege", enabled: true, logonTriggers: 1, triggerTypes: ["LogonTrigger"], logonTriggerEnabled: true,
  logonTriggerUser: sid, actionTypes: ["Exec"], actions: [windowsManagedAction(binding)], executionEnvironment: {}, securityDescriptor: "synthetic" });

// Observe only children launched by the real XML transformer; its original script/argv/env are forwarded unchanged.
function recordXmlChildren(t: test.TestContext): void {
  const spawn = childProcess.spawnSync;
  const mock = t.mock.method(childProcess, "spawnSync", ((executable: string, args: string[], options: any) => {
    assert.equal(executable, "powershell.exe");
    assert.match(options.input, /LoadXml/);
    assert.doesNotMatch(options.input, /ScheduledTasks|Get-ScheduledTask|Register-ScheduledTask|WindowsIdentity|Get-CimInstance/);
    const startedAt = new Date().toISOString(), result = spawn(executable, args, options);
    console.log(`XML-CHILD ${JSON.stringify({ pid: result.pid, startedAt, closedAt: new Date().toISOString(), exit: result.status,
      signal: result.signal, errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null, collected: true })}`);
    return result;
  }) as typeof spawn);
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}

function persisted(t: test.TestContext) {
  const h = setup(t);
  for (const binding of [h.old, h.candidate]) {
    binding.source = { ...binding.source, root: path.join(serviceRoot(h.paths), "source-pins", binding.source.commit) };
    fs.mkdirSync(binding.source.root, { recursive: true });
  }
  const snapshot = { definition: windowsFreshXml(h.old, sid), security: Buffer.from("SYNTHETIC_PRESERVED_SECURITY"),
    running: false, windows: summary(h.old) };
  const receipt = receiptFor(h.old, snapshot, now);
  writeServiceReceipt(h.paths, receipt);
  const backup = saveServiceBackup(h.paths, snapshot, { receipt, priorSource: h.old.source, now });
  const restored = readServiceBackup(h.paths, backup.id);
  const pending: ServiceCandidate = { version: 2, phase: "attested", preparedAt: now, binding: h.candidate,
    ...snapshotDigests(snapshot), backupId: backup.id, command: "upgrade" };
  assert.equal(Object.hasOwn(restored.snapshot, "windows"), false);
  assert.deepEqual(restored.snapshot.definition, snapshot.definition);
  assert.deepEqual(restored.snapshot.security, snapshot.security);
  assert.deepEqual(restored.backup.priorReceipt, receipt);
  assert.deepEqual(recordedPriorBackup(h.paths, pending, receipt), restored);
  return { h, snapshot, receipt, backup, restored, pending };
}

test("Windows retarget accepts the real persisted backup representation and preserves unrelated XML/security", windowsOnly, async t => {
  const f = persisted(t);
  recordXmlChildren(t);
  const bytes = await new WindowsServiceAdapter().retargeted(f.restored.snapshot, f.h.candidate);
  const before = f.snapshot.definition.toString("utf16le"), after = bytes.toString("utf16le");
  const actionBlock = /<Actions\b[^>]*>[\s\S]*?<\/Actions>/;
  assert.equal(after.replace(actionBlock, "<Actions/>"), before.replace(actionBlock, "<Actions/>"));
  assert.equal((after.match(/<Exec>/g) ?? []).length, 1);
  const action = windowsManagedAction(f.h.candidate);
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  for (const [name, value] of [["Command", action.executable], ["Arguments", action.arguments], ["WorkingDirectory", action.workingDirectory!]]) {
    assert.ok(after.includes(`<${name}>${escape(value)}</${name}>`), name);
  }
  assert.deepEqual(readServiceBackup(f.h.paths, f.backup.id), f.restored);
  assert.deepEqual(readServiceReceipt(f.h.paths), f.receipt);
});

test("Windows orphan recovery consumes persisted backup through the real retargeter and restores the exact receipt", windowsOnly, async t => {
  const f = persisted(t), real = new WindowsServiceAdapter();
  recordXmlChildren(t);
  const definition = await real.retargeted(f.restored.snapshot, f.h.candidate);
  f.h.adapter.snapshot = { definition, security: f.snapshot.security, running: false, windows: summary(f.h.candidate) };
  f.h.adapter.state = null;
  f.h.adapter.oldPidAlive = f.h.adapter.candidatePidAlive = false;
  f.h.adapter.validateManaged = async (snapshot, binding) => {
    assert.ok(snapshot.windows);
    validateWindowsManaged(snapshot.windows, binding, sid);
  };
  let retargets = 0;
  const adapter: ServiceAdapter = f.h.adapter;
  adapter.retargeted = async (snapshot, binding) => {
    retargets++;
    assert.equal(Object.hasOwn(snapshot, "windows"), false);
    assert.deepEqual(snapshot.definition, f.restored.snapshot.definition);
    assert.deepEqual(snapshot.security, f.restored.snapshot.security);
    return real.retargeted(snapshot, binding);
  };
  const checkout = path.join(path.dirname(f.h.paths.dir), "candidate-checkout");
  fs.mkdirSync(checkout);
  const canonicalCheckout = fs.realpathSync.native(checkout);
  const deps = { ...f.h.deps, captureSource: (root: string) => {
    if (root === canonicalCheckout) return { ...f.h.candidate.source, root, kind: "checkout" as const };
    const binding = [f.h.old, f.h.candidate].find(b => b.source.root === root);
    if (!binding) throw new Error("unknown synthetic source");
    return binding.source;
  } };
  const result = await rollbackManagedService({ binding: f.h.old,
    recover: { backup: f.backup.id, source: canonicalCheckout } }, deps);
  assert.equal(retargets, 1, "recovery reaches the real persisted-backup retarget boundary");
  assert.equal(result.source.commit, f.h.old.source.commit);
  assert.deepEqual(f.h.adapter.snapshot?.definition, f.snapshot.definition);
  assert.deepEqual(f.h.adapter.snapshot?.security, f.snapshot.security);
  assert.deepEqual(readServiceReceipt(f.h.paths), f.receipt);
  assert.equal(readServiceCandidate(f.h.paths), null);
});

for (const invalid of ["malformed", "zero", "multiple", "non-exec"] as const) {
  test(`Windows persisted retarget rejects ${invalid} XML actions`, windowsOnly, async t => {
    const f = persisted(t), xml = f.snapshot.definition.toString("utf16le");
    let invalidXml: string;
    if (invalid === "malformed") invalidXml = "<Task>";
    else if (invalid === "zero") invalidXml = xml.replace(/<Exec>[\s\S]*?<\/Exec>/, "");
    else if (invalid === "multiple") invalidXml = xml.replace(/(<Exec>[\s\S]*?<\/Exec>)/, "$1$1");
    else invalidXml = xml.replace(/<Exec>[\s\S]*?<\/Exec>/, "<ComHandler/>");
    recordXmlChildren(t);
    await assert.rejects(new WindowsServiceAdapter().retargeted({ ...f.restored.snapshot, definition: Buffer.from(invalidXml, "utf16le") },
      f.h.candidate), /Scheduled Task operation failed/);
  });
}

test("Windows authority methods still require a live summary before any user lookup", async t => {
  const f = persisted(t), adapter = new WindowsServiceAdapter();
  let lookups = 0;
  t.mock.method(adapter, "currentUser", async () => { lookups++; throw new Error("user lookup must not execute"); });
  await assert.rejects(adapter.adopted(f.restored.snapshot, f.h.candidate, f.h.old.source.root), /Scheduled Task summary is missing/);
  await assert.rejects(adapter.validateManaged(f.restored.snapshot, f.h.candidate), /Scheduled Task summary is missing/);
  assert.equal(lookups, 0);
});

for (const corrupt of ["definition.bin", "security.bin", "digest", "receipt"] as const) {
  test(`persisted backup ${corrupt} corruption remains unbound`, t => {
    const f = persisted(t), root = path.join(serviceRoot(f.h.paths), "backups", f.backup.id);
    if (corrupt.endsWith(".bin")) fs.writeFileSync(path.join(root, corrupt), "TAMPERED_BYTES");
    else {
      const file = path.join(root, "backup.json"), value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (corrupt === "digest") value.definitionDigest = "0".repeat(64);
      else value.priorReceipt.activatedAt = "2026-11-02T18:00:00.000Z";
      fs.writeFileSync(file, JSON.stringify(value));
    }
    if (corrupt !== "receipt") assert.throws(() => readServiceBackup(f.h.paths, f.backup.id), /corrupt/);
    assert.equal(recordedPriorBackup(f.h.paths, f.pending, f.receipt), null);
    assert.deepEqual(readServiceReceipt(f.h.paths), f.receipt);
    assert.equal(readServiceCandidate(f.h.paths), null);
  });
}
