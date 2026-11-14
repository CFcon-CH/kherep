// Issue #919: a held, idle-loaded Codex thread whose hook record is older than the
// 12 h window is a native queue candidate while a message waits for it; every
// other refusal of the native producer shows its cause in `msg status`.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { takeTurn, TURN_SPACING_MS } from "./autonomy.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { nativeQueueNode as fixture, NATIVE_OWNER as OWNER } from "./codex-queue-producer-fixture.mts";
import { CODEX_ACTIVE_MS, codexSessionName, recordCodexSession } from "./codex-sessions.mts";
import { getMessage, getMessageDiagnostic, getMessageProgress, type InboxRecord } from "./inbox.mts";
import { runMsg } from "./msg-cli.mts";
import { publishSynthetic } from "./session-authority-fixture.mts";
import { T0 } from "./task-fixture.mts";

const STALE = T0 - CODEX_ACTIVE_MS - 1;
type Node = ReturnType<typeof fixture>;
const attempts = (node: Node) => path.join(node.paths.dir, "codex-native-attempts", node.owner);
const cause = (node: Node, id: string) => {
  const progress = getMessageProgress(node.paths.inbox, id), diagnostic = getMessageDiagnostic(node.paths.inbox, id);
  return [progress?.phase, progress?.code, diagnostic?.kind === "blocker" ? diagnostic.code : undefined, diagnostic?.observedState];
};
async function status(node: Node, id: string): Promise<string> {
  const lines: string[] = [];
  assert.equal(await runMsg(["status", id], { paths: node.paths, env: {}, now: () => node.deps().now!(),
    out: line => lines.push(line), err: line => assert.fail(line) }), 0);
  return lines.join("\n");
}

test("T1: a held idle-loaded thread past the 12 h window gets one native pointer", async (t) => {
  const node = fixture(t, OWNER, { seenAt: STALE, state: "idle-loaded" });
  const id = node.add();
  await node.poll();
  assert.equal(node.fake.runs().length, 1);
  assert.equal(node.fake.runs()[0]!.argv[2], OWNER);
  assert.equal(JSON.parse(fs.readFileSync(path.join(attempts(node), `${id}.json`), "utf8")).state, "submitted");
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
});

test("T2: the stale pointer is offered at most once across polls and fresh deps", async (t) => {
  const node = fixture(t, OWNER, { seenAt: STALE, state: "idle-loaded" });
  node.add();
  for (let round = 0; round < 4; round++) await node.poll();
  pollCodexQueue({ ...node.deps() });
  await codexQueueIdle();
  assert.equal(node.fake.runs().length, 1);
});

test("T3: a stale running thread is not woken and shows target-not-idle", async (t) => {
  const node = fixture(t, OWNER, { seenAt: STALE, state: "running" });
  const id = node.add();
  await node.poll();
  assert.equal(node.fake.runs().length, 0);
  assert.equal(fs.existsSync(attempts(node)), false);
  assert.deepEqual(cause(node, id), ["waiting", "awaiting-user-turn", "target-not-idle", "running"]);
  assert.match(await status(node, id), /Waiting: target idle-loaded state was not established/);
});

test("T4: a stale thread without fresh evidence shows an unknown target state", async (t) => {
  const node = fixture(t, OWNER, { seenAt: STALE, state: "unknown" });
  const id = node.add();
  await node.poll();
  assert.equal(node.fake.runs().length, 0);
  assert.deepEqual(cause(node, id), ["waiting", "awaiting-user-turn", "target-not-idle", "unknown"]);
  assert.match(await status(node, id), /Target state is unknown; idle-loaded was not established/);
});

test("T5: a parked in-window message is offered once when the verdict turns idle-loaded", async (t) => {
  const node = fixture(t, OWNER, { state: "unknown" });
  const id = node.add();
  await node.poll();
  assert.equal(node.fake.runs().length, 0);
  assert.deepEqual(cause(node, id), ["waiting", "awaiting-user-turn", "target-not-idle", "unknown"]);
  node.publish("idle-loaded");
  await node.poll();
  assert.equal(node.fake.runs().length, 1);
  await node.poll();
  assert.equal(node.fake.runs().length, 1);
});

test("T6: parked, the record ages past 12 h, the verdict turns idle-loaded: exactly one pointer", async (t) => {
  const node = fixture(t, OWNER, { state: "unknown" });
  node.add();
  await node.poll();
  assert.equal(node.fake.runs().length, 0);
  node.tick(CODEX_ACTIVE_MS + 1);
  node.publish("idle-loaded");
  await node.poll();
  assert.equal(node.fake.runs().length, 1);
  await node.poll();
  assert.equal(node.fake.runs().length, 1);
});

test("T7: the stale running cause is written once and does not flip between rounds", async (t) => {
  const node = fixture(t, OWNER, { seenAt: STALE, state: "running" });
  const id = node.add();
  let second: string | undefined;
  for (let round = 1; round <= 5; round++) {
    node.tick(2_000);
    node.publish("running");
    await node.poll();
    if (round === 2) second = getMessageProgress(node.paths.inbox, id)?.observedAt;
  }
  assert.equal(node.fake.runs().length, 0);
  assert.ok(second);
  assert.equal(getMessageProgress(node.paths.inbox, id)?.observedAt, second);
});

