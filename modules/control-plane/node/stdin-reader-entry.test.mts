import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { nodePaths, writeConfig } from "./config.mts";
import { runCodexHook, runHook } from "./deliver-hook.mts";

test("MCP entry retains its raw 32KiB limit and argument-before-read validation", () => {
  const hook = path.join(import.meta.dirname, "mcp-intent-hook.mts");
  const run = (input: Buffer, args = ["--config-root", os.tmpdir(), "--runtime", "claude-code"]) => {
    const result = spawnSync(process.execPath, [hook, ...args], { input, encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  for (const size of [32_767, 32_768]) {
    const raw = Buffer.concat([Buffer.alloc(size - 1, 32), Buffer.from([0xff])]);
    assert.equal(Buffer.byteLength(raw.toString("utf8")) > raw.length, true);
    assert.match(run(raw), /remote_mcp_invalid_input/);
  }
  assert.match(run(Buffer.alloc(32_769, 32)), /remote_mcp_input_too_large/);
  assert.match(run(Buffer.alloc(65_700), ["--invalid"]), /remote_mcp_invalid_arguments/);
});

test("delivery preserves its decoded 64KiB boundary and oversized Codex reconciliation", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-stdin-entry-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.com", nodeId: "00000000-0000-4000-8000-000000000001",
    name: "fixture", publicKey: "synthetic", privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  const warnings: string[] = [], writes: string[] = [];
  runHook(" ".repeat(65_535) + "{", { paths }, value => writes.push(value), value => warnings.push(value));
  assert.equal(warnings.length, 1, "exactly 64KiB reaches JSON parsing");
  warnings.length = 0;
  runHook(" ".repeat(65_536) + "{", { paths }, value => writes.push(value), value => warnings.push(value));
  assert.equal(warnings.length, 0, "more than 64KiB skips delivery");
  runHook(Buffer.alloc(32_768, 0xff).toString("utf8"), { paths }, value => writes.push(value), value => warnings.push(value));
  assert.equal(warnings.length, 0, "decoded/reencoded bytes, not the smaller raw input, determine delivery's limit");
  const owner = "019a2b3c-4d5e-7f60-8123-456789abcdef", reconciled: string[] = [];
  const fork = process.env.KHEREP_CODEX_FORK;
  delete process.env.KHEREP_CODEX_FORK;
  try {
    await runCodexHook(JSON.stringify({ hook_event_name: "Stop", session_id: owner, padding: "x".repeat(65_536) }),
      { paths }, value => writes.push(value), value => warnings.push(value), async value => { reconciled.push(value); });
  } finally {
    if (fork === undefined) delete process.env.KHEREP_CODEX_FORK;
    else process.env.KHEREP_CODEX_FORK = fork;
  }
  assert.deepEqual(reconciled, [owner]);
  assert.deepEqual(writes, []);
  assert.deepEqual(warnings, []);
});
