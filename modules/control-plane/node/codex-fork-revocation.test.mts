import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { listenerDir, wakeAudit } from "./autonomy.mts";
import { busyPolicyFingerprint } from "./codex-busy-policy.mts";
import { recheckForkReply } from "./codex-fork-admission.mts";
import { forkAttempts, forkAttemptsPath } from "./codex-fork-attempts.mts";
import { FORK_ID, FORK_OWNER, forkNode, PEER } from "./codex-fork-fixture.mts";
import { relayNode } from "./codex-fork-relay-fixture.mts";
import { forkTestTimeouts, resetForkFeatureCache } from "./codex-fork-reply.mts";
import { FAST, runFork } from "./codex-fork-run-fixture.mts";
import { resetMcpCache } from "./codex-mcp.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import { readPolicy } from "./policy.mts";
import { serviceAdmissionsIdle } from "./service-drain.mts";
import { testServiceOwner, T0 } from "./task-fixture.mts";

type Node = ReturnType<typeof forkNode>;
const poll = async (n: Node, deps = n.deps()): Promise<void> => { pollCodexQueue(deps); await codexQueueIdle(); };
const outbox = (n: Node): string[] => fs.existsSync(n.paths.outbox) ? fs.readdirSync(n.paths.outbox) : [];
const budgetFile = (n: Node): string => path.join(listenerDir(n.paths), `${FORK_OWNER}.turns.json`);
const policyText = (n: Pick<Node, "paths">): string => fs.readFileSync(n.paths.policy, "utf8");
function revoke(n: Pick<Node, "paths">): void {
  const policy = JSON.parse(policyText(n));
  delete policy.wake.codexFork;
  fs.writeFileSync(n.paths.policy, JSON.stringify(policy));
}
function addBound(n: Pick<Node, "paths">): string {
  const id = crypto.randomUUID(), from = { ...PEER, session: crypto.randomUUID() };
  storeMessage(n.paths.inbox, { messageId: id, from, toSession: FORK_OWNER, text: "Synthetic S18 original",
    createdAt: new Date(T0).toISOString(), senderOrigin:{nodeId:from.nodeId,sentAt:new Date(T0).toISOString()}, binding: { version: 1, mode: "exact",
      from: { sessionId: from.session, runtime: "codex", lifecycleGeneration: null },
      to: { sessionId: FORK_OWNER, runtime: "codex", lifecycleGeneration: 7 },
      leaseId: crypto.randomUUID(), localGeneration: null } }, T0);
  return id;
}

test.beforeEach(() => { resetMcpCache(); resetForkFeatureCache(); forkTestTimeouts.value = FAST; });
test.after(() => { forkTestTimeouts.value = undefined; });

const REQUESTS: [string, string, string | undefined, string][] = [
  ["initialize", "initialize", undefined, "thread/read"],
  ["owner read", "thread/read", FORK_OWNER, "thread/turns/list"],
  ["owner turns", "thread/turns/list", FORK_OWNER, "thread/goal/get"],
  ["owner goal", "thread/goal/get", FORK_OWNER, "thread/fork"],
  ["fork response", "thread/fork", FORK_OWNER, "thread/goal/get:fork"],
  ["fork goal", "thread/goal/get", FORK_ID, "turn/start"],
  ["submitted turn", "turn/start", FORK_ID, "second turn/start"],
];
for (const [name, method, threadId, forbidden] of REQUESTS) {
  test(`S18: revocation at ${name} vetoes the next action, stays terminal and preserves the original`, async t => {
    let reached = 0;
    const n = forkNode(t, { hang: method === "turn/start", onRequest: (m, p) => {
      if (m === method && (threadId === undefined || p.threadId === threadId)) { reached++; revoke(n); }
    } });
    const saved = policyText(n), id = addBound(n), original = getMessage(n.paths.inbox, id);
    await poll(n);
    assert.equal(reached, 1);
    const run = n.app.runs[0]!;
    const matching = run.requests.filter(r => forbidden === "thread/goal/get:fork"
      ? r.method === "thread/goal/get" && r.params?.threadId === FORK_ID : r.method === forbidden);
    assert.deepEqual(matching, []);
    assert.equal(run.requests.filter(r => r.method === "turn/start").length, method === "turn/start" ? 1 : 0);
    if (method === "turn/start") assert.ok(run.requests.some(r => r.method === "turn/interrupt"));
    assert.ok(run.ended);
    assert.equal(serviceAdmissionsIdle(n.paths, testServiceOwner), true);
    assert.deepEqual(forkAttempts(n.paths, FORK_OWNER).map(a => [a.state, a.answer]), [["superseded", undefined]]);
    assert.deepEqual(getMessage(n.paths.inbox, id), original);
    assert.deepEqual(outbox(n), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(budgetFile(n), "utf8")).turns, [T0]);
    fs.writeFileSync(n.paths.policy, saved);
    await poll(n);
    assert.equal(n.app.runs.length, 1, "restoring permission never retries a withdrawn claim");
    assert.deepEqual(outbox(n), []);
  });
}

