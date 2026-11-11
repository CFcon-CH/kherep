import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { publishBusyHint, type BusyHintAdmission } from "./codex-busy-ticket.mts";

const OWNER = "01a0db74-0000-7000-8000-000000000001";
const POLICY = "a".repeat(64), NOW = 1_800_000_000_000;
type Reply = { result: string | { status: string; count?: number };
  observed?: { generation: string; messages: BusyHintAdmission["messages"] } };

function runner(t: test.TestContext, directory: string, time: number, action: string, admission?: BusyHintAdmission, delay = 0) {
  const child = spawn(process.execPath,
    [fileURLToPath(new URL("./codex-busy-ticket-race-fixture.mts", import.meta.url)),
      directory, OWNER, POLICY, String(time), action, admission ? JSON.stringify(admission) : "", String(delay)],
    { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let reply: Reply | undefined;
  let readySeen = false;
  const ready = new Promise<void>((resolve, reject) => {
    child.on("message", (message: any) => {
      if (message.type === "ready") { readySeen = true; resolve(); }
      if (message.type === "result") reply = message;
    });
    child.once("error", reject);
    child.once("exit", () => { if (!readySeen) reject(new Error("synthetic child exited before readiness")); });
  });
  const done = new Promise<Reply>((resolve, reject) => {
    const deadline = setTimeout(() => child.kill(), 10_000);
    child.once("error", (error) => { clearTimeout(deadline); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(deadline);
      if (code === 0 && reply) resolve(reply);
      else reject(new Error("synthetic child did not complete its storage operation"));
    });
  });
  // Attach handlers while the separate readiness barrier is pending.
  void done.catch(() => {});
  return { child, ready, done };
}

async function race(t: test.TestContext, directory: string, time: number, incoming?: BusyHintAdmission) {
  const children = [runner(t, directory, time, incoming ? "publish" : "claim", incoming, 150),
    runner(t, directory, time, "claim", undefined, 300)];
  await Promise.all(children.map((child) => child.ready));
  children.forEach((child) => child.child.send("go"));
  return Promise.all(children.map((child) => child.done));
}

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-busy-race-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const admission: BusyHintAdmission = { owner: OWNER, generation: crypto.randomUUID(), admittedAt: NOW,
    expiresAt: NOW + 60_000, policyFingerprint: POLICY,
    messages: [{ messageId: crypto.randomUUID(), toSession: OWNER }] };
  return { directory, admission, file: path.join(directory, `${OWNER}.busy-hint.json`) };
}

test("two independent processes can claim each generation only once", async (t) => {
  const { directory, admission, file } = fixture(t);
  for (let round = 0; round < 8; round++) {
    admission.generation = crypto.randomUUID();
    admission.admittedAt = NOW + round;
    assert.equal(publishBusyHint(directory, admission, NOW + round), "published");
    const results = await race(t, directory, NOW + round);
    assert.equal(results.filter((reply) => typeof reply.result === "object" && reply.result.status === "hint").length, 1);
    assert.equal(results.filter((reply) => reply.observed).length, 1, "the losing process must not read targeted records");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).claimed, true);
    assert.deepEqual(fs.readdirSync(directory), [path.basename(file)], "completed generations retain a fixed file count");
  }
});

test("two processes racing for one orphaned lock yield exactly one owner (issue #877)", async (t) => {
  const { directory, admission, file } = fixture(t);
  for (let round = 0; round < 8; round++) {
    admission.generation = crypto.randomUUID();
    admission.admittedAt = NOW + round;
    assert.equal(publishBusyHint(directory, admission, NOW + round), "published");
    const lock = file + ".lock", then = new Date(Date.now() - 120_000);
    fs.writeFileSync(lock, "");
    fs.utimesSync(lock, then, then);
    const results = await race(t, directory, NOW + round);
    assert.equal(results.filter((reply) => typeof reply.result === "object" && reply.result.status === "hint").length, 1);
    assert.equal(results.filter((reply) => reply.observed).length, 1, "exactly one process owns the recovered lock");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).claimed, true);
    assert.deepEqual(fs.readdirSync(directory), [path.basename(file)], "no lock, gate or tombstone stays");
  }
});

test("publication racing a claim preserves a complete generation and its claim state", async (t) => {
  const { directory, admission, file } = fixture(t);
  for (let round = 0; round < 8; round++) {
    const previous = { ...admission, generation: crypto.randomUUID(), admittedAt: NOW + round * 2 };
    const next = { ...previous, generation: crypto.randomUUID(), admittedAt: previous.admittedAt + 1,
      messages: [{ messageId: crypto.randomUUID(), toSession: "codex-00000001" }] };
    assert.equal(publishBusyHint(directory, previous, previous.admittedAt), "published");
    const [publication, claim] = await race(t, directory, next.admittedAt, next);
    assert.ok(publication.result === "published" || publication.result === "busy");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    const expected = publication.result === "published" ? next : previous;
    assert.equal(stored.generation, expected.generation);
    assert.deepEqual(stored.messages, expected.messages);
    if (claim.observed) {
      const observed = claim.observed.generation === next.generation ? next : previous;
      assert.equal(claim.observed.generation, observed.generation);
      assert.deepEqual(claim.observed.messages, observed.messages);
      if (stored.claimed) assert.equal(stored.generation, claim.observed.generation);
      else assert.ok(stored.generation === next.generation && claim.observed.generation === previous.generation);
    } else assert.equal(stored.claimed, false);
    assert.deepEqual(fs.readdirSync(directory), [path.basename(file)]);
  }
});
