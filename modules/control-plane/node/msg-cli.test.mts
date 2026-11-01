import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { DirectoryBody } from "../protocol-messages.mts";
import { CODEX_ACTIVE_MS, recordCodexSession } from "./codex-sessions.mts";
import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { getOutbox, recordSent, writeDirectory, writeLocalSessions } from "./exchange.mts";
import { getMessage, markDelivered, markOffered, storeMessage } from "./inbox.mts";
import { writeTask } from "./task-records.mts";
import { runMsg } from "./msg-cli.mts";
import { NESTED_RUNTIME, resolveTarget } from "./msg-resolve.mts";
import type { ProcessTable } from "./launch-mode.mts";
import { claudeUnderCodex, codexUnderClaude, NESTED_ENV, THREAD } from "./runtime-fixture.mts";

const SELF = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000cc";
const TWIN = "00000000-0000-4000-8000-0000000000dd";
const INCOMING = "00000000-0000-4000-8000-0000000000e1";
const NOW = Date.UTC(2026, 5, 1);
const ENV = { CLAUDE_CODE_SESSION_ID: "s-self" };

const DIRECTORY: DirectoryBody = {
  nodes: [
    // Issue #441: node-a without intake (an older Worker), node-b not draining, node-c empty.
    { nodeId: SELF, name: "node-a", status: "online" },
    { nodeId: PEER, name: "node-b", status: "online",
      intake: { lastAcceptedAt: new Date(NOW - 25 * 60_000).toISOString(), oldestQueuedAt: new Date(NOW - 12 * 60_000).toISOString(), queued: 3 } },
    { nodeId: TWIN, name: "node-c", status: "offline", intake: { lastAcceptedAt: new Date(NOW - 3 * 60_000).toISOString(), oldestQueuedAt: null, queued: 0 } },
  ],
  sessions: [
    { nodeId: SELF, sessionId: "s-self", name: "review", state: "busy", runtime: "claude-code", cwd: "/work/a" },
    { nodeId: PEER, sessionId: "s-b1", name: "build", state: "idle", runtime: "claude-code" },
    { nodeId: PEER, sessionId: "s-b2", name: "build", state: "idle", runtime: "claude-code" },
    { nodeId: PEER, sessionId: "s-b3", name: "docs", state: "idle", runtime: "claude-code" },
  ],
  fetchedAt: new Date(NOW - 30_000).toISOString(),
};

function setup(t: test.TestContext, directory: DirectoryBody | null = DIRECTORY): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-msg-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.com", nodeId: SELF, name: "node-a", publicKey: "x",
    privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  if (directory) writeDirectory(paths, directory);
  writeLocalSessions(paths, [{ sessionId: "s-self", runtime: "claude-code", state: "busy", name: "review" }]);
  return paths;
}

async function run(paths: NodePaths, argv: string[], env: NodeJS.ProcessEnv = ENV, now = NOW, processTable?: () => ProcessTable | null) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMsg(argv, { paths, env, now: () => now, out: (l) => out.push(l), err: (l) => err.push(l), sleep: async () => {},
    processTable });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("resolves the node and the session by name or id and addresses the session by its id", () => {
  assert.deepEqual(resolveTarget(DIRECTORY, "node-b/docs"), { ok: true, value: { nodeId: PEER, session: "s-b3" } });
  assert.deepEqual(resolveTarget(DIRECTORY, `${PEER}/s-b1`), { ok: true, value: { nodeId: PEER, session: "s-b1" } });
  const ambiguous = resolveTarget(DIRECTORY, "node-b/build");
  assert.equal(ambiguous.ok, false);
  assert.match(!ambiguous.ok ? ambiguous.error : "", /ambiguous session on node-b "build"; candidates: build \(s-b1\), build \(s-b2\)/);
  const unknownNode = resolveTarget(DIRECTORY, "node-x/docs");
  assert.match(!unknownNode.ok ? unknownNode.error : "", /unknown node "node-x"; candidates: node-a .*node-b .*node-c/);
  const unknownSession = resolveTarget(DIRECTORY, "node-c/docs");
  assert.match(!unknownSession.ok ? unknownSession.error : "", /unknown session on node-c "docs"; candidates: none/);
  for (const bad of ["node-b", "/docs", "node-b/"]) assert.equal(resolveTarget(DIRECTORY, bad).ok, false);
});

