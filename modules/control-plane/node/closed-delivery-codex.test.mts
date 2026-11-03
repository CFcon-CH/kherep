import {publishSynthetic,fixtureEvidence} from './session-authority-fixture.mts';
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TURN_SPACING_MS } from "./autonomy.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { ACCEPT_ALL, audits, closedSince, deliver, PEER } from "./closed-fixture.mts";
import { SCRIPT, THREAD, codexNode, waitFor, type FakeRun } from "./codex-fixture.mts";
import { readExit } from "./codex-output.mts";
import { codexFiles, type CodexDeps } from "./codex-process.mts";
import { watchCodexTasks } from "./codex-watch.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessage, messageIds } from "./inbox.mts";
import { T0, taskNode, startArgs, TASK } from "./task-fixture.mts";
import { startTask } from './session-runner.mts';
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
    const file=path.join(node.root,"public-executable");fs.writeFileSync(file,Buffer.from([0x7f,69,76,70,2,1,1,0]));
    await deliverToClosed({ ...node.deps(), codex:{...codex,home:node.root,mcpList:async()=>({code:0,stdout:"[]",stderr:""}),...(name==="spawn failure"?{findCodex:()=>file}:{})} });
    const message = getMessage(node.paths.inbox, id);
    if(name==="missing binary"){
      assert.equal(message?.state,"accepted");assert.equal(message?.delivery,undefined);assert.equal(listTasks(node.paths).length,0);assert.match(String(audits(node).at(-1)?.reason),/producer-unknown/);
    }else{
      assert.equal(message?.state,"offered");assert.ok(message?.targetAttempt);assert.ok(message?.delivery);assert.equal(listTasks(node.paths).at(-1)?.state,"failed");
      assert.ok(!String(audits(node).at(-1)?.reason).includes("synthetic peer content"));
    }
  }
});
// The answer in the outbox to a message, from the msg CLI the fake ran.
const replyTo = (outbox: string, id: string): { to: unknown; inReplyTo?: string } | undefined => messageIds(outbox)
  .map((m) => JSON.parse(fs.readFileSync(path.join(outbox, `${m}.json`), "utf8")) as { to: unknown; inReplyTo?: string })
  .find((r) => r.inReplyTo === id);

test("a closed Codex session starts one threaded intercom and retains its strict owner after completion", async (t) => {
  const node = codexNode(t, { runtimes: ["claude", "codex"], delegate: { accept: true } },{},
    { messaging: { ...ACCEPT_ALL, resumeClosed: true } });
  const repo = path.join(node.workspace, "repo");
  // Last seen by a hook 13 hours ago: no longer listed.
  recordCodexSession(node.paths, CLOSED, repo, T0 - 13 * 3_600_000, "default");
  // Issue #389: closed by its miss streak.
  closedSince(node, CLOSED_SESSION);
  const codex={runs:node.runs};
  const deps = node.deps;
  const ended = async (task: TaskRecord): Promise<void> => {
    await waitFor(() => readExit(codexFiles(node.paths, task.taskId)) !== null, "the end of the run");
    await waitFor(() => node.ownedClosed(codex.runs().at(-1)!.pid), "the owned process exit");
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
  assert.equal(getMessage(node.paths.inbox, first)?.state, "delivered");
  assert.deepEqual(getMessage(node.paths.inbox, first)?.delivery,
    { taskId: task.taskId, runtime: "codex", sessionId: THREAD });
  await waitFor(() => replyTo(node.paths.outbox, first) !== undefined, "the threaded reply");
  assert.deepEqual(replyTo(node.paths.outbox, first)?.to, PEER);
  await ended(task);
  assert.equal(listTasks(node.paths)[0].sessionId, THREAD);

  node.tick(TURN_SPACING_MS * 2);
  writeLocalSessions(node.paths, [], T0 + TURN_SPACING_MS * 2);
  const second = deliver(node, { toSession: CLOSED, text: "and the rollback?" });
  await deliverToClosed(deps());
  assert.equal(codex.runs().length,1,'completion does not retire the immutable strict owner');
  assert.equal(getMessage(node.paths.inbox,second)?.state,'accepted');
  assert.equal(getMessage(node.paths.inbox,second)?.delivery,undefined);
  assert.equal(replyTo(node.paths.outbox,second),undefined);
  assert.equal(listTasks(node.paths).length, 1);
  assert.deepEqual(node.reports(), []);
});

test('a legacy ended Codex intercom gets one exact threaded resume without resuming the original closed session',async t=>{
  const node=codexNode(t,{delegate:{accept:true}},{},{messaging:{...ACCEPT_ALL,resumeClosed:true}});
  await startTask(startArgs(TASK,{runtime:'codex',requestedBy:`${PEER.nodeId}/${PEER.session}`}),{...node.deps(),local:'intercom',executionContext:{kind:'operator'}});
  await waitFor(()=>readExit(codexFiles(node.paths,TASK))!==null&&node.ownedClosed(node.runs()[0].pid),'the legacy owned run close');
  await watchCodexTasks(node.deps());node.reports();node.tick(TURN_SPACING_MS*2);
  recordCodexSession(node.paths,CLOSED,path.join(node.workspace,'repo'),T0-13*3600000,'default');
  closedSince(node,CLOSED_SESSION,T0+TURN_SPACING_MS*2);
  publishSynthetic(node.paths,[CLOSED,THREAD].map(sessionId=>({...fixtureEvidence({runtime:'codex',sessionId},'closed',T0+TURN_SPACING_MS*2),lifecycle:{status:'value' as const,value:{state:'restored' as const,generation:7},source:'native-lifecycle' as const,observedAt:T0+TURN_SPACING_MS*2,complete:true,reasonCode:'observed' as const}})),T0+TURN_SPACING_MS*2,[],node.livenessAuthority);
  const id=deliver(node,{toSession:CLOSED,text:'legacy intercom first strict reply'});
  await deliverToClosed(node.deps());await waitFor(()=>replyTo(node.paths.outbox,id)!==undefined,'the resumed threaded reply');
  const resume=node.runs()[1];assert.deepEqual(resume.argv.slice(0,2),['exec','resume']);assert.equal(resume.argv.at(-2),THREAD);
  assert.equal(resume.argv.includes(CLOSED),false);assert.ok(resume.stdin.includes(`--reply-to ${id} -- <reply text>`));
  assert.deepEqual(replyTo(node.paths.outbox,id)?.to,PEER);assert.equal(getMessage(node.paths.inbox,id)?.state,'delivered');
  assert.equal(listTasks(node.paths).length,1);
});
