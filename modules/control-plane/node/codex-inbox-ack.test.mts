import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BUSY_OWNER, BUSY_BODY, busyFixture } from "./codex-busy-fixture.mts";
import { nodePaths } from "./config.mts";
import { acknowledgeCodexOffer, prepareCodexOffers } from "./codex-inbox-ack.mts";
import { deliverForCodex } from "./deliver-codex.mts";
import { getMessage, markReported, unreportedStatuses, writeJsonAtomic, type InboxRecord } from "./inbox.mts";
import { runMsg } from "./msg-cli.mts";

function client(t: test.TestContext, count = 1) {
  const node = busyFixture(t, count, Date.now(), false);
  const call = async (args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const status = await runMsg(["inbox", ...args], { paths: node.paths, env: { CODEX_THREAD_ID: BUSY_OWNER },
      out: line => out.push(line), err: line => err.push(line) });
    return { status, text: out.join("\n"), error: err.join("\n") };
  };
  const receive = () => call(["--from", BUSY_OWNER, "--receive"]);
  const ack = (receipt: string, owner = BUSY_OWNER) => call(["--from", owner, "--ack", receipt]);
  const stop = () => deliverForCodex({ ...node.input, hook_event_name: "Stop", stop_hook_active: true }, { paths: node.paths });
  return { ...node, call, receive, ack, stop };
}
const receiptOf = (text: string): string => {
  const found = text.match(/msg inbox --ack ([0-9a-f-]{36}) --from /);
  assert.ok(found, "complete emitted offer carries explicit processing ACK command");
  return found[1]!;
};

test("receive and ordinary repeated Stop cannot acknowledge processing", async t => {
  const c = client(t), first = await c.receive();
  assert.ok(first.text.includes(BUSY_BODY));
  c.stop(); c.stop();
  assert.equal(getMessage(c.paths.inbox, c.ids[0])?.state, "offered");
});

test("interrupted offers recover immediately without consuming attempts; exact ACK is idempotent and remote receipt stays separate", async t => {
  const c = client(t), first = await c.receive(), token = receiptOf(first.text);
  const again = await c.receive();
  assert.ok(again.text.includes(BUSY_BODY));
  assert.equal(getMessage(c.paths.inbox, c.ids[0])?.offers, 1);
  assert.equal((await c.ack(token)).status, 0);
  assert.equal(getMessage(c.paths.inbox, c.ids[0])?.state, "delivered");
  assert.equal((await c.ack(token)).status, 0);
  assert.ok(unreportedStatuses(c.paths.inbox).some(r => r.messageId === c.ids[0] && r.state === "delivered"));
  assert.match((await c.ack(token)).text, /local.*committed.*Worker.*pending/i);
  markReported(c.paths.inbox, c.ids[0], "delivered", "delivered");
  assert.match((await c.ack(token)).text, /Worker.*persisted.*sender.*not verified/i);
  assert.equal((await c.receive()).text.includes(BUSY_BODY), false);
});

test("ACK fails closed for wrong owner, stale generation, readdressed, changed origin, refused and never offered", async t => {
  for (const kind of ["owner", "generation", "address", "origin", "refused", "never"] as const) await t.test(kind, async sub => {
    const c = client(sub), token = receiptOf((await c.receive()).text), file = path.join(c.paths.inbox, `${c.ids[0]}.json`);
    const record = getMessage(c.paths.inbox, c.ids[0])!;
    if (kind === "generation") writeJsonAtomic(file, { ...record, offeredAt: new Date(0).toISOString() });
    if (kind === "origin") writeJsonAtomic(file, { ...record, senderOrigin: { nodeId: record.from.nodeId, sentAt: new Date(0).toISOString() } });
    if (kind === "address") writeJsonAtomic(file, { ...record, toSession: "other" });
    if (kind === "refused") writeJsonAtomic(file, { ...record, state: "refused" });
    if (kind === "never") writeJsonAtomic(file, { ...record, state: "accepted", codexOffer: undefined });
    const result = await c.ack(token, kind === "owner" ? "01a0db74-0000-7000-8000-000000000099" : BUSY_OWNER);
    assert.equal(result.status, 1);
    assert.notEqual(getMessage(c.paths.inbox, c.ids[0])?.state, "delivered");
  });
});