test("T8: a stale idle-loaded thread addressed by name only gets the CP hint, no native pointer", async (t) => {
  const node = fixture(t, OWNER, { seenAt: STALE, state: "idle-loaded" });
  const id = node.add("Public alias message", codexSessionName(OWNER));
  await node.poll();
  assert.equal(node.fake.runs().length, 0);
  assert.ok(fs.existsSync(path.join(node.paths.dir, "listeners", `${OWNER}.busy-admission.json`)));
  assert.deepEqual(cause(node, id).slice(0, 2), ["waiting", "awaiting-user-turn"]);
});

test("T9: wake.codexApp never grants a stale thread (amendment A1)", async (t) => {
  for (const inWindowApp of [true, false]) await t.test(String(inWindowApp), async (sub) => {
    const node = fixture(sub, OWNER, { seenAt: STALE, state: "idle-loaded" });
    const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8"));
    policy.wake = { enabled: true, sessions: [], codexApp: true, nativeQueue: true };
    fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
    const other = "01a0db01-0000-7000-8000-000000000002";
    const dir = path.join(node.home, "sessions", "2026", "10", "14");
    fs.mkdirSync(dir, { recursive: true });
    for (const id of inWindowApp ? [OWNER, other] : [OWNER]) fs.writeFileSync(path.join(dir, `rollout-${id}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { id, originator: "Codex Desktop", source: "vscode" } }) + "\n");
    if (inWindowApp) recordCodexSession(node.paths, other, node.workspace, T0, "default");
    const id = node.add();
    await node.poll();
    assert.equal(node.fake.runs().length, 0);
    assert.deepEqual(cause(node, id).slice(0, 2), ["waiting", "wake-not-authorized"]);
  });
});

test("T10: no accepted message outside the window reads no session file", async (t) => {
  const node = fixture(t);
  const { staleCodexTargets } = await import("./codex-queue-stale.mts");
  let reads = 0;
  const paths = new Proxy(node.paths, { get: (target, key) => {
    if (key === "sessions" || key === "codexSessions") reads++;
    return Reflect.get(target, key);
  } });
  const records = [{ messageId: "a", toSession: OWNER, state: "accepted" }, { messageId: "b", toSession: "codex-elsewhere", state: "delivered" }] as InboxRecord[];
  assert.deepEqual(staleCodexTargets(paths, records, [OWNER], new Set(), T0), { idle: [], parked: [] });
  assert.equal(reads, 0);
});

test("T11: turn spacing on an admitted thread shows retry-pending with turn-spacing, stable", async (t) => {
  const node = fixture(t);
  const id = node.add();
  takeTurn(node.paths, OWNER, T0);
  await node.poll();
  await node.poll();
  assert.equal(node.fake.runs().length, 0);
  assert.deepEqual(cause(node, id).slice(0, 3), ["waiting", "retry-pending", "turn-spacing"]);
  const observed = getMessageProgress(node.paths.inbox, id)?.observedAt;
  await node.poll();
  assert.equal(getMessageProgress(node.paths.inbox, id)?.observedAt, observed);
  assert.ok(TURN_SPACING_MS > 0);
});

test("T12: a missing Codex executable shows runtime-pending", async (t) => {
  const node = fixture(t);
  const id = node.add();
  for (let round = 0; round < 2; round++) {
    const deps = node.deps();
    deps.codex!.findCodex = () => null;
    pollCodexQueue(deps);
    await codexQueueIdle();
  }
  assert.equal(node.fake.runs().length, 0);
  assert.deepEqual(cause(node, id).slice(0, 3), ["waiting", "awaiting-user-turn", "runtime-pending"]);
});

test("T13: livenessAdmissionVerdict returns the admitted state and livenessAdmission its generation", async (t) => {
  const { livenessAdmission, livenessAdmissionVerdict } = await import("./session-lifecycle.mts");
  const node = fixture(t);
  const target = { runtime: "codex", sessionId: OWNER };
  for (const state of ["running", "idle-loaded"] as const) {
    node.publish(state);
    const authority = node.deps().livenessAuthority;
    const verdict = livenessAdmissionVerdict(node.paths, target, "queue", T0, undefined, authority);
    assert.equal(verdict?.state, state);
    assert.equal(livenessAdmission(node.paths, target, "queue", T0, undefined, authority), verdict?.generation);
  }
  const authority = publishSynthetic(node.paths, [{ ...target, holder: { status: "value", value: { present: true, creationIdentity: "synthetic-holder" },
    source: "native-holder", observedAt: T0, complete: true, reasonCode: "observed" } }], T0, [{ ...target, state: "reachable-probable" }]);
  assert.equal(livenessAdmissionVerdict(node.paths, target, "queue", T0, undefined, authority), null);
  assert.equal(livenessAdmission(node.paths, target, "queue", T0, undefined, authority), null);
});
