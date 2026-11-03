import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { isMessageId } from "../protocol-messages.mts";
import { RELAY_MAX_AGE_MS } from "./codex-fork-admission.mts";
import { advanceForkAttempt, forkAttempts, forkAttemptsPath, type ForkAttempt } from "./codex-fork-attempts.mts";
import { ANSWER, FORK_ID, FORK_OWNER } from "./codex-fork-fixture.mts";
import { forkTestTimeouts, resetForkFeatureCache } from "./codex-fork-reply.mts";
import { relayNode } from "./codex-fork-relay-fixture.mts";
import { markRelayDue } from "./codex-fork-relay.mts";
import { FAST } from "./codex-fork-run-fixture.mts";
import { resetMcpCache } from "./codex-mcp.mts";
import { getOutbox, getSent, recordSent } from "./exchange.mts";
import { getMessage, markAnswered, markOffered, writeJsonAtomic } from "./inbox.mts";
import { getProxied } from "./inbox-proxied.mts";
import { unnoticedNotices } from "./sent-notices.mts";

// Issue #408, PR 4 (design r3 sections 2 and 6): the relay of a completed
// fork answer as one labelled proxy answer, through the real poll, sweep and
// exchange gate, against the fake app-server only. The original stays accepted.

test.beforeEach(() => { resetMcpCache(); resetForkFeatureCache(); forkTestTimeouts.value = FAST; });
test.after(() => { forkTestTimeouts.value = undefined; });

const header = (id: string): string => `Kherep proxy answer: an ephemeral fork of session ${FORK_OWNER} (fork ${FORK_ID}) answered message ${id} `
  + "while the owner was idle. The owner has not read your message yet.";
const only = (n: ReturnType<typeof relayNode>): ForkAttempt => {
  const attempts = forkAttempts(n.paths, FORK_OWNER);
  assert.equal(attempts.length, 1);
  return attempts[0]!;
};
const held = (n: ReturnType<typeof relayNode>, code: string): string[] => n.logs.filter((line) => line.includes(`relay held: ${code}`));

test("a completed fork is relayed by the next sweep and sent by the gate once; relayedAt waits for the Worker's answer", async (t) => {
  const n = relayNode(t);
  const id = n.add();
  const file = path.join(n.paths.inbox, `${id}.json`);
  writeJsonAtomic(file, { ...JSON.parse(fs.readFileSync(file, "utf8")), depth: 2 });
  const record = getMessage(n.paths.inbox, id)!;
  await n.poll();
  assert.deepEqual([only(n).state, n.outbox()], ["completed", []], "the fork's own poll only marks the relay due");
  await n.poll();
  const attempt = only(n);
  assert.ok(isMessageId(attempt.relayMessageId));
  assert.equal(attempt.relayedAt, undefined, "relayedAt means the Worker answered (D18)");
  const relay = attempt.relayMessageId!;
  assert.deepEqual(n.outbox(), [`${relay}.json`]);
  const written = getOutbox(n.paths, relay)!;
  assert.deepEqual(written, { messageId: relay, fromSession: FORK_OWNER, fromSessionId: FORK_OWNER, to: record.from,
    text: `${header(id)}\n\n${JSON.parse(ANSWER).text}`, proxyOf: id, depth: 3, createdAt: written.createdAt, senderSentAt: written.createdAt });
  const sidecar = getProxied(n.paths.inbox, id)!;
  assert.deepEqual(sidecar, { version: 1, relayMessageId: relay, forkId: FORK_ID, attemptId: attempt.attemptId, at: sidecar.at });
  assert.equal(getMessage(n.paths.inbox, id)?.state, "accepted", "never a receipt transition of the original");
  assert.equal(written.senderSentAt, written.createdAt, "new proxy answer owns a new immutable sender timestamp");
  const sent = await n.exchange();
  assert.deepEqual(sent, [{ messageId: relay, fromSession: FORK_OWNER, to: record.from, text: written.text, proxyOf: id, senderSentAt: written.senderSentAt }]);
  await n.status(relay, "queued");
  assert.equal(getSent(n.paths, relay)?.state, "queued");
  await n.poll();
  assert.equal(typeof only(n).relayedAt, "number");
  assert.deepEqual(n.audit(), ["fork", "fork-relayed"]);
  await n.poll();
  assert.deepEqual([n.outbox(), n.audit(), n.app.runs.length], [[], ["fork", "fork-relayed"], 1], "idempotent");
});

test("a crash after the relay id was persisted resumes with the same id; a sent record gets relayedAt and is never resent", async (t) => {
  const n = relayNode(t);
  const id = n.add();
  const relay = "40840000-0000-4000-8000-00000000c0de";
  n.seed(id);
  advanceForkAttempt(n.paths, FORK_OWNER, id, "completed", "completed", { relayMessageId: relay }, n.deps().now!());
  n.sweep();
  assert.deepEqual([n.outbox(), n.app.runs.length, n.turns()], [[`${relay}.json`], 0, []], "no new fork, no spent turn");
  assert.equal(getOutbox(n.paths, relay)?.text, `${header(id)}\n\nGreen.`);
  recordSent(n.paths, relay, "queued");
  n.sweep();
  assert.deepEqual([n.outbox(), getSent(n.paths, relay)?.state, only(n).state], [[], "queued", "completed"]);
  assert.equal(typeof only(n).relayedAt, "number", "relayedAt written from the sent record");
  // relayedAt lost in a crash after it was written: written again from sent/.
  const file = path.join(forkAttemptsPath(n.paths, FORK_OWNER), `${id}.json`);
  const { relayedAt: _lost, ...rest } = JSON.parse(fs.readFileSync(file, "utf8"));
  writeJsonAtomic(file, rest);
  markRelayDue(FORK_OWNER);
  n.sweep();
  assert.equal(typeof only(n).relayedAt, "number");
  assert.deepEqual(await n.exchange(), []);
});