test("listing has no receipt or writes; bounded ACK covers only complete output", async t => {
  const c = client(t, 12), listing = await c.call(["--from", BUSY_OWNER]);
  assert.ok(!listing.text.includes("msg inbox --ack"));
  assert.ok(c.ids.every(id => getMessage(c.paths.inbox, id)?.state === "accepted"));
  const received = await c.receive(), token = receiptOf(received.text);
  assert.ok(Buffer.byteLength(received.text) <= 6 * 1024);
  const emitted = c.ids.filter(id => received.text.includes(`Message id: ${id}`));
  assert.ok(emitted.length > 0 && emitted.length < c.ids.length);
  assert.equal((await c.ack(token)).status, 0);
  for (const id of c.ids) assert.equal(getMessage(c.paths.inbox, id)?.state, emitted.includes(id) ? "delivered" : "accepted");
  assert.ok(!fs.readFileSync(path.join(c.paths.inbox, `${c.ids[0]}.json`), "utf8").includes('"receiptText"'));
});

test("oversized batch gives an exact complete receive recovery command and no ACK; single receive then ACK covers all text", async t => {
  const c = client(t), file = path.join(c.paths.inbox, `${c.ids[0]}.json`);
  const text = "Public synthetic large message\n" + "x".repeat(12_000) + "\nFULL-END";
  writeJsonAtomic(file, { ...getMessage(c.paths.inbox, c.ids[0]), text });
  const batch = await c.receive();
  assert.ok(Buffer.byteLength(batch.text) <= 6 * 1024);
  assert.ok(!batch.text.includes("msg inbox --ack"));
  assert.ok(batch.text.includes(`--receive ${c.ids[0]}`));
  const single = await c.call(["--from", BUSY_OWNER, "--receive", c.ids[0]]);
  assert.equal(single.status, 0, single.error);
  assert.ok(single.text.includes(text));
  assert.match(single.text, /output.*truncated.*do not ACK/i);
  assert.equal((await c.ack(receiptOf(single.text))).status, 0);
  assert.equal(getMessage(c.paths.inbox, c.ids[0])?.state, "delivered");
});

test("single receive refuses unowned, terminal, invalid, extra and conflicting selectors", async t => {
  for (const kind of ["owner", "terminal", "invalid", "extra", "all", "ack"] as const) await t.test(kind, async sub => {
    const c = client(sub), file = path.join(c.paths.inbox, `${c.ids[0]}.json`);
    if (kind === "owner") writeJsonAtomic(file, { ...getMessage(c.paths.inbox, c.ids[0]), toSession: "another-owner" });
    if (kind === "terminal") writeJsonAtomic(file, { ...getMessage(c.paths.inbox, c.ids[0]), state: "delivered" });
    const args = ["--from", BUSY_OWNER, "--receive", kind === "invalid" ? "invalid-id" : c.ids[0]!];
    if (kind === "extra") args.push(c.ids[0]!);
    if (kind === "all") args.push("--all");
    if (kind === "ack") args.push("--ack", c.ids[0]!);
    const result = await c.call(args);
    assert.equal(result.status, 1);
    assert.ok(!result.text.includes("msg inbox --ack"));
  });
});

test("ACK and receive reject unrelated option combinations", async t => {
  const c = client(t), token = receiptOf((await c.receive()).text);
  for (const args of [
    ["--from", BUSY_OWNER, "--ack", token, "--to", "another/owner"],
    ["--from", BUSY_OWNER, "--receive", "--wait", "1"],
  ]) assert.equal((await c.call(args)).status, 1);
});

// Frozen actual v1 production output from kherep@a0062625f68fb0b68bdab2a24c59506db8461eb5.
// It was prepared and successfully ACKed by that baseline before testing upgrade.
// Keep the stored token/hash unchanged; recomputing it with current code hides regressions.
const V1_UPGRADE = {
  "owner": "01a0db74-0000-7000-8000-000000000001",
  "token": "00000000-0000-4000-8000-000000000002",
  "record": {
    "messageId": "00000000-0000-4000-8000-000000000001",
    "from": {
      "nodeId": "00000000-0000-4000-8000-000000000003",
      "session": "synthetic-sender"
    },
    "toSession": "01a0db74-0000-7000-8000-000000000001",
    "text": "PUBLIC SYNTHETIC UPGRADE\nComplete body.",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "receivedAt": "2026-01-01T00:00:01.000Z",
    "state": "offered",
    "depth": 0,
    "offers": 1,
    "offeredAt": "2026-01-01T00:00:02.000Z",
    "offeredBy": "receive",
    "codexOffer": {
      "owner": "01a0db74-0000-7000-8000-000000000001",
      "generation": "0f526aec-0e36-4e97-902c-6bdc099097a3",
      "fingerprint": "e6347a50aee8a588d46dd8bed4e5f8f950aa2d5e5e67fbfc36482a13eb16d6e3"
    }
  },
  "receipt": {
    "version": 1,
    "owner": "01a0db74-0000-7000-8000-000000000001",
    "entries": [
      {
        "messageId": "00000000-0000-4000-8000-000000000001",
        "generation": "0f526aec-0e36-4e97-902c-6bdc099097a3",
        "fingerprint": "e6347a50aee8a588d46dd8bed4e5f8f950aa2d5e5e67fbfc36482a13eb16d6e3"
      }
    ]
  }
} satisfies { owner: string; token: string; record: InboxRecord; receipt: object };

