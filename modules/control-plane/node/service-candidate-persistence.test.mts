import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { activateManagedService } from "./service-transaction.mts";
import { readServiceCandidate, readServiceReceipt, writeServiceCandidate } from "./service-records.mts";
import { candidateFile, caught, failedUpgrade, staleDrain } from "./service-candidate-fixture.mts";
import { seedManaged, setup } from "./service-transaction-fixture.mts";

test("prepared persistence failure prevents native definition write and candidate start", async t => {
  const h = setup(t);
  seedManaged(h);
  const receipt = readServiceReceipt(h.paths);
  const failure = await caught(activateManagedService({ mode: "upgrade", binding: h.candidate },
    { ...h.deps, writeCandidate: () => { throw new Error("synthetic record persistence failure"); } }));
  assert.equal(failure.blocker, "RECOVERY_RECORD_PERSISTENCE_FAILED");
  assert.deepEqual(readServiceReceipt(h.paths), receipt);
  assert.equal(h.adapter.snapshot?.definition.toString(), "MANAGED_OLD_XML");
  assert.deepEqual(h.adapter.events.filter(x => x.startsWith("write:") || x.startsWith("start:")), []);
});

test("prepared persistence failure keeps the byte-exact original pending record", async t => {
  const { h } = await failedUpgrade(t);
  staleDrain(h);
  const before = fs.readFileSync(candidateFile(h));
  await assert.rejects(activateManagedService({ mode: "upgrade", binding: h.candidate },
    { ...h.deps, writeCandidate: () => { throw new Error("synthetic persistence failure"); } }));
  assert.deepEqual(fs.readFileSync(candidateFile(h)), before);
});

test("failure immediately after native write retains a prepared candidate before any start", async t => {
  const h = setup(t);
  seedManaged(h);
  const read = h.adapter.read.bind(h.adapter);
  let fail = true;
  h.adapter.read = async () => {
    if (fail && h.adapter.events.includes("write:RAW_NEW_XML")) { fail = false; throw new Error("synthetic interrupted verify"); }
    return read();
  };
  const failure = await caught(activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps));
  assert.equal(failure.stage, "verify");
  assert.equal(failure.recovery, "unknown");
  assert.equal(readServiceCandidate(h.paths)?.phase, "prepared");
  assert.equal(h.adapter.events.some(x => x.startsWith("start:")), false);
});

test("failed attested update and failed metadata update preserve the prepared record", async t => {
  const h = setup(t);
  seedManaged(h);
  const write = h.adapter.write.bind(h.adapter);
  h.adapter.write = async (binding, definition, security) => {
    await write(binding, definition, security);
    if (definition.toString() === "RAW_NEW_XML") h.adapter.snapshot!.running = true;
  };
  const preflight = h.adapter.preflightStop.bind(h.adapter);
  h.adapter.preflightStop = async (binding, expected) => {
    if (h.adapter.events.includes("write:RAW_NEW_XML")) throw new Error("synthetic uncertain stop");
    await preflight(binding, expected);
  };
  let prepared: Buffer | undefined;
  const failure = await caught(activateManagedService({ mode: "upgrade", binding: h.candidate }, { ...h.deps,
    writeCandidate: (paths, value) => {
      if (prepared) throw new Error("synthetic atomic update failure");
      writeServiceCandidate(paths, value);
      prepared = fs.readFileSync(candidateFile(h));
    } }));
  assert.equal(failure.blocker, "RECOVERY_RECORD_PERSISTENCE_FAILED");
  assert.deepEqual(fs.readFileSync(candidateFile(h)), prepared);
  assert.equal(readServiceCandidate(h.paths)?.phase, "prepared");
  assert.equal(h.adapter.events.some(x => x.startsWith("start:")), false);
});

for (const afterRename of [false, true]) {
  test(`receipt persistence failure ${afterRename ? "after" : "before"} replacement restores bound prior state`, async t => {
    const h = setup(t);
    seedManaged(h);
    const receipt = readServiceReceipt(h.paths), rename = fs.renameSync;
    let armed = true;
    t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (armed && String(to).endsWith("receipt.json")) {
        armed = false;
        if (afterRename) rename(from, to);
        throw Object.assign(new Error("synthetic receipt persistence failure"), { code: "EIO" });
      }
      return rename(from, to);
    });
    const failure = await caught(activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps));
    assert.equal(failure.stage, "receipt");
    assert.equal(failure.recovery, "restored");
    assert.deepEqual(readServiceReceipt(h.paths), receipt);
    assert.equal(h.adapter.snapshot?.definition.toString(), "MANAGED_OLD_XML");
    assert.equal(readServiceCandidate(h.paths), null);
  });
}

test("uncertain health retains exact ABSENCE_UNPROVEN evidence separately from a loaded-candidate refusal", async t => {
  const h = setup(t);
  seedManaged(h);
  h.adapter.failCandidateHealth = true;
  let proofs = 0;
  h.adapter.proveStopped = async () => {
    if (++proofs > 1) throw Object.assign(new Error("synthetic family unknown"), { code: "STOP_UNKNOWN_DESCENDANTS", familyUnproven: true });
  };
  const stop = h.adapter.stop.bind(h.adapter);
  h.adapter.stop = async (binding, expected) => {
    if (binding.source.commit === h.candidate.source.commit) {
      throw Object.assign(new Error("synthetic family unknown"), { code: "STOP_UNKNOWN_DESCENDANTS", familyUnproven: true });
    }
    await stop(binding, expected);
  };
  const failure = await caught(activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps));
  assert.equal(failure.blocker, "RECOVERY_ABSENCE_UNPROVEN");
  assert.equal(readServiceCandidate(h.paths)?.phase, "attested");
  assert.equal(readServiceCandidate(h.paths)?.blocker, "RECOVERY_ABSENCE_UNPROVEN");
  assert.equal(h.adapter.events.includes("write:MANAGED_OLD_XML"), false);
});
