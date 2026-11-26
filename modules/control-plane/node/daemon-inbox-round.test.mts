import { watchInboxReads } from "./inbox-read-fixture.mts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, PONG_FRAME } from "../protocol.mts";
import { AUTH_OK, flush, intakeHarness, NODE, PEER as PEER_NODE, statuses } from "./daemon-intake-fixture.mts";
import { ROUND_STEPS } from "./round-timing.mts";
import { EXCHANGE_INTERVAL_MS } from "./exchange.mts";
import { markDelivered, setDeliveryTask, type InboxRecord } from "./inbox.mts";

// Issue #487: the production daemon's exchange round, against a large settled
// inbox. A round after the first reads no record or receipt; a record a hook
// changes is re-read and reported; a round that sends many frames says so.

const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "synthetic-peer" };
const idOf = (n: number): string => `00000000-0000-4000-8000-${String(n + 500).padStart(12, "0")}`;

function populate(inbox: string, count: number, receipts: (n: number) => InboxRecord["state"] | null,
  state: (n: number) => InboxRecord["state"] = () => "delivered"): void {
  fs.mkdirSync(path.join(inbox, "receipts"), { recursive: true });
  const at = new Date().toISOString();
  for (let n = 0; n < count; n++) {
    const record: InboxRecord = { messageId: idOf(n), from: PEER, toSession: "synthetic-closed-session", text: "synthetic peer content",
      createdAt: at, receivedAt: at, state: state(n), depth: 0 };
    fs.writeFileSync(path.join(inbox, `${record.messageId}.json`), JSON.stringify(record));
    const reported = receipts(n);
    if (reported) fs.writeFileSync(path.join(inbox, "receipts", `${record.messageId}.json`),
      JSON.stringify({ reportedAt: at, reportedState: reported, workerState: reported }));
  }
}

function countInboxReads(t: test.TestContext, inbox: string): () => number {
  return watchInboxReads(t, inbox).reads;
}

async function connectedRound(t: test.TestContext, options: Parameters<typeof intakeHarness>[1] = {}) {
  const h = intakeHarness(t, options);
  await flush();
  h.socket().message(AUTH_OK);
  await flush();
  const round = async (): Promise<void> => {
    h.timers.get(EXCHANGE_INTERVAL_MS)!.at(-1)!();
    await flush();
    await flush();
  };
  return { ...h, round };
}

test("a round after the first reads no record of a 3000-record settled inbox and picks up a hook's change", async (t) => {
  const h = await connectedRound(t);
  const waiting = 2999;
  populate(h.paths.inbox, 3000, (n) => n === waiting ? "accepted" : "delivered", (n) => n === waiting ? "accepted" : "delivered");
  await h.round();
  assert.equal(h.socket().sent.filter((f) => f.type === "message.status").length, 0, "a settled inbox reports nothing");
  const reads = countInboxReads(t, h.paths.inbox);
  await h.round();
  assert.ok(reads() <= 10, `the second round read ${reads()} inbox files`);
  markDelivered(h.paths.inbox, idOf(waiting)); // the delivery hook, outside the daemon
  const before = reads();
  await h.round();
  assert.equal(statuses(h.socket(), idOf(waiting), "delivered").length, 1, "the hook's change is reported");
  assert.ok(reads() - before <= 10, `the round after a hook write read ${reads() - before} inbox files`);
});