for (const boundary of ["completion", "shutdown"] as const) {
  test(`S18: revocation during ${boundary} discards the completed answer`, async t => {
    let reached = false;
    const cancel = (): [] => { reached = true; revoke(n); return []; };
    const n = forkNode(t, boundary === "completion" ? { afterCompleted: cancel } : { onClose: cancel });
    const id = addBound(n), before = getMessage(n.paths.inbox, id);
    await poll(n);
    assert.equal(reached, true);
    assert.equal(n.app.runs[0]!.requests.filter(r => r.method === "turn/start").length, 1);
    assert.ok(n.app.runs[0]!.ended);
    assert.deepEqual(forkAttempts(n.paths, FORK_OWNER).map(a => [a.state, a.answer, a.forkId]), [["superseded", undefined, FORK_ID]]);
    assert.deepEqual(getMessage(n.paths.inbox, id), before);
    await poll(n);
    assert.deepEqual(outbox(n), []);
  });
}

test("S18: a failing fresh hook guard is latched even when shutdown restores it", async t => {
  let fail = false, restored = false;
  const n = forkNode(t, { onRequest: m => { if (m === "thread/read") fail = true; },
    onClose: () => { fail = false; restored = true; return []; } });
  const id = addBound(n), before = getMessage(n.paths.inbox, id);
  await poll(n, n.deps({ postToolHook: () => { if (fail) throw new Error("synthetic guard failure"); return true; } }));
  assert.equal(restored, true);
  assert.deepEqual(forkAttempts(n.paths, FORK_OWNER).map(a => [a.state, a.answer]), [["superseded", undefined]]);
  assert.ok(!n.app.runs[0]!.requests.some(r => r.method === "thread/fork"));
  assert.deepEqual(getMessage(n.paths.inbox, id), before);
});

test("S18: producer persistence rechecks the capability after the runner's confirmed-close check", async t => {
  let closed = false, checks = 0;
  const n = forkNode(t, { onClose: () => { closed = true; return []; } });
  addBound(n);
  await poll(n, { ...n.deps(), workerCapabilities: () => {
    if (closed && ++checks === 2) throw new Error("synthetic capability failure");
    return ["messaging.proxy.v1"];
  } });
  assert.equal(checks, 2, "runner and producer both recheck after close");
  assert.deepEqual(forkAttempts(n.paths, FORK_OWNER).map(a => [a.state, a.answer]), [["superseded", undefined]]);
  assert.deepEqual(outbox(n), []);
});

test("S18: stable allowed continuation rechecks never debit budget or rewrite the claimed attempt", async t => {
  let checked = false;
  const n = forkNode(t, { onRequest: method => {
    if (method !== "thread/read") return;
    const beforeBudget = fs.readFileSync(budgetFile(n)), dir = forkAttemptsPath(n.paths, FORK_OWNER);
    const file = path.join(dir, fs.readdirSync(dir).find(p => p.endsWith(".json"))!);
    const beforeAttempt = fs.readFileSync(file);
    const fingerprint = busyPolicyFingerprint(readPolicy(n.paths.policy, true)!);
    for (let i = 0; i < 3; i++) assert.deepEqual(recheckForkReply({ paths: n.paths, now: () => T0, platform: "darwin",
      postToolHook: () => true }, FORK_OWNER, id, fingerprint), { ok: true, cwd: n.cwd });
    assert.deepEqual(fs.readFileSync(budgetFile(n)), beforeBudget);
    assert.deepEqual(fs.readFileSync(file), beforeAttempt);
    checked = true;
  } });
  const id = addBound(n), before = getMessage(n.paths.inbox, id);
  await poll(n);
  assert.equal(checked, true);
  assert.deepEqual(forkAttempts(n.paths, FORK_OWNER).map(a => a.state), ["completed"]);
  assert.equal(n.app.runs[0]!.requests.filter(r => r.method === "turn/start").length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(budgetFile(n), "utf8")).turns, [T0]);
  assert.deepEqual(getMessage(n.paths.inbox, id), before);
  await poll(n);
  assert.equal(outbox(n).length, 1);
  assert.equal(n.app.runs.length, 1);
});

test("S18: runner refuses a throwing continuation before spawning", async t => {
  const r = await runFork(t, {}, { continueAllowed: () => { throw new Error("synthetic"); } });
  assert.deepEqual(r.outcome, { state: "superseded", from: "launching" });
  assert.deepEqual(r.app.runs, []);
});

test("S18: unconfirmed shutdown dominates revocation and keeps service admission", async t => {
  let revoked = false;
  const r = await runFork(t, { ignoreEnd: true, neverExit: true,
    onRequest: m => { if (m === "turn/start") revoked = true; } }, { continueAllowed: () => !revoked });
  assert.deepEqual(r.outcome, { state: "uncertain", from: "running", reason: "close-unconfirmed" });
  assert.equal(serviceAdmissionsIdle(r.paths, testServiceOwner), false);
  assert.ok(r.methods().includes("turn/interrupt"));
  assert.equal(r.unconfirmed(), 1);
});

