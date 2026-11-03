import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { listenerDir, wakeAudit } from "./autonomy.mts";
import { advanceForkAttempt, claimForkAttempt, forkAttempts, forkAttemptsPath, recoverForkAttempts } from "./codex-fork-attempts.mts";
import { ANSWER, FORK_ID, FORK_OWNER, forkNode, LAST_TURN, PEER } from "./codex-fork-fixture.mts";
import { forkTestTimeouts, resetForkFeatureCache } from "./codex-fork-reply.mts";
import { FAST } from "./codex-fork-run-fixture.mts";
import { resetMcpCache } from "./codex-mcp.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import { T0 } from "./task-fixture.mts";

// Issue #408, PR 3: the fork reply producer through the real poll and lane
// (design sections 6 and 12), against the fake app-server only.

test.beforeEach(() => { resetMcpCache(); resetForkFeatureCache(); forkTestTimeouts.value = FAST; });
test.after(() => { forkTestTimeouts.value = undefined; });

type Node = ReturnType<typeof forkNode>;
const poll = async (f: Node, platform?: string): Promise<void> => {
  pollCodexQueue({ ...f.deps(), ...(platform ? { platform: platform as NodeJS.Platform } : {}) });
  await codexQueueIdle();
};
const forkAudit = (f: Node): { action: string; messageIds: string[] }[] => (fs.existsSync(wakeAudit(f.paths))
  ? fs.readFileSync(wakeAudit(f.paths), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [])
  .filter((line) => String(line.action).startsWith("fork"));
const turns = (f: Node): number[] => {
  const file = path.join(listenerDir(f.paths), `${FORK_OWNER}.turns.json`);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { turns: number[] }).turns : [];
};

test("S18: revoking codexFork at owner thread/read prevents the later fork turn", async t => {
  let revoked = false;
  const f = forkNode(t, { onRequest: (method, params) => {
    if (method !== "thread/read" || params.threadId !== FORK_OWNER) return;
    const policy = JSON.parse(fs.readFileSync(f.paths.policy, "utf8"));
    delete policy.wake.codexFork;
    fs.writeFileSync(f.paths.policy, JSON.stringify(policy));
    revoked = true;
  } });
  const id = crypto.randomUUID(), from = { ...PEER, session: crypto.randomUUID() };
  storeMessage(f.paths.inbox, { messageId: id, from, toSession: FORK_OWNER, text: "Synthetic S18 exact-owner content",
    createdAt: new Date(T0).toISOString(), binding: { version: 1, mode: "exact",
      from: { sessionId: from.session, runtime: "codex", lifecycleGeneration: null },
      to: { sessionId: FORK_OWNER, runtime: "codex", lifecycleGeneration: null },
      leaseId: crypto.randomUUID(), localGeneration: null } }, T0);
  const before = getMessage(f.paths.inbox, id);
  await poll(f);
  const requests = f.app.runs.flatMap(run => run.requests);
  const attempts = forkAttempts(f.paths, FORK_OWNER);
  const outbox = fs.existsSync(f.paths.outbox) ? fs.readdirSync(f.paths.outbox) : [];
  t.diagnostic(JSON.stringify({ boundary: "owner thread/read", revoked, requests,
    attempts: attempts.map(a => ({ state: a.state, answer: a.answer })), outbox,
    inboxUnchanged: JSON.stringify(getMessage(f.paths.inbox, id)) === JSON.stringify(before) }));
  assert.equal(revoked, true, "the real scheduler reached the revocation callback");
  assert.equal(f.app.runs.length, 1, "an already-admitted synthetic helper is allowed");
  assert.deepEqual(getMessage(f.paths.inbox, id), before, "the exact bound original stays accepted and unchanged");
  assert.ok(!requests.some(request => request.method === "turn/start"), "revoked permission must veto a later turn/start");
  assert.ok(attempts.every(attempt => attempt.answer === undefined), "no answer is retained after revocation");
  assert.deepEqual(outbox, [], "no answer is queued after revocation");
});

