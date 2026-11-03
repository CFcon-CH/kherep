import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { fixture, ID, OWNER, PEER } from "./inbox-storage-fixture.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { writeLocalSessions } from "./exchange-sessions.mts";
import { prepareCodexOffers } from "./codex-inbox-ack.mts";
const REVISION = "f34b66fa581be6b5bdd5f1d84262b6d64a80a150";
const SOURCE_ROOT = path.resolve(import.meta.dirname, "../../..");
const hash = (b: Buffer): string => crypto.createHash("sha256").update(b).digest("hex");
// The fixture copies the complete immutable import closure, including type-only
// imports. No current helper is substituted into any historical reader.
function oldClosure(root: string, entries: string[]) {
  const copied = new Map<string, string>();
  const copy = (relative: string): void => {
    if (copied.has(relative)) return;
    const bytes = execFileSync("git", ["show", `${REVISION}:${relative}`], { cwd: SOURCE_ROOT });
    copied.set(relative, hash(bytes));
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    assert.equal(hash(fs.readFileSync(file)), hash(bytes), relative);
    for (const match of bytes.toString().matchAll(/(?:from\s*|import\s*\(\s*|import\s*)["'](\.[^"']+\.mts)["']/g)) {
      copy(path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1])));
    }
  };
  entries.forEach(copy);
  return copied;
}
test("immutable HEAD enumerate/exact receive/ACK/hooks/MCP cannot see a bound-only body, while legacy is unchanged", async t => {
  const f = fixture(t), now = Date.now(), oldRoot = path.join(f.root, "immutable-source");
  const names = ["inbox", "msg-inbox", "msg-inbox-exact", "codex-inbox-ack", "deliver-hook", "mcp-local", "inbox-purge"];
  const prefix = "modules/control-plane/node/";
  const copied = oldClosure(oldRoot, names.map(n => `${prefix}${n}.mts`));
  const old = Object.fromEntries(await Promise.all(names.map(async n => [n, await import(pathToFileURL(path.join(oldRoot, prefix, `${n}.mts`)).href)])));
  const body = { ...f.body, inReplyTo: PEER }; const record = storeMessage(f.paths.inbox, body, now);
  writeLocalSessions(f.paths, [{ sessionId: OWNER, runtime: "codex", state: "unknown" }]);
  recordCodexSession(f.paths, OWNER, f.root, now);
  const token = crypto.randomUUID(); prepareCodexOffers(f.paths, [record], OWNER, token, now + 1, "receive");
  fs.mkdirSync(path.join(f.paths.inbox, "receipts"), { recursive: true });
  fs.writeFileSync(path.join(f.paths.inbox, "receipts", `${ID}.json`), JSON.stringify({ reportedState: "accepted", workerState: "accepted" }));
  const before = hash(fs.readFileSync(f.bound));
  assert.deepEqual(old.inbox.messageIds(f.paths.inbox), []); assert.deepEqual(old.inbox.listInbox(f.paths.inbox), []);
  assert.equal(old.inbox.getMessage(f.paths.inbox, ID), null);
  const out: string[] = [], err: string[] = [];
  const io = { paths: f.paths, env: { CODEX_THREAD_ID: OWNER }, now: () => now + 2, out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
  assert.equal(old["msg-inbox"].inbox(io, { from: OWNER, receive: true }, [ID]), 1);
  assert.equal(out.join("").includes(body.text), false);
  assert.throws(() => old["codex-inbox-ack"].acknowledgeCodexOffer(f.paths, OWNER, token, [OWNER]));
  assert.equal(old["deliver-hook"].deliverForHook({ hook_event_name: "UserPromptSubmit", session_id: OWNER }, { paths: f.paths }), "");
  assert.deepEqual(old["mcp-local"].readMcpInbox(f.paths, OWNER, 10, ID), []);
  fs.mkdirSync(f.paths.sent, { recursive: true });
  fs.writeFileSync(path.join(f.paths.sent, `${PEER}.json`), JSON.stringify({ messageId: PEER, fromSessionId: OWNER, to: { nodeId: PEER, session: "source" } }));
  assert.equal(old["msg-inbox-exact"].exactInbox(io, ["inbox"], { from: OWNER, "message-id": ID,
    "expect-node": PEER, "expect-session": "source", "expect-target-session": "source", "expect-reply-to": PEER,
    "expect-text-sha256": crypto.createHash("sha256").update(body.text).digest("hex") }), 1);
  assert.equal(old["inbox-purge"].purgeInbox(f.paths.inbox, now + 30 * 86400000), 0);
  assert.equal(hash(fs.readFileSync(f.bound)), before); assert.equal(fs.existsSync(f.flat), false);
  const legacyId = crypto.randomUUID(), { binding: _binding, ...legacy } = f.body;
  storeMessage(f.paths.inbox, { ...legacy, messageId: legacyId }, now);
  assert.deepEqual(old.inbox.getMessage(f.paths.inbox, legacyId), getMessage(f.paths.inbox, legacyId));
  assert.deepEqual(old.inbox.messageIds(f.paths.inbox), [legacyId]);
  for (const [relative, expected] of copied) assert.equal(hash(fs.readFileSync(path.join(oldRoot, relative))), expected);
  console.log("IMMUTABLE_OLD_READER_PROOF " + JSON.stringify({ revision: REVISION, files: Object.fromEntries(copied), boundBefore: before, boundAfter: hash(fs.readFileSync(f.bound)), noFlatBody: true }));
});
