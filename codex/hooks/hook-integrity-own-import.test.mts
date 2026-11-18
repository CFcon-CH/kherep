// Issue #965. The installed Codex hook-integrity hook with one of its own imports broken after
// the four libs a restore needs: a broken repair module cannot restore itself, and a heartbeat
// that cannot be removed blocks the restore of a broken lib. Fixture: install() into a temp
// Codex home, as hook-integrity-trigger.test.mts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { install } from "../install.mts";
import { fixtureModelOptions } from "../lib/model-policy.fixture.mts";
import { declareInstalled } from "./hook-adapter.fixture.mts";

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-own-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "home", ".codex");
  const claudeRegistryFile = path.join(root, "home", ".claude.json");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(claudeRegistryFile, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
  install({
    ...fixtureModelOptions(), codexHome, claudeRegistryFile, claudeConfigDir: path.join(root, "home", ".claude"),
    workspace: path.join(root, "workspace", "Kherep"), nodePath: process.execPath, log: (): void => {},
    resolveRegistryRuntime: () => "fixture",
    runCodex: (args: string[]): string => (args[0] === "--version" ? "codex-cli 0.144.6"
      : args.join(" ") === "plugin marketplace list --json" ? '{"marketplaces":[]}' : "ok"),
    controlPlaneOutbox: path.join(root, "kherep config", "control-plane", "outbox"),
  });
  declareInstalled(codexHome, ["hook-integrity-repair.mts"]); // the first case empties the repair module
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_HOME: path.join(root, "no-claude-home"), KHEREP_WORKSPACE: path.join(root, "no-workspace") };
  delete env.CODEX_HOME;
  const hookDir = path.join(codexHome, "hooks", "kherep-maestro");
  const run = (args: string[]): string => {
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(hookDir, "codex-hook-integrity.mts"), ...args],
      { input: JSON.stringify({ cwd: root }), encoding: "utf8", env, windowsHide: true, timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  return { codexHome, hookDir, run, cache: path.join(codexHome, ".cache", "hook-integrity") };
}

test("an empty hook-integrity-repair.mts is reported in both forms and cannot be restored by itself", (t) => {
  const ctx = fixture(t);
  const repair = path.join(ctx.hookDir, "hook-integrity-repair.mts");
  fs.writeFileSync(repair, "");
  const line = "own import hook-integrity-repair.mts cannot be loaded (no function restore, journal, checkoutOf, entryChecker, sourceReaders); "
    + "nothing was verified this session -> NOT restored (the restore itself needs hook-integrity-repair.mts). ENFORCEMENT IS OFF for this hook";
  assert.equal(ctx.run(["--trigger", "hook-adapter"]), `${line}\nheartbeat not written (own import hook-integrity-repair.mts cannot be loaded)\n`);
  const doc = JSON.parse(ctx.run([])) as { systemMessage: string; hookSpecificOutput: { additionalContext: string } };
  assert.equal(doc.systemMessage, `Kherep hook integrity: ${line}`);
  assert.equal(doc.hookSpecificOutput.additionalContext, `KHEREP CODEX HOOK-INTEGRITY:\n  - ${line}`);
  assert.equal(fs.statSync(repair).size, 0);
  assert.equal(fs.existsSync(path.join(ctx.cache, "incidents.jsonl")), false, "no journal without the repair module");
});

test("a broken own lib with a heartbeat that cannot be removed: not restored, journalled with the reason", (t) => {
  const ctx = fixture(t);
  fs.mkdirSync(path.join(ctx.cache, "heartbeat.json", "inside"), { recursive: true });
  const lib = path.join(ctx.hookDir, "lib", "hook-syntax.mts");
  fs.writeFileSync(lib, "");
  const [first, second] = ctx.run(["--trigger", "hook-adapter"]).split("\n");
  assert.match(first!, /^own import lib\/hook-syntax\.mts cannot be loaded \(no function syntaxVerdict\); nothing was verified this session -> NOT restored \(heartbeat could not be removed: [A-Z_]+\)\. ENFORCEMENT IS OFF for this hook$/);
  assert.equal(second, "heartbeat not written (own import lib/hook-syntax.mts cannot be loaded)");
  assert.equal(fs.statSync(lib).size, 0);
  const [entry] = fs.readFileSync(path.join(ctx.cache, "incidents.jsonl"), "utf8").trim().split("\n").map((row) => JSON.parse(row) as Record<string, unknown>);
  assert.equal(entry!.kind, "self");
  assert.equal(entry!.restoreProven, false);
  assert.match(String(entry!.restoreDetail), /^heartbeat could not be removed: /);
});
