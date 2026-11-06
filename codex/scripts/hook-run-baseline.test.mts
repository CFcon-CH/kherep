import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { replayHooks } from "./hook-run-baseline.mts";

// Issue #503. A Control Plane hook command starts the stable entry point, which
// starts the hook as its one Node child: one extra Node process per such run.
const ENTRY = "codex-control-plane-hook.mts";

test("actual hook/process counts retain guard decisions and real Intercom Receive/Stop/ACK", () => {
  const measured = replayHooks();
  const node = path.basename(process.execPath);
  const entryRuns = measured.rows.filter(r => r.hook === ENTRY);
  assert.equal(entryRuns.length, 11);
  for (const row of entryRuns) {
    assert.deepEqual(row.children.filter(c => c.file === node), [{ file: node, script: `${row.target}-hook.mts` }]);
  }
  assert.equal(measured.totals.hookCommands, 41);
  // Issue #833. The eight shell-dispatcher replays each start one guard more; hookCommands stays.
  assert.equal(measured.totals.nodeProcesses, 87 + entryRuns.length);
  // On Windows the two Stop replays (stop-empty, stop-confirm) each resolve the service
  // owner once, which starts one powershell.exe (service-owner-probe.mts currentOwner);
  // POSIX reads os.userInfo() and starts nothing (issue #534).
  const ownerProbes = measured.rows
    .flatMap(r => r.children.filter(c => /^powershell(?:\.exe)?$/i.test(c.file)).map(() => r.label)).sort();
  assert.deepEqual(ownerProbes, process.platform === "win32" ? ["stop-confirm", "stop-empty"] : []);
  assert.equal(measured.totals.totalProcesses, 93 + entryRuns.length + ownerProbes.length);
  for (const label of ["lookup", "intercom-empty", "intercom-message"]) {
    const rows = measured.rows.filter(r => r.label === label && r.event === "PostToolUse");
    assert.equal(rows.length, 3, "the native return-point consumer is retained");
    assert.equal(rows.reduce((n, r) => n + r.nodeProcesses - (r.hook === ENTRY ? 1 : 0), 0), 3, "Bash watchers start no children");
  }
  const hint = measured.rows.filter(r => r.label === "intercom-message" && r.output.includes("New peer messages"));
  assert.equal(hint.length, 1);
  assert.deepEqual([hint[0]?.hook, hint[0]?.target], [ENTRY, "deliver"]);
  assert.equal(measured.rows.filter(r => r.label === "intercom-empty").every(r => !r.output), true);
  assert.equal(measured.rows.some(r => r.children.some(c => /codex(?:\.exe)?$/.test(c.file))), false);
});
