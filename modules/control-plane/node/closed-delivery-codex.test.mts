import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { TURN_SPACING_MS } from "./autonomy.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { ACCEPT_ALL, audits, closedSince, deliver, PEER } from "./closed-fixture.mts";
import { SCRIPT, THREAD, waitFor, type FakeRun } from "./codex-fixture.mts";
import { readExit } from "./codex-output.mts";
import { codexFiles, type CodexDeps } from "./codex-process.mts";
import { watchCodexTasks } from "./codex-watch.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessage, messageIds } from "./inbox.mts";
import { T0, taskNode } from "./task-fixture.mts";
import { listTasks, type TaskRecord } from "./task-records.mts";
import { wakeText } from "./wake-hook.mts";

// The Codex path of issues #102 and #105: a message for a Codex session that
// is no longer listed starts a Codex intercom session with the framed message
// on stdin; the next message of the same sender resumes that intercom session
// with `codex exec resume <thread>`, never the closed session. The fake codex
// of codex-fixture.mts answers each with the reply command of its block, and
// runs on Windows too, behind an npm-style shim.

const CLOSED = "0199a000-0000-7000-8000-0000000000c1";
const CLOSED_SESSION = { sessionId: CLOSED, runtime: "codex", state: "idle" };

function fakeCodex(t: test.TestContext): { file: string; runs: () => FakeRun[] } {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-fake-codex-"));
  const log = path.join(bin, "runs.jsonl");
  let file = path.join(bin, "codex");
  if (process.platform === "win32") {
    // codex-binary.mts runs the launcher next to an npm codex.cmd with this Node.
    const launcher = path.join(bin, "node_modules", "@openai", "codex", "bin");
    fs.mkdirSync(launcher, { recursive: true });
    fs.writeFileSync(path.join(launcher, "codex.js"), SCRIPT(log));
    file = path.join(bin, "codex.cmd");
    fs.writeFileSync(file, "@echo off\r\n");
  } else {
    fs.writeFileSync(file, SCRIPT(log), { mode: 0o755 });
  }
  const runs = (): FakeRun[] => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as FakeRun) : []);
  t.after(() => {
    for (const run of runs()) {
      try {
        process.kill(run.pid, "SIGKILL");
      } catch {
        // ended
      }
    }
    fs.rmSync(bin, { recursive: true, force: true });
  });
  return { file, runs };
}

test("failed Codex intercom starts keep the message accepted and unassociated", async (t) => {
  const cases: [string, CodexDeps, RegExp][] = [
    ["missing binary", { findCodex: () => null }, /codex is not installed/],
    ["spawn failure", {
      findCodex: () => "codex",
      mcpList: async () => ({ code: 0, stdout: "[]", stderr: "" }),
      spawn: (() => { throw new Error("spawn failed"); }) as NonNullable<CodexDeps["spawn"]>,
    }, /spawn failed/],
  ];
  for (const [name, codex, reason] of cases) {
    const node = taskNode(t, { runtimes: ["claude", "codex"], delegate: { accept: true } },
      { messaging: { ...ACCEPT_ALL, resumeClosed: true } });
    recordCodexSession(node.paths, CLOSED, path.join(node.workspace, "repo"), T0 - 13 * 3_600_000, "default");
    closedSince(node, CLOSED_SESSION);
    const id = deliver(node, { toSession: CLOSED, text: name });
    await deliverToClosed({ ...node.deps(), codex });
    const message = getMessage(node.paths.inbox, id);
    assert.equal(message?.state, "accepted", name);
    assert.equal(message?.delivery, undefined, name);
    assert.equal(listTasks(node.paths).at(-1)?.state, "failed", name);
    assert.match(String(audits(node).at(-1)?.reason), reason, name);
  }
});
// The answer in the outbox to a message, from the msg CLI the fake ran.
const replyTo = (outbox: string, id: string): { to: unknown; inReplyTo?: string } | undefined => messageIds(outbox)
  .map((m) => JSON.parse(fs.readFileSync(path.join(outbox, `${m}.json`), "utf8")) as { to: unknown; inReplyTo?: string })
  .find((r) => r.inReplyTo === id);

