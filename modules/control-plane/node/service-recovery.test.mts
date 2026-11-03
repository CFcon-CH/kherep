import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeConfig } from "./config.mts";
import { windowsManagedAction } from "./service-definitions.mts";
import { parseServiceCommand, runService } from "./service-cli.mts";
import { readServiceCandidate, readServiceReceipt, removeServiceCandidate, serviceRoot, writeServiceCandidate } from "./service-records.mts";
import { activateManagedService, rollbackManagedService } from "./service-transaction.mts";
import { seedManaged, setup } from "./service-transaction-fixture.mts";
import { candidateFile, caught, status } from "./service-candidate-fixture.mts";

async function orphan(t: test.TestContext) {
  const h = setup(t);
  for (const binding of [h.old, h.candidate]) {
    binding.source = { ...binding.source, root: path.join(serviceRoot(h.paths), "source-pins", binding.source.commit) };
    fs.mkdirSync(binding.source.root, { recursive: true });
  }
  seedManaged(h);
  h.adapter.failCandidateHealth = h.adapter.failCandidateRecoveryStop = true;
  await caught(activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps));
  h.adapter.failCandidateHealth = h.adapter.failCandidateRecoveryStop = false;
  const pending = readServiceCandidate(h.paths)!;
  removeServiceCandidate(h.paths);
  h.advanceController();
  h.adapter.snapshot!.windows = { actions: [windowsManagedAction(pending.binding)] } as any;
  const checkout = path.join(path.dirname(h.paths.dir), "candidate-checkout");
  fs.mkdirSync(checkout);
  const captureSource = (root: string) => {
    if (root === checkout) return { ...pending.binding.source, root, kind: "checkout" as const };
    const binding = [h.old, pending.binding].find(b => b.source.root === root);
    if (!binding) throw new Error("unknown synthetic source");
    return binding.source;
  };
  const root = path.dirname(h.paths.dir);
  writeConfig(h.paths.config, { version: 1, controlUrl: "https://control.example.com", nodeId: "00000000-0000-4000-8000-000000000001",
    name: "synthetic", publicKey: "synthetic", privateKeyFile: h.paths.privateKey, policyFile: h.paths.policy,
    enrolledAt: "2026-10-14T10:00:00.000Z" });
  const dependencies = { root, adapterFor: () => h.adapter, readState: () => h.adapter.state,
    alive: h.deps.pidAlive, ownerProbe: h.deps.ownerProbe, lifecycle: { ...h.deps, captureSource } };
  return { h, pending, checkout, dependencies, argv: ["rollback", "--recover", "--backup", pending.backupId!, "--source", checkout] };
}

test("recover flags are accepted only together on the explicit rollback form", () => {
  assert.deepEqual(parseServiceCommand(["rollback", "--recover", "--backup", "backup", "--source", path.resolve("synthetic")]),
    { action: "rollback", recover: true, backup: "backup", source: path.resolve("synthetic") });
  for (const args of [["upgrade", "--recover"], ["status", "--recover"], ["install", "--recover"],
    ["rollback", "--recover"], ["rollback", "--backup", "backup"], ["rollback", "--source", path.resolve("synthetic")]]) {
    assert.throws(() => parseServiceCommand(args), /usage/);
  }
});

test("orphan refuses ordinary upgrade AND rollback; the status recovery command restores the receipt", async t => {
  const f = await orphan(t), before = readServiceReceipt(f.h.paths);
  await assert.rejects(activateManagedService({ mode: "upgrade", binding: f.h.candidate }, f.h.deps), /drifted/);
  await assert.rejects(rollbackManagedService({ binding: f.h.old }, f.h.deps), /drifted/);
  const s = await status(f.h);
  assert.doesNotMatch(s.report.recovery, /upgrade --source/);
  assert.match(s.report.recovery, /rollback --recover --backup/);
  const fromHint = String(s.report.recovery).match(/service (rollback --recover --backup <backup-id> --source <candidate-clean-checkout>)/)?.[1];
  assert.ok(fromHint, "the executable CLI form comes from the status hint");
  const args = fromHint.split(" ").map(x => {
    if (x === "<backup-id>") return f.pending.backupId!;
    if (x === "<candidate-clean-checkout>") return f.checkout;
    return x;
  });
  const log = console.log;
  const lines: string[] = [];
  console.log = value => { lines.push(String(value)); };
  try { assert.equal(await runService(args, f.dependencies), 0); } finally { console.log = log; }
  assert.equal(JSON.parse(lines[0]).ok, true);
  assert.deepEqual(readServiceReceipt(f.h.paths), before);
  assert.equal(f.h.adapter.snapshot?.definition.toString(), "MANAGED_OLD_XML");
  assert.equal(readServiceCandidate(f.h.paths), null);
  f.h.adapter.candidatePid = 43;
  await activateManagedService({ mode: "upgrade", binding: f.h.candidate }, f.h.deps);
  assert.equal(readServiceReceipt(f.h.paths)?.binding.source.commit, f.h.candidate.source.commit, "normal upgrade is reachable after recovery");
});

