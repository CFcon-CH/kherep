import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { daemonStateFile } from "./daemon-state.mts";
import { captureSourceIdentity } from "./daemon-source.mts";
import { runDoctor, type DoctorDeps } from "./doctor.mts";
import { writeIntercomHost } from "./doctor-intercom-fixture.mts";
import { writeDirectory, writeLocalSessions } from "./exchange.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";

// Issue #215. Every check is driven through runDoctor against a synthetic
// host: config directory, runtime config files and checkout in a temp dir.
export const NODE_ID = "00000000-0000-4000-8000-0000000000aa";
export const LIVE_PID = 4242;
export const HOOKS = (repo: string) => path.join(repo, "modules", "control-plane", "node");

interface Host { root: string; paths: NodePaths; repo: string; deps: DoctorDeps; pem: string }

function gitExecutable(): string {
  const key = Object.keys(process.env).find((name) => name.toLowerCase() === "path");
  const names = process.platform === "win32" ? ["git.exe", "git"] : ["git"];
  for (const dir of (key ? process.env[key] ?? "" : "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error("git not found on PATH");
}

export function host(t: test.TestContext): Host {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-doctor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(path.join(root, "config"));
  fs.mkdirSync(paths.dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.invalid", nodeId: NODE_ID, name: "synthetic",
    publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: ["node.status"],
    wake: { enabled: true, sessions: ["build"] }, sessions: { enabled: true, workspaceRoots: ["/synthetic/work"], runtimes: ["claude"] } }));
  const repo = path.join(root, "checkout");
  fs.mkdirSync(HOOKS(repo), { recursive: true });
  for (const hook of ["deliver-hook.mts", "wake-hook.mts"]) fs.writeFileSync(path.join(HOOKS(repo), hook), "");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ version: "9.8.7" }));
  const gitBin = gitExecutable();
  const git = (...args: string[]) => spawnSync(gitBin, ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("add", ".").status, 0);
  const tree = git("write-tree").stdout.trim();
  const committed = git("-c", "user.name=Kherep Fixture", "-c", "user.email=fixture@example.invalid",
    "commit-tree", tree, "-m", "fixture");
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(git("update-ref", "HEAD", committed.stdout.trim()).status, 0);
  fs.writeFileSync(daemonStateFile(paths), JSON.stringify({ pid: LIVE_PID, startedAt: "2026-10-04T10:00:00.000Z",
    connectedAt: "2026-10-04T10:00:01.000Z", source: captureSourceIdentity(repo) }));
  writeLocalSessions(paths, [], Date.parse("2026-10-04T12:00:00.000Z"));
  // Issue #441: the last directory shows this node's queue at the control plane empty.
  writeDirectory(paths, { nodes: [{ nodeId: NODE_ID, name: "synthetic", status: "online",
    intake: { lastAcceptedAt: null, oldestQueuedAt: null, queued: 0 } }], sessions: [], fetchedAt: "2026-10-04T11:59:30.000Z" });
  const claude = path.join(root, "claude");
  const codex = path.join(root, "codex");
  fs.mkdirSync(claude);
  fs.mkdirSync(codex);
  writeHooks(claude, codex, repo);
  writeIntercomHost(paths, claude, codex, root);
  const deps: DoctorDeps = {
    paths, repoRoot: repo, claudeConfigDir: claude, codexHome: codex, now: () => Date.parse("2026-10-04T12:00:00.000Z"),
    pidAlive: (pid) => pid === LIVE_PID,
    fetch: async () => Response.json({ ok: true, service: "kherep-control", version: "9.8.7", commit: null, remoteMcp: true }),
    find: (name) => (name === "claude" ? "/synthetic/bin/claude" : null),
    versionOf: async (name) => (name === "claude" ? "2.1.300 (Claude Code)" : null),
  };
  return { root, paths, repo, deps, pem: fs.readFileSync(paths.privateKey, "utf8") };
}

// As the installers and runtimes write them: Claude settings JSON and Codex TOML strings.
export function writeHooks(claudeDir: string, codexDir: string, repo: string, codexRepo = repo): void {
  const command = (hook: string, extra: string) => `node "${path.join(HOOKS(repo), hook)}"${extra}`;
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [
    { type: "command", command: command("deliver-hook.mts", "") },
    { type: "command", command: command("wake-hook.mts", " --timeout 86400"), asyncRewake: true }] }] } }, null, 2)
    .replace(/\//g, "\\/")); // settings.json may spell "/" as "\/" (seen on a live host, 2026-10-04)
  const codexCommand = `"/usr/bin/node" "${path.join(HOOKS(codexRepo), "deliver-hook.mts")}" "--runtime" "codex"`;
  fs.writeFileSync(path.join(codexDir, "config.toml"), `[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(codexCommand)}\n`);
}

