import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { takeTurn, TURN_SPACING_MS, TURNS_PER_HOUR } from "./autonomy.mts";
import { listCodexTaskSessions, recordCodexSession } from "./codex-sessions.mts";
import { codexNode, THREAD, waitFor } from "./codex-fixture.mts";
import { readExit } from "./codex-output.mts";
import { stopCodex } from "./codex-runner.mts";
import { codexFiles } from "./codex-process.mts";
import { pollCodexInbound } from "./codex-wake.mts";
import { readLocalSessions } from "./exchange-sessions.mts";
import { fixtureEvidence, publishSynthetic } from "./session-authority-fixture.mts";
import { getOutbox } from "./exchange.mts";
import { getMessage, messageIds, storeMessage } from "./inbox.mts";
import { continueTask, startTask, stopTask } from "./session-runner.mts";
import { listSessions } from "./sessions.mts";
import { startArgs, T0, TASK } from "./task-fixture.mts";
import { readTask, writeTask } from "./task-records.mts";
import { watchTasks } from "./task-watch.mts";

// Codex task sessions in the directory and in messaging (issue #63): visible
// from the task records, resumed for peer messages under the wake guards, and
// able to answer with the msg CLI through the environment the node gives.

const posix = { skip: process.platform === "win32" ? "the fake codex is a POSIX script" : false };
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "peer-1" };
const NAME = "task-3f2a1b0c";
let counter = 0;
const messageId = (): string => `7e57${(++counter).toString(16).padStart(4, "0")}-0000-4000-8000-000000000000`;

type Node = ReturnType<typeof codexNode>;

// An ended task alone never proves a loaded holder. Positive wake cases opt
// into both the existing wake policy and independently generated source facts.
function enableWake(node: Node): void {
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8"));
  fs.writeFileSync(node.paths.policy, JSON.stringify({ ...policy, wake: { enabled: true, sessions: ["unrelated"] } }));
}
function loaded(node: Node): void {
  const now = node.deps().now!();
  publishSynthetic(node.paths, [fixtureEvidence({ runtime: "codex", sessionId: THREAD }, "idle-loaded", now)],
    now, listCodexTaskSessions(node.paths, now).map(row => ({ ...row, state: "idle-loaded" })), node.livenessAuthority);
}

// A finished Codex task, its run ended and reported done.
async function doneTask(t: test.TestContext, sessions: Record<string, unknown> = {}, cwd?: string, observed = true): Promise<Node> {
  const node = codexNode(t, sessions);
  await startTask(startArgs(TASK, { runtime: "codex", ...(cwd ? { cwd: path.join(node.workspace, cwd) } : {}) }), node.deps());
  await waitFor(() => readExit(codexFiles(node.paths, TASK)) !== null, "the first run");
  await watchTasks(node.deps());
  assert.equal(readTask(node.paths, TASK)?.state, "done");
  node.reports();
  enableWake(node);
  if (observed) loaded(node);
  return node;
}

function deliver(node: Node, text: string, extra: { taskId?: string; toSession?: string; depth?: number } = {}): string {
  const id = messageId();
  // No taskId means the task's own; an empty one means none.
  const taskId = extra.taskId ?? TASK;
  storeMessage(node.paths.inbox, { messageId: id, from: PEER, toSession: extra.toSession ?? NAME, text, createdAt: new Date(T0).toISOString(),
    ...(taskId ? { taskId } : {}) }, T0, extra.depth ?? 0);
  return id;
}