test("with wake.codexFork absent nothing is read, started, written or audited (design section 12)", async (t) => {
  const f = forkNode(t, {}, { fork: false });
  f.add();
  const deps = f.deps();
  // The section added on disk after the policy was loaded: only deps.policy counts.
  const policy = JSON.parse(fs.readFileSync(f.paths.policy, "utf8"));
  policy.wake.codexFork = { enabled: true, sessions: [FORK_OWNER] };
  fs.writeFileSync(f.paths.policy, JSON.stringify(policy));
  pollCodexQueue(deps);
  await codexQueueIdle();
  assert.deepEqual(f.app.runs, []);
  assert.deepEqual(f.calls, [], "no codex features list or mcp list");
  assert.equal(fs.existsSync(path.join(f.paths.dir, "codex-fork-attempts")), false);
  assert.deepEqual(forkAudit(f), []);
  assert.deepEqual(turns(f), [], "no budget spent");
  assert.deepEqual(recoverForkAttempts(f.paths, T0), { recovered: 0, unreadable: [] });
});

test("an opt-in written after a poll without it is claimed at the next poll; an opt-out stops it (issue #444)", async (t) => {
  const f = forkNode(t, {}, { fork: false });
  const id = f.add();
  await poll(f);
  assert.deepEqual([f.app.runs.length, forkAttempts(f.paths, FORK_OWNER).length, forkAudit(f)], [0, 0, []]);
  // The fixture's deps() reloads the file per poll, as the daemon's exchange round does.
  const policy = JSON.parse(fs.readFileSync(f.paths.policy, "utf8"));
  policy.wake.codexFork = { enabled: true, sessions: [FORK_OWNER] };
  fs.writeFileSync(f.paths.policy, JSON.stringify(policy));
  await poll(f);
  assert.equal(f.app.runs.length, 1);
  assert.deepEqual(forkAttempts(f.paths, FORK_OWNER).map((a) => [a.messageId, a.state]), [[id, "completed"]]);
  assert.deepEqual(forkAudit(f).map((line) => [line.action, line.messageIds]), [["fork", [id]]]);
  assert.deepEqual(turns(f), [T0]);
  delete policy.wake.codexFork;
  fs.writeFileSync(f.paths.policy, JSON.stringify(policy));
  f.add();
  await poll(f);
  await poll(f);
  assert.deepEqual([f.app.runs.length, forkAttempts(f.paths, FORK_OWNER).length, forkAudit(f).length], [1, 1, 1], "opt-out at the next poll");
});

test("on another platform the only effect is one fork-disabled-platform line per message", async (t) => {
  const f = forkNode(t);
  const id = f.add();
  await poll(f, "win32");
  await poll(f, "win32");
  assert.deepEqual(forkAudit(f), [{ ...forkAudit(f)[0]!, action: "fork-disabled-platform", messageIds: [id] }]);
  assert.deepEqual([f.app.runs, f.calls, turns(f)], [[], [], []]);
  assert.equal(fs.existsSync(path.join(f.paths.dir, "codex-fork-attempts")), false);
});

test("an owner without idle evidence gets fork-not-idle once, no helper and no spent turn", async (t) => {
  const f = forkNode(t);
  const id = f.add();
  recordCodexSession(f.paths, FORK_OWNER, f.cwd, T0 - 60_000, "default", "UserPromptSubmit");
  await poll(f);
  await poll(f);
  assert.deepEqual(forkAudit(f).map((line) => [line.action, line.messageIds]), [["fork-not-idle", [id]]]);
  assert.deepEqual([f.app.runs.length, turns(f)], [0, []]);
});

