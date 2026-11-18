#!/usr/bin/env node
// Issue #965: the background refresh of orphan-check-nudge.mts, which the contract suite turns off.
// The workspace holds a synthetic checkout whose bootstrap/orphan-check.sh only leaves a marker, so
// no live space is ever read. A missing or stale report starts that script detached and says so;
// without a checkout, or without the script in it, the hook names the manual command instead.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const HOOK = path.join(import.meta.dirname, "orphan-check-nudge.mts");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orphan-refresh-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const CLEAN = "space: KB\npages: 200\ncount: 0\nexit: 0\n";
let seq = 0;

interface Box { home: string; workspace: string; marker: string }

// A home with an optional report (mtime hours ago) and a workspace whose checkout has the fake script.
function box(report: string | null, hoursAgo = 0, { checkout = true, script = true } = {}): Box {
  const root = path.join(TMP, `case-${++seq}`);
  const home = path.join(root, "home", ".claude");
  const workspace = path.join(root, "ws");
  const marker = path.join(root, "refresh-started");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  if (checkout) fs.mkdirSync(path.join(workspace, "kherep", "claude", "hooks"), { recursive: true });
  if (checkout && script) {
    fs.mkdirSync(path.join(workspace, "kherep", "bootstrap"));
    fs.writeFileSync(path.join(workspace, "kherep", "bootstrap", "orphan-check.sh"), "printf started > \"$(dirname \"$0\")/../../../refresh-started\"\n");
  }
  if (report !== null) {
    const file = path.join(home, ".cache", "orphan-check", "last-report.txt");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, report);
    const when = new Date(Date.now() - hoursAgo * 3_600_000);
    fs.utimesSync(file, when, when);
  }
  return { home, workspace, marker };
}

function run(b: Box, homeVariable: "CLAUDE_HOME" | "HOME" = "CLAUDE_HOME"): string {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("KHEREP_") && name !== "CLAUDE_HOME"));
  const homes = homeVariable === "CLAUDE_HOME" ? { CLAUDE_HOME: b.home } : { HOME: path.dirname(b.home), USERPROFILE: path.dirname(b.home) };
  return execFileSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: b.workspace }), encoding: "utf8", windowsHide: true,
    env: { ...inherited, ...homes, KHEREP_WORKSPACE: b.workspace } });
}

async function started(b: Box): Promise<boolean> {
  for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 50))) {
    if (fs.existsSync(b.marker)) return true;
  }
  return false;
}

test("a missing report starts the read-only scan in the background", async () => {
  const b = box(null);
  assert.match(run(b), /never been checked .* A read-only scan was started in the background/);
  assert.equal(await started(b), true, "the checkout's script ran");
});

test("without CLAUDE_HOME the report is looked up under the user's home directory", async () => {
  const b = box(CLEAN, 72);
  assert.match(run(b, "HOME"), /found no orphans, but it is stale\. A refresh was started in the background\./);
  assert.equal(await started(b), true);
});

test("a stale report with orphans lists five, counts the rest and starts a fresh count", async () => {
  const titles = Array.from({ length: 7 }, (_, i) => `orphan\t${i}\tPage ${i}`).join("\n");
  const b = box(`space: KB\n${titles}\npages: 200\ncount: 7\nexit: 1\n`, 72);
  const out = run(b);
  assert.match(out, /^ORPHAN-CHECK: 7 page\(s\) in the knowledge space have no incoming link \(report 3d old, STALE\):$/m);
  assert.match(out, /^ {2}- Page 4$/m);
  assert.doesNotMatch(out, /Page 5/);
  assert.match(out, /^ {2}\.\.\. and 2 more$/m);
  assert.match(out, /A fresh read-only count was started in the background\./);
  assert.equal(await started(b), true);
});

test("without a checkout, or without the script in it, the manual command is named", () => {
  for (const options of [{ checkout: false }, { script: false }]) {
    const b = box(null, 0, options);
    assert.match(run(b), /never been checked .* Run `bash kherep\/bootstrap\/orphan-check\.sh`/, JSON.stringify(options));
    assert.equal(fs.existsSync(b.marker), false);
  }
});
