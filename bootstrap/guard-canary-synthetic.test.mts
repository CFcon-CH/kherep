// Issue #808, stage 2b: the canary's --synthetic mode. It pipes the known-bad event through an installed
// dispatcher command (a scratch Claude home here) and a checkout's dispatcher (this one), spending no tokens.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { main } from "./guard-canary.mts";
import { DENY_TEXT, EM_DASH } from "./guard-canary-verdict.mts";

const REPO = path.resolve(import.meta.dirname, "..");
const tmp = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

// A Claude home whose settings.json wires a copy of this checkout's dispatcher and commit-guard, as the installer would.
// matcher null: the group has no matcher key, which matches every tool.
function syntheticHome(command?: (hooks: string) => string, matcher: string | null = "Bash"): string {
  const home = tmp("canary-synth-"), hooks = path.join(home, "hooks");
  fs.cpSync(path.join(REPO, "claude", "hooks"), hooks, { recursive: true });
  fs.mkdirSync(path.join(home, ".cache", "hook-integrity"), { recursive: true });
  fs.writeFileSync(path.join(home, ".cache", "hook-integrity", "heartbeat.json"), "{}\n");
  const cmd = command ? command(hooks) : `node "${path.join(hooks, "guard-dispatch.mts")}" "${path.join(hooks, "commit-guard.mts")}"`;
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Agent", hooks: [] },
    { matcher: "[", hooks: [{ type: "command", command: "x commit-guard.mts" }] }, { ...(matcher === null ? {} : { matcher }), hooks: [{ type: "command", command: cmd }] }] } }));
  return home;
}
async function synthetic(home: string, extra: string[] = []): Promise<{ code: number; report: Record<string, unknown>; lines: string[] }> {
  const lines: string[] = [];
  const code = await main(["--synthetic", "--home", home, ...extra], { env: process.env, out: (line) => lines.push(line) });
  return { code, lines, report: JSON.parse(fs.readFileSync(path.join(home, ".cache", "guard-canary", "last-report.json"), "utf8")) };
}

test("synthetic: the installed command and this checkout's dispatcher both deny the known-bad event", async () => {
  const { code, report } = await synthetic(syntheticHome(), ["--checkout", REPO]);
  assert.equal(code, 0);
  assert.equal(report.mode, "synthetic");
  assert.deepEqual((report.results as object[]).map((r) => ({ ...r })), [
    { runtime: "claude", source: "installed", verdict: "DENIED", exitCode: 0, reason: "deny-evidence", version: null },
    { runtime: "claude", source: "checkout", verdict: "DENIED", exitCode: 0, reason: "deny-evidence", version: null },
  ]);
  const text = JSON.stringify(report);
  for (const value of [EM_DASH, DENY_TEXT, "git commit", REPO]) assert.ok(!text.includes(value), value);
});

test("synthetic: a dispatcher that lets the event through is ALLOWED, exit 1", async () => {
  const home = syntheticHome((hooks) => {
    fs.writeFileSync(path.join(hooks, "allow.mts"), "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n");
    return `node "${path.join(hooks, "allow.mts")}" commit-guard.mts`;
  }, null);
  const { code, report, lines } = await synthetic(home);
  assert.equal(code, 1);
  assert.equal((report.results as { reason: string }[])[0]!.reason, "dispatcher-allowed");
  assert.ok(lines.some((line) => /ALLOWED.*FAILURE/.test(line)));
});

test("synthetic: missing settings, wiring, dispatcher or a hanging command are INCONCLUSIVE", async () => {
  const cases: [string, () => string, string[]][] = [
    ["settings-unreadable", () => tmp("canary-synth-"), []],
    ["installed-command-missing", () => { const home = tmp("canary-synth-"); fs.writeFileSync(path.join(home, "settings.json"), "{}"); return home; }, []],
    ["installed-command-missing", () => syntheticHome(undefined, "Agent|Task"), []],
    ["installed-command-unreadable", () => syntheticHome(() => 'node "commit-guard.mts'), []],
    ["timeout", () => syntheticHome((hooks) => {
      fs.writeFileSync(path.join(hooks, "hang.mts"), "setInterval(() => {}, 1000);\n");
      return `"${process.execPath}" "${path.join(hooks, "hang.mts")}" commit-guard.mts`;
    }), ["--timeout", "1"]],
  ];
  for (const [reason, home, extra] of cases) {
    const { code, report } = await synthetic(home(), extra);
    assert.equal(code, 2, reason);
    assert.equal((report.results as { reason: string }[])[0]!.reason, reason);
  }
  const { report } = await synthetic(syntheticHome(), ["--checkout", tmp("canary-empty-checkout-")]);
  assert.equal((report.results as { reason: string }[])[1]!.reason, "dispatcher-missing");
});
