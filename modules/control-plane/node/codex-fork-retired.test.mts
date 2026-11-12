import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { RELAY_MAX_AGE_MS } from "./codex-fork-admission.mts";
import { forkAttempts } from "./codex-fork-attempts.mts";
import { FORK_OWNER } from "./codex-fork-fixture.mts";
import { forkTestTimeouts, resetForkFeatureCache } from "./codex-fork-reply.mts";
import { relayNode } from "./codex-fork-relay-fixture.mts";
import { resetRelayState } from "./codex-fork-relay.mts";
import { FAST } from "./codex-fork-run-fixture.mts";
import { resetMcpCache } from "./codex-mcp.mts";
import { getMessage } from "./inbox.mts";
import { getProxied } from "./inbox-proxied.mts";

// Issue #890 (retirement step R3): the poll starts no Codex fork reply and
// writes no proxy answer, whatever wake.codexFork says. The relay bookkeeping
// still reconciles a stored attempt from inbox/proxied/, without a send.
// The exchange holds every proxy record (daemon-relay-gate.test.mts covers the
// daemon's wiring). Synthetic fixtures only; the fake app-server never runs.

test.beforeEach(() => { resetMcpCache(); resetForkFeatureCache(); forkTestTimeouts.value = FAST; });
test.after(() => { forkTestTimeouts.value = undefined; });

const restart = (): void => { resetRelayState(); resetForkFeatureCache(); resetMcpCache(); };

test("with wake.codexFork set an idle owner and an eligible message start no fork and write no proxy answer, also after a restart", async (t) => {
  const n = relayNode(t);
  assert.deepEqual(n.deps().policy.wake?.codexFork?.sessions, [FORK_OWNER], "the fixture opts the idle owner in");
  const id = n.add();
  for (const round of ["first poll", "second poll", "after a restart"]) {
    if (round === "after a restart") restart();
    await n.poll();
    assert.deepEqual([n.app.runs.length, n.calls.length], [0, 0], `${round}: no app-server, features or MCP list`);
    assert.equal(fs.existsSync(path.join(n.paths.dir, "codex-fork-attempts")), false, `${round}: no attempt claimed`);
    assert.deepEqual([n.outbox(), n.audit(), n.turns()], [[], [], []], `${round}: no proxy record, fork audit or fork turn`);
    assert.equal(getMessage(n.paths.inbox, id)?.state, "accepted", `${round}: the original stays for its owner`);
  }
});

test("a stored completed attempt with a held relay reconciles without a send while wake.codexFork is set", async (t) => {
  const n = relayNode(t);
  const id = n.add();
  // State a node left before the upgrade: a completed attempt and its relay record.
  n.seed(id);
  n.sweep();
  const relay = n.attempt(id).relayMessageId!;
  assert.deepEqual(n.outbox(), [`${relay}.json`]);
  restart();
  n.session({ lastSeen: new Date(n.deps().now!()).toISOString() });
  for (let i = 0; i < 2; i++) await n.poll();
  assert.deepEqual([n.outbox(), n.app.runs.length, n.turns(), n.attempt(id).state], [[`${relay}.json`], 0, [], "completed"],
    "held inside the bound, nothing forked");
  assert.equal(typeof getProxied(n.paths.inbox, id)?.unconfirmedAt, "string", "a previous daemon's record is kept as unconfirmed");
  n.tick(RELAY_MAX_AGE_MS + 1);
  await n.poll();
  assert.deepEqual([n.outbox(), typeof getProxied(n.paths.inbox, id)?.unresolvedAt], [[], "string"], "the bound cleans the record up");
  assert.deepEqual([forkAttempts(n.paths, FORK_OWNER).length, n.attempt(id).state, n.attempt(id).relayedAt], [1, "completed", undefined],
    "the stored attempt stays, never relayed");
  assert.deepEqual([n.app.runs.length, n.turns(), n.audit()], [0, [], []]);
});

test("a stored completed attempt without a relay is never relayed while wake.codexFork is set", async (t) => {
  const n = relayNode(t);
  const id = n.add();
  n.seed(id);
  restart();
  for (let i = 0; i < 2; i++) await n.poll();
  assert.deepEqual([n.outbox(), getProxied(n.paths.inbox, id), n.attempt(id).state, n.attempt(id).relayMessageId],
    [[], null, "completed", undefined]);
  assert.deepEqual([n.app.runs.length, n.turns(), n.audit()], [0, [], []]);
});