test("msg sessions lists every node, marks this session and warns about a stale or missing directory", async (t) => {
  const paths = setup(t);
  const listed = await run(paths, ["sessions"]);
  assert.equal(listed.code, 0);
  assert.equal(listed.err, "");
  assert.match(listed.out, /node-a \(.*\) online \[this node\]\n    intake: .*\n  \* review  s-self  running  claude-code  \/work\/a/);
  assert.match(listed.out, /node-b .*\n    intake: .*\n    build  s-b1  idle-loaded  claude-code/);
  assert.match(listed.out, /node-c .* offline\n    intake: .*\n    no sessions reported/);
  assert.ok(fs.existsSync(paths.directoryRequest), "a refresh is requested");

  const stale = await run(paths, ["sessions"], ENV, NOW + 10 * 60_000);
  assert.equal(stale.code, 0);
  assert.match(stale.err, /warning: the session directory is 11 min old/);

  const missing = await run(setup(t, null), ["sessions"]);
  assert.equal(missing.code, 1);
  assert.equal(missing.out, "");
  assert.match(missing.err, /no session directory yet .*Is the daemon running\?/);
});

test("msg sessions shows each node's intake beside its connection, UNKNOWN when unmeasured (issue #441)", async (t) => {
  const fetched = new Date(NOW - 30_000).toISOString();
  const listed = await run(setup(t), ["sessions"]);
  assert.equal(listed.code, 0, listed.err);
  const lines = listed.out.split("\n");
  const after = (header: RegExp) => lines[lines.findIndex((l) => header.test(l)) + 1];
  assert.equal(after(/^node-a /), "    intake: UNKNOWN (the control plane did not report queue state; it may run an older Worker)");
  assert.equal(after(/^node-b /), `    intake: NOT DRAINING: 3 queued, oldest 12 min (over 5 min) as of ${fetched}; last intake 25 min ago`);
  assert.equal(after(/^node-c /), `    intake: queue empty as of ${fetched}; last intake 3 min ago`);
  assert.equal(lines.at(-1), "(NOT DRAINING: a node holds a queued message older than 5 min; messages to it wait in the control plane; "
    + "on that node run `kherep-node doctor` (queueDrain, intakeLatency) and read its daemon log for `lane` lines)");
  // No intake line carries a session id, name or cwd.
  for (const line of lines.filter((l) => l.startsWith("    intake:"))) assert.doesNotMatch(line, /s-self|s-b\d|review|build|docs|\/work/);

  // Every line is UNKNOWN when the directory is stale or dated ahead of this clock.
  const stale = await run(setup(t), ["sessions"], ENV, NOW + 10 * 60_000);
  assert.deepEqual(stale.out.split("\n").filter((l) => l.startsWith("    intake:")),
    Array(3).fill("    intake: UNKNOWN (the session directory is 11 min old)"));
  assert.doesNotMatch(stale.out, /NOT DRAINING/);
  const ahead = await run(setup(t, { ...DIRECTORY, fetchedAt: new Date(NOW + 3 * 60_000).toISOString() }), ["sessions"]);
  assert.deepEqual(ahead.out.split("\n").filter((l) => l.startsWith("    intake:")),
    Array(3).fill("    intake: UNKNOWN (the session directory is dated 3 min ahead of this clock)"));
  // A truncated directory: a node without intake is UNKNOWN for that reason.
  const truncated = await run(setup(t, { ...DIRECTORY, truncated: true }), ["sessions"]);
  assert.ok(truncated.out.includes("    intake: UNKNOWN (not reported in a truncated directory)"), truncated.out);
  // A record that contradicts itself is UNKNOWN, never an empty queue.
  const odd = await run(setup(t, { ...DIRECTORY, nodes: [{ nodeId: PEER, name: "node-b", status: "online",
    intake: { lastAcceptedAt: null, oldestQueuedAt: fetched, queued: 0 } }] }), ["sessions"]);
  assert.ok(odd.out.includes("    intake: UNKNOWN (the intake record is inconsistent)"), odd.out);
  const none = await run(setup(t, { ...DIRECTORY, nodes: [{ nodeId: PEER, name: "node-b", status: "online",
    intake: { lastAcceptedAt: null, oldestQueuedAt: null, queued: 0 } }] }), ["sessions"]);
  assert.ok(none.out.includes(`    intake: queue empty as of ${fetched}; last intake: none recorded by the control plane`), none.out);
  assert.doesNotMatch(none.out, /NOT DRAINING/);
});

