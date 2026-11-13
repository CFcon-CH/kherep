// Issue #899: the Codex liveness source with the real Windows holder probe and
// fake powershell.exe output (PowerShell itself is never started). Two
// candidates, where the second file's Restart Manager call fails (X row).
// Synthetic ids, files and records only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ChildRun } from "./child-run.mts";
import { probeCodexHoldersWindows } from "./codex-holder-probe-windows.mts";
import { codexLivenessSource } from "./codex-liveness-source.mts";
import { markStopEnded, recordCodexSession } from "./codex-sessions.mts";
import { nodePaths } from "./config.mts";
import { judgeSession, type SessionEvidence } from "./session-liveness.mts";

const T = Date.UTC(2026, 10, 11, 9);
const NEWER = "01a0db01-0000-7000-8000-0000000000d1";
const OLDER = "01a0db01-0000-7000-8000-0000000000d2";
const FT = "134072163010000000";
const BATCH = `P 4242 ${FT}\nP 4343 ${FT}\nH 0 4242:${FT}\nX 1 list1 6\nE\n`;

function windowsNode(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-liveness-win-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: true, sessions: [NEWER, OLDER], nativeQueue: true } }));
  const home = path.join(root, "codex-home"), day = path.join(home, "sessions", "2026", "11", "11");
  fs.mkdirSync(day, { recursive: true });
  for (const [id, seen] of [[NEWER, T - 60_000], [OLDER, T - 120_000]] as const) {
    const rollout = path.join(day, `rollout-2026-11-11T09-00-00-${id}.jsonl`);
    fs.writeFileSync(rollout, "");
    fs.utimesSync(rollout, (T - 120_000) / 1000, (T - 120_000) / 1000);
    recordCodexSession(paths, id, undefined, seen, "default", "Stop");
    markStopEnded(paths, id);
  }
  return { paths, home };
}

test("an X row leaves only its thread unknown, logged once; the next clean scan gives both verdicts and one recovery line", async (t) => {
  const { paths, home } = windowsNode(t);
  let output = BATCH;
  let runs = 0;
  const run: ChildRun = async (file) => {
    assert.equal(file, "powershell.exe");
    runs++;
    return output;
  };
  const lines: string[] = [];
  const source = codexLivenessSource({ paths, home, now: () => T, platform: "win32", log: l => lines.push(l),
    probe: (h, c, signal) => probeCodexHoldersWindows(h, c, signal, run, () => T) });
  const targets = [{ runtime: "codex", sessionId: NEWER }, { runtime: "codex", sessionId: OLDER }];
  const verdicts = async () => {
    const observation = await source.observe(targets, new AbortController().signal);
    assert.equal(observation.status, "value");
    const value = observation.status === "value" ? observation.value : [];
    return Object.fromEntries(value.map((e: SessionEvidence) => [e.sessionId, judgeSession(e, T).state]));
  };

  assert.deepEqual(await verdicts(), { [NEWER]: "idle-loaded", [OLDER]: "unknown" });
  assert.deepEqual(await verdicts(), { [NEWER]: "idle-loaded", [OLDER]: "unknown" });
  assert.deepEqual(lines, [`kherep-node: codex holder probe failed: ${OLDER}: list1 6`], "logged once while unchanged");

  output = `P 4242 ${FT}\nP 4343 ${FT}\nH 0 4242:${FT}\nH 1 4343:${FT}\nE\n`;
  assert.deepEqual(await verdicts(), { [NEWER]: "idle-loaded", [OLDER]: "idle-loaded" });
  assert.deepEqual(await verdicts(), { [NEWER]: "idle-loaded", [OLDER]: "idle-loaded" });
  assert.deepEqual(lines.slice(1), ["kherep-node: codex holder probe recovered"]);
  assert.equal(runs, 4, "one powershell.exe per scan");
});
