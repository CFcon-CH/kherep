// Issue #922, lead amendment A3. hooks/lib/obs-session-policy.mts is a static
// import of lib/dispatch-policy.mts, so a home without it makes the dispatch
// guard deny every dispatch (HOOK_RUNTIME_FAILURE). One real install.sh run into
// a temporary home shows the three inventories that must carry it do: the
// installer copies it (bootstrap/manifest/files.txt), the Claude hook-integrity
// walk (lib/hook-inventory.mts, the heartbeat's closure) reaches it from the
// wired dispatch guard, and drift-check.sh compares it and reports it missing.
// install.ps1 forwards to install.sh, so it has no list of its own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { hookInventory, wiredFiles } from "../claude/hooks/lib/hook-inventory.mts";

const REPO = path.resolve(import.meta.dirname, "..");
const LIB = "lib/obs-session-policy.mts";
// Git Bash wants /c/... on Windows; install.sh refuses a drive-letter path.
const slash = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-issue922-")));
const home = path.join(root, "home");
const claudeHome = path.join(home, ".claude");
const env = {
  PATH: process.env.PATH, HOME: slash(home), CLAUDE_HOME: slash(claudeHome), KHEREP_PROFILE: "mac",
  KHEREP_WORKSPACE: slash(path.join(root, "workspace")), KHEREP_CREDENTIALS_ROOT: slash(path.join(root, "creds")),
  KHEREP_INSTALL_PREVIEW: "1", SKIP_SECRETS: "1", SKIP_DEPS: "1",
  GIT_CONFIG_GLOBAL: path.join(root, "gitconfig-global"), GIT_CONFIG_SYSTEM: path.join(root, "gitconfig-system"),
};
after(() => fs.rmSync(root, { recursive: true, force: true }));

const bash = (script: string) => {
  const run = spawnSync("bash", [path.join(REPO, "bootstrap", script)], { encoding: "utf8", timeout: 300_000, env });
  return { status: run.status, out: `${run.stdout}\n${run.stderr}` };
};

before(() => {
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(root, "workspace"));
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "");
  const run = bash("install.sh");
  assert.equal(run.status, 0, run.out.slice(-4000));
});

test("the installer copies the lib byte for byte", () => {
  const installed = fs.readFileSync(path.join(claudeHome, "hooks", LIB));
  assert.ok(installed.equals(fs.readFileSync(path.join(REPO, "claude", "hooks", LIB))));
});

test("the integrity closure of the installed wiring reaches the lib from the dispatch guard", () => {
  const wiring = wiredFiles(claudeHome);
  assert.ok(wiring.readAny && wiring.notes.length === 0, wiring.notes.join("; "));
  assert.ok(wiring.files.some((entry) => entry.rel === "dispatch-contract-guard.mts"), "the dispatch guard is wired");
  const inventory = hookInventory(wiring.files, `${claudeHome}/hooks`, (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
  const entry = inventory.find((item) => item.rel === LIB);
  assert.ok(entry, "the closure contains the lib");
  assert.ok(entry.importedBy.includes("lib/dispatch-policy.mts"), entry.importedBy.join(", "));
  const absent = inventory.filter((item) => !fs.existsSync(item.file) || fs.statSync(item.file).size === 0).map((item) => item.rel);
  assert.deepEqual(absent, [], "every closure file is installed and non-empty");
});

test("the installed guard denies a claude-obs brief without the session line", () => {
  const payload = { tool_name: "Agent", session_id: "0f3c2a9e-1b7d-4c55-9e21-5a0d6b8c4f17",
    tool_input: { subagent_type: "claude-obs", model: "haiku", prompt: "- relayed: the operator, in chat" } };
  const run = spawnSync("node", [path.join(claudeHome, "hooks", "dispatch-contract-guard.mts")],
    { input: JSON.stringify(payload), encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
  assert.match(run.stdout, /\[dispatch-contract:OBS_BRIEF_SESSION\]/, run.stdout + run.stderr);
});

// One run, about a minute: the byte comparison above already shows the synced state.
test("drift-check compares the lib and reports it missing", () => {
  fs.rmSync(path.join(claudeHome, "hooks", LIB));
  const drifted = bash("drift-check.sh");
  assert.notEqual(drifted.status, 0);
  assert.match(drifted.out, /^MISSING-LIVE +hooks\/lib\/obs-session-policy\.mts /m);
});
