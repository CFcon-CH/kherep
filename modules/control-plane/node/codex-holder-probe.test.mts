// Issue #706, Phase 2: the macOS holder probe on synthetic ps and lsof text.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ChildRun } from "./child-run.mts";
import { parseCodexProcesses, parseRolloutHolders, probeCodexHolders } from "./codex-holder-probe.mts";

const A = "01a0db01-0000-7000-8000-0000000000b1";
const B = "01a0db01-0000-7000-8000-0000000000b2";
const PS = [
  "  101 Wed Nov 11 09:05:01 2026     /Applications/Synthetic.app/Contents/MacOS/codex",
  "  202 Wed Nov 11 08:00:00 2026     /usr/local/bin/codex-helper",
  "  303 Tue Nov 10 23:59:59 2026     codex",
  "  404 Wed Nov 11 09:00:00 2026     /bin/zsh",
].join("\n");

function home(t: test.TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-holder-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "home", "sessions"), { recursive: true });
  return { root, home: path.join(root, "home"), sessions: path.join(root, "home", "sessions") };
}

test("ps rows keep exactly the codex executables, with a pid:start identity", () => {
  const processes = parseCodexProcesses(PS);
  assert.deepEqual(processes.map(p => p.pid), [101, 303]);
  assert.equal(processes[0].identity, `101:${Date.parse("Wed Nov 11 09:05:01 2026") / 1000}`);
  assert.match(processes[1].identity, /^[A-Za-z0-9._:-]{1,128}$/);
  assert.throws(() => parseCodexProcesses("garbled row"), /unparsable/);
});

test("lsof names outside <home>/sessions, non-rollout names and unnormalized paths are ignored", (t) => {
  const { sessions } = home(t);
  const processes = parseCodexProcesses(PS);
  const text = ["p101", "f12", `n${sessions}/2026/11/11/rollout-2026-11-11T09-00-00-${A}.jsonl`,
    `n${sessions}/2026/11/11/rollout-2026-11-11T09-00-00-${A}.jsonl`,
    `n${sessions}/../elsewhere/rollout-2026-11-11T09-00-00-${B}.jsonl`,
    `n/tmp/rollout-2026-11-11T09-00-00-${B}.jsonl`, `n${sessions}/notes.jsonl`, "p303",
    `n${sessions}/2026/11/11/rollout-2026-11-11T09-00-00-${B}.jsonl`].join("\n");
  const holders = parseRolloutHolders(text, sessions, processes);
  assert.deepEqual([...holders.keys()].sort(), [A, B]);
  assert.deepEqual(holders.get(A)!.map(h => h.pid), [101], "one entry per process");
  assert.deepEqual(holders.get(B)!.map(h => h.pid), [303]);
  assert.throws(() => parseRolloutHolders("p999\n", sessions, processes), /unexpected process/);
});

test("probe: no codex process skips lsof; a symlinked home matches lsof's real paths only", async (t) => {
  const { root, home: real, sessions } = home(t);
  const link = path.join(root, "link");
  fs.symlinkSync(real, link);
  const calls: string[] = [];
  const signal = new AbortController().signal;
  const none: ChildRun = async (file) => { calls.push(file); return PS.split("\n")[3] + "\n"; };
  const empty = await probeCodexHolders(link, [], signal, none, () => 1);
  assert.deepEqual([calls, empty.processes, empty.holders.size, empty.probed], [["ps"], [], 0, undefined]);
  const run: ChildRun = async (file, args) => {
    calls.push(file);
    if (file === "ps") return PS;
    assert.deepEqual(args, ["-nP", "-Fpn", "-p", "101,303"]);
    return ["p101", `n${sessions}/rollout-2026-11-11T09-00-00-${A}.jsonl`, "p303", `n${link}/sessions/rollout-2026-11-11T09-00-00-${B}.jsonl`].join("\n");
  };
  const scan = await probeCodexHolders(link, [], signal, run, () => 2);
  assert.deepEqual([...scan.holders.keys()], [A]);
  assert.equal(scan.at, 2);
});

test("probe: a non-zero lsof exit or an abort throws instead of reporting no holder", async (t) => {
  const { home: real } = home(t);
  const failing: ChildRun = async (file) => {
    if (file === "ps") return PS;
    throw Object.assign(new Error("lsof exited 1"), { code: 1 });
  };
  await assert.rejects(probeCodexHolders(real, [], new AbortController().signal, failing), /lsof exited 1/);
  const controller = new AbortController();
  const aborting: ChildRun = async () => { controller.abort(); return PS; };
  await assert.rejects(probeCodexHolders(real, [], controller.signal, aborting), { name: "AbortError" });
});