test("an idle opted-in owner: one helper, the answer stored, relayed by the next sweep, nothing else changed", async (t) => {
  const f = forkNode(t);
  const id = f.add();
  const session = fs.readFileSync(path.join(f.paths.codexSessions, `${FORK_OWNER}.json`), "utf8");
  await poll(f);
  assert.equal(f.app.runs.length, 1);
  assert.ok(f.app.runs[0]!.ended, "codexQueueIdle resolves only after the helper closed");
  const [attempt] = forkAttempts(f.paths, FORK_OWNER);
  assert.deepEqual([attempt?.messageId, attempt?.state, attempt?.answer, attempt?.lastTurnId, attempt?.forkId, attempt?.reason,
    attempt?.goalProof], [id, "completed", JSON.parse(ANSWER).text, LAST_TURN, FORK_ID, undefined, "ephemeral-gate"], "T16");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(forkAttemptsPath(f.paths, FORK_OWNER), `${id}.json`)).mode & 0o777, 0o600);
  }
  assert.deepEqual(forkAudit(f).map((line) => [line.action, line.messageIds]), [["fork", [id]]], "fork-relayed waits for the Worker");
  assert.deepEqual(Object.keys(forkAudit(f)[0]!), ["ts", "sessionId", "messageIds", "action"], "metadata only");
  assert.equal(getMessage(f.paths.inbox, id)?.state, "accepted", "the owner still reads it");
  assert.equal(fs.readFileSync(path.join(f.paths.codexSessions, `${FORK_OWNER}.json`), "utf8"), session);
  assert.deepEqual(fs.existsSync(f.paths.outbox) ? fs.readdirSync(f.paths.outbox) : [], [], "the fork's own poll writes nothing");
  assert.deepEqual(turns(f), [T0], "one turn of the owner's budget");
  await poll(f);
  const relay = forkAttempts(f.paths, FORK_OWNER)[0]?.relayMessageId;
  assert.deepEqual(fs.readdirSync(f.paths.outbox), [`${relay}.json`], "one proxy answer (PR 4), written by the next sweep");
  assert.equal(f.app.runs.length, 1, "one attempt per message across polls");
  assert.deepEqual(turns(f), [T0]);
});

test("T17: a goal on the fork: the attempt is failed with reason fork-goal and its detail, no turn, helper closed", async (t) => {
  const f = forkNode(t, { forkGoalReply: { result: { goal: { threadId: FORK_ID, status: "active" } } } });
  const id = f.add();
  await poll(f);
  const [attempt] = forkAttempts(f.paths, FORK_OWNER);
  assert.deepEqual([attempt?.state, attempt?.reason, attempt?.detail, attempt?.forkId, attempt?.goalProof, attempt?.answer],
    ["failed", "fork-goal", "fork-has-goal", undefined, undefined, undefined]);
  assert.ok(!f.app.runs[0]!.requests.some((m) => m.method === "turn/start"));
  assert.ok(f.app.runs[0]!.ended);
  assert.deepEqual(forkAudit(f).map((line) => [line.action, line.messageIds]), [["fork-failed", [id]]]);
});

test("a running attempt carries the fork id, the cutoff turn and the goal proof together; the audit only ids", async (t) => {
  const f = forkNode(t, { hang: true });
  const id = f.add();
  await poll(f);
  const [attempt] = forkAttempts(f.paths, FORK_OWNER);
  assert.deepEqual([attempt?.state, attempt?.reason, attempt?.forkId, attempt?.lastTurnId, attempt?.goalProof, attempt?.answer],
    ["uncertain", "turn-timeout", FORK_ID, LAST_TURN, "ephemeral-gate", undefined]);
  const audit = fs.readFileSync(wakeAudit(f.paths), "utf8");
  assert.deepEqual(forkAudit(f).map((line) => [line.action, line.messageIds]), [["fork-uncertain", [id]]]);
  for (const text of ["ephemeral thread", "turn-timeout", "ephemeral-gate", FORK_ID, "Is the build green"]) {
    assert.equal(audit.includes(text), false, `the audit carries no ${text}`);
  }
});

