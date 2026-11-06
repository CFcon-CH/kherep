// Issue #533. An equivalence pin, not a new behaviour: a broken adapter module yields the
// observable pair a broken adapter file yields today. Through the shell dispatcher it is the
// unloadable-adapter deny, one integrity re-check and a restore; through the adapter entry
// alone (the adapter-only groups) it is exit 1 with empty stdout, as for a broken entry,
// which Codex treats as a non-blocking failure until the next shell call or session start.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { ADAPTER_MODULES, copyAdapter } from "./hook-adapter.fixture.mts";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const PAYLOAD = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "shell_command", tool_input: { command: "git status" } });
const GUARDS = ["commit-guard", "deploy-guard", "main-checkout-guard", "module-label-guard"];
const PEERS = ["codex-hook-adapter.mts", "hook-adapter.mts", "codex-shell-checks.mts"];
const BROKEN = "export const broken = ;\n";
// A fake integrity hook: restores every empty or BROKEN .mts from pristine/, records the peers, counts its runs.
const INTEGRITY = `import fs from "node:fs";
import path from "node:path";
const home = process.env.CODEX_HOME;
const dir = path.join(home, "hooks", "kherep-maestro");
fs.appendFileSync(path.join(home, "runs"), "x");
for (const name of fs.readdirSync(dir).filter((name) => name.endsWith(".mts"))) {
  const text = fs.readFileSync(path.join(dir, name), "utf8");
  if (!text.length || text === ${JSON.stringify(BROKEN)}) fs.copyFileSync(path.join(home, "pristine", name), path.join(dir, name));
}
const peers = Object.fromEntries(${JSON.stringify(PEERS)}.map((name) => { const s = fs.statSync(path.join(dir, name), { bigint: true });
  return [name, { dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs), sha256: "fixture" }]; }));
fs.writeFileSync(path.join(home, ".cache", "hook-integrity", "heartbeat.json"), JSON.stringify({ peers }) + "\\n");
console.log("all 3 files OK (1 restored), heartbeat refreshed");
`;

interface Box { root: string; dir: string }

// The installed layout with fresh, proven peers: only a broken file starts a re-check.
function box(t: TestContext): Box {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-adapter-module-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "hooks", "kherep-maestro");
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, ".cache", "hook-integrity"), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, "shell-checks.mts"), path.join(dir, "codex-shell-checks.mts"));
  copyAdapter(dir, "hook-adapter.mts");
  copyAdapter(dir, "codex-hook-adapter.mts");
  fs.copyFileSync(path.join(REPO, "claude", "hooks", "lib", "guard-recheck.mts"), path.join(dir, "lib", "guard-recheck.mts"));
  for (const name of GUARDS) fs.writeFileSync(path.join(dir, `${name}.mts`), "process.exit(0);\n");
  fs.writeFileSync(path.join(dir, "codex-hook-integrity.mts"), INTEGRITY);
  fs.cpSync(dir, path.join(root, "pristine"), { recursive: true });
  spawnSync(process.execPath, [path.join(dir, "codex-hook-integrity.mts")], { env: { ...process.env, CODEX_HOME: root }, windowsHide: true });
  fs.rmSync(path.join(root, "runs"));
  return { root, dir };
}

const runs = (b: Box): number => fs.existsSync(path.join(b.root, "runs")) ? fs.readFileSync(path.join(b.root, "runs"), "utf8").length : 0;
const pristine = (b: Box, name: string): boolean => fs.readFileSync(path.join(b.dir, name)).equals(fs.readFileSync(path.join(b.root, "pristine", name)));

function shell(b: Box): { stdout: string; reason?: string } {
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(b.dir, "codex-shell-checks.mts")],
    { input: PAYLOAD, encoding: "utf8", windowsHide: true, timeout: 45_000 });
  assert.equal(run.status, 0, run.stderr);
  const doc = run.stdout ? JSON.parse(run.stdout) as { hookSpecificOutput?: { permissionDecisionReason?: string } } : undefined;
  return { stdout: run.stdout, reason: doc?.hookSpecificOutput?.permissionDecisionReason };
}

for (const name of ADAPTER_MODULES) {
  for (const broken of ["", BROKEN]) {
    test(`${name} ${broken ? "syntax-broken" : "empty"}: the shell dispatcher denies as for a broken adapter, one re-check restores it`, (t) => {
      const b = box(t);
      assert.equal(shell(b).stdout, "", "healthy and proven: quiet");
      fs.writeFileSync(path.join(b.dir, name), broken);
      assert.equal(shell(b).reason, "Shell guard adapter could not load; this tool call is blocked.");
      assert.equal(runs(b), 1);
      assert.ok(pristine(b, name), `${name} restored`);
      assert.equal(shell(b).stdout, "", "the next call is quiet");
      assert.equal(runs(b), 1);
    });
  }
}

test("the adapter entry alone: a broken module gives exit 1 and empty stdout, exactly as a broken entry", (t) => {
  const b = box(t);
  const guard = path.join(b.dir, "commit-guard.mts");
  const adapter = (): { status: number | null; stdout: string } => spawnSync(process.execPath,
    [path.join(b.dir, "codex-hook-adapter.mts"), guard, "pre"], { input: PAYLOAD, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  for (const file of [...ADAPTER_MODULES, "codex-hook-adapter.mts"]) {
    for (const broken of file === "codex-hook-adapter.mts" ? [BROKEN] : ["", BROKEN]) {
      fs.writeFileSync(path.join(b.dir, file), broken);
      const run = adapter();
      assert.deepEqual([run.status, run.stdout], [1, ""], `${file} ${broken ? "syntax-broken" : "empty"}`);
      fs.copyFileSync(path.join(b.root, "pristine", file), path.join(b.dir, file));
    }
  }
  assert.equal(adapter().status, 0, "restored: the entry runs again");
});