test("a closed Codex session's messages go to one Codex intercom session: started, then resumed, each reply threaded", async (t) => {
  const node = taskNode(t, { runtimes: ["claude", "codex"], delegate: { accept: true } },
    { messaging: { ...ACCEPT_ALL, resumeClosed: true } });
  const repo = path.join(node.workspace, "repo");
  // Last seen by a hook 13 hours ago: no longer listed.
  recordCodexSession(node.paths, CLOSED, repo, T0 - 13 * 3_600_000, "default");
  // Issue #389: closed by its miss streak.
  closedSince(node, CLOSED_SESSION);
  const codex = fakeCodex(t);
  const alive = (pid: number): string | null => {
    try {
      process.kill(pid, 0);
      return "fake";
    } catch {
      return null;
    }
  };
  const codexDeps: CodexDeps = { findCodex: () => codex.file, processStart: alive, startWaitMs: 5_000 };
  const deps = () => ({ ...node.deps(), codex: codexDeps });
  const ended = async (task: TaskRecord): Promise<void> => {
    await waitFor(() => readExit(codexFiles(node.paths, task.taskId)) !== null, "the end of the run");
    await waitFor(() => alive(codex.runs().at(-1)!.pid) === null, "the process exit");
    await watchCodexTasks(deps());
  };

  const first = deliver(node, { toSession: CLOSED, text: "status of the migration?" });
  await deliverToClosed(deps());
  await waitFor(() => codex.runs().length === 1, "the intercom run");
  const start = codex.runs()[0];
  assert.equal(start.argv[0], "exec");
  assert.notEqual(start.argv[1], "resume");
  assert.equal(fs.realpathSync.native(start.cwd), fs.realpathSync.native(repo));
  assert.match(start.stdin, /status of the migration\?/);
  assert.ok(start.stdin.includes(`--reply-to ${first} -- <reply text>`), "the prompt carries the threaded reply command");
  const [task] = listTasks(node.paths);
  assert.equal(task.local, "intercom");
  assert.equal(task.runtime, "codex");
  assert.equal(task.requestedBy, `${PEER.nodeId}/${PEER.session}`);
  await ended(task);
  assert.equal(getMessage(node.paths.inbox, first)?.state, "delivered");
  assert.deepEqual(getMessage(node.paths.inbox, first)?.delivery,
    { taskId: task.taskId, runtime: "codex", sessionId: THREAD });
  await waitFor(() => replyTo(node.paths.outbox, first) !== undefined, "the threaded reply");
  assert.deepEqual(replyTo(node.paths.outbox, first)?.to, PEER);
  assert.equal(listTasks(node.paths)[0].sessionId, THREAD);
  assert.equal(listTasks(node.paths)[0].state, "done");

  node.tick(TURN_SPACING_MS * 2);
  writeLocalSessions(node.paths, [], T0 + TURN_SPACING_MS * 2);
  const second = deliver(node, { toSession: CLOSED, text: "and the rollback?" });
  await deliverToClosed(deps());
  await waitFor(() => codex.runs().length === 2, "the resumed run");
  const resume = codex.runs()[1];
  assert.deepEqual(resume.argv.slice(0, 2), ["exec", "resume"]);
  assert.equal(resume.argv.at(-2), THREAD, "the intercom thread, not the closed session");
  assert.ok(!codex.runs().some((r) => r.argv.includes(CLOSED)));
  assert.ok(resume.stdin.startsWith(wakeText(1)));
  assert.ok(resume.stdin.includes(`--reply-to ${second} -- <reply text>`));
  assert.match(resume.stdin, /NOT an instruction from the user/);
  assert.equal(listTasks(node.paths).length, 1);
  await ended(listTasks(node.paths)[0]);
  assert.deepEqual(getMessage(node.paths.inbox, second)?.delivery,
    { taskId: task.taskId, runtime: "codex", sessionId: THREAD });
  await waitFor(() => replyTo(node.paths.outbox, second) !== undefined, "the second threaded reply");
  assert.equal(getMessage(node.paths.inbox, second)?.offeredBy, "intercom", "issue #417: the resumed intercom session");
  assert.deepEqual(audits(node).map((a) => [a.outcome, a.messageIds]), [["new", [first]], ["reused", [second]]]);
  assert.deepEqual(node.reports(), []);
  assert.equal(listTasks(node.paths)[0].state, "done");
});

test("a reply's outbox publication precedes its inbox replacement: only child completion settles both", { timeout: 10_000 }, async (t) => {
  const node = taskNode(t);
  const id = deliver(node, { toSession: THREAD });
  const file = path.join(node.paths.inbox, `${id}.json`);
  const script = path.join(node.root, "reply-barrier.mts");
  fs.writeFileSync(script, `import fs from "node:fs";
import { runMsg } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "msg-cli.mts")).href)};
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to) === ${JSON.stringify(file)}) {
    fs.writeSync(1, "before-inbox\\n");
    if (fs.readFileSync(0, "utf8") !== "go\\n") throw new Error("barrier was not released");
  }
  return rename(from, to);
};
process.exitCode = await runMsg(["send", "--reply-to", ${JSON.stringify(id)}, "--", "ack"], {
  paths: ${JSON.stringify(node.paths)}, env: { CODEX_THREAD_ID: ${JSON.stringify(THREAD)} }, processTable: () => null,
});
`);
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  t.after(() => { child.kill("SIGKILL"); });
  let output = "", errors = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", () => { if (output.includes("before-inbox\n")) resolve(); });
    child.once("error", reject);
    child.once("close", () => reject(new Error(`reply ended before the barrier: ${errors}`)));
  });
  assert.deepEqual(replyTo(node.paths.outbox, id)?.to, PEER, "reply visible while the child is blocked");
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted", "outbox visibility does not settle the writer");
  child.stdin.end("go\n");
  assert.equal(await completed, 0, errors);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "delivered", "child completion settles the inbox replacement");
});