// Issue #1012: with own task control the delivery registrations use the
// round's index snapshot; before, every round listed and read each record.
test("1012: with own task control a round after the first reads no record of a 3000-record inbox and still registers a delivery", async (t) => {
  const h = await connectedRound(t);
  const policy = JSON.parse(fs.readFileSync(h.paths.policy, "utf8"));
  fs.writeFileSync(h.paths.policy, JSON.stringify({ ...policy, sessions: { ...policy.sessions, ownTaskControl: true } }));
  populate(h.paths.inbox, 3000, () => "delivered");
  const task = "3f2a1b0c-0000-4000-8000-000000000001";
  setDeliveryTask(h.paths.inbox, idOf(0), { taskId: task, runtime: "claude" });
  await h.round();
  const registration = JSON.parse(fs.readFileSync(path.join(h.paths.taskControl, "registrations", `${idOf(0)}.json`), "utf8"));
  assert.equal(registration.body.taskId, task, "the delivery record is registered");
  assert.equal(registration.body.sourceMessageId, idOf(0));
  assert.deepEqual(fs.readdirSync(path.join(h.paths.taskControl, "registrations")), [`${idOf(0)}.json`], "records without delivery register nothing");
  const reads = countInboxReads(t, h.paths.inbox);
  await h.round();
  t.diagnostic(`second round inbox reads: ${reads()}`);
  assert.ok(reads() <= 10, `the second round read ${reads()} inbox files`);
});

// Issue #1012: with the threshold at 0 every round writes its per-step line, metadata only.
const ROUND_LINE = /^kherep-node: round slow total_ms=\d+ sync_ms=\d+ cpu_ms=\d+ host_busy_pct=(\d+|unknown) skipped=\d+ steps=([a-z-]+:\d+(\+\d+)?\/\d+)(,[a-z-]+:\d+(\+\d+)?\/\d+)*$/;
test("1012: a slow round logs every step of the round in fixed order, metadata only", async (t) => {
  const h = await connectedRound(t, { daemonOptions: { roundSlowMs: 0 } });
  populate(h.paths.inbox, 5, () => "delivered");
  await h.round();
  const lines = h.logs.filter((entry) => entry.startsWith("kherep-node: round slow"));
  assert.equal(lines.length, 1, h.logs.join("\n"));
  t.diagnostic(lines[0]);
  assert.match(lines[0], ROUND_LINE);
  const names = lines[0].replace(/^.* steps=/, "").split(",").map((step) => step.replace(/:.*$/, ""));
  assert.deepEqual(names, [...ROUND_STEPS]);
  for (const forbidden of [h.paths.dir, path.basename(h.paths.dir), NODE, PEER_NODE, PEER.session, "synthetic-node", "synthetic-closed-session"]) {
    assert.equal(lines[0].includes(forbidden), false, forbidden);
  }
});

test("a round that sends more than 32 frames logs its counters, a quiet round does not", async (t) => {
  const h = await connectedRound(t);
  populate(h.paths.inbox, 40, () => null);
  await h.round();
  assert.equal(h.socket().sent.filter((f) => f.type === "message.status").length, 40);
  const counters = h.logs.filter((line) => line.includes("kherep-node: round sent"));
  assert.equal(counters.length, 1, h.logs.join("\n"));
  assert.equal(counters[0], "kherep-node: round sent 40 status/0 outbox frames, handled 1 inbound items: auth 1");
  await h.round();
  assert.equal(h.logs.filter((line) => line.includes("kherep-node: round sent")).length, 1, "nothing due, no counters line");
});

// Issue #493 D2: the frames of a reconnect burst, counted by closed kind.
const replayed = (n: number, state: string): string =>
  JSON.stringify(makeEnvelope("message.status", { messageId: idOf(n), state }, 0, 0));
const receipt = (n: number): string => JSON.stringify(makeEnvelope("event",
  { name: "message.receipt", messageId: idOf(n), requestedState: "accepted", storedState: "accepted" }, 0, 0));
const unknownType = JSON.stringify({ ...makeEnvelope("event", { name: "x" }, 0, 0), type: "synthetic.unknown" });
const counterLines = (logs: string[]): string[] => logs.filter((line) => line.includes("kherep-node: round sent"));
const line = (handled: number, summary: string): string =>
  `kherep-node: round sent 0 status/0 outbox frames, handled ${handled} inbound items: ${summary}`;