test("S18: existing sweep and exchange gates hold answers after later permission revocation", async t => {
  for (const queued of [false, true]) {
    const n = relayNode(t), id = addBound(n), before = getMessage(n.paths.inbox, id);
    n.seed(id);
    if (queued) n.sweep();
    assert.equal(n.outbox().length, queued ? 1 : 0);
    revoke(n);
    n.sweep();
    assert.equal(n.outbox().length, queued ? 1 : 0, "held retention is unchanged");
    assert.deepEqual(await n.exchange(), []);
    assert.deepEqual([n.app.runs.length, n.turns(), n.attempt(id).state], [0, [], "completed"]);
    assert.deepEqual(getMessage(n.paths.inbox, id), before);
  }
});

for (const boundary of ["cwd change", "capability removal", "unreadable policy"] as const) {
  test(`S18: fresh ${boundary} after admission refuses the existing helper`, async t => {
    let revoked = false;
    const n = forkNode(t, { onRequest: method => {
      if (method !== "thread/read") return;
      revoked = true;
      if (boundary === "unreadable policy") fs.writeFileSync(n.paths.policy, "{invalid");
      if (boundary === "cwd change") {
        const next = path.join(n.cwd, "next");
        fs.mkdirSync(next);
        const file = path.join(n.paths.codexSessions, `${FORK_OWNER}.json`);
        const session = JSON.parse(fs.readFileSync(file, "utf8"));
        session.cwd = next;
        fs.writeFileSync(file, JSON.stringify(session));
      }
    } });
    const id = addBound(n), before = getMessage(n.paths.inbox, id);
    await poll(n, { ...n.deps(), workerCapabilities: () => boundary === "capability removal" && revoked ? [] : ["messaging.proxy.v1"] });
    assert.equal(revoked, true);
    assert.deepEqual(forkAttempts(n.paths, FORK_OWNER).map(a => [a.state, a.answer]), [["superseded", undefined]]);
    assert.ok(!n.app.runs[0]!.requests.some(r => r.method === "thread/fork"));
    assert.ok(n.app.runs[0]!.ended);
    assert.deepEqual(getMessage(n.paths.inbox, id), before);
  });
}

test("S18: a watch violation during revoked shutdown dominates superseded", async t => {
  let revoked = false;
  const r = await runFork(t, { onRequest: m => { if (m === "thread/read") revoked = true; },
    onClose: fork => [{ id: 950, method: "item/tool/requestUserInput", params: { threadId: fork } }] },
  { continueAllowed: () => !revoked });
  assert.deepEqual(r.outcome, { state: "failed", from: "launching", reason: "server-request" });
  assert.equal(r.run.ended, true);
  assert.deepEqual(r.run.signals, ["SIGKILL"]);
});

for (const boundary of ["mcpList", "featuresList"] as const) test(`S18: pre-admission ${boundary} wait observes revocation before any claim or turn`, { timeout: 10_000 }, async t => {
  const n = forkNode(t), id = addBound(n), original = getMessage(n.paths.inbox, id);
  const file = path.join(n.paths.inbox, "bound-v1", `${id}.json`), bytes = fs.readFileSync(file);
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  t.after(() => resume.resolve());
  const deps = n.deps({ [boundary]: async (args: string[]) => {
    entered.resolve(); await resume.promise; return n.codex[boundary]!(args);
  } });
  pollCodexQueue(deps);
  await entered.promise;
  assert.deepEqual(n.app.runs, []); assert.deepEqual(forkAttempts(n.paths, FORK_OWNER), []);
  assert.equal(fs.existsSync(budgetFile(n)), false);
  assert.equal(serviceAdmissionsIdle(n.paths, testServiceOwner), false);
  revoke(n); resume.resolve();
  await codexQueueIdle();
  assert.deepEqual(n.app.runs, []); assert.deepEqual(forkAttempts(n.paths, FORK_OWNER), []);
  assert.equal(fs.existsSync(budgetFile(n)), false);
  assert.deepEqual(outbox(n), []);
  assert.deepEqual(getMessage(n.paths.inbox, id), original); assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(serviceAdmissionsIdle(n.paths, testServiceOwner), true);
  const actions = fs.readFileSync(wakeAudit(n.paths), "utf8").trim().split("\n").map(line => JSON.parse(line).action);
  assert.deepEqual(actions.filter(action => action.startsWith("fork-")), ["fork-off"]);
  await poll(n);
  assert.deepEqual(forkAttempts(n.paths, FORK_OWNER), []); assert.deepEqual(n.app.runs, []);
  assert.deepEqual(fs.readFileSync(file), bytes);
});
