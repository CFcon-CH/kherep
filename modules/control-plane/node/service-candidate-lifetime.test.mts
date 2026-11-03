import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { activateManagedService } from "./service-transaction.mts";
import { candidateFile, caught, failedUpgrade, receiptFile, secondCall, staleDrain } from "./service-candidate-fixture.mts";

for (const owner of [true, "unknown"] as const) {
  test(`blocked ${owner === true ? "active" : "unknown"} drain preserves original candidate bytes`, async t => {
    const { h } = await failedUpgrade(t);
    const before = fs.readFileSync(candidateFile(h));
    const receipt = fs.readFileSync(receiptFile(h));
    const writes = h.adapter.events.filter(x => x.startsWith("write:")).length;
    h.setControllerState(owner);
    h.adapter.candidateDefinition = "RAW_NEW2_XML";
    await assert.rejects(activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps), /drain/);
    assert.deepEqual(fs.readFileSync(candidateFile(h)), before);
    assert.deepEqual(fs.readFileSync(receiptFile(h)), receipt);
    assert.equal(h.adapter.events.filter(x => x.startsWith("write:")).length, writes);
  });
}

test("preflight rejection preserves the loaded candidate record exactly", async t => {
  const { h } = await failedUpgrade(t);
  const before = fs.readFileSync(candidateFile(h));
  staleDrain(h);
  h.adapter.descendants = 1;
  await assert.rejects(activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps), /DESCENDANTS/);
  assert.deepEqual(fs.readFileSync(candidateFile(h)), before);
});

test("an unproven stop before write-ahead preserves the original pending record", async t => {
  const { h } = await failedUpgrade(t);
  const before = fs.readFileSync(candidateFile(h));
  staleDrain(h);
  h.adapter.stopFailureAfterEffect = Object.assign(new Error("synthetic unproven stop"), { code: "STOP_UNLISTED_ALIVE" });
  const failure = await caught(activateManagedService({ mode: "upgrade", binding: h.candidate }, h.deps));
  assert.equal(failure.stage, "stop");
  assert.deepEqual(fs.readFileSync(candidateFile(h)), before);
});

test("recovery to a prior unreceipted candidate restores its original record bytes", async t => {
  const { h } = await failedUpgrade(t);
  const before = fs.readFileSync(candidateFile(h));
  const deps = secondCall(h);
  h.adapter.candidateDefinition = "RAW_NEW2_XML";
  const write = h.adapter.write.bind(h.adapter);
  h.adapter.write = async (binding, definition, security) => {
    if (definition.toString() === "RAW_NEW2_XML") throw new Error("synthetic pre-mutation write failure");
    await write(binding, definition, security);
  };
  const failure = await caught(activateManagedService({ mode: "upgrade", binding: h.candidate }, deps));
  assert.equal(failure.code, "SERVICE_ACTIVATION_FAILED");
  assert.equal(failure.recovery, "restored");
  assert.equal(h.adapter.snapshot?.definition.toString(), "RAW_NEW_XML");
  assert.deepEqual(fs.readFileSync(candidateFile(h)), before);
});
