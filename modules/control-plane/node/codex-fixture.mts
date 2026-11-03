import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type test from "node:test";

import type { CodexDeps } from "./codex-process.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { taskNode } from "./task-fixture.mts";
import { runMsg } from './msg-cli.mts';

// A fake codex for the Codex task tests (issue #63): an executable Node script
// that never runs a model. It reads its prompt from stdin to the end (so a
// stdin left open hangs it), logs argv, working directory and that prompt,
// then prints `codex exec --json` events. The prompt
// picks the behavior: [sleep] runs until stopped after its first item,
// [stall] runs until stopped without any item (issue #197), [ignore-term] also ignores
// SIGTERM, [fail] ends with turn.failed and exit 1, [silent] exits 2 without
// events (`codex queue` only logs, or fails for a thread starting with fa11), [stderr] exits 1 after two stderr lines, [tree] also starts a
// child that runs until killed (as codex does behind the npm launcher); otherwise the turn completes, -o gets the last message, exit 0.
// A resume keeps the thread id it was given. A prompt that carries a peer
// message ("Message id: <id>") is answered first with the real
// `kherep-node msg send --reply-to <id>`, run with the environment the node
// gave, unless the prompt says [fail]: that turn fails before any reply.

import {SCRIPT} from "./codex-script-fixture.mts";
export {SCRIPT,THREAD,LAST_MESSAGE} from "./codex-script-fixture.mts";
const ownedBinaries=new Set<string>();

export interface FakeRun { argv: string[]; cwd: string; stdin: string; pid: number; ppid?: number; env: { KHEREP_CONFIG_DIR?: string; KHEREP_SESSION_ID?: string } }

export function codexNode(t: test.TestContext, sessions: Record<string, unknown> = {}, codex: CodexDeps = {},extra:Record<string,unknown>={}) {
  const node = taskNode(t, { runtimes: ["claude", "codex"], ...sessions },extra);
  // Outside the node directory, so the cleanup below still finds the log.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-fake-codex-"));
  const log = path.join(bin, "runs.jsonl");
  const fake = path.join(bin, "codex");
  fs.writeFileSync(fake, SCRIPT(log), { mode: 0o755 });
  ownedBinaries.add(fake);
  const children=new Map<number,ChildProcess>();
  const descendants=new Map<number,{parent:ChildProcess;alive:boolean}>(),treeStops=new Map<ChildProcess,NodeJS.Signals>();
  const ownedSpawn:typeof spawn=((file:string,args:string[],options:Parameters<typeof spawn>[2])=>{
    if(!ownedBinaries.has(file)&&!(file===process.execPath&&args.some(a=>ownedBinaries.has(a))))throw Error("fixture rejects a non-owned executable");
    const env=options?.env??{};
    const stdio=Array.isArray(options?.stdio)?[...options.stdio,'ipc' as const]:options?.stdio;
    const safeEnv:NodeJS.ProcessEnv={PATH:path.dirname(process.execPath),HOME:bin,CODEX_HOME:env.CODEX_HOME??path.join(bin,'home'),TMPDIR:bin,
      ...Object.fromEntries(Object.entries(env).filter(([key])=>["KHEREP_CONFIG_DIR","KHEREP_SESSION_ID","CLAUDE_CODE_SESSION_ID"].includes(key)))};
    const child=spawn(file,args,{...options,stdio,env:safeEnv});
    child.on('message',value=>{
      const event=value as {kind?:unknown;pid?:unknown};
      if(event?.kind==='fixture-child-born'&&Number.isSafeInteger(event.pid)&&(event.pid as number)>0){descendants.set(event.pid as number,{parent:child,alive:true});return;}
      if(event?.kind==='fixture-child-closed'){const owned=descendants.get(event.pid as number);if(owned?.parent===child)owned.alive=false;return;}
      if(event?.kind==='fixture-tree-empty'){const signal=treeStops.get(child);if(signal){treeStops.delete(child);child.kill(signal);}return;}
      const request=value as {kind?:unknown;id?:unknown};if(request?.kind!=='fixture-reply'||typeof request.id!=='string')return;
      void runMsg(['send','--reply-to',request.id,'--','ack'],{paths:node.paths,env:{KHEREP_SESSION_ID:safeEnv.KHEREP_SESSION_ID},now:()=>node.deps().now!(),
        processTable:()=>new Map(),out:()=>{},err:()=>{}}).then(code=>{if(child.connected)child.send({kind:'fixture-reply-complete',id:request.id,ok:code===0});});
    });
    if(child.pid)children.set(child.pid,child);return child;
  }) as typeof spawn;
  // Only complete, non-empty lines count as recorded starts (issue #452).
  const runs = (): FakeRun[] => {
    if (!fs.existsSync(log)) return [];
    const text = fs.readFileSync(log, "utf8");
    const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
    return complete.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as FakeRun);
  };
  // No fake outlives its test.
  t.after(async () => {
    for (const child of children.values())if(child.exitCode===null&&child.signalCode===null) {
      const closed=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('owned fixture teardown timed out')),5000);child.once('close',()=>{clearTimeout(timer);resolve();});});
      signalOwned(child.pid!,'SIGKILL','group');await closed;
    }
    if([...descendants.values()].some(d=>d.alive))throw Error('owned fixture descendant close unconfirmed');
    fs.rmSync(bin, { recursive: true, force: true });
  });
  const ownedStart=(pid:number):string|null=>{const child=children.get(pid);return child&&child.exitCode===null&&child.signalCode===null||descendants.get(pid)?.alive?`owned-start:${pid}`:null;};
  const signalOwned=(pid:number,signal:NodeJS.Signals,scope?:string)=>{
    const child=children.get(pid);
    if(child){if(scope==='group'&&[...descendants.values()].some(d=>d.parent===child&&d.alive)){treeStops.set(child,signal);child.send({kind:'fixture-tree-signal',signal});}else child.kill(signal);return;}
    const owned=descendants.get(pid);if(!owned?.alive||!owned.parent.connected)throw Error('fixture rejects a non-owned process');
    owned.parent.send({kind:'fixture-child-signal',pid,signal});
  };
  // Only relations emitted by our generated processes, never a host inventory.
  const relations = () => {
    const childFile = `${log}.relations`;
    const children = fs.existsSync(childFile) ? fs.readFileSync(childFile, "utf8").trim().split("\n")
      .filter(Boolean).map(line => JSON.parse(line) as { pid: number; ppid: number }) : [];
    return [...runs().flatMap(run => run.ppid === undefined ? [] : [{ pid: run.pid, ppid: run.ppid }]), ...children];
  };
  const deps = (extra: CodexDeps = {}): RunnerDeps => ({
    ...node.deps(), codex: { findCodex: () => fake,home:path.join(bin,"home"),spawn:ownedSpawn,
      mcpList:async()=>({code:0,stdout:"[]",stderr:""}),
      processStart:ownedStart,
      processTree:pid=>{const start=ownedStart(pid),root=children.get(pid);return start&&root?[{pid,start},...[...descendants].filter(([,d])=>d.parent===root&&d.alive).map(([pid])=>({pid,start:ownedStart(pid)!}))]:[];},signal:signalOwned,
      startWaitMs: 5_000, graceMs: 300, processRelations: relations, ...codex, ...extra },
  });
  return { ...node, fake, runs, deps,ownedStart,ownedClosed:(pid:number)=>ownedStart(pid)===null };
}

