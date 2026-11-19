import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "./cli.mts";
import { nodePaths, writeConfig } from "./config.mts";

const nodeId = "00000000-0000-4000-8000-0000000000aa";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-node-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, KHEREP_CONFIG_DIR: root, CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    CODEX_HOME: path.join(root, "codex"), KHEREP_ENROLL_CODE: "" };
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "cli.mts"), ...args],
      { env, encoding: "utf8", timeout: 20_000, windowsHide: true });
    assert.ifError(result.error);
    return result;
  };
  return { root, paths: nodePaths(root), run };
}

test("node status and unenroll operate on the selected local enrollment only", t => {
  const { paths, root, run } = fixture(t);
  assert.deepEqual(JSON.parse(run("node", "status").stdout), { enrolled: false });
  fs.mkdirSync(paths.dir);
  const config = { version: 1 as const, nodeId, name: "synthetic", controlUrl: "https://control.example.invalid",
    publicKey: "synthetic public id", privateKeyFile: path.join(root, "synthetic-identity"), policyFile: paths.policy,
    enrolledAt: new Date(0).toISOString() };
  fs.writeFileSync(config.privateKeyFile, "synthetic key material");
  writeConfig(paths.config, config);
  const status = run("node", "status");
  assert.equal(status.status, 0);
  assert.deepEqual(JSON.parse(status.stdout), { enrolled: true, config, privateKeyPresent: true });
  assert.doesNotMatch(status.stdout, /synthetic key material/);

  const removed = run("node", "unenroll");
  assert.equal(removed.status, 0);
  assert.deepEqual(JSON.parse(removed.stdout), { unenrolled: true, nodeId,
    next: `ask an operator to revoke it: DELETE /api/nodes/${nodeId}` });
  assert.equal(fs.existsSync(paths.config), false);
  assert.equal(fs.existsSync(config.privateKeyFile), false);
  const repeated = run("node", "unenroll");
  assert.equal(repeated.status, 0);
  assert.deepEqual(JSON.parse(repeated.stdout), { unenrolled: false, nodeId: null, next: "nothing was enrolled" });
});

test("the node CLI prints a daemon error and an unsuccessful doctor report for an empty config root", t => {
  const { run } = fixture(t);
  const daemon = run("daemon");
  assert.equal(daemon.status, 1);
  assert.equal(daemon.stdout, "");
  assert.match(daemon.stderr, /kherep-node: not enrolled .*kherep-node node onboard/);

  const doctor = run("doctor");
  assert.equal(doctor.status, 1);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.checks.enrollment.ok, false);
  assert.deepEqual(report.checks.worker, { ok: false, detail: "needs an enrolled node" });
});

test("the CLI dispatches subcommands to their own argument parsers and reports incomplete enrollment", async t => {
  const { run } = fixture(t);
  const cases: Array<[string[], RegExp]> = [
    [["attach"], /kherep-node attach/],
    [["task", "status"], /kherep-node task status/],
    [["msg"], /kherep-node msg sessions/],
    [["node", "onboard", "--url", "https://control.example.invalid"], /kherep-node node onboard/],
    [["node", "unknown"], /kherep-node node status/],
  ];
  for (const [args, usage] of cases) {
    const result = run(...args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, usage);
  }
  assert.equal(await main(["attribution", "--unknown-option"]), 2);
});
