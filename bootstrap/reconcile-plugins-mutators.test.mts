// Issue #965. The marketplace-add and plugin-enable outcomes of
// reconcile-plugins.mts that reconcile-plugins.test.mts leaves open, plus the
// manifest, configuration and usage refusals. A mutator's exit status never
// decides alone: the re-read state does. Fake `claude`, temp files only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { ReconcileError } from "./plugin-contract.mts";
import { getClaudeCommand } from "./reconcile-plugins.mts";

const SUBJECT = path.join(import.meta.dirname, "reconcile-plugins.mts");

// Plain JavaScript on purpose: a runtime fixture written into a throwaway
// directory. A mutator applies its catalog entry unless its outcome says
// apply:false, and exits with the outcome's status.
const FAKE_CLAUDE = String.raw`
"use strict";
const fs = require("node:fs");
const file = process.env.FAKE_CLAUDE_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const signature = args.join(" ");
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, signature + "\n");
if (signature === "plugin marketplace list --json") { process.stdout.write(JSON.stringify(state.marketplaces)); process.exit(0); }
if (signature === "plugin list --json") { process.stdout.write(JSON.stringify(state.plugins)); process.exit(0); }
const outcome = state.outcomes[signature] || { exit: 0 };
if (outcome.apply !== false) {
  if (args[2] === "add") state.marketplaces.push(state.catalog.marketplace);
  if (args[1] === "enable") for (const p of state.plugins) if (p.id === args[4]) p.enabled = true;
  fs.writeFileSync(file, JSON.stringify(state));
}
process.exit(outcome.exit);
`;

const MARKETPLACE = { name: "main", source: "github", repo: "example/main" };

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-reconcile-mutators-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installPath = path.join(root, "installed", "alpha");
  fs.mkdirSync(installPath, { recursive: true });
  const files = {
    fake: path.join(root, "fake-claude.js"), log: path.join(root, "commands.log"), state: path.join(root, "state.json"),
    marketplaces: path.join(root, "marketplaces.json"), plugins: path.join(root, "plugins.json"),
  };
  fs.writeFileSync(files.fake, FAKE_CLAUDE);
  fs.writeFileSync(files.marketplaces, JSON.stringify({ main: { source: { source: "github", repo: "example/main" } } }));
  fs.writeFileSync(files.plugins, JSON.stringify({ enabledPlugins: { "alpha@main": true } }));
  const state = {
    marketplaces: [MARKETPLACE] as unknown[],
    plugins: [{ id: "alpha@main", scope: "user", enabled: true, installPath }],
    catalog: { marketplace: MARKETPLACE },
    outcomes: {} as Record<string, { exit: number; apply?: boolean }>,
  };
  const run = (env: Record<string, string> = {}, args = [files.marketplaces, files.plugins]) => {
    fs.writeFileSync(files.state, JSON.stringify(state));
    const result = spawnSync(process.execPath, [SUBJECT, ...args], {
      encoding: "utf8",
      env: {
        ...process.env, KHEREP_CLAUDE_BIN: process.execPath, KHEREP_CLAUDE_BIN_ARGS_JSON: JSON.stringify([files.fake]),
        FAKE_CLAUDE_STATE: files.state, FAKE_CLAUDE_LOG: files.log, ...env,
      },
    });
    const log = fs.existsSync(files.log) ? fs.readFileSync(files.log, "utf8").trim().split(/\r?\n/) : [];
    return { ...result, log };
  };
  return { files, state, run };
}

const ADD = "plugin marketplace add --scope user example/main";
const ENABLE = "plugin enable --scope user alpha@main";

test("a marketplace add is judged by the re-read state, whatever its exit status", async (t) => {
  for (const [outcome, status, message] of [
    [{ exit: 0, apply: false }, 1, /FATAL: marketplace add returned success without required state: main/],
    [{ exit: 3, apply: false }, 1, /FATAL: marketplace add failed without required state: main/],
    [{ exit: 3 }, 0, /marketplace converged after nonzero response: main\n[\s\S]*required marketplaces and plugins verified/],
  ] as const) {
    await t.test(JSON.stringify(outcome), (t) => {
      const ctx = fixture(t);
      ctx.state.marketplaces = [];
      ctx.state.outcomes[ADD] = { ...outcome };
      const result = ctx.run();
      assert.equal(result.status, status, result.stderr);
      assert.match(result.stdout + result.stderr, message);
      assert.equal(result.log.filter((line) => line === ADD).length, 1);
    });
  }
});

