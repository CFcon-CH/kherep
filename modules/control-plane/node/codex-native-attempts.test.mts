import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { nativeQueueGroups, outstandingNativeAttempts, retireNativeQueue } from "./codex-native-attempts.mts";
import { nativeReconcileFixture, OWNER } from "./codex-native-reconcile-fixture.mts";

test("native batch reconciliation accepts reordered IDs and retains mismatched attempts", t => {
  const f = nativeReconcileFixture(t, 3);
  for (const messageId of f.ids) {
    const file = f.attempt(messageId);
    const attempt = JSON.parse(fs.readFileSync(file, "utf8"));
    attempt.groupMessageIds.reverse();
    fs.writeFileSync(file, JSON.stringify(attempt));
  }
  const groups = nativeQueueGroups(f.paths, OWNER);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.admissionMessageIds, [...f.ids].sort());
  assert.deepEqual(outstandingNativeAttempts(f.paths, OWNER).sort(), [...f.ids].sort());
  retireNativeQueue(f.paths, groups[0]!);
  assert.deepEqual(nativeQueueGroups(f.paths, OWNER), []);
  assert.deepEqual(outstandingNativeAttempts(f.paths, OWNER), []);
  const file = f.attempt(f.ids[0]!);
  const attempt = JSON.parse(fs.readFileSync(file, "utf8"));
  attempt.groupMessageIds = [f.ids[0]];
  fs.writeFileSync(file, JSON.stringify(attempt));
  assert.deepEqual(outstandingNativeAttempts(f.paths, OWNER), [f.ids[0]]);
});
