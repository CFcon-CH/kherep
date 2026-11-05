import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { filesFor } from "./ci-shard.mts";
import { findTrustedExecutable, requireTrustedExecutable } from "../claude/hooks/lib/trusted-executable.mts";

test("native executable in cwd cannot run through empty, relative or absolute-cwd PATH entries", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trusted-native-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const native = process.platform === "win32" ? "fixture-tool.exe" : "fixture-tool";
  const planted = path.join(root, native), marker = path.join(root, "ran");
  const nativeFile = (file: string) => process.platform === "win32"
    ? fs.copyFileSync(process.execPath, file) : fs.symlinkSync(process.execPath, file);
  nativeFile(planted);
  const args = ["--eval", "require('node:fs').writeFileSync(process.env.FIXTURE_MARKER,'planted')"];
  const env = { ...process.env, FIXTURE_MARKER: marker };
  // Positive control proves this is a runnable native executable, including .exe on Windows.
  const control = spawnSync(planted, args, { cwd: root, env, encoding: "utf8" });
  assert.equal(control.status, 0, control.stderr);
  assert.equal(fs.readFileSync(marker, "utf8"), "planted");
  fs.unlinkSync(marker);
  for (const entry of ["", ".", "relative", root]) {
    const lookup = { cwd: root, env: { ...env, PATH: entry } };
    assert.equal(findTrustedExecutable("fixture-tool", lookup), null);
    assert.throws(() => requireTrustedExecutable("fixture-tool", lookup), { code: "ENOENT" });
  }
  if (process.platform !== "win32") {
    const alias = path.join(root, "cwd-alias");
    fs.symlinkSync(root, alias, "dir");
    assert.equal(findTrustedExecutable("fixture-tool", { cwd: root, env: { PATH: alias } }), null);
  }
  const trusted = path.join(root, "trusted");
  fs.mkdirSync(trusted);
  nativeFile(path.join(trusted, native));
  const command = requireTrustedExecutable("fixture-tool", { cwd: root, env: { ...env, PATH: trusted } });
  const safe = spawnSync(command, ["--eval", "console.log('trusted')"], { cwd: root, env, encoding: "utf8" });
  assert.equal(safe.status, 0, safe.stderr);
  assert.equal(safe.stdout.trim(), "trusted");
  assert.equal(fs.existsSync(marker), false, "the cwd executable ran");
});

test("a checkout executable is never run by public-export when PATH is relative", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trusted-cwd-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, "ran");
  // POSIX reproduces the same issue via relative PATH; the native Windows
  // executable regression below also exercises Windows' implicit cwd lookup.
  if (process.platform === "win32") { t.skip("POSIX relative-PATH reproduction; native .exe regression runs above"); return; }
  fs.writeFileSync(path.join(root, "git"), `#!/bin/sh\nprintf planted > '${marker}'\nexit 1\n`, { mode: 0o755 });
  const script = path.resolve(import.meta.dirname, "public-export.mts");
  const run = spawnSync(process.execPath, [script, "HEAD", path.join(root, "out")], {
    cwd: root, env: { ...process.env, PATH: "." }, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(fs.existsSync(marker), false, "the cwd git executable ran");
});

test("the native planted-executable regression belongs to the required Windows bootstrap-rest shard", () => {
  assert.ok(filesFor("bootstrap-rest").includes("trusted-executable-execution.test.mts"));
  const workflow = fs.readFileSync(path.resolve(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /suite: \[[^\n]*bootstrap-rest/);
  assert.match(workflow, /unit-windows-gate:[\s\S]*needs: unit-windows/);
});