test("msg status of a queued message names its target's intake (issue #441)", async (t) => {
  const fetched = new Date(NOW - 30_000).toISOString();
  const paths = setup(t);
  const queuedTo = async (target: string) => {
    const sent = (await run(paths, ["send", target, "x"])).out;
    recordSent(paths, sent, "queued", undefined, NOW);
    return sent;
  };
  const toPeer = await queuedTo("node-b/docs");
  const status = await run(paths, ["status", toPeer]);
  assert.equal(status.code, 0, status.err);
  assert.deepEqual(status.out.split("\n"), [`${toPeer} queued (updated ${new Date(NOW).toISOString()})`,
    `  target node-b (${PEER}) online; intake: NOT DRAINING: 3 queued, oldest 12 min (over 5 min) as of ${fetched}; last intake 25 min ago`]);

  const toSelf = await queuedTo("node-a/s-self");
  assert.equal((await run(paths, ["status", toSelf])).out.split("\n")[1],
    `  target node-a (${SELF}) online; intake: UNKNOWN (the control plane did not report queue state; it may run an older Worker)`);
  writeDirectory(paths, { ...DIRECTORY, nodes: DIRECTORY.nodes.filter((n) => n.nodeId !== PEER) });
  assert.equal((await run(paths, ["status", toPeer])).out.split("\n")[1], `  target ${PEER}: intake UNKNOWN (not listed in the directory)`);
  writeDirectory(paths, { ...DIRECTORY, nodes: DIRECTORY.nodes.filter((n) => n.nodeId !== PEER), truncated: true });
  assert.equal((await run(paths, ["status", toPeer])).out.split("\n")[1], `  target ${PEER}: intake UNKNOWN (not listed in a truncated directory)`);
  fs.rmSync(paths.directory);
  const missing = await run(paths, ["status", toPeer]);
  assert.deepEqual([missing.code, missing.out.split("\n")[1]], [0, `  target ${PEER}: intake UNKNOWN (no session directory; is the daemon running?)`]);

  // Later states add nothing.
  writeDirectory(paths, DIRECTORY);
  recordSent(paths, toPeer, "accepted", undefined, NOW);
  assert.deepEqual((await run(paths, ["status", toPeer])).out.split("\n"), [`${toPeer} accepted (updated ${new Date(NOW).toISOString()})`]);
});

test("msg sessions shows a Codex thread title next to the name, and the title is never an address (issue #88)", async (t) => {
  const codex = "019a0000-0000-7000-8000-0000d7d07717";
  const directory: DirectoryBody = { ...DIRECTORY, sessions: [...DIRECTORY.sessions,
    { nodeId: PEER, sessionId: codex, name: "codex-d7d07717", state: "active", runtime: "codex", kind: "codex", title: "Kherep \"Funktionen\" nachschlagen" }] };
  const listed = await run(setup(t, directory), ["sessions"]);
  assert.equal(listed.code, 0);
  assert.ok(listed.out.includes(`    codex-d7d07717  "Kherep \\"Funktionen\\" nachschlagen"  ${codex}  reachable-probable  codex`), listed.out);
  // Sessions without a title keep the earlier format.
  assert.match(listed.out, /\n    docs  s-b3  idle-loaded  claude-code\n/);
  assert.deepEqual(resolveTarget(directory, "node-b/codex-d7d07717"), { ok: true, value: { nodeId: PEER, session: codex } });
  const byTitle = resolveTarget(directory, "node-b/Kherep \"Funktionen\" nachschlagen");
  assert.equal(byTitle.ok, false);
  assert.match(!byTitle.ok ? byTitle.error : "", /unknown session on node-b/);
});