test("a plugin enable is judged by the re-read state, whatever its exit status", async (t) => {
  for (const [outcome, status, message] of [
    [{ exit: 0, apply: false }, 1, /FATAL: plugin enable returned success without required state: alpha@main/],
    [{ exit: 5, apply: false }, 1, /FATAL: plugin enable failed without required state: alpha@main/],
    [{ exit: 5 }, 0, /plugin converged after nonzero response: alpha@main\n[\s\S]*required marketplaces and plugins verified/],
  ] as const) {
    await t.test(JSON.stringify(outcome), (t) => {
      const ctx = fixture(t);
      ctx.state.plugins[0].enabled = false;
      ctx.state.outcomes[ENABLE] = { ...outcome };
      const result = ctx.run();
      assert.equal(result.status, status, result.stderr);
      assert.match(result.stdout + result.stderr, message);
      assert.equal(result.log.filter((line) => line === ENABLE).length, 1);
    });
  }
});

test("an unreadable or malformed manifest fails before Claude is asked anything", (t) => {
  const ctx = fixture(t);
  const missing = ctx.run({}, [path.join(path.dirname(ctx.files.fake), "absent.json"), ctx.files.plugins]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^reconcile-plugins: FATAL: cannot read marketplaces manifest$/m);
  fs.writeFileSync(ctx.files.plugins, "{not json");
  const malformed = ctx.run();
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /^reconcile-plugins: FATAL: malformed plugins manifest JSON$/m);
  assert.deepEqual(malformed.log, []);
});

test("a wrong argument count is a usage error that runs nothing", (t) => {
  const ctx = fixture(t);
  const result = ctx.run({}, [ctx.files.marketplaces]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^reconcile-plugins: FATAL: usage: reconcile-plugins\.mts <marketplaces\.json> <plugins\.json> \[<plugin-versions\.json> <claude-home>\]$/m);
  assert.deepEqual(result.log, []);
});

test("an executable argument list that is no JSON list of strings is refused", (t) => {
  const ctx = fixture(t);
  const result = ctx.run({ KHEREP_CLAUDE_BIN_ARGS_JSON: "[not json" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FATAL: invalid Claude executable argument configuration/);
  assert.deepEqual(result.log, []);
  const refused = (env: NodeJS.ProcessEnv) => assert.throws(() => getClaudeCommand(env, { platform: "linux" }), ReconcileError);
  refused({ KHEREP_CLAUDE_BIN: "claude", KHEREP_CLAUDE_BIN_ARGS_JSON: "{\"a\":1}" });
  refused({ KHEREP_CLAUDE_BIN: "" });
  refused({ KHEREP_CLAUDE_BIN: "claude\nother" });
});

test("a Claude binary that cannot be started fails the first list read without a mutator", (t) => {
  const ctx = fixture(t);
  const result = ctx.run({ KHEREP_CLAUDE_BIN: path.join(path.dirname(ctx.files.fake), "absent-claude"), KHEREP_CLAUDE_BIN_ARGS_JSON: "[]" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^reconcile-plugins: FATAL: Claude marketplace list failed$/m);
  assert.deepEqual(result.log, []);
});

test("without a configured binary, claude is found by name off Windows and refused when Windows has none", () => {
  assert.deepEqual(getClaudeCommand({}, { platform: "linux" }), { executable: "claude", prefixArgs: [] });
  assert.throws(() => getClaudeCommand({ PATH: "C:\\absent" }, { platform: "win32", isFile: () => false }),
    /claude not found on PATH as claude\.exe or as an npm shim/);
  assert.throws(() => getClaudeCommand({}, { platform: "win32", isFile: () => false }), /claude not found on PATH/);
});

test("importing the module from an eval entry reconciles nothing", () => {
  const code = `await import(${JSON.stringify(pathToFileURL(SUBJECT).href)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /reconcile-plugins/);
});
