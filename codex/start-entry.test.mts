import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { catalog, fixture, newerCatalog, repoRoot, write } from "./model-selection-install.fixture.mts";

const entry = path.join(repoRoot, "codex", "start.mts");
const coverageEnv = process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {};

test("the real start entry prints help, reports a bounded argument error, and is silent on import", (t) => {
  const f = fixture(t);
  const run = (args: string[], env: NodeJS.ProcessEnv = { CODEX_HOME: f.codexHome }) => spawnSync(process.execPath, args, {
    cwd: f.root, encoding: "utf8", timeout: 15_000, env: { ...coverageEnv, SystemRoot: process.env.SystemRoot, ...env },
  });
  const help = run([entry, "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: node codex\/start\.mts \[--workspace/);
  const invalid = run([entry, "--synthetic-invalid"]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /^codex-start-invalid-arguments\r?\n/);
  assert.match(run([entry, "--prepare-only", "--prepare-only"]).stderr, /^codex-start-invalid-arguments\r?\n/);
  const injectedHome = path.join(f.root, "injected-home.mjs");
  write(injectedHome, 'import os from "node:os"; os.homedir = () => { throw new Error("private home diagnostic fixture"); };\n');
  const unresolvedHome = run(["--import", pathToFileURL(injectedHome).href, entry, "--prepare-only"], {});
  assert.equal(unresolvedHome.status, 1);
  assert.match(unresolvedHome.stderr, /^codex-start-preflight-failed\r?\n/);
  assert.doesNotMatch(unresolvedHome.stderr, /private home/);
  const url = new URL("./start.mts", import.meta.url).href;
  for (const beforeImport of ["", `process.argv[1] = ${JSON.stringify(path.join(f.root, "absent.mts"))};`]) {
    const imported = run(["--input-type=module", "-e", `${beforeImport} await import(${JSON.stringify(url)});`]);
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, "");
  }
  if (process.platform !== "win32") {
    const alias = path.join(f.root, "linked-source");
    fs.symlinkSync(repoRoot, alias, "dir");
    for (const options of [[], ["--preserve-symlinks-main"]]) {
      const linked = run([...options, path.join(alias, "codex", "start.mts"), "--help"]);
      assert.equal(linked.status, 0, linked.stderr);
      assert.equal(linked.stdout, help.stdout);
    }
  }
});

// Bounded metadata protocol and startup command recorder. The test puts this
// executable first on a synthetic PATH and supplies only fixture config/data.
const fakeCodex = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
const mode = args.includes("app-server") ? "catalog" : "interactive";
const save = (data) => fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(data) + "\n");
save({ mode, args, workspace: process.cwd(), home: process.env.CODEX_HOME });
if (mode === "catalog") {
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const { id, method, params } = JSON.parse(line);
    save({ method, params });
    if (method === "initialized") return;
    if (method !== "initialize" && method !== "model/list") throw new Error("unexpected fixture request");
    if (method === "model/list" && process.env.FIXTURE_UNLINK === "1") fs.unlinkSync(process.argv[1]);
    const result = method === "initialize" ? {} : { data: JSON.parse(process.env.FIXTURE_CATALOG), nextCursor: null };
    process.stdout.write(JSON.stringify({ id, result }) + "\n");
  });
} else if (process.env.FIXTURE_SIGNAL) {
  process.kill(process.pid, process.env.FIXTURE_SIGNAL);
} else {
  process.exitCode = Number(process.env.FIXTURE_EXIT || "0");
}
`;

test("the POSIX start entry reads a real fixture catalog, prepares or launches, and reports launch failure", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.workspace, { recursive: true });
  f.run({ modelCatalog: catalog(), applyRootModelPolicy: true });
  const workspace = fs.realpathSync.native(f.workspace), home = fs.realpathSync.native(f.codexHome);
  const bin = path.join(f.root, "bin"), executable = path.join(bin, "codex"), log = path.join(f.root, "calls.jsonl");
  write(executable, fakeCodex);
  fs.chmodSync(executable, 0o700);
  const calls = () => fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const run = (args: string[], fixtureEnv: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [entry, "--workspace", workspace, ...args], {
    cwd: f.root, encoding: "utf8", timeout: 45_000,
    env: { ...coverageEnv, PATH: [bin, path.dirname(process.execPath)].join(path.delimiter), CODEX_HOME: home,
      FIXTURE_CATALOG: JSON.stringify(newerCatalog().models), FIXTURE_CALLS: log, ...fixtureEnv },
  });

  const prepared = run(["--prepare-only"]);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /model selection prepared/);
  assert.deepEqual(calls()[0], { mode: "catalog", args: ["-c", "features.plugins=false", "app-server", "--listen", "stdio://"], workspace, home });
  assert.deepEqual(calls().slice(1).map((row) => row.method), ["initialize", "initialized", "model/list"]);
  assert.equal(f.field("kherep-builder", "model"), "gpt-7-sol");

  const unsupportedDesktop = run(["--desktop"]);
  assert.equal(unsupportedDesktop.status, 1);
  assert.match(unsupportedDesktop.stderr, /^codex-start-desktop-platform-unsupported\r?\n/);

  const interactive = run([], { FIXTURE_EXIT: "19" });
  assert.equal(interactive.status, 19, interactive.stderr);
  assert.deepEqual(calls().at(-1), { mode: "interactive", args: ["--no-daemon", "--cd", workspace, "--model", "gpt-7-sol"], workspace, home });
  assert.equal(run([], { FIXTURE_SIGNAL: "SIGINT" }).status, 130);
  assert.equal(run([], { FIXTURE_SIGNAL: "SIGTERM" }).status, 1);

  const failed = run([], { FIXTURE_UNLINK: "1" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /^codex-start-launch-failed\r?\n/);
  assert.equal(calls().at(-1).method, "model/list");
});
