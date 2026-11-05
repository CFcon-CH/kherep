import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BUSY_BODY, BUSY_CONTEXT, BUSY_OWNER, busyFixture } from "./codex-busy-fixture.mts";
import { codexSessionName, legacyCodexSessionName, recordCodexSession } from "./codex-sessions.mts";
import { writeLocalSessions } from "./exchange.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { listQueueBindings, queueBindingDir } from "./codex-queue-binding.mts";
import { listenerDir } from "./autonomy.mts";
import { getMessage } from "./inbox.mts";

const HOOK = fileURLToPath(new URL("./deliver-hook.mts", import.meta.url));
const CLI = fileURLToPath(new URL("./cli.mts", import.meta.url));

function commands(node: ReturnType<typeof busyFixture>) {
  const env: NodeJS.ProcessEnv = { ...process.env, KHEREP_CONFIG_DIR: node.root, CODEX_THREAD_ID: BUSY_OWNER };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.KHEREP_SESSION_ID;
  const hook = (input: Record<string, unknown>) => spawnSync(process.execPath, [HOOK, "--runtime", "codex"], {
    env, windowsHide: true, encoding: "utf8", input: JSON.stringify(input), timeout: 10_000 });
  const receive = () => spawnSync(process.execPath, [CLI, "msg", "inbox", "--from", BUSY_OWNER, "--receive"], {
    env, windowsHide: true, encoding: "utf8", timeout: 10_000 });
  return { hook, receive };
}

test("real CP poll, hook, Receive and Stop require a separate processing ACK without native artifacts", async (t) => {
  let now = Date.now();
  const node = busyFixture(t, 1, now, false);
  const legacyLedger = path.join(listenerDir(node.paths), `${BUSY_OWNER}.queued.json`);
  const legacyBinding = path.join(queueBindingDir(node.paths), "00000000-0000-4000-8000-000000000001.json");
  const card = path.join(node.root, "synthetic-native-queue-card.json");
  fs.mkdirSync(listenerDir(node.paths), { recursive: true });
  fs.mkdirSync(queueBindingDir(node.paths), { recursive: true });
  const seeded = [legacyLedger, legacyBinding, card].map((file, index) => {
    const bytes = index === 0 ? JSON.stringify({ queued: { [node.ids[0]]: new Date(now).toISOString() } })
      : JSON.stringify({ syntheticLegacyArtifact: index });
    fs.writeFileSync(file, bytes); return { file, bytes };
  });
  const poll = async () => {
    pollCodexQueue({ ...node.deps(), now: () => now, codex: { home: path.join(node.root, "empty-home"),
      findCodex: () => { assert.fail("no native queue or appserver process"); } } });
    await codexQueueIdle();
  };
  await poll();
  await poll();
  assert.equal(JSON.parse(fs.readFileSync(node.ticket, "utf8")).messages.length, 1);
  assert.deepEqual(listQueueBindings(node.paths), [], "no new native binding");
  const { hook, receive } = commands(node);
  const hinted = hook(node.input);
  assert.equal(hinted.status, 0, hinted.stderr);
  // Node 24.1 emits this runtime warning before running the hook's .mts source.
  assert.match(hinted.stderr, /^(?:\(node:\d+\) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?$/);
  assert.deepEqual(JSON.parse(hinted.stdout), { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: BUSY_CONTEXT } });
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "accepted");
  assert.equal(hook(node.input).stdout, "", "claim is once per generation");
  await poll();
  const received = receive();
  assert.equal(received.status, 0, received.stderr);
  assert.ok(received.stdout.includes(BUSY_BODY));
  const offered = getMessage(node.paths.inbox, node.ids[0])!;
  assert.equal(offered.state, "offered");
  assert.equal(offered.offers, 1);
  assert.equal(receive().stdout.includes(BUSY_BODY), true, "explicit receive recovers an interrupted offer");
  const hintBeforeRecovery = fs.readFileSync(node.ticket, "utf8");
  now += 120_000;
  await poll();
  assert.equal(fs.readFileSync(node.ticket, "utf8"), hintBeforeRecovery, "Receive prevents recovery from republishing a hint");
  const stopped = hook({ ...node.input, hook_event_name: "Stop", stop_hook_active: true });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.stdout, "");
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "offered");
  const token = received.stdout.match(/msg inbox --ack ([0-9a-f-]{36}) --from /)![1]!;
  const acked = spawnSync(process.execPath, [CLI, "msg", "inbox", "--ack", token, "--from", BUSY_OWNER], {
    env: { ...process.env, KHEREP_CONFIG_DIR: node.root, CODEX_THREAD_ID: BUSY_OWNER }, windowsHide: true, encoding: "utf8" });
  assert.equal(acked.status, 0, acked.stderr);
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "delivered");
  assert.equal(hook(node.input).stdout, "");
  assert.equal(receive().stdout.includes(BUSY_BODY), false, "a later intake does not offer the packet again");
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.offers, 1);
  for (const { file, bytes } of seeded) assert.equal(fs.readFileSync(file, "utf8"), bytes);
});

