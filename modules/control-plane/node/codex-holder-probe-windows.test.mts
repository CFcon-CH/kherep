// Issue #706, Phase 2: the Windows holder probe's parser and timeout handling
// on synthetic rows. PowerShell itself is never started here.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ChildRun } from "./child-run.mts";
import { parseWindowsHolders, probeCodexHoldersWindows } from "./codex-holder-probe-windows.mts";

const A = "01a0db01-0000-7000-8000-0000000000c1";
const B = "01a0db01-0000-7000-8000-0000000000c2";
const FT = "134072163010000000"; // a FILETIME in November 2026
const files = [{ file: "C:\\synthetic\\a.jsonl", threadId: A }, { file: "C:\\synthetic\\b.jsonl", threadId: B }];

test("rows bind a holder only to a live codex process with the same start time", () => {
  const scan = parseWindowsHolders([`P 11 ${FT}`, `P 22 ${FT}`, `H 0 11:${FT},33:${FT}`, `H 1 22:1`, "E"].join("\r\n"), files, 5);
  assert.deepEqual(scan.processes.map(p => p.identity), [`11:${FT}`, `22:${FT}`]);
  assert.deepEqual(scan.holders.get(A)!.map(h => h.pid), [11]);
  assert.deepEqual(scan.holders.get(B), [], "start time differs: not a holder");
  assert.deepEqual([...scan.probed!].sort(), [A, B]);
  assert.equal(scan.processes[0].startMs, Number(BigInt(FT) / 10_000n - 11_644_473_600_000n));
  assert.match(scan.processes[0].identity, /^[A-Za-z0-9._:-]{1,128}$/);
});

test("without a codex process every thread is covered; a missing end or row fails the scan", () => {
  const none = parseWindowsHolders("E\n", files, 5);
  assert.deepEqual([none.processes, none.holders.size, none.probed], [[], 0, undefined]);
  assert.throws(() => parseWindowsHolders(`P 11 ${FT}\nH 0`, files, 5), /incomplete/);
  assert.throws(() => parseWindowsHolders(`P 11 ${FT}\nH 0\nE`, files, 5), /incomplete/);
  assert.throws(() => parseWindowsHolders(`P 11 ${FT}\nH 0\nH 0\nH 1\nE`, files, 5), /unparsable/);
  assert.throws(() => parseWindowsHolders("garbage\nE", files, 5), /unparsable/);
});

test("a PowerShell timeout runs once more; a second timeout or other error throws", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-holder-win-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const day = path.join(root, "sessions", "2026", "11", "11");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-11-11T09-00-00-${A}.jsonl`), "");
  const timeout = () => Object.assign(new Error("powershell.exe timed out after 10 s"), { code: "ETIMEDOUT" });
  let calls = 0;
  const once: ChildRun = async (file, args) => {
    assert.equal(file, "powershell.exe");
    assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    if (++calls === 1) throw timeout();
    return `P 11 ${FT}\nH 0 11:${FT}\nE\n`;
  };
  const scan = await probeCodexHoldersWindows(root, [A, B], new AbortController().signal, once, () => 7);
  assert.equal(calls, 2);
  assert.deepEqual([...scan.probed!], [A], "a thread without a located rollout is not probed");
  assert.deepEqual(scan.holders.get(A)!.map(h => h.file), [path.join(day, `rollout-2026-11-11T09-00-00-${A}.jsonl`)]);
  await assert.rejects(probeCodexHoldersWindows(root, [A], new AbortController().signal, async () => { throw timeout(); }), /timed out/);
  await assert.rejects(probeCodexHoldersWindows(root, [A], new AbortController().signal, async () => { throw new Error("exit 1"); }), /exit 1/);
});
