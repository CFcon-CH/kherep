import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { blockerDiagnostic } from "../protocol-diagnostics.mts";
import type { NodeClient } from "./client.mts";
import { listenerDir } from "./autonomy.mts";
import { codexNode } from "./codex-fixture.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { progressRecords } from "./delivery-progress.mts";
import { pollExchange } from "./exchange.mts";
import { getMessage, getMessageDiagnostic, getMessageProgress, storeMessage } from "./inbox.mts";
import { T0 } from "./task-fixture.mts";

const OWNER = "01a0db01-0000-7000-8000-000000000001";
for (const failure of ["capture", "busy", "storage", "invalid"] as const) test(`identical ${failure} hint failures retain progress and exchange report identity`, async t => {
  const node = codexNode(t, {}, { findCodex: () => null });
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8"));
  policy.wake = { enabled: true, sessions: [OWNER] };
  fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
  recordCodexSession(node.paths, OWNER, node.workspace, T0, "default");
  const ids = Array.from({ length: 10 }, () => crypto.randomUUID());
  for (const messageId of ids) storeMessage(node.paths.inbox, { messageId, from: { nodeId: crypto.randomUUID(), session: "peer" },
    toSession: OWNER, text: "synthetic", createdAt: new Date(T0).toISOString() }, T0);
  const dir = listenerDir(node.paths);
  fs.mkdirSync(dir, { recursive: true });
  let failCapture = false;
  const randomUUID = crypto.randomUUID.bind(crypto);
  if (failure === "capture") t.mock.method(crypto, "randomUUID", () => {
    if (failCapture) { failCapture = false; throw new Error("synthetic capture failure"); }
    return randomUUID();
  });
  if (failure === "busy") fs.writeFileSync(path.join(dir, `${OWNER}.busy-hint.json.lock`), "held");
  if (failure === "storage") fs.mkdirSync(path.join(dir, `${OWNER}.busy-hint.json`));
  const inflight = new Map<string, number>();
  let reports = 0;
  const client = { reportStatus: () => ["report"] } as unknown as NodeClient;
  for (let pass = 0; pass < 2; pass++) {
    failCapture = failure === "capture";
    pollCodexQueue(node.deps());
    if (failure === "invalid") recordCodexSession(node.paths, OWNER, node.workspace, T0, "bypassPermissions");
    await codexQueueIdle();
    if (failure === "invalid") recordCodexSession(node.paths, OWNER, node.workspace, T0, "default");
    pollExchange(client, node.paths, inflight, () => { reports++; return true; }, T0 + pass, () => 0);
    if (pass === 0) node.tick(1);
  }
  assert.equal(reports, 10, "an identical failure does not bypass report backoff with a fresh key");
  const details = ids.map(id => getMessageDiagnostic(node.paths.inbox, id));
  const code = { capture: "hint-capture-failed", busy: "hint-lock-busy", storage: "hint-storage-failed", invalid: "hint-invalidated" }[failure];
  assert.equal(details.filter(d => d?.kind === "blocker" && d.code === code).length, 8);
  for (const id of ids) assert.equal(getMessageProgress(node.paths.inbox, id)?.observedAt, new Date(T0).toISOString());
});

test("progress persistence remains mandatory without a diagnostic and observational with one", t => {
  const node = codexNode(t), messageId = crypto.randomUUID();
  storeMessage(node.paths.inbox, { messageId, from: { nodeId: crypto.randomUUID(), session: "peer" }, toSession: OWNER,
    text: "synthetic", createdAt: new Date(T0).toISOString() }, T0);
  const records = [getMessage(node.paths.inbox, messageId)!];
  fs.writeFileSync(path.join(node.paths.inbox, "progress"), "blocked");
  assert.throws(() => progressRecords(node.paths, records, "waiting", "retry-pending", T0));
  assert.doesNotThrow(() => progressRecords(node.paths, records, "waiting", "retry-pending", T0, undefined, blockerDiagnostic("runtime-pending", T0)));
});
