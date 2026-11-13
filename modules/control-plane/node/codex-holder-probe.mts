import fs from "node:fs";
import path from "node:path";

import { children, type ChildRun } from "./child-run.mts";
import { rolloutThreadId } from "./codex-hook-owner.mts";
import { timedAsync } from "./sync-timing.mts";

// Issue #706, Phase 2: which live codex process holds a thread's rollout file
// open (design D1: the holder is the process that has the thread loaded). Only
// the OS process table and open-file table are read: the executable name, the
// start time and open file names. No argv, no file content, nothing logged.
// Every failure throws; a failed scan must never look like "no holder".
// Codex source (openai/codex 2b60119, rollout/src/recorder.rs): a resumed
// thread opens its rollout at once, a new thread at its first write, and the
// writer closes at shutdown or after an I/O error (false negatives only).

export interface HolderProcess { pid: number; startMs: number; identity: string }
export interface Holder extends HolderProcess { file: string }
// processes: every live codex process; holders: thread id to the processes
// holding its rollout; probed: the thread ids the scan covered, undefined when
// it covered every rollout under <home>/sessions; failed: probed thread ids
// whose own query failed (Windows, issue #899), to a fixed reason "<stage> <code>".
export interface HolderScan { at: number; processes: HolderProcess[]; holders: Map<string, Holder[]>; probed?: Set<string>; failed?: Map<string, string> }
export type HolderProbe = (home: string, candidates: string[], signal: AbortSignal) => Promise<HolderScan>;

export const HOLDER_PROBE_TIMEOUT_MS = 10_000;
// Matched against the trimmed row, so the command needs no lazy match or trailing-space group.
const PS_ROW = /^(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*)$/;

// `ps -axo pid=,lstart=,comm=` in the C locale. Keeps rows whose executable
// basename is exactly codex; an unparsable row fails the whole scan.
export function parseCodexProcesses(text: string): HolderProcess[] {
  const processes: HolderProcess[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const match = PS_ROW.exec(line.trim());
    if (!match) throw new Error("unparsable process row");
    if (path.posix.basename(match[3]) !== "codex") continue;
    const pid = Number(match[1]), startMs = Date.parse(match[2]);
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isFinite(startMs)) throw new Error("unparsable process row");
    const start = Math.floor(startMs / 1000);
    processes.push({ pid, startMs: start * 1000, identity: `${pid}:${start}` });
  }
  return processes;
}

// The canonical rollout path under root, or undefined for anything else
// (another directory, a relative or non-normalized path, a non-rollout name).
export function rolloutUnder(root: string, name: string): { file: string; threadId: string } | undefined {
  if (!path.isAbsolute(name) || path.resolve(name) !== name) return;
  const relative = path.relative(root, name);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
  const threadId = rolloutThreadId(name);
  return threadId ? { file: name, threadId } : undefined;
}

// `lsof -nP -Fpn -p <pids>` field output: p<pid> starts a process set, n<name>
// names an open file. Only rollout names under root are kept.
export function parseRolloutHolders(text: string, root: string, processes: HolderProcess[]): Map<string, Holder[]> {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const holders = new Map<string, Holder[]>();
  let current: HolderProcess | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) {
      current = byPid.get(Number(line.slice(1)));
      if (!current) throw new Error("open-file listing names an unexpected process");
    } else if (line.startsWith("n") && current) {
      const rollout = rolloutUnder(root, line.slice(1));
      if (!rollout) continue;
      const list = holders.get(rollout.threadId) ?? [];
      if (!list.some(h => h.pid === current!.pid)) list.push({ ...current, file: rollout.file });
      holders.set(rollout.threadId, list);
    }
  }
  return holders;
}

// macOS. Candidates are ignored: the scan covers every rollout under <home>/sessions.
export async function probeCodexHolders(home: string, _candidates: string[], signal: AbortSignal,
  run: ChildRun = children.run, now: () => number = Date.now): Promise<HolderScan> {
  signal.throwIfAborted();
  const at = now();
  const env = { ...process.env, LC_ALL: "C" };
  const ps = await timedAsync("codex-holder-ps", () => run("ps", ["-axo", "pid=,lstart=,comm="], { env, timeoutMs: HOLDER_PROBE_TIMEOUT_MS }));
  signal.throwIfAborted();
  const processes = parseCodexProcesses(ps);
  if (processes.length === 0) return { at, processes, holders: new Map() };
  const root = path.join(fs.realpathSync(home), "sessions");
  // A pid that ended between both commands makes lsof exit non-zero: a failed scan.
  const lsof = await timedAsync("codex-holder-lsof", () => run("lsof", ["-nP", "-Fpn", "-p", processes.map(p => p.pid).join(",")],
    { env, timeoutMs: HOLDER_PROBE_TIMEOUT_MS }));
  signal.throwIfAborted();
  return { at, processes, holders: parseRolloutHolders(lsof, root, processes) };
}
