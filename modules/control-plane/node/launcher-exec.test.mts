import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { ensureLauncher, launcherCommand, launcherPath, resolveLauncher } from "./launcher.mts";
import { LAUNCHER_HINT, LAUNCHER_REASONS } from "./launcher-template.mts";
import { COMMIT_A, COMMIT_B, RECORD_ENV, makePin, receiptFor, receiptPath, tempRoot, writeReceipt } from "./launcher-fixture.mts";
import { withNodeOnPath } from "./task-env.mts";

// Issue #436: the generated kherep-node.mjs and its shims, executed for real
// against synthetic config roots. Shells that are absent are skipped, not passed.

const ARGS = ["msg", "send", "peer/session", "--", "ready for review", "with spaces"];
const platform = process.platform === "win32" ? "win32" : "darwin";

function host(t: test.TestContext) {
  const root = tempRoot(t);
  ensureLauncher(root, { platform, nodeExecutable: process.execPath });
  const record = path.join(root, "record.txt");
  const env: NodeJS.ProcessEnv = { ...process.env, KHEREP_CONFIG_DIR: root, [RECORD_ENV]: record };
  return { root, record, env, ran: () => fs.existsSync(record) ? fs.readFileSync(record, "utf8") : "" };
}

function run(file: string, args: string[], options: SpawnSyncOptions) {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 30_000, ...options });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

const launch = (root: string, args: string[], env: NodeJS.ProcessEnv) => run(process.execPath, [launcherPath(root), ...args], { env });

function available(command: string, args: string[]): boolean {
  return spawnSync(command, args, { windowsHide: true, timeout: 15_000 }).status === 0;
}

test("the launcher runs the receipt's pin with the argument vector verbatim and passes exit code 7 back", (t) => {
  const h = host(t);
  const pin = makePin(h.root, COMMIT_A, "A");
  writeReceipt(h.root, receiptFor(pin, COMMIT_A));
  const result = launch(h.root, ARGS, h.env);
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { pin: "A", argv: ARGS });
  assert.equal(h.ran(), "A\n");
});

test("every failed resolution exits 1 with the fixed message and starts no child", (t) => {
  const h = host(t);
  const runLauncherCase = (reason: keyof typeof LAUNCHER_REASONS) => {
    const result = launch(h.root, ARGS, h.env);
    assert.equal(result.status, 1, reason);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `kherep-node: ${LAUNCHER_REASONS[reason]}; receipt ${receiptPath(h.root)}; ${LAUNCHER_HINT}\n`);
    if (reason !== "spawn") {
      const resolved = resolveLauncher(h.root);
      assert.equal(resolved.ok ? "ok" : resolved.reason, reason, "resolveLauncher agrees");
    }
  };
  runLauncherCase("missing");
  writeReceipt(h.root, "{ corrupt");
  runLauncherCase("invalid");
  const pin = makePin(h.root, COMMIT_A, "A");
  writeReceipt(h.root, receiptFor(pin, COMMIT_A, process.execPath, "checkout"));
  runLauncherCase("invalid");
  writeReceipt(h.root, receiptFor(path.join(h.root, "gone"), COMMIT_A));
  runLauncherCase("missing-pin");
  writeReceipt(h.root, receiptFor(makePin(h.root, COMMIT_B, "B", { cli: false }), COMMIT_B));
  runLauncherCase("missing-cli");
  writeReceipt(h.root, receiptFor(pin, COMMIT_A, path.join(h.root, "no-such-node")));
  runLauncherCase("spawn");
  assert.equal(h.ran(), "", "no stub ran");
});