function upgradeFixture(t: test.TestContext, origin = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-ack-upgrade-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root), { owner, token } = V1_UPGRADE;
  fs.mkdirSync(path.join(paths.inbox, "codex-offers"), { recursive: true });
  const file = path.join(paths.inbox, `${V1_UPGRADE.record.messageId}.json`);
  const record: InboxRecord = structuredClone(V1_UPGRADE.record);
  if (origin) record.senderOrigin = { nodeId: record.from.nodeId, sentAt: record.createdAt };
  writeJsonAtomic(file, record);
  writeJsonAtomic(path.join(paths.inbox, "codex-offers", `${token}.json`), V1_UPGRADE.receipt);
  if (origin) prepareCodexOffers(paths, [record], owner, token, Date.parse(record.offeredAt!), "receive");
  return { paths, file, owner, token, read: () => getMessage(paths.inbox, record.messageId)! };
}

test("upgrade ACK accepts the unchanged persisted v1 token without another Receive or generation", t => {
  const f = upgradeFixture(t), generation = f.read().codexOffer!.generation;
  assert.match(acknowledgeCodexOffer(f.paths, f.owner, f.token, [f.owner]), /processing ACK committed/);
  assert.equal(f.read().state, "delivered");
  assert.deepEqual(f.read().codexOffer, V1_UPGRADE.record.codexOffer);
  assert.equal(f.read().codexOffer!.generation, generation);
});

test("a newly prepared origin-bound token remains valid and may ACK after the admission deadline", t => {
  const f = upgradeFixture(t, true);
  assert.notEqual(f.read().codexOffer!.fingerprint, V1_UPGRADE.record.codexOffer.fingerprint);
  assert.match(acknowledgeCodexOffer(f.paths, f.owner, f.token, [f.owner]), /processing ACK committed/);
  assert.equal(f.read().state, "delivered");
});

test("upgrade ACK never falls back across origin, owner, generation or complete content changes", async t => {
  for (const change of ["add", "legacy-null", "legacy-malformed", "remove", "time", "node", "null", "malformed", "unbound",
    "owner", "generation", "body", "address", "legacy-owner", "legacy-generation", "legacy-body", "legacy-address"] as const) {
    await t.test(change, sub => {
      const f = upgradeFixture(sub, change !== "add" && !change.startsWith("legacy-")), record = f.read();
      const kind = change.replace(/^legacy-/, "");
      if (kind === "add") record.senderOrigin = { nodeId: record.from.nodeId, sentAt: record.createdAt };
      if (kind === "remove") delete record.senderOrigin;
      if (kind === "time") record.senderOrigin!.sentAt = "2026-01-01T00:00:00.001Z";
      if (kind === "node") record.senderOrigin!.nodeId = "00000000-0000-4000-8000-000000000004";
      if (kind === "null") (record as unknown as { senderOrigin: null }).senderOrigin = null;
      if (kind === "malformed") record.senderOrigin = { nodeId: record.from.nodeId, sentAt: "invalid" };
      if (kind === "unbound") record.from.nodeId = "00000000-0000-4000-8000-000000000004";
      if (kind === "generation") record.codexOffer!.generation = "00000000-0000-4000-8000-000000000099";
      if (kind === "body") record.text += " changed";
      if (kind === "address") record.from.session = "other-sender";
      writeJsonAtomic(f.file, record);
      assert.throws(() => acknowledgeCodexOffer(f.paths, kind === "owner" ? "other-owner" : f.owner, f.token, [f.owner]));
      assert.equal(f.read().state, "offered");
    });
  }
});
