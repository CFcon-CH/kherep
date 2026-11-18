// Issue #965. npm-globals.mts refuses an npm configuration it cannot trust,
// reads the `npm ls -g` payload rather than its exit code, reports a failed
// install even when npm says nothing, and finds npm itself when no binary is
// configured. Fake npm for the decisions; the real npm only against an empty
// temp prefix with temp config files, read-only and offline.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

const SUBJECT = path.join(import.meta.dirname, "npm-globals.mts");

// Plain JavaScript on purpose: a runtime fixture written into a throwaway
// directory. `ls` prints FAKE_NPM_LS verbatim; `i -g` exits FAKE_NPM_INSTALL_EXIT
// and writes nothing to stderr.
const FAKE_NPM = String.raw`
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG, args.join(" ") + "\n");
if (args[0] === "ls") { process.stdout.write(process.env.FAKE_NPM_LS); process.exit(0); }
if (args[0] === "i") process.exit(Number(process.env.FAKE_NPM_INSTALL_EXIT));
process.exit(64);
`;

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(path|kherep_npm_bin(_args_json)?|kherep_install_upgrade_globals)$/i.test(key)
      || /^npm_/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function fixture(t: TestContext, manifest: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-npm-globals-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = { fake: path.join(root, "fake-npm.js"), log: path.join(root, "npm.log"), manifest: path.join(root, "globals.txt") };
  fs.writeFileSync(files.fake, FAKE_NPM);
  fs.writeFileSync(files.manifest, manifest.join("\n") + "\n");
  const empty = path.join(root, "empty-path");
  fs.mkdirSync(empty);
  const run = (env: Record<string, string>, args: string[] = [files.manifest]) => {
    const result = spawnSync(process.execPath, [SUBJECT, ...args], {
      encoding: "utf8",
      env: {
        ...baseEnv(), PATH: empty, KHEREP_NPM_BIN: process.execPath, KHEREP_NPM_BIN_ARGS_JSON: JSON.stringify([files.fake]),
        FAKE_NPM_LOG: files.log, FAKE_NPM_LS: "{}", FAKE_NPM_INSTALL_EXIT: "0", ...env,
      },
    });
    const log = fs.existsSync(files.log) ? fs.readFileSync(files.log, "utf8").trim().split(/\r?\n/) : [];
    return { ...result, log };
  };
  return { root, files, run };
}

test("an ls payload that is no JSON fails closed before any install", (t) => {
  const ctx = fixture(t, ["alpha"]);
  const result = ctx.run({ FAKE_NPM_LS: "npm ERR! not json" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^npm-globals: FATAL: npm ls -g returned malformed JSON$/m);
  assert.deepEqual(result.log, ["ls -g --depth=0 --json"]);
});

test("an installed package without a readable version counts as unknown, never as the pin", (t) => {
  const ctx = fixture(t, ["alpha", "beta@2.0.0"]);
  const result = ctx.run({ FAKE_NPM_LS: JSON.stringify({ dependencies: { alpha: {}, beta: "2.0.0" } }) }, [ctx.files.manifest, "--plan-only"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^npm-globals: alpha skip \(unpinned, unknown installed \(no silent upgrade\)\)$/m);
  assert.match(result.stdout, /^npm-globals: beta install \(pinned 2\.0\.0, found unknown \(downgrade to pin\)\)$/m);
  assert.match(result.stdout, /plan-only 2 entries, 1 would install/);
});

test("a payload without a dependency map plans every entry as not installed", (t) => {
  const ctx = fixture(t, ["alpha"]);
  const result = ctx.run({ FAKE_NPM_LS: "null" }, [ctx.files.manifest, "--plan-only"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^npm-globals: alpha install \(not installed\)$/m);
});

test("an install npm rejects without a word is still reported as failed, with no empty detail", (t) => {
  const ctx = fixture(t, ["alpha"]);
  const result = ctx.run({ FAKE_NPM_INSTALL_EXIT: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^npm-globals: alpha FAILED \(npm i -g alpha\)$/m);
  assert.match(result.stdout, /1 entries, 0 installed, 0 skipped, 1 failed/);
});

test("an empty binary or an argument list that is no JSON list of strings is refused before npm runs", (t) => {
  const ctx = fixture(t, ["alpha"]);
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ KHEREP_NPM_BIN: "" }, /FATAL: invalid npm executable configuration/],
    [{ KHEREP_NPM_BIN_ARGS_JSON: "[not json" }, /FATAL: invalid npm executable argument configuration/],
    [{ KHEREP_NPM_BIN_ARGS_JSON: "{\"a\":1}" }, /FATAL: invalid npm executable argument configuration/],
  ];
  for (const [env, message] of cases) {
    const result = ctx.run(env);
    assert.equal(result.status, 1, JSON.stringify(env));
    assert.match(result.stderr, message);
  }
  const usage = ctx.run({}, ["--plan-only"]);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /FATAL: usage: npm-globals\.mts <manifest>/);
  assert.equal(fs.existsSync(ctx.files.log), false, "npm never ran");
});

test("without KHEREP_NPM_BIN the step finds npm itself and reads the global tree", (t) => {
  const ctx = fixture(t, ["kherep-synthetic-absent-package"]);
  const prefix = path.join(ctx.root, "prefix");
  fs.mkdirSync(prefix);
  const env = baseEnv();
  const result = spawnSync(process.execPath, [SUBJECT, ctx.files.manifest, "--plan-only"], {
    encoding: "utf8",
    env: {
      ...env,
      PATH: process.env.PATH ?? process.env.Path ?? "",
      npm_config_prefix: prefix,
      npm_config_userconfig: path.join(ctx.root, "user.npmrc"),
      npm_config_globalconfig: path.join(ctx.root, "global.npmrc"),
      npm_config_cache: path.join(ctx.root, "cache"),
      npm_config_update_notifier: "false",
      npm_config_offline: "true",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^npm-globals: kherep-synthetic-absent-package install \(not installed\)$/m);
  assert.match(result.stdout, /plan-only 1 entries, 1 would install/);
});

test("importing the module from an eval entry plans nothing", () => {
  const code = `await import(${JSON.stringify(pathToFileURL(SUBJECT).href)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /npm-globals/);
});