test("msg send writes an outbox record from this session's name and prints the message id", async (t) => {
  const paths = setup(t);
  const sent = await run(paths, ["send", "node-b/docs", "please", "review"]);
  assert.equal(sent.code, 0, sent.err);
  const record = getOutbox(paths, sent.out);
  // fromSessionId (issue #253): the session's id beside its name, kept locally for the reply grant.
  assert.deepEqual(record, { messageId: sent.out, fromSession: "review", fromSessionId: "s-self", to: { nodeId: PEER, session: "s-b3" },
    text: "please review", createdAt: new Date(NOW).toISOString(), depth: 0 });

  // Without a name in sessions.json the id is the sender; --from may name this same session by id or name.
  const sender = async (argv: string[], env?: NodeJS.ProcessEnv) => {
    const record = getOutbox(paths, (await run(paths, ["send", ...argv, "node-b/docs", "x"], env)).out);
    return [record?.fromSession, record?.fromSessionId];
  };
  assert.deepEqual(await sender([], { CLAUDE_CODE_SESSION_ID: "s-other" }), ["s-other", "s-other"]);
  assert.deepEqual(await sender(["--from", "s-self"]), ["s-self", "s-self"]);
  assert.deepEqual(await sender(["--from", "review"]), ["review", "s-self"]);
  const anonymous = await run(paths, ["send", "node-b/docs", "x"], {});
  assert.equal(anonymous.code, 1);
  assert.match(anonymous.err, /none of CLAUDE_CODE_SESSION_ID \(Claude Code\), CODEX_THREAD_ID \(Codex\) or KHEREP_SESSION_ID \(the node's Codex runs\) is set; a Codex session may pass --from/);
  // Issue #200: --from is never taken as typed. Another name, with or without a session variable, is refused and nothing is written.
  for (const variables of [{}, ENV, { KHEREP_SESSION_ID: "s-self" }]) {
    const posed = await run(paths, ["send", "--from", "ops", "node-b/docs", "x"], variables);
    assert.equal(posed.code, 1);
    assert.match(posed.err, /--from "ops" is not a verified sender/);
    assert.equal(posed.out, "");
  }

  for (const [argv, pattern] of [
    [["send", "node-b/build", "x"], /ambiguous session/], [["send", "node-z/docs", "x"], /unknown node/], [["send", "node-b/docs"], /1 to 16384 characters/],
  ] as const) {
    const failed = await run(paths, [...argv]);
    assert.equal(failed.code, 1);
    assert.match(failed.err, pattern);
  }
  assert.equal((await run(setup(t, null), ["send", "node-b/docs", "x"])).code, 1);
});

test("msg send reaches a full session id the directory does not list on an online node, and only that (issue #107)", async (t) => {
  const paths = setup(t);
  const closed = "1f0e2c9a-6d0b-4c11-9f39-2a77c1d4e8b5";
  for (const target of [`node-b/${closed}`, `${PEER}/${closed}`]) {
    const sent = await run(paths, ["send", target, "--", "still there?"]);
    assert.equal(sent.code, 0, sent.err);
    assert.equal(sent.err, "kherep-node msg: note: session not listed on node-b; the node decides whether it can deliver");
    assert.deepEqual(getOutbox(paths, sent.out)?.to, { nodeId: PEER, session: closed });
  }
  // A listed session gets no note.
  assert.equal((await run(paths, ["send", "node-b/docs", "x"])).err, "");
  for (const [target, pattern] of [
    ["node-b/ghost", /unknown session on node-b "ghost"/], ["node-b/codex-2a77c1d4", /unknown session on node-b "codex-2a77c1d4"/],
    [`node-b/${closed.toUpperCase()}`, /unknown session on node-b/], [`node-x/${closed}`, /unknown node "node-x"/],
    [`node-c/${closed}`, /unknown session on node-c/],
  ] as const) {
    const refused = await run(paths, ["send", target, "x"]);
    assert.equal(refused.code, 1, target);
    assert.match(refused.err, pattern);
  }
  // attach and every other caller of resolveTarget keep needing a listed session.
  assert.equal(resolveTarget(DIRECTORY, `node-b/${closed}`).ok, false);
});

test("msg send --reply-to answers the sender of an inbox message and --wait reports the answer", async (t) => {
  const paths = setup(t);
  // The incoming message is itself a reply at depth 2, so the answer is at depth 3.
  storeMessage(paths.inbox, { messageId: INCOMING, from: { nodeId: PEER, session: "build" }, toSession: "review", text: "done?",
    createdAt: new Date(0).toISOString() }, NOW, 2);
  fs.rmSync(paths.directory); // a reply to the sender needs no directory
  const reply = await run(paths, ["send", "--reply-to", INCOMING, "yes"]);
  assert.equal(reply.code, 0, reply.err);
  assert.deepEqual(getOutbox(paths, reply.out), { messageId: reply.out, fromSession: "review", fromSessionId: "s-self",
    to: { nodeId: PEER, session: "build" }, text: "yes", inReplyTo: INCOMING, createdAt: new Date(NOW).toISOString(), depth: 3 });
  writeDirectory(paths, DIRECTORY);
  const redirected = await run(paths, ["send", "--reply-to", INCOMING, "--to", "node-b/docs", "cc"]);
  assert.deepEqual(getOutbox(paths, redirected.out)?.to, { nodeId: PEER, session: "s-b3" });
  assert.match((await run(paths, ["send", "--reply-to", "00000000-0000-4000-8000-0000000000ff", "x"])).err, /not in this node's inbox/);

  // --wait: the sleep hook plays the daemon and moves the record to sent/.
  const out: string[] = [];
  let calls = 0;
  const code = await runMsg(["send", "--wait", "5", "node-b/docs", "ping"], {
    paths, env: ENV, now: () => NOW, out: (l) => out.push(l), err: () => {},
    sleep: async () => { recordSent(paths, out[0], calls++ === 0 ? "queued" : "accepted"); },
  });
  assert.deepEqual([code, out[1]], [0, "accepted"]);
  let clock = NOW;
  const timeout = await runMsg(["send", "--wait", "1", "node-b/docs", "ping"], { paths, env: ENV, now: () => clock, out: (l) => out.push(l),
    err: () => {}, sleep: async (ms) => { clock += ms; } });
  assert.deepEqual([timeout, out.at(-1)], [1, "no answer yet: not sent by the daemon yet"]);
});

test("msg inbox shows this session's messages, msg status the state of a sent one", async (t) => {
  const paths = setup(t);
  const deliver = (messageId: string, toSession: string) => storeMessage(paths.inbox, { messageId, from: { nodeId: PEER, session: "build" },
    toSession, text: "line one\nline two", createdAt: new Date(0).toISOString() });
  deliver(INCOMING, "review");
  deliver("00000000-0000-4000-8000-0000000000e2", "s-self");
  deliver("00000000-0000-4000-8000-0000000000e3", "someone-else");
  markDelivered(paths.inbox, "00000000-0000-4000-8000-0000000000e2");
  const open = await run(paths, ["inbox"]);
  assert.match(open.out, new RegExp(`${INCOMING}  accepted .*\n  from: node node-b \\(${PEER}\\), session build\n  \\| line one\n  \\| line two`));
  assert.doesNotMatch(open.out, /e2|e3/);
  const all = await run(paths, ["inbox", "--all"]);
  assert.match(all.out, /0000000000e2  delivered/);
  assert.doesNotMatch(all.out, /e3/);

  const sent = (await run(paths, ["send", "node-b/docs", "x"])).out;
  assert.match((await run(paths, ["status", sent])).out, /pending: waiting for the daemon/);
  recordSent(paths, sent, "refused", "not accepted by node policy");
  assert.match((await run(paths, ["status", sent])).out, new RegExp(`${sent} refused: not accepted by node policy`));
  const progressId = (await run(paths, ["send", "node-b/docs", "x"])).out;
  recordSent(paths, progressId, "accepted", "legacy text must stay hidden", NOW, {
    phase: "waiting", code: "wake-unconfirmed", observedAt: new Date(NOW).toISOString(),
  });
  const progress = (await run(paths, ["status", progressId])).out;
  assert.match(progress, /accepted: the automatic wake was not confirmed; start the target turn to retry delivery/);
  assert.doesNotMatch(progress, /legacy text|private|path/i);
  // Issue #417: msg status answers for a message in this node's inbox too.
  const received = getMessage(paths.inbox, INCOMING)!.receivedAt;
  const before = await run(paths, ["status", INCOMING]);
  assert.deepEqual([before.code, before.out], [0, `${INCOMING} accepted (received ${received})`]);
  markOffered(paths.inbox, INCOMING, NOW, "prompt");
  const offered = `  offered by: prompt at ${new Date(NOW).toISOString()} (offer 1)`;
  const after = await run(paths, ["status", INCOMING]);
  assert.deepEqual([after.code, after.out], [0, `${INCOMING} offered (received ${received})\n${offered}`]);
  assert.ok((await run(paths, ["inbox"])).out.includes(`\n${offered}\n  | line one`), "msg inbox shows the same line");
  assert.equal((await run(paths, ["status", "00000000-0000-4000-8000-0000000000f9"])).code, 1, "an unknown id still fails");
  assert.equal((await run(paths, ["frobnicate"])).code, 2);
});

test("msg send --from preserves a recorded Codex session id", async (t) => {
  const paths = setup(t);
  const codex = "019a2b3c-4d5e-7f60-8123-456789abcdef";
  recordCodexSession(paths, codex, "/work/b", NOW);
  const sent = await run(paths, ["send", "--from", codex, "node-b/docs", "--", "hello"], {});
  assert.equal(sent.code, 0, sent.err);
  assert.equal(getOutbox(paths, sent.out)?.fromSession, codex);
  writeLocalSessions(paths, [{ sessionId: codex, name: "codex-89abcdef", runtime: "codex", state: "running" }]);
  const implicit = await run(paths, ["send", "node-b/docs", "hello"], { KHEREP_SESSION_ID: codex });
  assert.equal(implicit.code, 0, implicit.err);
  assert.equal(getOutbox(paths, implicit.out)?.fromSession, codex);
  assert.deepEqual([getOutbox(paths, sent.out)?.fromSessionId, getOutbox(paths, implicit.out)?.fromSessionId], [codex, codex]);
});

test("msg send --from refuses a Codex sender that no recent hook record verifies (issue #200)", async (t) => {
  const paths = setup(t);
  const codex = "019a2b3c-4d5e-7f60-8123-456789abcdef";
  recordCodexSession(paths, codex, "/work/b", NOW);
  const refused = async (from: string, variables: NodeJS.ProcessEnv = {}, now = NOW) => {
    const sent = await run(paths, ["send", "--from", from, "node-b/docs", "hello"], variables, now);
    assert.equal(sent.code, 1, `${from} was accepted`);
    assert.match(sent.err, /is not a verified sender/);
  };
  // A short alias, an id no hook recorded, and a record older than 12 hours.
  await refused("codex-89abcdef");
  await refused("019a2b3c-0000-7000-8000-000000000000");
  await refused(codex, {}, NOW + 12 * 60 * 60_000 + 1);
  // Another node-set session cannot name it.
  await refused(codex, { KHEREP_SESSION_ID: "task-other" });
  // An inherited Claude Code variable (Codex started from a Claude Code tool) neither verifies nor vetoes the hook record.
  for (const variables of [ENV, { CLAUDE_CODE_SESSION_ID: "" }]) {
    const inherited = await run(paths, ["send", "--from", codex, "node-b/docs", "hello"], variables);
    assert.equal(inherited.code, 0, inherited.err);
    assert.equal(getOutbox(paths, inherited.out)?.fromSession, codex);
    // Never bound to the Claude Code session whose variable it inherited (issue #253).
    assert.equal(getOutbox(paths, inherited.out)?.fromSessionId, codex);
  }
  // A node-started Codex run whose task record carries that thread may name it.
  writeTask(paths, { taskId: "00000000-0000-4000-8000-0000000000f1", runtime: "codex", name: "task-00000000", cwd: "/w", permissionMode: "auto",
    state: "running", startedAt: new Date(NOW).toISOString(), deadline: new Date(NOW + 60_000).toISOString(),
    updatedAt: new Date(NOW).toISOString(), sessionId: codex });
  const taskRun = await run(paths, ["send", "--from", codex, "node-b/docs", "hello"], { KHEREP_SESSION_ID: "task-00000000" });
  assert.equal(taskRun.code, 0, taskRun.err);
  assert.equal(getOutbox(paths, taskRun.out)?.fromSession, codex);
  assert.equal(getOutbox(paths, taskRun.out)?.fromSessionId, codex, "the thread id, not the task's name");
});

test("msg sessions marks background tasks and the session --from names (issue #198)", async (t) => {
  const codex = "019a2b3c-4d5e-7f60-8123-456789abcdef";
  const paths = setup(t, { ...DIRECTORY, sessions: [...DIRECTORY.sessions,
    { nodeId: SELF, sessionId: codex, name: "codex-89abcdef", state: "idle", runtime: "codex", kind: "codex" },
    { nodeId: PEER, sessionId: "019a0000-0000-7000-8000-000000000002", name: "task-3f2a1b0c", label: "intercom: codex@node-a",
      state: "running", runtime: "codex", kind: "codex-task" },
    { nodeId: PEER, sessionId: "019a0000-0000-7000-8000-000000000003", name: "task-4e5f6a7b", state: "idle", runtime: "codex",
      kind: "codex-intercom" },
    { nodeId: PEER, sessionId: "s-b4", name: "notes", state: "idle", runtime: "claude-code", kind: "interactive" }] });
  recordCodexSession(paths, codex, "/work/b", NOW);
  const listed = await run(paths, ["sessions", "--from", codex], {});
  assert.equal(listed.code, 0, listed.err);
  const lines = listed.out.split("\n");
  assert.ok(lines.includes(`  * codex-89abcdef  ${codex}  idle-loaded  codex`), listed.out);
  assert.ok(lines.includes("    intercom: codex@node-a  019a0000-0000-7000-8000-000000000002  running  codex  [background task]"), listed.out);
  // An unlabelled intercom run is still marked by its kind.
  assert.ok(lines.includes("    task-4e5f6a7b  019a0000-0000-7000-8000-000000000003  unknown  codex  [background task]"), listed.out);
  assert.ok(lines.includes("    notes  s-b4  idle-loaded  claude-code"), listed.out);
  assert.ok(lines.includes("    review  s-self  running  claude-code  /work/a"), listed.out);
  assert.match(listed.out, /\[background task\] runs as a Control Plane task, not as a desktop app chat, and the desktop apps may not list it/);
  assert.match(listed.out, /kherep-node attach <node>\/<session id>.*kherep-node task status <taskId>/);
  const unverified = await run(paths, ["sessions", "--from", "codex-89abcdef"], {});
  assert.equal(unverified.code, 1);
  assert.match(unverified.err, /not a verified sender/);
  const anonymous = await run(paths, ["sessions"], {});
  assert.match(anonymous.out, /none of CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID or KHEREP_SESSION_ID names this session and no --from was given, so none is marked/);});

test("msg sessions shows the last recorded hook event of this node's Codex sessions (issue #408)", async (t) => {
  const codex = "019a2b3c-4d5e-7f60-8123-456789abcdef";
  const remote = "019a0000-0000-7000-8000-000000000004";
  const paths = setup(t, { ...DIRECTORY, sessions: [...DIRECTORY.sessions,
    { nodeId: SELF, sessionId: codex, name: "codex-89abcdef", state: "active", runtime: "codex", kind: "codex", cwd: "/work/b" },
    { nodeId: PEER, sessionId: remote, name: "codex-00000004", state: "active", runtime: "codex", kind: "codex" }] });
  recordCodexSession(paths, codex, "/work/b", NOW - 120_000, "default", "Stop");
  recordCodexSession(paths, remote, "/work/c", NOW, "default", "Stop");
  const lines = (await run(paths, ["sessions"])).out.split("\n");
  const stoppedAt = new Date(NOW - 120_000).toISOString();
  assert.ok(lines.includes(`    codex-89abcdef  ${codex}  reachable-probable  codex  /work/b  last event Stop at ${stoppedAt}`), lines.join("\n"));
  assert.ok(lines.includes(`    codex-00000004  ${remote}  reachable-probable  codex`), "another node's session shows no local record");
});

test("msg status shows the threaded replies that reached this node (issue #200)", async (t) => {
  const paths = setup(t);
  const sent = await run(paths, ["send", "node-b/docs", "question"]);
  assert.equal(sent.code, 0, sent.err);
  recordSent(paths, sent.out, "replied", undefined, NOW + 1);
  const reply = "00000000-0000-4000-8000-0000000000e2";
  const deliver = (messageId: string, nodeId: string, toSession: string, inReplyTo: string = sent.out) => storeMessage(paths.inbox,
    { messageId, from: { nodeId, session: "s-b3" }, toSession, text: "answer", inReplyTo, createdAt: new Date(NOW).toISOString() }, NOW + 2);
  deliver(reply, PEER, "review");
  // Not replies to this message: another node, another sender session, another original.
  deliver("00000000-0000-4000-8000-0000000000e3", TWIN, "review");
  deliver("00000000-0000-4000-8000-0000000000e4", PEER, "s-other");
  deliver("00000000-0000-4000-8000-0000000000e5", PEER, "review", INCOMING);
  const status = await run(paths, ["status", sent.out]);
  assert.equal(status.code, 0, status.err);
  assert.deepEqual(status.out.split("\n"), [
    `${sent.out} replied (updated ${new Date(NOW + 1).toISOString()})`,
    `  reply ${reply} from node node-b (${PEER}), session s-b3 (accepted, received ${new Date(NOW + 2).toISOString()})`,
  ]);
  // The reply keeps the original id, and the sender's inbox shows its text.
  const inbox = await run(paths, ["inbox"]);
  assert.match(inbox.out, new RegExp(`${reply}  accepted .*\\n  from: node node-b \\(${PEER}\\), session s-b3\\n  in reply to: ${sent.out}\\n  \\| answer`));
  // Issue #417: an offered reply names the path that offered it.
  markOffered(paths.inbox, reply, NOW + 3, "wake");
  assert.deepEqual((await run(paths, ["status", sent.out])).out.split("\n").slice(1), [
    `  reply ${reply} from node node-b (${PEER}), session s-b3 (offered, received ${new Date(NOW + 2).toISOString()})`,
    `    offered by: wake at ${new Date(NOW + 3).toISOString()} (offer 1)`,
  ]);
});

test("msg status names an unusable closed-session cwd, not the target policy (issue #396)", async (t) => {
  const paths = setup(t);
  const sent = (await run(paths, ["send", "node-b/docs", "x"])).out;
  const observed = new Date(NOW).toISOString();
  recordSent(paths, sent, "accepted", undefined, NOW, { phase: "waiting", code: "cwd-refused", observedAt: observed });
  const status = await run(paths, ["status", sent]);
  assert.deepEqual([status.code, status.out], [0, `${sent} accepted: the last closed-session delivery attempt was refused: the closed `
    + "session's working directory is not usable on the target node (not absolute, missing, or outside its workspace roots); the message "
    + `stays queued and is tried again each round [waiting/cwd-refused; observed ${observed}] (updated ${observed})`]);
});

// Issue #471: a Codex process started from a Claude Code tool inherits CLAUDE_CODE_SESSION_ID.
test("msg send from a codex exec started inside a Claude Code tool is sent by the Codex thread, also for --reply-to (issue #471)", async (t) => {
  const paths = setup(t);
  // An exec thread has no hook record (codex-sessions/), so nothing is recorded here.
  const sent = await run(paths, ["send", "node-b/docs", "hello"], NESTED_ENV, NOW, codexUnderClaude);
  assert.equal(sent.code, 0, sent.err);
  assert.deepEqual([getOutbox(paths, sent.out)?.fromSession, getOutbox(paths, sent.out)?.fromSessionId], [THREAD, THREAD]);
  storeMessage(paths.inbox, { messageId: INCOMING, from: { nodeId: PEER, session: "build" }, toSession: THREAD, text: "done?",
    createdAt: new Date(0).toISOString() }, NOW);
  const reply = await run(paths, ["send", "--reply-to", INCOMING, "yes"], NESTED_ENV, NOW, codexUnderClaude);
  assert.equal(reply.code, 0, reply.err);
  assert.deepEqual([getOutbox(paths, reply.out)?.fromSession, getOutbox(paths, reply.out)?.fromSessionId], [THREAD, THREAD]);
  const listed = await run(paths, ["sessions"], NESTED_ENV, NOW, codexUnderClaude);
  assert.equal(listed.code, 0, listed.err);
  assert.ok(listed.out.includes("    review  s-self  running  claude-code  /work/a"), listed.out);
});

test("msg send refuses an undecidable nesting with the fixed reason and writes nothing (issue #471)", async (t) => {
  const paths = setup(t);
  const refused = await run(paths, ["send", "node-b/docs", "hello"], NESTED_ENV, NOW, () => null);
  assert.deepEqual([refused.code, refused.out, refused.err], [1, "", `kherep-node msg: ${NESTED_RUNTIME}`]);
  assert.deepEqual(fs.existsSync(paths.outbox) ? fs.readdirSync(paths.outbox) : [], []);
  // Issue #489: the hint names the conditional hook-record requirement and no assumed cause.
  assert.match(NESTED_RUNTIME, /--from requires the full id of a Codex session a Kherep hook recorded within 12 hours; if KHEREP_SESSION_ID is set/);
  assert.doesNotMatch(NESTED_RUNTIME, /sandbox/i);
});

test("a claude -p started inside a Codex tool sends as its own Claude session (issue #471)", async (t) => {
  const paths = setup(t);
  const sent = await run(paths, ["send", "node-b/docs", "hello"], NESTED_ENV, NOW, claudeUnderCodex);
  assert.equal(sent.code, 0, sent.err);
  assert.deepEqual([getOutbox(paths, sent.out)?.fromSession, getOutbox(paths, sent.out)?.fromSessionId], ["review", "s-self"]);
});

test("msg send --from <own thread> inside that thread needs no hook record; --from <other recorded thread> still needs one (issue #471)", async (t) => {
  const paths = setup(t);
  const other = "019a2b3c-4d5e-7f60-8123-000000000099";
  const thread = { CODEX_THREAD_ID: THREAD };
  const own = await run(paths, ["send", "--from", THREAD, "node-b/docs", "hello"], thread);
  assert.equal(own.code, 0, own.err);
  assert.deepEqual([getOutbox(paths, own.out)?.fromSession, getOutbox(paths, own.out)?.fromSessionId], [THREAD, THREAD]);
  const implicit = await run(paths, ["send", "node-b/docs", "hello"], thread);
  assert.equal(getOutbox(paths, implicit.out)?.fromSession, THREAD);
  const unrecorded = await run(paths, ["send", "--from", other, "node-b/docs", "hello"], thread);
  assert.equal(unrecorded.code, 1);
  assert.match(unrecorded.err, /is not a verified sender/);
  recordCodexSession(paths, other, "/work/b", NOW);
  const recorded = await run(paths, ["send", "--from", other, "node-b/docs", "hello"], thread);
  assert.equal(recorded.code, 0, recorded.err);
  assert.equal(getOutbox(paths, recorded.out)?.fromSession, other);
});

// Issue #489: with an undecidable nesting, --from is accepted only for a fresh hook record and a matching task binding.
test("msg send --from under an undecidable nesting needs a fresh hook record and a matching task (issue #489)", async (t) => {
  const other = "019a2b3c-4d5e-7f60-8123-000000000099";
  const task = (paths: NodePaths, sessionId: string) => writeTask(paths, { taskId: "00000000-0000-4000-8000-0000000000f2", runtime: "codex",
    name: "task-00000002", cwd: "/w", permissionMode: "auto", state: "running", startedAt: new Date(NOW).toISOString(),
    deadline: new Date(NOW + 60_000).toISOString(), updatedAt: new Date(NOW).toISOString(), sessionId });
  const cases: [string, string, number | null, NodeJS.ProcessEnv, ((paths: NodePaths) => void) | null, boolean][] = [
    ["own thread, no hook record", THREAD, null, NESTED_ENV, null, false],
    ["own thread, fresh record", THREAD, NOW, NESTED_ENV, null, true],
    ["own thread, stale record", THREAD, NOW - CODEX_ACTIVE_MS - 1, NESTED_ENV, null, false],
    ["own thread, fresh record, task bound to another thread", THREAD, NOW, { ...NESTED_ENV, KHEREP_SESSION_ID: "task-00000002" },
      (paths) => task(paths, other), false],
    ["another fresh recorded thread", other, NOW, NESTED_ENV, null, true],
  ];
  for (const [label, from, seen, env, prepare, accepted] of cases) {
    const paths = setup(t);
    if (seen !== null) recordCodexSession(paths, from, "/work/b", seen);
    prepare?.(paths);
    const outbox = () => (fs.existsSync(paths.outbox) ? fs.readdirSync(paths.outbox).sort() : []);
    const before = outbox();
    const sent = await run(paths, ["send", "--from", from, "node-b/docs", "hello"], env, NOW, () => null);
    if (accepted) {
      assert.equal(sent.code, 0, `${label}: ${sent.err}`);
      assert.equal(outbox().length, before.length + 1, label);
      assert.deepEqual([getOutbox(paths, sent.out)?.fromSession, getOutbox(paths, sent.out)?.fromSessionId], [from, from], label);
    } else {
      assert.deepEqual([sent.code, sent.out], [1, ""], label);
      assert.match(sent.err, /is not a verified sender: .*a Codex session a Kherep hook recorded within 12 hours/, label);
      assert.deepEqual(outbox(), before, label);
    }
  }
});
