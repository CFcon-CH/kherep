import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { BUSY_CONTEXT, BUSY_OWNER, busyFixture } from "./codex-busy-fixture.mts";
import { listenerDir } from "./autonomy.mts";
import { deliverForCodex } from "./deliver-codex.mts";
import { getMessage, MAX_REPLY_DEPTH } from "./inbox.mts";

test("the original owner receives one compact hint with at most eight targeted reads and no Inbox discovery", (t) => {
  const node = busyFixture(t, 12);
  const before = node.inboxBytes();
  const session = fs.readFileSync(path.join(node.paths.codexSessions, `${BUSY_OWNER}.json`), "utf8");
  let reads = 0;
  const read = fs.readFileSync;
  const mockedRead = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
    if (String(args[0]).startsWith(node.paths.inbox + path.sep)) reads++;
    return Reflect.apply(read, fs, args);
  });
  const discovery = t.mock.method(fs, "readdirSync", () => { throw new Error("discovery is forbidden at a tool boundary"); });
  const output = deliverForCodex(node.input, node.hookDeps);
  assert.deepEqual(JSON.parse(output), { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: BUSY_CONTEXT } });
  assert.equal(reads, 8);
  assert.equal(deliverForCodex(node.input, node.hookDeps), "");
  assert.equal(reads, 8, "a claimed generation does not reread Inbox records");
  discovery.mock.restore(); mockedRead.mock.restore();
  assert.deepEqual(node.inboxBytes(), before, "hinting does not offer, confirm or change progress");
  // Issue #408: the tool boundary refreshes only the last event, never lastSeen, cwd or mode.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(node.paths.codexSessions, `${BUSY_OWNER}.json`), "utf8")),
    { ...JSON.parse(session), lastEvent: "PostToolUse", lastEventAt: new Date(node.admission.admittedAt).toISOString() });
  assert.equal(fs.existsSync(path.join(node.paths.dir, "wake.jsonl")), false);
  assert.deepEqual(fs.readdirSync(listenerDir(node.paths)), [`${BUSY_OWNER}.busy-hint.json`]);
});

test("the verified owner's PostToolUse records its last event even without a hint; a child's leaves the record untouched", (t) => {
  const node = busyFixture(t, 1, undefined, false);
  const file = path.join(node.paths.codexSessions, `${BUSY_OWNER}.json`);
  const session = fs.readFileSync(file, "utf8");
  for (const patch of [{ agent_id: "synthetic-child" }, { agent_type: "worker" }, { transcript_path: node.input.transcript_path.replace(BUSY_OWNER,
    "01a0db74-0000-7000-8000-000000000002") }]) {
    assert.equal(deliverForCodex({ ...node.input, ...patch }, node.hookDeps), "");
    assert.equal(fs.readFileSync(file, "utf8"), session, JSON.stringify(patch));
  }
  fs.writeFileSync(path.join(node.paths.dir, "wake.disabled"), "");
  assert.equal(deliverForCodex(node.input, node.hookDeps), "", "the kill switch still suppresses the hint");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).lastEvent, "PostToolUse");
});

test("an owner PostToolUse never creates a session record, and a failed refresh keeps the hint", (t) => {
  const node = busyFixture(t);
  const file = path.join(node.paths.codexSessions, `${BUSY_OWNER}.json`);
  fs.unlinkSync(file);
  assert.match(deliverForCodex(node.input, node.hookDeps), /New peer messages/);
  assert.equal(fs.existsSync(file), false);
  const other = busyFixture(t);
  fs.writeFileSync(path.join(other.paths.codexSessions, `${BUSY_OWNER}.json`), "{broken json");
  assert.equal(deliverForCodex({ ...other.input, permission_mode: "default" }, other.hookDeps).length > 0, true);
});

test("a child or foreign transcript is rejected before ticket or Inbox reads", (t) => {
  const node = busyFixture(t);
  let reads = 0;
  const read = t.mock.method(fs, "readFileSync", () => { reads++; throw new Error("no read allowed"); });
  for (const patch of [{ agent_id: BUSY_OWNER }, { agent_type: null }, { transcript_path: node.input.transcript_path.replace(BUSY_OWNER,
    "01a0db74-0000-7000-8000-000000000002") }, { transcript_path: "not-a-rollout" }]) {
    assert.equal(deliverForCodex({ ...node.input, ...patch }, node.hookDeps), "");
  }
  assert.equal(reads, 0);
  read.mock.restore();
  assert.equal(JSON.parse(fs.readFileSync(node.ticket, "utf8")).claimed, false);
});

test("only still-accepted admitted records count, and arrivals during a read are not added", (t) => {
  const node = busyFixture(t, 5);
  for (let i = 0; i < 4; i++) {
    const file = path.join(node.paths.inbox, `${node.ids[i]}.json`);
    if (i === 1) { fs.unlinkSync(file); continue; }
    const record = getMessage(node.paths.inbox, node.ids[i])!;
    fs.writeFileSync(file, JSON.stringify({ ...record, ...(i === 0 ? { state: "offered" }
      : i === 2 ? { toSession: "another-session" } : { depth: MAX_REPLY_DEPTH }) }));
  }
  const remaining = node.ids.filter((_, i) => i !== 1);
  const before = remaining.map((id) => fs.readFileSync(path.join(node.paths.inbox, `${id}.json`), "utf8"));
  const read = fs.readFileSync;
  const during = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
    const value = Reflect.apply(read, fs, args);
    if (String(args[0]) === path.join(node.paths.inbox, `${node.ids[4]}.json`)) {
      fs.writeFileSync(path.join(node.paths.inbox, "00000000-0000-4000-8000-000000000009.json"), "{new synthetic arrival}");
    }
    return value;
  });
  assert.match(deliverForCodex(node.input, node.hookDeps), /New peer messages/);
  during.mock.restore();
  assert.equal(getMessage(node.paths.inbox, node.ids[4])?.state, "accepted");
  assert.equal(JSON.parse(fs.readFileSync(node.ticket, "utf8")).claimed, true);
  assert.deepEqual(remaining.map((id) => fs.readFileSync(path.join(node.paths.inbox, `${id}.json`), "utf8")), before);
});

test("no eligible reference leaves the generation unclaimed", (t) => {
  const node = busyFixture(t);
  fs.unlinkSync(path.join(node.paths.inbox, `${node.ids[0]}.json`));
  assert.equal(deliverForCodex(node.input, node.hookDeps), "");
  assert.equal(JSON.parse(fs.readFileSync(node.ticket, "utf8")).claimed, false);
});

test("guarded20 counts in exact-owner hint consumption; malformed admission never consumes", (t) => {
  for (const valid of [true, false]) {
    const node = busyFixture(t), id = node.ids[0];
    const file = path.join(node.paths.inbox, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...getMessage(node.paths.inbox, id)!, depth: 20,
      loop: { version: valid ? 1 : 2, threadId: id, depth: 20, generation: 0, ordinal: 21 } }));
    assert.equal(deliverForCodex(node.input, node.hookDeps).includes("New peer messages"), valid);
    assert.equal(JSON.parse(fs.readFileSync(node.ticket, "utf8")).claimed, valid);
  }
});
