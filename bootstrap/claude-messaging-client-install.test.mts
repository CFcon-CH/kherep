import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { toBashPath } from "./render-profile-paths.mts";

const REPO = path.resolve(import.meta.dirname, "..");
const INSTALLER = path.join(import.meta.dirname, "install-claude-messaging-client.sh");
const CLIENT = path.join(REPO, "modules/control-plane/node/claude-mcp-client.mts");
const BASH = process.env.BASH || "bash";
const BASH_PROBE = spawnSync(BASH, ["-c", "uname -s"], { encoding: "utf8" });
const BASH_SKIP = BASH_PROBE.status !== 0 || (process.platform === "win32" && !/^(MINGW|MSYS|CYGWIN)/.test(BASH_PROBE.stdout))
  ? "Git for Windows Bash is unavailable" : false;

interface Fixture { root: string; home: string; config: string; target: string; protected: Map<string, Buffer> }

function fixture(t: test.TestContext): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-claude-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "Claude Home");
  const config = path.join(root, "Node Config");
  fs.mkdirSync(path.join(home, "hooks"), { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  const content = new Map<string, string>([
    [path.join(home, "settings.json"), JSON.stringify({ hooks: { Stop: [{ matcher: "custom" }] },
      permissions: { allow: ["Read"], deny: ["WebFetch"] } })],
    [path.join(home, ".mcp.json"), JSON.stringify({ mcpServers: { unrelated: { command: "keep" } } })],
    [path.join(home, "hooks", "custom.json"), "arbitrary-hook-bytes\n"],
  ]);
  for (const [file, bytes] of content) fs.writeFileSync(file, bytes);
  return { root, home, config, target: path.join(home, "kherep", "claude-messaging-client"),
    protected: new Map([...content.keys()].map((file) => [file, fs.readFileSync(file)])) };
}

function install(f: Fixture, config = f.config, env: NodeJS.ProcessEnv = {}, nodeCommand?: string) {
  return spawnSync(BASH, [toBashPath(INSTALLER), "--home", toBashPath(f.home), "--config-root", toBashPath(config),
    ...(nodeCommand ? ["--node", toBashPath(nodeCommand)] : [])], {
    cwd: REPO, encoding: "utf8", env: { ...process.env, ...env },
  });
}

function assertProtected(f: Fixture): void {
  for (const [file, bytes] of f.protected) assert.deepEqual(fs.readFileSync(file), bytes, file);
}

function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const relative = path.relative(root, full);
      const stat = fs.lstatSync(full);
      hash.update(`${relative}\0${stat.isDirectory() ? "d" : "f"}\0`);
      if (stat.isDirectory()) visit(full); else hash.update(fs.readFileSync(full));
    }
  };
  visit(root);
  return hash.digest("hex");
}

function backups(f: Fixture): string[] {
  const root = path.join(f.home, "backups", "claude-messaging-client");
  return fs.existsSync(root) ? fs.readdirSync(root).filter((name) => name.startsWith("install-")) : [];
}

test("no arguments and help install nothing", { skip: BASH_SKIP }, (t) => {
  const f = fixture(t);
  for (const args of [[], ["--help"]]) {
    const result = spawnSync(BASH, [toBashPath(INSTALLER), ...args], { cwd: f.root, encoding: "utf8" });
    assert.equal(result.status, args.length ? 0 : 2, result.stderr);
    assert.equal(fs.existsSync(f.target), false);
  }
  assertProtected(f);
  assert.doesNotMatch(fs.readFileSync(path.join(import.meta.dirname, "install.sh"), "utf8"),
    /install-claude-messaging-client/);
});

