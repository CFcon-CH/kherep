import { syntheticQueueContext } from "./target-delivery-test-support.mts";
import type { RunnerDeps } from "./session-runner.mts";
import type { QueueProducerIdentity } from "./codex-queue-binding.mts";
import type { ServiceAdmission } from "./service-drain.mts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { codexCommand } from "./codex-binary.mts";
import { codexNode, fakeCodexBin } from "./codex-fixture.mts";
import { queueProducerIdentity } from "./codex-queue-context.mts";
import { MAX_QUEUE_STDOUT_BYTES, parseQueueAdmission, queueArgs, runQueue as actualRunQueue } from "./codex-queue-run.mts";
import { beginServiceDrain, serviceAdmissionsIdle } from "./service-drain.mts";
import { testServiceOwner } from "./task-fixture.mts";

const OWNER = "01a0db01-0000-7000-8000-000000000001";
const QUEUE = "00000001-0000-4000-8000-000000000001";

test("a service drain rejects a queue subprocess before spawn", async (t) => {
  const fake = fakeCodexBin(t);
  const node = codexNode(t);
  const endDrain = beginServiceDrain(node.paths);
  t.after(endDrain);
  await assert.rejects(runQueue({ ...node.deps(), codex: { findCodex: () => fake.file, home: node.root } }, queueArgs(OWNER, 1)),
    /draining new session admissions/);
  assert.equal(fake.runs().length, 0);
});

test("changed executable bytes reject the captured producer before starting a child", async (t) => {
  const fake = fakeCodexBin(t);
  const node = codexNode(t);
  const deps = { ...node.deps(), codex: { findCodex: () => fake.file, home: node.root } };
  const args = queueArgs(OWNER, 1);
  const expected = queueProducerIdentity(fake.file, args, deps);
  const command = codexCommand(fake.file, args, process.platform);
  const script = process.platform === "win32" ? command.args[0]! : fake.file;
  fs.appendFileSync(script, "\n// public synthetic binary drift\n");
  await assert.rejects(runQueue(deps, args, expected), /producer changed/);
  assert.equal(fake.runs().length, 0);
});

test("queue child uses its captured producer home instead of the parent's home", async (t) => {
  const fake = fakeCodexBin(t);
  const node = codexNode(t);
  const home = path.join(node.root, "approved-synthetic-home");
  fs.mkdirSync(home);
  const args = queueArgs(OWNER, 1);
  const command = codexCommand(fake.file, args, process.platform);
  const script = process.platform === "win32" ? command.args[0]! : fake.file;
  const original = fs.readFileSync(script, "utf8");
  const guard = `if (process.env.CODEX_HOME !== ${JSON.stringify(home)}) { process.stderr.write("wrong owner home\\n"); process.exit(1); }\n`;
  fs.writeFileSync(script, original.replace(/^(#![^\n]*\n)?/, (line) => line + guard));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(node.root, "different-parent-home");
  try {
    const result = await runQueue({ ...node.deps(), codex: { findCodex: () => fake.file, home } }, args);
    assert.equal(result.owner, OWNER);
    assert.equal(result.producer.resolvedCodexHome, home);
    assert.ok(result.queueId);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("queue admission remains leased until the helper has exited and closed", async (t) => {
  const fake = fakeCodexBin(t);
  const node = codexNode(t);
  const child = Object.assign(new EventEmitter(), {
    pid: 4242, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, killed: false,
    kill() { this.killed = true; return true; },
  });
  const pending = runQueue({ ...node.deps(), codex: {
    findCodex: () => fake.file, home: node.root,
    spawn: (() => child) as never,
  } }, queueArgs(OWNER, 1));
  const endDrain = beginServiceDrain(node.paths);
  t.after(endDrain);
  child.stdout.write(`Queued message ${QUEUE} for thread ${OWNER}.\n`);
  child.exitCode = 0;
  child.emit("exit", 0, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(serviceAdmissionsIdle(node.paths, testServiceOwner), false, "exit alone cannot release the helper lease");
  child.emit("close", 0, null);
  assert.equal((await pending).queueId, QUEUE);
  assert.equal(serviceAdmissionsIdle(node.paths, testServiceOwner), true);
});

test("unconfirmed queue helper shutdown retains a fail-closed admission lease", async (t) => {
  const fake = fakeCodexBin(t);
  const node = codexNode(t);
  const child = Object.assign(new EventEmitter(), {
    pid: 4243, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null, signalCode: null, killed: false,
    kill() { this.killed = true; return true; },
  });
  await assert.rejects(runQueue({ ...node.deps(), codex: {
    findCodex: () => fake.file, home: node.root, queueTimeoutMs: 5,
    spawn: (() => child) as never, signal: () => {},
  } }, queueArgs(OWNER, 1)), /did not finish/);
  assert.equal(serviceAdmissionsIdle(node.paths, testServiceOwner), false);
});

test("an exited helper is never signalled by reused PID while close remains unconfirmed", async (t) => {
  const fake = fakeCodexBin(t);
  const node = codexNode(t);
  const child = Object.assign(new EventEmitter(), {
    pid: 4244, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: 0, signalCode: null, killed: false, kill() { this.killed = true; return true; },
  });
  let signals = 0;
  const pending = runQueue({ ...node.deps(), codex: {
    findCodex: () => fake.file, home: node.root, queueTimeoutMs: 5,
    spawn: (() => child) as never, signal: () => { signals += 1; },
  } }, queueArgs(OWNER, 1));
  child.emit("exit", 0, null);
  await assert.rejects(pending, /did not finish/);
  assert.equal(signals, 0, "the exited PID may already belong to another process");
  assert.equal(serviceAdmissionsIdle(node.paths, testServiceOwner), false);
  child.emit("close", 0, null);
  assert.equal(serviceAdmissionsIdle(node.paths, testServiceOwner), false, "a late close cannot clear the retained fail-closed lease");
});

test("synchronous confirmed shutdown during timeout rejects once without a late retained lease", async (t) => {
  const fake = fakeCodexBin(t);
  const node = codexNode(t);
  const child = Object.assign(new EventEmitter(), {
    pid: 4245, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null as number | null, signalCode: null, killed: false, kill() { this.killed = true; return true; },
  });
  await assert.rejects(runQueue({ ...node.deps(), codex: {
    findCodex: () => fake.file, home: node.root, queueTimeoutMs: 5,
    spawn: (() => child) as never,
    signal: () => {
      child.exitCode = 1;
      child.emit("exit", 1, null);
      child.emit("close", 1, null);
    },
  } }, queueArgs(OWNER, 1)), /did not finish/);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(serviceAdmissionsIdle(node.paths, testServiceOwner), true);
});

test("queue admission requires one exact owner and bounded complete stdout", () => {
  const line = `Queued message ${QUEUE} for thread ${OWNER}.`;
  assert.equal(parseQueueAdmission(line, OWNER), QUEUE);
  assert.equal(parseQueueAdmission(line + "\n" + line, OWNER), null);
  assert.equal(parseQueueAdmission(line, QUEUE), null);
  assert.equal(parseQueueAdmission(line, OWNER, true), null);
  assert.equal(parseQueueAdmission("x".repeat(MAX_QUEUE_STDOUT_BYTES) + line, OWNER), null);
});

function runQueue(deps:RunnerDeps,args:string[],expected?:QueueProducerIdentity,admission?:ServiceAdmission){
  if(!/^[0-9a-f-]{36}$/i.test(args[2]??""))return actualRunQueue(deps,args,expected,admission);
  const fixture=syntheticQueueContext(deps,args);return actualRunQueue(fixture.deps,args,expected,admission,fixture.context);
}
