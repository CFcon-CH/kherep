import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {createHash} from "node:crypto";
import {REGISTRY_SCHEMA,migrateRegistry} from "../src/registry-schema.mts";
import type {NewMessage} from "../src/message-store.mts";
import { handleApi } from "../src/api.mts";
import type { Env } from "../src/env.mts";
import { MessageStore } from "../src/message-store.mts";
const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const T = Date.parse("2026-01-01T00:00:00.000Z");
const at = (ms: number) => new Date(ms).toISOString();
function fixture(t: test.TestContext, legacy = false) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  if (legacy) {
    db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, from_node TEXT NOT NULL, from_session TEXT NOT NULL,
      to_node TEXT NOT NULL, to_session TEXT NOT NULL, in_reply_to TEXT, text TEXT, state TEXT NOT NULL, reason TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
    db.prepare(`INSERT INTO messages (id, from_node, from_session, to_node, to_session, text, state, created_at, updated_at, expires_at)
      VALUES (?, ?, 's', ?, 't', 'legacy synthetic', 'queued', ?, ?, ?)`).run(A, A, B, T, T, T + 86_400_000);
  }
  const sql = { exec(query: string, ...args: (string | number | null)[]) {
    if (query.includes("CREATE TABLE IF NOT EXISTS")) { db.exec(query); return { toArray: () => [] }; }
    const statement = db.prepare(query);
    if (statement.columns().length) {
      const rows = statement.all(...args).map(row => ({ ...row }));
      return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
    }
    statement.run(...args);
    return { toArray: () => [] };
  } };
  // Registry creates the audit table. This fixture replaces its audit sink only.
  db.exec(REGISTRY_SCHEMA);migrateRegistry(sql as unknown as Parameters<typeof migrateRegistry>[0]);
  const store = new MessageStore(sql as unknown as ConstructorParameters<typeof MessageStore>[0], () => {}, () => ["messaging.v1", "messaging.origin.v1"]);
  return { store, db, sql };
}
const fingerprint=(m:NewMessage)=>createHash('sha256').update(JSON.stringify([m.from.nodeId,m.from.session,m.to.nodeId,m.to.session,m.text,m.inReplyTo??null,m.proxyOf??null,m.taskId??null])).digest('hex');
async function send(store:MessageStore,message:NewMessage,actor:string,now:number,proof?:string){
 const prepared=await store.prepare(message,async()=>"synthetic-loop-key");
 return store.send(message,actor,now,{...prepared,payload:{fingerprint:proof??fingerprint(message),from:message.from,to:message.to}});
}
test("origin is immutable on offline send/replay, conflicting resends and store restart", async t => {
  const { store, db, sql } = fixture(t);
  const origin = { nodeId: A, sentAt: at(T) };
  const msg = { messageId: A, from: { nodeId: A, session: "s" }, to: { nodeId: B, session: "t" }, text: "synthetic", senderOrigin: origin };
  const receipt = T + 23 * 60 * 60_000;
  const result = await send(store,msg, `node:${A}`, receipt);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.effects.deliveries[0]?.body.senderOrigin, origin);
  assert.equal(result.effects.deliveries[0]?.body.createdAt, at(receipt));
  for (const changed of [{ senderOrigin: { ...origin, sentAt: at(T + 1) } }, { to: { nodeId: B, session: "other" } }]) {
    assert.deepEqual(await send(store,{ ...msg, ...changed }, `node:${A}`, receipt + 1), { ok: false, error: "conflicting message binding" });
  }
  assert.deepEqual(await send(store,msg, `node:${A}`, receipt + 1, "changed-binding"), { ok: false, error: "conflicting message binding" });
  const restarted = new MessageStore(sql as unknown as ConstructorParameters<typeof MessageStore>[0], () => {}, () => ["messaging.v1", "messaging.origin.v1"]);
  assert.deepEqual(restarted.pendingFor(B, receipt + 1).deliveries[0]?.body.senderOrigin, origin);
  assert.equal(db.prepare("SELECT sender_sent_at FROM messages WHERE id = ?").get(A)?.sender_sent_at, origin.sentAt);
  assert.equal(store.report(B, { messageId: A, state: "accepted" }, receipt + 2).receipt?.storedState, "accepted");
  // An accepted turn may finish/ACK after the immutable admission deadline.
  assert.equal(store.report(B, { messageId: A, state: "delivered" }, T + 2 * 86_400_000).receipt?.storedState, "delivered");
});
test("legacy stays unknown and future or unbound assertions fail without creating rows", async t => {
  const { store, db } = fixture(t);
  const msg = { messageId: A, from: { nodeId: A, session: "s" }, to: { nodeId: B, session: "t" }, text: "synthetic" };
  assert.equal((await send(store,msg, `node:${A}`, T)).ok, true);
  assert.equal(store.pendingFor(B, T).deliveries[0]?.body.senderOrigin, undefined);
  assert.deepEqual(await send(store,{ ...msg, senderOrigin: { nodeId: A, sentAt: at(T) } }, `node:${A}`, T),
    { ok: false, error: "conflicting message binding" });
  for (const senderOrigin of [{ nodeId: A, sentAt: at(T + 1) }, { nodeId: B, sentAt: at(T) }, { nodeId: A, sentAt: "bad" }]) {
    const result = await send(store,{ ...msg, messageId: B, senderOrigin }, `node:${A}`, T);
    assert.deepEqual(result, { ok: false, error: "invalid sender origin" });
    assert.equal(db.prepare("SELECT id FROM messages WHERE id = ?").get(B), undefined);
  }
});