// The fake as a codex binary on any platform: on Windows behind an npm-style
// codex.cmd shim, which codex-binary.mts runs through its launcher with this Node.
export function fakeCodexBin(t: test.TestContext): { file: string; runs: () => FakeRun[]; child: () => number | null } {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-fake-codex-"));
  const log = path.join(bin, "runs.jsonl");
  let file = path.join(bin, "codex");
  if (process.platform === "win32") {
    const launcher = path.join(bin, "node_modules", "@openai", "codex", "bin");
    fs.mkdirSync(launcher, { recursive: true });
    fs.writeFileSync(path.join(launcher, "codex.js"), SCRIPT(log));
    file = path.join(bin, "codex.cmd");
    fs.writeFileSync(file, "@echo off\r\n");
  } else {
    fs.writeFileSync(file, SCRIPT(log), { mode: 0o755 });
  }
  // Only complete, non-empty lines count as recorded starts (issue #452).
  const runs = (): FakeRun[] => {
    if (!fs.existsSync(log)) return [];
    const text = fs.readFileSync(log, "utf8");
    const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
    return complete.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as FakeRun);
  };
  ownedBinaries.add(file);
  const childFile = `${log}.child`;
  const child = (): number | null => (fs.existsSync(childFile) ? Number(fs.readFileSync(childFile, "utf8")) : null);
  t.after(() => {
    for (const run of runs()) {
      try {
        process.kill(run.pid, "SIGKILL");
      } catch {
        // ended
      }
    }
    try {
      const pid = child();
      if (pid) process.kill(pid, "SIGKILL");
    } catch {
      // ended
    }
    fs.rmSync(bin, { recursive: true, force: true });
  });
  return { file, runs, child };
}

// Polls until check is true, for processes that end on their own schedule.
export async function waitFor(check: () => boolean | Promise<boolean>, what: string, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}