const hostile = ["wrong-checkout", "unverified-pin", "wrong-backup", "security", "action", "extra-action", "unknown-task",
  "unowned-process", "active-drain", "unknown-drain", "existing-candidate", "invalid-candidate", "source-escape", "principal", "backup-metadata"] as const;
for (const scenario of hostile) {
  test(`legacy recovery rejects ${scenario} without a stop or mutation`, async t => {
    const f = await orphan(t);
    switch (scenario) {
      case "wrong-checkout": f.argv[f.argv.length - 1] = f.h.old.source.root; break;
      case "unverified-pin": {
        const capture = f.dependencies.lifecycle.captureSource;
        f.dependencies.lifecycle.captureSource = root => ({ ...capture(root), verified: false }); break;
      }
      case "wrong-backup": f.argv[3] = "20261014110000-00000000-0000-4000-8000-000000000000"; break;
      case "security": f.h.adapter.snapshot!.security = Buffer.from("FOREIGN_SDDL"); break;
      case "action": f.h.adapter.snapshot!.windows!.actions[0].arguments += " extra"; break;
      case "extra-action": f.h.adapter.snapshot!.windows!.actions.push(f.h.adapter.snapshot!.windows!.actions[0]); break;
      case "unknown-task": f.h.adapter.snapshot!.running = "unknown"; break;
      case "unowned-process": f.h.adapter.owned = false; break;
      case "active-drain": f.h.deps.ownerProbe.active = () => true; break;
      case "unknown-drain": f.h.deps.ownerProbe.active = () => "unknown"; break;
      case "existing-candidate": writeServiceCandidate(f.h.paths, f.pending); break;
      case "invalid-candidate": fs.writeFileSync(candidateFile(f.h), "{"); break;
      case "source-escape": {
        const binding = { ...f.pending.binding, source: { ...f.pending.binding.source, root: f.checkout } };
        f.h.adapter.snapshot!.windows!.actions = [windowsManagedAction(binding)]; break;
      }
      case "principal": f.h.adapter.validateManaged = async () => { throw new Error("foreign principal"); }; break;
      case "backup-metadata": {
        const file = path.join(serviceRoot(f.h.paths), "backups", f.pending.backupId!, "backup.json");
        const backup = JSON.parse(fs.readFileSync(file, "utf8"));
        fs.writeFileSync(file, JSON.stringify({ ...backup, id: "not-the-selected-backup", wasRunning: "true" })); break;
      }
    }
    const before = JSON.stringify({ receipt: readServiceReceipt(f.h.paths), native: f.h.adapter.snapshot,
      candidate: fs.existsSync(candidateFile(f.h)) ? fs.readFileSync(candidateFile(f.h), "utf8") : null });
    const effects = f.h.adapter.events.filter(x => x === "stop" || x.startsWith("write:")).length;
    await assert.rejects(runService(f.argv, f.dependencies));
    assert.equal(f.h.adapter.events.filter(x => x === "stop" || x.startsWith("write:")).length, effects);
    assert.equal(JSON.stringify({ receipt: readServiceReceipt(f.h.paths), native: f.h.adapter.snapshot,
      candidate: fs.existsSync(candidateFile(f.h)) ? fs.readFileSync(candidateFile(f.h), "utf8") : null }), before);
  });
}

test("legacy recovery refuses a linked checkout before source capture or native mutation", async t => {
  const f = await orphan(t), link = path.join(path.dirname(f.checkout), "linked-checkout");
  try { fs.symlinkSync(f.checkout, link, "junction"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("synthetic directory link creation unavailable"); return;
    }
    throw error;
  }
  f.argv[f.argv.length - 1] = link;
  const stops = f.h.adapter.stopCalls.length;
  await assert.rejects(runService(f.argv, f.dependencies), /linked/);
  assert.equal(f.h.adapter.stopCalls.length, stops);
  assert.equal(readServiceCandidate(f.h.paths), null);
});