test("additive migration never retrofills sender origin or a legacy content binding", async t => {
  const { store, db, sql } = fixture(t, true);
  new MessageStore(sql as unknown as ConstructorParameters<typeof MessageStore>[0], () => {}, () => ["messaging.v1", "messaging.origin.v1"]);
  const record = db.prepare("SELECT sender_sent_at, message_binding, created_at FROM messages WHERE id = ?").get(A)!;
  assert.deepEqual({ ...record }, { sender_sent_at: null, message_binding: null, created_at: T });
  assert.deepEqual({ ...db.prepare("SELECT delivery_binding,delivery_pair FROM messages WHERE id=?").get(A) },
    { delivery_binding: null, delivery_pair: null });
  const columns = db.prepare("PRAGMA table_info(messages)").all().map(row => row.name);
  for (const name of ['sender_sent_at', 'message_binding', 'delivery_binding', 'delivery_pair', 'loop_pair', 'loop_identity']) assert.ok(columns.includes(name));
  assert.equal(store.pendingFor(B, T).deliveries[0]?.body.senderOrigin, undefined);
});

test("operator handler omits the stored duplicate digest while retaining ordinary metadata", async t => {
  const { store, db } = fixture(t);
  const msg = { messageId: A, from: { nodeId: A, session: "s" }, to: { nodeId: B, session: "t" }, text: "synthetic", senderOrigin: { nodeId: A, sentAt: at(T) } };
  const digest = fingerprint(msg);
  assert.equal((await send(store,msg, `node:${A}`, Date.now(), digest)).ok, true);
  const env = { REGISTRY: { idFromName: () => "synthetic-registry", get: () => ({ listMessages: (node: string | null, limit: number) => store.list(node, limit) }) } };
  // handleApi's actor comes from its authenticated caller; real Access JWT is
  // exercised separately by api.test.mts inside the synthetic Worker suite.
  const response = await handleApi(new Request(`https://control.example.com/api/messages?node=${A}`), env as unknown as Env, "operator@example.com");
  assert.equal(response.status, 200);
  const body = await response.json() as { messages: Record<string, unknown>[] };
  assert.equal(body.messages[0]?.messageId, A);
  assert.equal(Object.hasOwn(body.messages[0]!, "binding"), false);
  assert.equal(JSON.stringify(body).includes(digest), false);
  assert.equal(db.prepare("SELECT message_binding FROM messages WHERE id = ?").get(A)?.message_binding, digest);
  assert.deepEqual(await send(store,{ ...msg, text: "changed" }, `node:${A}`, Date.now(), "changed-digest"), { ok: false, error: "conflicting message binding" });
});

test('payload send and status-only replay remain separate after a stored origin',async t=>{
 const {store,db}=fixture(t);const msg={messageId:A,from:{nodeId:A,session:'s'},to:{nodeId:B,session:'t'},text:'origin proof',senderOrigin:{nodeId:A,sentAt:at(T)}};
 assert.equal((await send(store,msg,`node:${A}`,T)).ok,true);
 assert.equal(store.replay(A,A,false)?.ok,true);assert.deepEqual(store.replay(A,B,false),{ok:false,error:'duplicate messageId'});
 assert.deepEqual(store.send(msg,`node:${A}`,T+1),{ok:false,error:'invalid sender origin'});
 const prepared=await store.prepare(msg,async()=> 'synthetic-loop-key');
 db.prepare('INSERT INTO sessions(node_id,session_id,runtime,state,updated_at) VALUES(?,?,?,?,?)').run(A,'s','codex','running',T);
 assert.deepEqual(store.send(msg,`node:${A}`,T+1,{...prepared,payload:{fingerprint:fingerprint(msg),from:msg.from,to:msg.to}}),{ok:false,error:'invalid sender origin'});
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n,1);
});

test('accepted legacy ordinary retries preserve metadata without retaining the erased body', async t => {
  const { store, db } = fixture(t);
  const message = { messageId: A, from: { nodeId: A, session: 's' }, to: { nodeId: B, session: 't' }, text: 'synthetic original' };
  const now = Date.now();
  assert.equal((await send(store, message, `node:${A}`, now)).ok, true);
  store.report(B, { messageId: A, state: 'accepted' }, now + 1);
  db.prepare('UPDATE messages SET sender_sent_at=NULL,message_binding=NULL WHERE id=?').run(A);
  const before = db.prepare('SELECT * FROM messages WHERE id=?').get(A);
  assert.equal(before?.sender_sent_at, null);
  assert.equal(before?.message_binding, null);
  assert.equal(before?.text, null);
  const result = await send(store, { ...message, text: 'synthetic changed' }, `node:${A}`, now + 2);
  assert.equal(result.ok && result.status.state, 'accepted');
  assert.deepEqual(result.ok && result.effects, { deliveries: [], statuses: [] });
  assert.deepEqual(db.prepare('SELECT * FROM messages WHERE id=?').get(A), before);
});

test('originless accepted modern retries enforce the persisted digest after body erasure', async t => {
  const { store, db } = fixture(t);
  const message = { messageId: A, from: { nodeId: A, session: 's' }, to: { nodeId: B, session: 't' }, text: 'synthetic modern original' };
  const now = Date.now();
  assert.equal((await send(store, message, `node:${A}`, now)).ok, true);
  store.report(B, { messageId: A, state: 'accepted' }, now + 1);
  const before = db.prepare('SELECT * FROM messages WHERE id=?').get(A);
  assert.equal(before?.sender_sent_at, null);
  assert.equal(before?.message_binding, fingerprint(message));
  assert.equal(before?.text, null);
  assert.equal((await send(store, message, `node:${A}`, now + 2)).ok, true);
  assert.deepEqual(await send(store, { ...message, text: 'synthetic changed modern body' }, `node:${A}`, now + 2),
    { ok: false, error: 'conflicting message binding' });
  assert.deepEqual(db.prepare('SELECT * FROM messages WHERE id=?').get(A), before);
});