test("installs a verifiable client while preserving every unrelated byte", { skip: BASH_SKIP }, (t) => {
  const f = fixture(t);
  const result = install(f);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /activate: claude --plugin-dir/);
  assert.match(result.stdout, / --mcp-config .* --strict-mcp-config/);
  assert.doesNotMatch(result.stdout, /allowedTools|dangerously-skip-permissions/);
  const verified = spawnSync(process.execPath, [CLIENT, "verify", "--client-root", f.target], { encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr);
  const identity = JSON.parse(verified.stdout);
  assert.match(identity.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(identity.files, 26);
  assert.equal(fs.readFileSync(path.join(f.target, "control-plane/protocol-session-identity.mts"), "utf8"),
    fs.readFileSync(path.join(import.meta.dirname, "../modules/control-plane/protocol-session-identity.mts"), "utf8"));
  assert.equal(fs.readFileSync(path.join(f.target, "control-plane/protocol-loop-brake.mts"), "utf8"),
    fs.readFileSync(path.join(import.meta.dirname, "../modules/control-plane/protocol-loop-brake.mts"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(f.target, "manifest.json"), "utf8"));
  for (const relative of ["protocol-diagnostics.mts", "node/inbox-storage.mts", "node/inbox-selected-read.mts"]) {
    const staged = fs.readFileSync(path.join(f.target, "control-plane", relative));
    const source = fs.readFileSync(path.join(import.meta.dirname, "../modules/control-plane", relative));
    assert.deepEqual(staged, source, relative);
    assert.equal(manifest.files[`control-plane/${relative}`], createHash("sha256").update(staged).digest("hex"));
  }
  assert.equal(path.resolve(manifest.clientRoot), path.resolve(f.target));
  assert.equal(path.resolve(manifest.configRoot), path.resolve(f.config));
  assertProtected(f);
});

test("uses the explicit node command for projection and verification", {
  skip: BASH_SKIP || (process.platform === "win32" ? "POSIX executable wrapper fixture" : false),
}, (t) => {
  const f = fixture(t);
  const wrapper = path.join(f.root, "node-wrapper");
  const marker = path.join(f.root, "node-wrapper.calls");
  fs.writeFileSync(wrapper, "#!/usr/bin/env bash\nprintf 'called\\n' >> \"$KHEREP_NODE_WRAPPER_MARKER\"\nexec \"$KHEREP_REAL_NODE\" \"$@\"\n",
    { mode: 0o700 });
  const result = install(f, f.config, { KHEREP_NODE_WRAPPER_MARKER: marker, KHEREP_REAL_NODE: process.execPath }, wrapper);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.readFileSync(marker, "utf8").trim().split("\n").length >= 3);
});

test("uses the explicit node command for the idempotent transaction comparison", {
  skip: BASH_SKIP || (process.platform === "win32" ? "POSIX executable wrapper fixture" : false),
}, (t) => {
  const f = fixture(t);
  const selectedNode = path.join(f.root, "selected-node");
  const marker = path.join(f.root, "selected-node.calls");
  const failingBin = path.join(f.root, "failing-bin");
  fs.mkdirSync(failingBin);
  fs.writeFileSync(selectedNode,
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$1\" >> \"$KHEREP_NODE_WRAPPER_MARKER\"\nexec \"$KHEREP_REAL_NODE\" \"$@\"\n",
    { mode: 0o700 });
  fs.writeFileSync(path.join(failingBin, "node"), "#!/usr/bin/env bash\nexit 71\n", { mode: 0o700 });
  const env = { KHEREP_NODE_WRAPPER_MARKER: marker, KHEREP_REAL_NODE: process.execPath };
  assert.equal(install(f, f.config, env, selectedNode).status, 0);
  fs.writeFileSync(marker, "");
  const before = treeDigest(f.target);
  const repeated = install(f, f.config, { ...env, PATH: `${failingBin}${path.delimiter}${process.env.PATH}` }, selectedNode);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(treeDigest(f.target), before);
  const calls = fs.readFileSync(marker, "utf8").trim().split("\n");
  assert.ok(calls.some((call) => /transaction-entry-equal\.mts$/.test(call)), calls.join("\n"));
});

test("an identical install is idempotent and a changed explicit root creates a reversible backup", { skip: BASH_SKIP }, (t) => {
  const f = fixture(t);
  assert.equal(install(f).status, 0);
  const first = treeDigest(f.target);
  assert.equal(install(f).status, 0);
  assert.equal(treeDigest(f.target), first);
  const nextConfig = path.join(f.root, "Next Config");
  fs.mkdirSync(nextConfig);
  const upgraded = install(f, nextConfig);
  assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.notEqual(treeDigest(f.target), first);
  const backupRoot = path.join(f.home, "backups", "claude-messaging-client");
  const previous = backups(f).map((name) => path.join(backupRoot, name, "previous-client"))
    .find((candidate) => fs.existsSync(candidate));
  assert.ok(previous, "upgrade did not retain the previous closed target");
  assert.equal(treeDigest(previous), first);
  assertProtected(f);
});

// A host without the symlink privilege refuses symlinkSync with EPERM; the symlink
// cases skip there, as the other symlink tests do, and CI proves them (issue #534).
function symlinked(t: TestContext, make: () => void): boolean {
  try {
    make();
    return true;
  } catch (error) {
    const { code, syscall } = error as NodeJS.ErrnoException;
    if (code !== "EPERM" || syscall !== "symlink") throw error;
    t.skip("symlink creation unavailable (EPERM)");
    return false;
  }
}

test("refuses modified, extra and symlinked managed targets before overwrite", { skip: BASH_SKIP }, async (t) => {
  const cases: Array<[string, (f: Fixture) => void, RegExp]> = [
    ["drift", (f) => fs.appendFileSync(path.join(f.target, "mcp.json"), "changed"), /client drift/],
    ["extra", (f) => fs.writeFileSync(path.join(f.target, "extra.txt"), "extra"), /unmanaged client content/],
    ["manifest identity", (f) => { const file = path.join(f.target, "manifest.json");
      const value = JSON.parse(fs.readFileSync(file, "utf8")); value.clientRoot = "/different/client";
      fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }, /client root identity/],
    ["symlink", (f) => { const saved = `${f.target}-saved`; fs.renameSync(f.target, saved); fs.symlinkSync(saved, f.target); },
      /symlink|real directory/],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, (st) => {
      const f = fixture(t);
      assert.equal(install(f).status, 0);
      if (name !== "symlink") mutate(f);
      else if (!symlinked(st, () => mutate(f))) return;
      const before = fs.lstatSync(f.target).isSymbolicLink() ? fs.readlinkSync(f.target) : treeDigest(f.target);
      const result = install(f);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      const after = fs.lstatSync(f.target).isSymbolicLink() ? fs.readlinkSync(f.target) : treeDigest(f.target);
      assert.equal(after, before);
      assertProtected(f);
    });
  }
});

test("refuses a symlink target ancestor without writing through it", { skip: BASH_SKIP }, (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  if (!symlinked(t, () => fs.symlinkSync(outside, path.join(f.home, "kherep")))) return;
  const result = install(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink ancestor/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assertProtected(f);
});

test("an injected upgrade failure restores the exact prior target", { skip: BASH_SKIP }, (t) => {
  const f = fixture(t);
  assert.equal(install(f).status, 0);
  const before = treeDigest(f.target);
  const nextConfig = path.join(f.root, "Rollback Config");
  fs.mkdirSync(nextConfig);
  const failed = install(f, nextConfig, { KHEREP_BOOTSTRAP_TEST_FAIL_AFTER_LABEL: "claude-messaging-client" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /injected failure/);
  assert.equal(treeDigest(f.target), before);
  const backupRoot = path.join(f.home, "backups", "claude-messaging-client");
  assert.ok(backups(f).some((name) => fs.existsSync(path.join(backupRoot, name, "ROLLED-BACK"))));
  assertProtected(f);
});
