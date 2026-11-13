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

// Issue #899: a failing Restart Manager call yields an X row for that file only.
test("an X row marks only its thread failed; X without a codex process or a duplicate row fails the scan", () => {
  const scan = parseWindowsHolders([`P 11 ${FT}`, `H 0 11:${FT}`, "X 1 list1 6", "E"].join("\n"), files, 5);
  assert.deepEqual(scan.holders.get(A)!.map(h => h.pid), [11]);
  assert.equal(scan.holders.has(B), false, "a failed thread has no holder entry");
  assert.deepEqual([...scan.failed!], [[B, "list1 6"]]);
  assert.deepEqual([...scan.probed!].sort(), [A, B]);
  const ended = parseWindowsHolders([`P 11 ${FT}`, "X 0 error -2146233088", "X 1 list2 6 end 6", "E"].join("\n"), files, 5);
  assert.deepEqual([...ended.failed!], [[A, "error -2146233088"], [B, "list2 6 end 6"]]);
  assert.equal(parseWindowsHolders([`P 11 ${FT}`, "H 0", "H 1", "E"].join("\n"), files, 5).failed, undefined);
  assert.throws(() => parseWindowsHolders("X 0 list1 6\nE", files, 5), /unparsable/);
  assert.throws(() => parseWindowsHolders(`P 11 ${FT}\nH 0\nX 0 list1 6\nH 1\nE`, files, 5), /unparsable/);
  assert.throws(() => parseWindowsHolders(`P 11 ${FT}\nH 0\nX 1 open 6\nE`, files, 5), /unparsable/);
  assert.throws(() => parseWindowsHolders(`P 11 ${FT}\nH 0\nX 1 list1\nE`, files, 5), /unparsable/);
});

function rollouts(t: test.TestContext, ids: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-holder-win-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const day = path.join(root, "sessions", "2026", "11", "11");
  fs.mkdirSync(day, { recursive: true });
  const paths = ids.map(id => path.join(day, `rollout-2026-11-11T09-00-00-${id}.jsonl`));
  for (const file of paths) fs.writeFileSync(file, "");
  return { root, paths };
}
// The script line that builds $files, and the paths of its base64 literals.
const filesLine = (script: string): string => script.split(/\r?\n/).find(l => l.startsWith("$files = "))!;
const embedded = (line: string): string[] => [...line.matchAll(/'([A-Za-z0-9+/=]*)'/g)].map(m => Buffer.from(m[1], "base64").toString("utf8"));

// Issue #899, measured on a Windows node: under Windows PowerShell 5.1
// `@(... | ConvertFrom-Json)` gave one element holding every path for 2+ files.
// Only the script text is checked here; PowerShell 5.1 itself runs only on Windows.
test("the script embeds each rollout as its own literal and never pipes a JSON array", async (t) => {
  const { root, paths } = rollouts(t, [A, B]);
  const scripts: string[] = [];
  // One H row per located rollout, as a correct script prints them, so the scan
  // completes and the script text itself decides this test.
  let rowCount = 2;
  const run: ChildRun = async (_file, args) => {
    scripts.push(args.at(-1)!);
    const rows = Array.from({ length: rowCount }, (_r, i) => `H ${i} ${11 * (i + 1)}:${FT}`);
    return [`P 11 ${FT}`, `P 22 ${FT}`, ...rows, "E"].join("\n");
  };
  const scan = await probeCodexHoldersWindows(root, [A, B], new AbortController().signal, run, () => 7);
  const line = filesLine(scripts[0]);
  assert.doesNotMatch(scripts[0], /@\([^\n]*\|\s*ConvertFrom-Json\s*\)/, "the PowerShell 5.1 list form of issue #899");
  assert.doesNotMatch(scripts[0], /ConvertFrom-Json/);
  assert.match(line, /^\$files = @\(@\('[^']+','[^']+'\) \| ForEach-Object \{ .*FromBase64String\(\$_\)\) \}\)$/);
  assert.deepEqual(embedded(line), paths, "two files: two elements, one path each");
  assert.match(scripts[0], /\[KherepRolloutHolders\]::Row\(\$i, \[string\]\$files\[\$i\]\)/);
  assert.equal(scan.failed, undefined);
  assert.deepEqual(scan.holders.get(A)!.map(h => [h.pid, h.file]), [[11, paths[0]]]);
  assert.deepEqual(scan.holders.get(B)!.map(h => [h.pid, h.file]), [[22, paths[1]]]);
  assert.deepEqual([...scan.probed!].sort(), [A, B]);
  rowCount = 1;
  await probeCodexHoldersWindows(root, [A], new AbortController().signal, run, () => 7);
  assert.deepEqual(embedded(filesLine(scripts[1])), [paths[0]], "one file: one element");
  await probeCodexHoldersWindows(root, [], new AbortController().signal, async (_f, args) => { scripts.push(args.at(-1)!); return "E\n"; }, () => 7);
  assert.equal(filesLine(scripts[2]), "$files = @(@() | ForEach-Object { [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) })");
});

test("an X row from the batch leaves only that thread failed and runs no second powershell.exe", async (t) => {
  const { root } = rollouts(t, [A, B]);
  let calls = 0;
  const run: ChildRun = async () => { calls++; return `P 11 ${FT}\nH 0 11:${FT}\nX 1 list1 6\nE\n`; };
  const scan = await probeCodexHoldersWindows(root, [A, B], new AbortController().signal, run, () => 7);
  assert.equal(calls, 1);
  assert.deepEqual([...scan.failed!], [[B, "list1 6"]]);
  assert.deepEqual(scan.holders.get(A)!.map(h => h.pid), [11]);
  assert.deepEqual([...scan.probed!].sort(), [A, B]);
});
