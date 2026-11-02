import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type test from "node:test";

import type { CodexDeps } from "./codex-process.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { taskNode } from "./task-fixture.mts";

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

export const THREAD = "0199a000-0000-7000-8000-000000000001";
export const LAST_MESSAGE = "  All tests pass.\n\n";

const CLI = path.join(import.meta.dirname, "cli.mts");

export const SCRIPT = (log: string): string => `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
// codex mcp list --json (codex-mcp.mts): no MCP server, not logged as a run.
if (argv.includes("mcp")) { process.stdout.write("[]\\n"); process.exit(0); }
const stdin = fs.readFileSync(0, "utf8");
const env = { KHEREP_CONFIG_DIR: process.env.KHEREP_CONFIG_DIR, KHEREP_SESSION_ID: process.env.KHEREP_SESSION_ID,
  CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID };
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd(), stdin, pid: process.pid, ppid: process.ppid, env }) + "\\n");
// codex queue: a thread starting with fa11 has no app server, as when none owns it.
if (argv[0] === "queue") {
  if (argv[2].startsWith("5eec")) { setTimeout(() => process.exit(0), 250); return; }
  // A thread starting with 0a9e hangs: a grandchild holds stderr open, as codex.exe behind the npm launcher does.
  if (argv[2].startsWith("0a9e")) {
    const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "inherit"] });
    fs.writeFileSync(${JSON.stringify(log)} + ".child", String(child.pid));
    fs.appendFileSync(${JSON.stringify(log)} + ".relations", JSON.stringify({ pid: child.pid, ppid: process.pid }) + "\\n");
    setInterval(() => {}, 1000);
    return;
  }
  if (argv[2].startsWith("fa11")) { process.stderr.write("Error: no app server owns this thread (token sk-live_Secret1)\\n"); process.exit(1); }
  if (argv[2].startsWith("beef")) { process.stdout.write("Queue accepted\\n"); process.exit(0); }
  process.stdout.write("Queued message " + require("node:crypto").randomUUID() + " for thread " + argv[2] + ".\\n");
  process.exit(0);
}
const prompt = argv[argv.length - 1] === "-" ? stdin : argv[argv.length - 1];
const out = argv[argv.indexOf("-o") + 1];
const thread = argv[1] === "resume" ? argv[argv.length - 2] : ${JSON.stringify(THREAD)};
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
if (prompt.includes("[silent]")) process.exit(2);
// Like the npm launcher: codex runs as a child of this process.
if (prompt.includes("[tree]")) {
  const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(${JSON.stringify(log)} + ".child", String(child.pid));
  fs.appendFileSync(${JSON.stringify(log)} + ".relations", JSON.stringify({ pid: child.pid, ppid: process.pid }) + "\\n");
}
if (prompt.includes("[stderr]")) {
  process.stderr.write("warning: first line\\nNot inside a trusted directory; key sk-proj_AbC*12-3 refused\\u0007\\n\\n");
  process.exit(1);
}
const peer = /^Message id: (\\S+)$/m.exec(prompt);
if (peer && !prompt.includes("[fail]") && !prompt.includes("[no-reply]")) require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(CLI)}, "msg", "send", "--reply-to", peer[1], "--", "ack"],
  { stdio: "ignore" });
emit({ type: "thread.started", thread_id: thread });
emit({ type: "turn.started" });
if (prompt.includes("[ignore-term]")) process.on("SIGTERM", () => {});
if (prompt.includes("[sleep]") || prompt.includes("[ignore-term]")) { emit({ type: "item.started", item: { id: "item_0", type: "reasoning" } }); setInterval(() => {}, 1000); }
else if (prompt.includes("[stall]")) setInterval(() => {}, 1000);
else if (prompt.includes("[fail]")) { emit({ type: "turn.failed", error: { message: "model refused" } }); process.exit(1); }
else { fs.writeFileSync(out, ${JSON.stringify(LAST_MESSAGE)}); emit({ type: "turn.completed", usage: {} }); process.exit(0); }
`;

export interface FakeRun { argv: string[]; cwd: string; stdin: string; pid: number; ppid?: number; env: { KHEREP_CONFIG_DIR?: string; KHEREP_SESSION_ID?: string } }

export function codexNode(t: test.TestContext, sessions: Record<string, unknown> = {}, codex: CodexDeps = {}) {
  const node = taskNode(t, { runtimes: ["claude", "codex"], ...sessions });
  // Outside the node directory, so the cleanup below still finds the log.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-fake-codex-"));
  const log = path.join(bin, "runs.jsonl");
  const fake = path.join(bin, "codex");
  fs.writeFileSync(fake, SCRIPT(log), { mode: 0o755 });
  // Only complete, non-empty lines count as recorded starts (issue #452).
  const runs = (): FakeRun[] => {
    if (!fs.existsSync(log)) return [];
    const text = fs.readFileSync(log, "utf8");
    const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
    return complete.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as FakeRun);
  };
  // No fake outlives its test.
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
  // Only relations emitted by our generated processes, never a host inventory.
  const relations = () => {
    const childFile = `${log}.relations`;
    const children = fs.existsSync(childFile) ? fs.readFileSync(childFile, "utf8").trim().split("\n")
      .filter(Boolean).map(line => JSON.parse(line) as { pid: number; ppid: number }) : [];
    return [...runs().flatMap(run => run.ppid === undefined ? [] : [{ pid: run.pid, ppid: run.ppid }]), ...children];
  };
  const deps = (extra: CodexDeps = {}): RunnerDeps => ({
    ...node.deps(), codex: { findCodex: () => fake, startWaitMs: 5_000, graceMs: 300, processRelations: relations, ...codex, ...extra },
  });
  return { ...node, fake, runs, deps };
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