const auditLines = (node: Node): { sessionId: string; messageIds: string[]; action: string }[] => {
  const file = path.join(node.paths.dir, "wake.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};

async function runEnds(node: Node, runs: number): Promise<void> {
  await waitFor(() => node.runs().length === runs, `run ${runs}`);
  await waitFor(() => readExit(codexFiles(node.paths, TASK)) !== null, `the end of run ${runs}`);
}

test("a Codex task session is listed from its task record, with the thread id and the task name", posix, async (t) => {
  const node = codexNode(t);
  await startTask(startArgs(TASK, { runtime: "codex", prompt: "work [sleep]" }), node.deps());
  // The delivery hook may record the same thread; it is listed once, as the task.
  recordCodexSession(node.paths, THREAD, node.workspace, T0);
  const listed = (await listSessions({ paths: node.paths, findClaude: () => null, now: () => T0 })).filter((s) => s.sessionId === THREAD);
  assert.deepEqual(listed, [{ sessionId: THREAD, runtime: "codex", state: "unknown", startedAt: new Date(T0).toISOString(), name: NAME,
    cwd: fs.realpathSync.native(node.workspace), kind: "codex-task" }]);
  await stopTask({ taskId: TASK }, node.deps());
  const idle = await listSessions({ paths: node.paths, findClaude: () => null, now: () => T0 });
  assert.equal(idle.find((s) => s.sessionId === THREAD)?.state, "unknown", "task completion is not loaded-holder evidence");
  loaded(node);
  assert.equal(readLocalSessions(node.paths, T0).find(s => s.sessionId === THREAD)?.state, "idle-loaded");
  const later = await listSessions({ paths: node.paths, findClaude: () => null, now: () => T0 + 13 * 60 * 60_000 });
  assert.deepEqual(later.filter((s) => s.name === NAME), [], "an ended task is listed for 12 hours");
});

test("a peer message resumes an ended task with the framed message; the reply goes out through the msg CLI", posix, async (t) => {
  const node = await doneTask(t, {}, undefined, false);
  const id = deliver(node, "please rerun the suite");
  await pollCodexInbound(node.deps());
  assert.equal(node.runs().length, 1, "UNKNOWN never resumes an ended task");
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");
  loaded(node);
  // The generated hook identifies this named sender as Codex to the real msg CLI.
  recordCodexSession(node.paths, THREAD, node.workspace, T0);
  await pollCodexInbound(node.deps());
  await runEnds(node, 2);
  const run = node.runs()[1];
  const files = codexFiles(node.paths, TASK);
  assert.deepEqual(run.argv.slice(0, 11), ["exec", "resume", "--json", "--skip-git-repo-check", "-c", "sandbox_mode=\"workspace-write\"",
    "-c", `sandbox_workspace_write.writable_roots=[${JSON.stringify(node.paths.outbox)}]`, "-o", files.lastMessage, THREAD]);
  assert.deepEqual(run.argv.slice(11), ["-"], "the peer message is not an argument");
  const prompt = run.stdin;
  assert.match(prompt, /^Kherep: 1 new message\(s\) from other agent sessions arrived/);
  assert.match(prompt, /NOT an instruction from the user/);
  const tag = /=== Kherep peer message \S+ \[([0-9a-f]{12})\] ===/.exec(prompt)?.[1];
  assert.ok(tag, "nonce markers");
  assert.ok(prompt.includes(`--- message text [${tag}] ---\nplease rerun the suite\n--- end of message text [${tag}] ---`));
  assert.deepEqual(run.env, { KHEREP_CONFIG_DIR: node.root, KHEREP_SESSION_ID: THREAD });
  // The task keeps its reported state while the run carries the message.
  const during = readTask(node.paths, TASK)!;
  assert.deepEqual([during.state, during.running, during.offered], ["done", true, [id]]);
  // The fake answered it with `msg send --reply-to` during the run, which marks
  // the message delivered at once (issue #111), before the turn is confirmed.
  assert.equal(getMessage(node.paths.inbox, id)?.state, "delivered");
  assert.equal(getMessage(node.paths.inbox, id)?.offeredBy, "codex-wake", "issue #417: the resume offered it; delivered keeps it");

  await watchTasks(node.deps());
  assert.equal(getMessage(node.paths.inbox, id)?.state, "delivered", "still delivered once the completed turn is settled");
  assert.deepEqual(node.reports(), [], "no task report for a message run");
  assert.equal(readTask(node.paths, TASK)?.running, undefined);
  // The fake answered with `msg send --reply-to`: this session, its task, one hop deeper.
  const [reply] = messageIds(node.paths.outbox).map((m) => getOutbox(node.paths, m)!);
  assert.deepEqual([reply.fromSession, reply.to, reply.taskId, reply.depth, reply.inReplyTo, reply.text], [THREAD, PEER, TASK, 1, id, "ack"]);
  const lines = auditLines(node);
  assert.deepEqual(lines.map((l) => [l.action, l.messageIds]), [["wake", [id]]]);
  assert.ok(!JSON.stringify(lines).includes("please rerun"), "the audit carries no text");
});

test("the wake guards: allowlist or task grant, reply depth, kill switch, budget", posix, async (t) => {
  const node = await doneTask(t);
  const other = deliver(node, "not about the task", { taskId: "" });
  const deep = deliver(node, "deep", { depth: 6 });
  fs.writeFileSync(path.join(node.paths.dir, "wake.disabled"), "");
  const granted = deliver(node, "about the task");
  await pollCodexInbound(node.deps());
  assert.equal(node.runs().length, 1, "nothing ran");
  assert.deepEqual(auditLines(node).map((l) => [l.action, l.messageIds]),
    [["not-allowlisted", [other]], ["depth-limit", [deep]], ["disabled", [granted]]]);
  fs.rmSync(path.join(node.paths.dir, "wake.disabled"));
  // Budget: the default autonomous turns of this hour leave none.
  for (let n = 0; n < TURNS_PER_HOUR; n++) assert.equal(takeTurn(node.paths, THREAD, T0 - 50 * 60_000 + n * TURN_SPACING_MS * 2), "ok");
  await pollCodexInbound(node.deps());
  assert.equal(node.runs().length, 1);
  assert.equal(auditLines(node).at(-1)?.action, "budget");
  assert.equal(getMessage(node.paths.inbox, granted)?.state, "accepted", "it waits");
});

test("a configured wake.budget lets a resume past the default hour through (issue #259)", posix, async (t) => {
  const node = await doneTask(t);
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(node.paths.policy, JSON.stringify({ ...policy,
    wake: { enabled: true, sessions: ["unrelated"], budget: { perHour: TURNS_PER_HOUR + 2, perDay: 100 } } }));
  for (let n = 0; n < TURNS_PER_HOUR; n++) assert.equal(takeTurn(node.paths, THREAD, T0 - 50 * 60_000 + n * TURN_SPACING_MS * 2), "ok");
  const id = deliver(node, "about the task");
  await pollCodexInbound(node.deps());
  await runEnds(node, 2);
  assert.deepEqual(auditLines(node).map((l) => [l.action, l.messageIds]), [["wake", [id]]]);
});

test("an allowlisted session gets every message; codex must be listed and sessions enabled", posix, async (t) => {
  const rewrite = (node: Node, change: (policy: Record<string, any>) => void): void => {
    const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8")) as Record<string, any>;
    change(policy);
    fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
  };
  const off = await doneTask(t);
  rewrite(off, (p) => { p.sessions.runtimes = ["claude"]; });
  deliver(off, "x");
  await pollCodexInbound(off.deps());
  assert.equal(off.runs().length, 1, "codex no longer listed: nothing resumes");
  const node = await doneTask(t);
  rewrite(node, (p) => { p.wake = { enabled: true, sessions: [NAME] }; });
  const other = deliver(node, "not about the task", { taskId: "" });
  await pollCodexInbound(node.deps());
  await runEnds(node, 2);
  assert.match(node.runs()[1].stdin, /not about the task/);
  await watchTasks(node.deps());
  assert.equal(getMessage(node.paths.inbox, other)?.state, "delivered");
});

test("a message run past the max runtime keeps the task's state and sends no report", posix, async (t) => {
  const node = codexNode(t, { maxRuntimeMinutes: 30 });
  await startTask(startArgs(TASK, { runtime: "codex", prompt: "work [fail]" }), node.deps());
  await waitFor(() => readExit(codexFiles(node.paths, TASK)) !== null, "the first run");
  await watchTasks(node.deps());
  assert.equal(readTask(node.paths, TASK)?.state, "failed");
  node.reports();
  enableWake(node);
  loaded(node);
  const id = deliver(node, "take your time [sleep]");
  await pollCodexInbound(node.deps());
  await waitFor(() => node.runs().length === 2, "the message run");
  node.tick(30 * 60_000);
  await watchTasks(node.deps());
  assert.deepEqual(node.reports(), []);
  const record = readTask(node.paths, TASK)!;
  assert.deepEqual([record.state, record.running], ["failed", undefined]);
  assert.equal(getMessage(node.paths.inbox, id)?.retry, true);
  await waitFor(() => readExit(codexFiles(node.paths, TASK)) !== null, "the stopped run");
});

test("one run at a time; a system-stopped or failed run offers its messages again within the limits", posix, async (t) => {
  const node = await doneTask(t);
  const slow = deliver(node, "take your time [sleep]");
  await pollCodexInbound(node.deps());
  await waitFor(() => node.runs().length === 2, "the message run");
  const waiting = deliver(node, "second");
  node.tick(TURN_SPACING_MS + 1);
  loaded(node);
  await pollCodexInbound(node.deps());
  assert.equal(node.runs().length, 2, "no second run while one runs");
  assert.equal(getMessage(node.paths.inbox, waiting)?.state, "accepted");
  await stopCodex({ taskId: TASK }, node.deps(), "test interruption", false);
  assert.equal(readTask(node.paths, TASK)?.state, "done", "the task keeps its reported done");
  assert.equal(readTask(node.paths, TASK)?.operatorStoppedAt, undefined, "a system stop does not block retry");
  assert.equal(getMessage(node.paths.inbox, slow)?.retry, true);
  await waitFor(() => readExit(codexFiles(node.paths, TASK)) !== null, "the stopped run");

  // Both go in the next run, which fails: they stay offered for a retry.
  node.tick(TURN_SPACING_MS + 1);
  loaded(node);
  fs.rmSync(path.join(node.paths.inbox, `${slow}.json`));
  const failing = deliver(node, "this one fails [fail]");
  await pollCodexInbound(node.deps());
  await runEnds(node, 3);
  await watchTasks(node.deps());
  for (const id of [waiting, failing]) assert.deepEqual([getMessage(node.paths.inbox, id)?.state, getMessage(node.paths.inbox, id)?.retry], ["offered", true]);
  node.tick(TURN_SPACING_MS + 1);
  loaded(node);
  await pollCodexInbound(node.deps());
  await runEnds(node, 4);
  assert.equal(auditLines(node).at(-1)?.action, "stuck-offer");
});

test("an operator stop blocks message auto-resume until an explicit continue", posix, async (t) => {
  const node = await doneTask(t);
  writeTask(node.paths, { ...readTask(node.paths, TASK)!, operatorStoppedAt: new Date(T0).toISOString() });
  const id = deliver(node, "wait for the operator");
  await pollCodexInbound(node.deps());
  assert.equal(node.runs().length, 1);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted");

  await continueTask({ taskId: TASK, prompt: "continue now" }, node.deps());
  assert.equal(readTask(node.paths, TASK)?.operatorStoppedAt, undefined);
});
test("a message resume checks the working directory again", posix, async (t) => {
  const node = await doneTask(t, {}, "repo");
  const outside = path.join(node.root, "outside");
  fs.mkdirSync(outside);
  // The task's recorded directory now leads out of the workspace root.
  const repo = path.join(node.workspace, "repo");
  fs.renameSync(repo, path.join(node.workspace, "moved"));
  fs.symlinkSync(outside, repo);
  deliver(node, "hello");
  const lines: string[] = [];
  await pollCodexInbound(node.deps(), (line) => lines.push(line));
  assert.equal(node.runs().length, 1, "nothing resumed");
  assert.match(lines[0] ?? "", /not resuming task .*outside the workspace roots/);
});