test("an interrupt before confirming Stop leaves the actual offer unconfirmed", (t) => {
  const node = busyFixture(t, 1, Date.now());
  const { hook, receive } = commands(node);
  assert.equal(hook(node.input).status, 0);
  assert.equal(receive().status, 0);
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "offered");
  // A real interrupt supplies no confirming Stop. Another tool hint cannot stand in for one.
  assert.equal(hook(node.input).stdout, "");
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "offered");
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.offers, 1);
});

test("a post-admission alias collision cannot deliver a peer body through Receive", (t) => {
  const node = busyFixture(t, 1, Date.now());
  const alias = legacyCodexSessionName(BUSY_OWNER);
  const file = path.join(node.paths.inbox, `${node.ids[0]}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...getMessage(node.paths.inbox, node.ids[0]), toSession: alias }));
  const ticket = JSON.parse(fs.readFileSync(node.ticket, "utf8"));
  ticket.messages[0].toSession = alias;
  fs.writeFileSync(node.ticket, JSON.stringify(ticket));
  const other = "01a0db74-1111-7000-8000-000000000002";
  recordCodexSession(node.paths, other, node.workspace, Date.now(), "default");
  writeLocalSessions(node.paths, [BUSY_OWNER, other].map((sessionId) => ({ sessionId,
    name: codexSessionName(sessionId), runtime: "codex", state: "active" })), Date.now());
  const { hook, receive } = commands(node);
  assert.ok(hook(node.input).stdout.includes(BUSY_CONTEXT), "the existing admission can give a stale metadata hint");
  assert.equal(receive().stdout.includes(BUSY_BODY), false, "Receive still checks current alias uniqueness");
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "accepted");
});


test("more than eight admitted IDs and bounded Receive retain every unreturned message", async (t) => {
  const now = Date.now();
  const node = busyFixture(t, 12, now, false);
  // Existing Receive has a per-call maximum of ten messages; no artificial
  // test receipt is used to confirm the two records outside its actual output.
  pollCodexQueue({ ...node.deps(), now: () => now, codex: { home: path.join(node.root, "empty-home") } });
  await codexQueueIdle();
  assert.equal(JSON.parse(fs.readFileSync(node.ticket, "utf8")).messages.length, 8);
  const { hook, receive } = commands(node);
  assert.ok(hook(node.input).stdout.includes(BUSY_CONTEXT));
  assert.ok(node.ids.every((id) => getMessage(node.paths.inbox, id)?.state === "accepted"));
  const received = receive();
  assert.equal(received.status, 0, received.stderr);
  const returned = node.ids.filter((id) => received.stdout.includes(id));
  assert.ok(returned.length > 0 && returned.length < node.ids.length);
  for (const id of node.ids) assert.equal(getMessage(node.paths.inbox, id)?.state,
    returned.includes(id) ? "offered" : "accepted");
  const stopped = hook({ ...node.input, hook_event_name: "Stop", stop_hook_active: true });
  assert.equal(stopped.status, 0, stopped.stderr);
  for (const id of node.ids) assert.equal(getMessage(node.paths.inbox, id)?.state,
    returned.includes(id) ? "offered" : "accepted");
});


test("a real original-owner hint without Receive leaves content accepted", async (t) => {
  const now = Date.now();
  const node = busyFixture(t, 1, now, false);
  pollCodexQueue({ ...node.deps(), now: () => now, codex: { home: path.join(node.root, "empty-home") } });
  await codexQueueIdle();
  const { hook } = commands(node);
  assert.ok(hook(node.input).stdout.includes(BUSY_CONTEXT));
  assert.equal(hook(node.input).stdout, "");
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "accepted");
  // A stop_hook_active input confirms actual offers only, without authorizing
  // another Stop continuation for the unread accepted packet.
  assert.equal(hook({ ...node.input, hook_event_name: "Stop", stop_hook_active: true }).stdout, "");
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "accepted");
  assert.equal(getMessage(node.paths.inbox, node.ids[0])?.offers, undefined);
});
