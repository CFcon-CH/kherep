import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { install } from "../codex/install.mts";
import { sourceOf } from "../codex/hooks/hook-integrity-sources.mts";
import { fixtureModelOptions } from "../codex/lib/model-policy.fixture.mts";
import { stageClaudeClient, verifyClaudeClient } from "../modules/control-plane/node/claude-mcp-client.mts";

const SOURCE = path.resolve(import.meta.dirname, "..");
const CANONICAL = path.join(SOURCE, "claude/hooks/lib/stdin-reader.mts");
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
// Only the known warning from older admitted type-stripping releases is ignored.
const stderrWithoutTypeWarning = (value: string) => value.replace(/^\(node:\d+\) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n/gm, "");

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-stdin-projection-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex");
  fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
  const options = {
    ...fixtureModelOptions(), homeDir: root, codexHome, workspace: path.join(root, "workspace"),
    claudeConfigDir: path.join(root, "claude"), claudeRegistryFile: path.join(root, "registry.json"),
    controlPlaneOutbox: path.join(root, "outbox"), nodePath: process.execPath,
    skipPluginRegistration: true, log: () => {}, resolveRegistryRuntime: () => "fixture",
    runCodex: (args: string[]) => args[0] === "--version" ? "codex-cli 0.144.6" : "ok",
  };
  return { root, codexHome, options };
}

test("stdin source mapping identifies canonical bytes for every Codex projection", () => {
  for (const relative of ["stdin-reader.mts", "kherep-maestro/stdin-reader.mts", "kherep-maestro/lib/stdin-reader.mts"]) {
    assert.deepEqual(sourceOf(relative), { from: "claude/hooks/lib/stdin-reader.mts" });
  }
  assert.match((sourceOf("elsewhere/stdin-reader.mts") as { hint: string }).hint, /not installed/);
});

test("Codex installs canonical stdin siblings with client enabled or disabled and rolls all new copies back", t => {
  const { codexHome, options } = fixture(t);
  const base = ["hooks/stdin-reader.mts", "hooks/kherep-maestro/stdin-reader.mts", "hooks/kherep-maestro/lib/stdin-reader.mts"];
  install(options);
  for (const relative of base) assert.equal(digest(path.join(codexHome, relative)), digest(CANONICAL), relative);
  const client = "orchestra/control-plane/node/stdin-reader.mts";
  assert.equal(fs.existsSync(path.join(codexHome, client)), false);
  install({ ...options, messagingClient: true });
  const copies = [...base, client];
  for (const relative of copies) assert.equal(digest(path.join(codexHome, relative)), digest(CANONICAL), relative);
  for (const relative of copies) fs.writeFileSync(path.join(codexHome, relative), `old:${relative}`);
  let injected = false;
  assert.throws(() => install({ ...options, messagingClient: true, afterWrite() {
    if (copies.every(relative => fs.existsSync(path.join(codexHome, relative))
      && digest(path.join(codexHome, relative)) === digest(CANONICAL))) {
      injected = true;
      throw new Error("synthetic projection rollback");
    }
  } }), /synthetic projection rollback/);
  assert.equal(injected, true, "failure follows every new helper copy");
  for (const relative of copies) assert.equal(fs.readFileSync(path.join(codexHome, relative), "utf8"), `old:${relative}`);
});

test("isolated Claude MCP stage uses canonical bytes and rejects missing, tampered and extra dependencies", t => {
  const { root } = fixture(t);
  const outputRoot = path.join(root, "stage");
  const configRoot = path.join(root, "config");
  stageClaudeClient({ outputRoot, configRoot, clientRoot: outputRoot, nodeCommand: process.execPath });
  const helper = path.join(outputRoot, "control-plane/node/stdin-reader.mts");
  assert.equal(digest(helper), digest(CANONICAL));
  const manifest = JSON.parse(fs.readFileSync(path.join(outputRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.files["control-plane/node/stdin-reader.mts"], digest(CANONICAL));
  assert.equal(manifest.graph.filter((value: string) => value === "node/stdin-reader.mts").length, 1);
  assert.equal(fs.existsSync(path.join(outputRoot, "claude")), false);
  const child = spawnSync(process.execPath, [path.join(outputRoot, "control-plane/node/mcp-intent-hook.mts"),
    "--config-root", configRoot, "--runtime", "claude-code"], { cwd: root, input: "{", encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT } });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /remote_mcp_invalid_input/);
  const bytes = fs.readFileSync(helper);
  fs.writeFileSync(helper, "tampered");
  assert.throws(() => verifyClaudeClient(outputRoot), /client drift/);
  fs.rmSync(helper);
  assert.throws(() => verifyClaudeClient(outputRoot), /required client content missing/);
  fs.writeFileSync(helper, bytes);
  fs.writeFileSync(path.join(outputRoot, "control-plane/node/extra.mts"), "");
  assert.throws(() => verifyClaudeClient(outputRoot), /unmanaged client content/);
});

test("missing or corrupt stdin helper retains fixed deny, quiet fallback and continued integrity checks", t => {
  const { root } = fixture(t);
  const hooks = path.join(root, "hooks");
  fs.cpSync(path.join(SOURCE, "claude/hooks/lib"), path.join(hooks, "lib"), { recursive: true });
  for (const name of ["dispatch-contract-guard.mts", "critical-file-integrity.mts"]) {
    fs.copyFileSync(path.join(SOURCE, "claude/hooks", name), path.join(hooks, name));
  }
  const codex = path.join(root, "codex-hooks"); fs.mkdirSync(codex);
  for (const name of ["dispatch-contract-guard.mts", "acceptance-gate.mts", "acceptance-policy.mts"]) {
    fs.copyFileSync(path.join(SOURCE, "codex/hooks", name), path.join(codex, name));
  }
  const child = (file: string) => spawnSync(process.execPath, [file], { cwd: root, input: "{}", encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, CLAUDE_HOME: path.join(root, "empty-home"),
      KHEREP_PROFILE: process.platform === "win32" ? "win" : "mac" } });
  for (const broken of [null, "export function broken( {"]) {
    const helper = path.join(hooks, "lib/stdin-reader.mts"), own = path.join(codex, "stdin-reader.mts");
    if (broken === null) { fs.rmSync(helper); fs.rmSync(own, { force: true }); }
    else { fs.writeFileSync(helper, broken); fs.writeFileSync(own, broken); }
    for (const guard of [path.join(hooks, "dispatch-contract-guard.mts"), path.join(codex, "dispatch-contract-guard.mts")]) {
      const result = child(guard);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
    }
    const quiet = child(path.join(codex, "acceptance-gate.mts"));
    assert.deepEqual([quiet.status, quiet.stdout, stderrWithoutTypeWarning(quiet.stderr)], [0, "", ""]);
    const integrity = child(path.join(hooks, "critical-file-integrity.mts"));
    assert.equal(integrity.status, 0, integrity.stderr);
    assert.match(integrity.stdout, /CRITICAL-FILE-INTEGRITY/);
    assert.doesNotMatch(integrity.stdout + integrity.stderr, /export function broken/);
  }
});