test("a thread/fork RPC error fails closed: fork-rejected, no text kept, no turn, a clean helper exit", async (t) => {
  const error = { code: -32600, message: "", data: { canary: "data-canary-7f3a" } };
  const f = forkNode(t, { errors: { "thread/fork": error } });
  // #477: the canary set; the fake reads the error when it answers, after the node exists.
  error.message = `synthetic -32600 refusal text of ${FORK_OWNER} at ${f.cwd} home ${f.home} with token sk-live_Secret1, /private/path`
    + " and C:\\Users\\canary\\secret.txt asked: Is the build green?";
  const id = f.add();
  const logs: string[] = [];
  for (let round = 0; round < 2; round++) {
    pollCodexQueue(f.deps(), (line) => { logs.push(line); });
    await codexQueueIdle();
  }
  const [attempt] = forkAttempts(f.paths, FORK_OWNER);
  assert.deepEqual([attempt?.state, attempt?.reason, attempt?.detail, attempt?.forkId, attempt?.lastTurnId],
    ["failed", "fork-rejected", undefined, undefined, undefined], "terminal, never running");
  assert.equal(Object.hasOwn(attempt!, "rpc"), false, "#477: no persisted field");
  const run = f.app.runs[0]!;
  assert.ok(!run.requests.some((m) => m.method === "turn/start"));
  assert.deepEqual([f.app.runs.length, run.ended, run.signals], [1, true, []], "stdin end closed it; no signal");
  const dirs = fs.readdirSync(f.paths.dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(dirs, ["codex-fork-attempts","codex-native-pending","codex-sessions","inbox","listeners","service","target-delivery-groups"],"the required common owner/history are the only added stores");
  const hash = crypto.createHash("sha256").update(error.message, "utf8").digest("hex").slice(0, 12);
  // The test's temporary directory may itself carry the word kherep, then the path is also that mention.
  const kherep = error.message.toLowerCase().includes("kherep") ? ",kherep" : "";
  assert.deepEqual(logs.filter((line) => line.includes("refused")),
    [`kherep-node: Codex fork helper refused thread/fork (code -32600, text, sha256 ${hash}, mentions owner,cwd,codex-home${kherep})`]);
  const outbox = fs.existsSync(f.paths.outbox) ? fs.readdirSync(f.paths.outbox) : [];
  assert.deepEqual([outbox, fs.existsSync(path.join(f.paths.inbox, "proxied"))], [[], false], "nothing relayed");
  const written = fs.readFileSync(path.join(forkAttemptsPath(f.paths, FORK_OWNER), `${id}.json`), "utf8")
    + fs.readFileSync(wakeAudit(f.paths), "utf8");
  for (const text of ["synthetic -32600", "refusal text", "sk-live", "Secret1", "/private/path", "C:\\Users\\canary", "secret.txt",
    "data-canary-7f3a", "Is the build green?"]) {
    assert.equal(written.includes(text), false, text);
    assert.equal(logs.join("\n").includes(text), false, `log: ${text}`);
  }
  for (const text of [FORK_OWNER, f.cwd, f.home]) assert.equal(logs.join("\n").includes(text), false, `log: ${text}`);
  assert.deepEqual(forkAudit(f).map((line) => line.action), ["fork-failed"]);
});

test("after a restart a running attempt is uncertain and the message is never forked again", async (t) => {
  const f = forkNode(t);
  const id = f.add();
  claimForkAttempt(f.paths, { owner: FORK_OWNER, messageId: id, attemptedAt: T0, policyFingerprint: "c".repeat(64), producer: { route: "local" } });
  advanceForkAttempt(f.paths, FORK_OWNER, id, "launching", "running", {}, T0);
  assert.deepEqual(recoverForkAttempts(f.paths, T0 + 1), { recovered: 1, unreadable: [] });
  await poll(f);
  assert.deepEqual(f.app.runs, []);
  assert.deepEqual(forkAttempts(f.paths, FORK_OWNER).map((a) => [a.state, a.reason]), [["uncertain", "helper-exit"]]);
});

test("guards 10 to 12 refuse before admission: no helper, no claim, no spent turn", async (t) => {
  const cases: [string, (f: Node) => Parameters<Node["deps"]>[0]][] = [
    ["features list fails", (f) => { f.features("", 1); return {}; }],
    ["features list unparsable", (f) => { f.features("Name Stage Enabled\n"); return {}; }],
    ["mcp list fails", () => ({ mcpList: async () => ({ code: 1, stdout: "", stderr: "boom" }) })],
    ["no codex", () => ({ findCodex: () => null })],
    ["not a native executable", (f) => { fs.writeFileSync(f.binary, "#!/bin/sh\n"); return {}; }],
    ["remote route", (f) => { fs.writeFileSync(path.join(f.home, "environments.toml"), ""); return {}; }],
  ];
  for (const [name, setup] of cases) {
    resetMcpCache();
    resetForkFeatureCache();
    const f = forkNode(t);
    f.add();
    const extra = setup(f);
    pollCodexQueue(f.deps(extra));
    await codexQueueIdle();
    assert.deepEqual([f.app.runs.length, forkAttempts(f.paths, FORK_OWNER).length, turns(f)], [0, 0, []], name);
  }
});
