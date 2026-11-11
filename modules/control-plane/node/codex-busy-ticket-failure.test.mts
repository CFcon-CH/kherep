import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claimBusyHint, publishBusyHint, type BusyHintAdmission } from "./codex-busy-ticket.mts";

const OWNER = "01a0db74-0000-7000-8000-000000000001";
const POLICY = "a".repeat(64), NOW = 1_800_000_000_000;

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-busy-failure-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const admission: BusyHintAdmission = { owner: OWNER, generation: crypto.randomUUID(), admittedAt: NOW,
    expiresAt: NOW + 60_000, policyFingerprint: POLICY,
    messages: [{ messageId: crypto.randomUUID(), toSession: OWNER }] };
  assert.equal(publishBusyHint(directory, admission, NOW), "published");
  return { directory, admission, file: path.join(directory, `${OWNER}.busy-hint.json`) };
}

test("atomic rename failure returns no hint and preserves the previous ticket", (t) => {
  const { directory, admission, file } = fixture(t);
  const before = fs.readFileSync(file, "utf8");
  t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("synthetic disk error"), { code: "EACCES" }); });
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, () => 1), { status: "failed" });
  assert.equal(publishBusyHint(directory, { ...admission, generation: crypto.randomUUID(), admittedAt: NOW + 1 }, NOW + 2), "failed");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(fs.readdirSync(directory), [path.basename(file)], "failed writes must remove only their own temporary file");
});

test("pre-existing temporary data is preserved and cannot authorize a claim", (t) => {
  const { directory, file } = fixture(t);
  const before = fs.readFileSync(file, "utf8"), temporary = file + ".tmp";
  fs.writeFileSync(temporary, "synthetic interrupted write");
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, () => 1), { status: "failed" });
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(fs.readFileSync(temporary, "utf8"), "synthetic interrupted write");
});

test("failure to release the owned lock is fail-closed after claim persistence and leaves a recoverable lock", (t) => {
  const { directory, file } = fixture(t);
  const mock = t.mock.method(fs, "unlinkSync", () => { throw Object.assign(new Error("synthetic lock error"), { code: "EACCES" }); });
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, () => 1), { status: "failed" });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).claimed, true);
  assert.equal(fs.existsSync(file + ".lock"), true);
  mock.mock.restore();
  // Issue #877: the lock records this process, so the next call recovers it.
  assert.deepEqual(claimBusyHint(directory, OWNER, POLICY, NOW, () => assert.fail("claimed generation")), { status: "empty" });
  assert.equal(fs.existsSync(file + ".lock"), false);
});