test("the owner answering or reading during the relay withdraws it exactly: no outbox record, no sidecar, superseded", (t) => {
  for (const [name, owner] of [["msg send --reply-to", markAnswered], ["a delivery hook", markOffered]] as const) {
    const n = relayNode(t);
    const id = n.add();
    n.seed(id);
    n.sweep({ beforeOutbox: () => { owner(n.paths.inbox, id); } });
    const attempt = only(n);
    assert.deepEqual([attempt.state, attempt.relayedAt, n.outbox(), getProxied(n.paths.inbox, id)], ["superseded", undefined, [], null], name);
    assert.deepEqual(n.audit(), ["fork-superseded"], name);
  }
});

test("the owner answering after relayedAt changes nothing locally: the attempt stays completed", async (t) => {
  const n = relayNode(t);
  const id = n.add();
  n.seed(id);
  n.sweep();
  const relay = only(n).relayMessageId!;
  assert.equal((await n.exchange()).length, 1);
  await n.status(relay, "accepted");
  n.sweep();
  markAnswered(n.paths.inbox, id);
  assert.throws(() => advanceForkAttempt(n.paths, FORK_OWNER, id, "completed", "superseded", {}, n.deps().now!()), /relayed/);
  markRelayDue(FORK_OWNER);
  n.sweep();
  assert.deepEqual([only(n).state, n.audit(), getSent(n.paths, relay)?.state], ["completed", ["fork-relayed"], "accepted"]);
});

// P1-2 (P08/P13): a seeded PR 3 attempt, an accepted original; each guard of the sweep.
const BLOCKED: [string, string, (n: ReturnType<typeof relayNode>) => void][] = [
  ["no proof on the current connection, a capable directory.json on disk", "fork-relay-unsupported", (n) => n.capability(null)],
  ["the owner removed from codexFork.sessions", "policy-changed", (n) => n.policy((p) => { p.wake.codexFork.sessions = ["01a0db74-0000-7000-8000-0000000000ff"]; })],
  ["the kill switch", "kill-switch", (n) => n.killSwitch(true)],
];
for (const [name, code, arrange] of BLOCKED) {
  test(`an old completed attempt is held by the sweep (${code}): ${name}; logged once, nothing spent`, async (t) => {
    const n = relayNode(t);
    const id = n.add();
    n.seed(id);
    arrange(n);
    await n.poll();
    markRelayDue(FORK_OWNER);
    await n.poll();
    assert.deepEqual([n.outbox(), getProxied(n.paths.inbox, id), n.app.runs.length, n.turns()], [[], null, 0, []]);
    assert.equal(held(n, code).length, 1, n.logs.join("\n"));
    assert.equal(only(n).state, "completed");
  });
}

test("an attempt with another policy fingerprint is held as policy-changed", (t) => {
  const n = relayNode(t);
  const id = n.add();
  n.seed(id, { policyFingerprint: "c".repeat(64) });
  n.sweep();
  assert.deepEqual([n.outbox(), held(n, "policy-changed").length], [[], 1]);
});

test("an old completed attempt with every guard passing is relayed once: no helper, no turn", async (t) => {
  const n = relayNode(t);
  const id = n.add();
  n.seed(id);
  await n.poll();
  await n.poll();
  assert.deepEqual([n.outbox().length, n.app.runs.length, n.turns()], [1, 0, []]);
  assert.equal((await n.exchange()).length, 1);
});

test("an attempt older than RELAY_MAX_AGE_MS is never relayed, logged once, and not scanned again", (t) => {
  const n = relayNode(t);
  const id = n.add();
  n.seed(id, { attemptedAt: n.deps().now!() - RELAY_MAX_AGE_MS - 1 });
  n.sweep();
  markRelayDue(FORK_OWNER);
  n.sweep();
  assert.deepEqual([n.outbox(), getProxied(n.paths.inbox, id), only(n).state], [[], null, "completed"]);
  assert.equal(held(n, "fork-relay-stale").length, 1);
});

test("guard 13 before admission: without proof on the current connection no claim, no helper, no turn", async (t) => {
  const n = relayNode(t);
  n.add();
  n.capability(null);
  await n.poll();
  await n.poll();
  assert.deepEqual([forkAttempts(n.paths, FORK_OWNER).length, n.app.runs.length, n.turns(), n.outbox()], [0, 0, [], []]);
  assert.deepEqual(n.logs.filter((line) => line.includes("before admission: fork-relay-unsupported")).length, 1);
});

test("a Worker refusal of the proxy: relayedAt at the next sweep, no relaunch, no failure notice for the owner", async (t) => {
  const n = relayNode(t);
  const id = n.add();
  n.seed(id);
  n.sweep();
  const relay = only(n).relayMessageId!;
  assert.equal((await n.exchange()).length, 1);
  await n.status(relay, "refused", "reply depth exceeded");
  n.sweep();
  assert.deepEqual([only(n).state, typeof only(n).relayedAt, n.app.runs.length, n.outbox()], ["completed", "number", 0, []]);
  assert.equal(getSent(n.paths, relay)?.state, "refused");
  assert.equal(getMessage(n.paths.inbox, id)?.state, "accepted");
  assert.deepEqual(unnoticedNotices(n.paths, [FORK_OWNER]), { failures: [], receipts: [] });
});