test("without KHEREP_CONFIG_DIR the launcher derives the config root exactly as config.mts does", (t) => {
  const h = host(t);
  const home = path.dirname(h.root);
  const env: NodeJS.ProcessEnv = { ...process.env, APPDATA: home, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home };
  delete env.KHEREP_CONFIG_DIR;
  // On macOS configRoot reads os.homedir(), which follows HOME only in a process
  // started with it, so the expected root is derived in a child with the same env.
  const derived = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { configRoot } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "config.mts")).href)};`
    + " process.stdout.write(configRoot());"], { env, encoding: "utf8" });
  assert.equal(derived.status, 0, derived.stderr);
  const expected = path.join(derived.stdout, "control-plane", "service", "receipt.json");
  const result = launch(h.root, ["msg", "sessions"], env);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`; receipt ${expected}; `), result.stderr);
});

test("the POSIX shim runs the launcher from a root with a space", (t) => {
  if (!available("sh", ["-c", "exit 0"])) { t.skip("sh is not available on this host"); return; }
  const h = host(t);
  writeReceipt(h.root, receiptFor(makePin(h.root, COMMIT_A, "A"), COMMIT_A));
  const result = run("sh", [path.join(h.root, "bin", "kherep-node"), ...ARGS], { env: h.env });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { pin: "A", argv: ARGS });
});

// KB 276858897: Git Bash rewrites POSIX-looking arguments before a Windows
// program sees them. The canonical command names the launcher in drive-letter
// form, which MSYS leaves alone, and the launcher adds no conversion of its own:
// with MSYS_NO_PATHCONV=1 even a /-leading argument arrives verbatim.
test("the canonical command and the shim survive Git Bash path conversion", (t) => {
  if (process.platform !== "win32") { t.skip("Git Bash path conversion exists only on Windows"); return; }
  if (!available("sh", ["-c", "exit 0"])) { t.skip("Git Bash sh is not available on this host"); return; }
  const h = host(t);
  writeReceipt(h.root, receiptFor(makePin(h.root, COMMIT_A, "A"), COMMIT_A));
  const env = withNodeOnPath(h.env);
  for (const conversion of ["default", "off"] as const) {
    const shellEnv = { ...env, ...(conversion === "off" ? { MSYS_NO_PATHCONV: "1" } : {}) };
    const canonical = run("sh", ["-c", `${launcherCommand(h.root)} "$@"`, "sh", ...ARGS], { env: shellEnv });
    assert.equal(canonical.status, 7, `${conversion}: ${canonical.stderr}`);
    assert.deepEqual(JSON.parse(canonical.stdout).argv, ARGS, conversion);
    const shim = run("sh", [path.join(h.root, "bin", "kherep-node"), ...ARGS], { env: shellEnv });
    assert.equal(shim.status, 7, `${conversion}: ${shim.stderr}`);
    assert.deepEqual(JSON.parse(shim.stdout).argv, ARGS, conversion);
  }
  const posixArgument = run("sh", ["-c", `${launcherCommand(h.root)} msg send --cwd /c/work peer/session`],
    { env: { ...env, MSYS_NO_PATHCONV: "1" } });
  assert.deepEqual(JSON.parse(posixArgument.stdout).argv, ["msg", "send", "--cwd", "/c/work", "peer/session"]);
});

test("the cmd shim passes arguments and the exit code through", (t) => {
  if (process.platform !== "win32") { t.skip("cmd.exe exists only on Windows"); return; }
  const h = host(t);
  writeReceipt(h.root, receiptFor(makePin(h.root, COMMIT_A, "A"), COMMIT_A));
  const shim = path.join(h.root, "bin", "kherep-node.cmd");
  const line = `""${shim}" msg send peer/session -- "ready for review""`;
  const result = run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", line], { env: h.env, windowsVerbatimArguments: true });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).argv, ["msg", "send", "peer/session", "--", "ready for review"]);
});

test("the PowerShell shim passes arguments and the exit code through", (t) => {
  if (process.platform !== "win32") { t.skip("the .ps1 shim is written only on Windows"); return; }
  const shell = ["pwsh", "powershell"].find(name => available(name, ["-NoProfile", "-Command", "exit 0"]));
  if (!shell) { t.skip("no PowerShell on this host"); return; }
  const h = host(t);
  writeReceipt(h.root, receiptFor(makePin(h.root, COMMIT_A, "A"), COMMIT_A));
  const shim = path.join(h.root, "bin", "kherep-node.ps1").replaceAll("'", "''");
  const result = run(shell, ["-NoProfile", "-NonInteractive", "-Command",
    `& '${shim}' msg send peer/session 'ready for review'; exit $LASTEXITCODE`], { env: h.env });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).argv, ["msg", "send", "peer/session", "ready for review"]);
});