async function pongs(h: Awaited<ReturnType<typeof connectedRound>>, count: number): Promise<void> {
  for (let n = 0; n < count; n++) h.socket().message(PONG_FRAME);
  for (let i = 0; i < 5; i++) await flush();
  await h.round();
}

test("a burst of mixed frames logs one counters line with its kind histogram and an unchanged total", async (t) => {
  const h = await connectedRound(t);
  for (let n = 0; n < 300; n++) h.socket().message(replayed(n, "accepted"));
  for (let n = 300; n < 500; n++) h.socket().message(replayed(n, "delivered"));
  for (let n = 0; n < 40; n++) h.socket().message(receipt(n));
  for (let n = 0; n < 5; n++) h.socket().message(PONG_FRAME);
  for (let n = 0; n < 2; n++) h.socket().message(unknownType);
  for (let i = 0; i < 20; i++) await flush();
  await h.round();
  assert.deepEqual(counterLines(h.logs), [line(548, "frame:message.status:accepted 300, frame:message.status:delivered 200, "
    + "frame:event:receipt 40, pong 5, frame:invalid 2, auth 1")]);
});

// Design revision 2, section 4.4 items 11 and 12.
test("item 11: 32 handled items log nothing", async (t) => {
  const h = await connectedRound(t);
  await pongs(h, 31); // plus the initial auth.ok: 32
  assert.deepEqual(counterLines(h.logs), []);
  assert.deepEqual(h.logs.filter((entry) => entry.includes("round slow")), [], "a quiet round stays under the default threshold");
});

test("items 11 and 12: 33 log the line, and every following round starts from zero", async (t) => {
  const h = await connectedRound(t);
  await pongs(h, 32); // plus the initial auth.ok: 33
  assert.deepEqual(counterLines(h.logs), [line(33, "pong 32, auth 1")]);
  await pongs(h, 0);
  assert.equal(counterLines(h.logs).length, 1, "a round without inbound frames logs nothing");
  await pongs(h, 33);
  assert.deepEqual(counterLines(h.logs).slice(1), [line(33, "pong 33")]);
  await pongs(h, 10);
  assert.equal(counterLines(h.logs).length, 2, "10 log nothing");
  await pongs(h, 33);
  assert.deepEqual(counterLines(h.logs).slice(2), [line(33, "pong 33")], "the round of 10 was reset too");
});

// A round that throws discards its window's share, as base's round-local count did;
// the chain's count (auth 1) survives into the next round, as on base. Frames sent
// while pollCodexInbound lists tasks: only the first starts before the window
// drains, the rest are deferred to the chain, so one frame is the window's share.
test("a round whose Codex queue poll throws carries no window frame into the next round", async (t) => {
  const h = await connectedRound(t);
  fs.mkdirSync(h.paths.tasks, { recursive: true });
  const read = fs.readdirSync;
  let injected = false, thrown = false;
  // Issue #1012: the round timer's step frames push exchangeRound past the default stack depth of 10.
  const depth = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  t.after(() => { Error.stackTraceLimit = depth; });
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    const stack = path.resolve(String(args[0])) === path.resolve(h.paths.tasks) ? new Error().stack ?? "" : "";
    if (!injected && stack.includes("pollCodexInbound")) { injected = true; h.socket().message(receipt(0)); }
    if (!thrown && stack.includes("pollCodexQueue") && stack.includes("exchangeRound")) {
      thrown = true;
      throw Object.assign(new Error("synthetic EIO"), { code: "EIO" });
    }
    return read(...args);
  });
  await h.round();
  assert.ok(injected && thrown);
  assert.ok(h.logs.some((entry) => entry.startsWith("kherep-node: message exchange failed:")), h.logs.join("\n"));
  assert.deepEqual(counterLines(h.logs), []);
  await pongs(h, 32);
  assert.deepEqual(counterLines(h.logs), [line(33, "pong 32, auth 1")]);
});
