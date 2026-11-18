// Issue #507, part 3. The installed Codex hook-integrity hook in its --trigger mode:
// it walks the import closure again after each repair pass, writes the heartbeat
// only when everything ended OK and the write itself succeeded, and mutates nothing
// (no restore, journal or heartbeat) without run.lock, its own libs included.
// Fixture: install() into a temp Codex home, as codex/hook-integrity-install.test.mts.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { ABSOLUTE_PATH } from "../../claude/hooks/lib/denial-journal.mts";
import { holdLock as hold, killHolders, tryLock } from "../../claude/hooks/lib/lock-holder.fixture.mts";
import { install } from "../install.mts";
import { declareInstalled } from "./hook-adapter.fixture.mts";
import { fixtureModelOptions } from "../lib/model-policy.fixture.mts";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BUSY = "another integrity run holds run.lock (busy, holder UNKNOWN)";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-trigger-"));
  // Holders first: after() hooks run in registration order and stop at a throw, and
  // on Windows a holder with run.lock.sqlite open makes this rmSync fail (issue #534).
  t.after(async () => { await killHolders(); fs.rmSync(root, { recursive: true, force: true }); });
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
  declareInstalled(codexHome);
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_HOME: path.join(root, "no-claude-home"), KHEREP_WORKSPACE: path.join(root, "no-workspace") };
  delete env.CODEX_HOME;
  const cache = path.join(codexHome, ".cache", "hook-integrity");
  return { root, codexHome, config: path.join(codexHome, "config.toml"), hookDir: path.join(codexHome, "hooks", "kherep-maestro"), env, cache };
}
type Ctx = ReturnType<typeof fixture>;

const hookArgs = (ctx: Ctx, nodeArgs: string[] = []): string[] =>
  [...nodeArgs, path.join(ctx.hookDir, "codex-hook-integrity.mts"), "--trigger", "hook-adapter"];
const INPUT = (ctx: Ctx): string => JSON.stringify({ hook_event_name: "PreToolUse", cwd: ctx.root });

function integrity(ctx: Ctx, nodeArgs: string[] = []): { status: number | null; stderr: string; lines: string[] } {
  const run = spawnSync(process.execPath, hookArgs(ctx, nodeArgs), { input: INPUT(ctx), encoding: "utf8", env: ctx.env, windowsHide: true, timeout: 60_000 });
  return { status: run.status, stderr: run.stderr, lines: run.stdout.split(/\r?\n/).filter(Boolean) };
}

function journal(ctx: Ctx): Record<string, unknown>[] {
  const file = path.join(ctx.cache, "incidents.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}
const beatFile = (ctx: Ctx): string => path.join(ctx.cache, "heartbeat.json");
const same = (installed: string, source: string): boolean => fs.readFileSync(installed).equals(fs.readFileSync(path.join(REPO, source)));
const BROKEN = "export const = ;\n";

// A config.toml Stop entry that wires one more file under the hooks directory.
function wire(ctx: Ctx, file: string): void {
  const command = `"${process.execPath}" "${file}"`;
  fs.appendFileSync(ctx.config, `\n[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\ntimeout = 30\n`);
}

// A real process holding <home>/.cache/hook-integrity/run.lock.sqlite until the test ends.
async function holdLock(t: TestContext, home: string): Promise<void> {
  const holder = await hold(home);
  t.after(holder.kill);
}

test("T2.1 a broken parent that hid a missing import: both restored over two passes, heartbeat written", (t) => {
  const ctx = fixture(t);
  fs.writeFileSync(path.join(ctx.hookDir, "commit-guard.mts"), BROKEN);
  fs.rmSync(path.join(ctx.hookDir, "lib", "git-commit-match.mts"));
  const run = integrity(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(journal(ctx).map((e) => [e.file, e.kind, e.restoreProven, e.trigger]), [
    ["kherep-maestro/commit-guard.mts", "import", true, "hook-adapter"], ["kherep-maestro/lib/git-commit-match.mts", "import", true, "hook-adapter"]]);
  assert.ok(same(path.join(ctx.hookDir, "commit-guard.mts"), "claude/hooks/commit-guard.mts"));
  assert.ok(same(path.join(ctx.hookDir, "lib", "git-commit-match.mts"), "claude/hooks/lib/git-commit-match.mts"));
  assert.match(String(run.lines.at(-1)), /^all \d+ files OK \(2 restored\), heartbeat refreshed$/);
  const beat = JSON.parse(fs.readFileSync(beatFile(ctx), "utf8"));
  assert.deepEqual([beat.trigger, beat.runtime], ["hook-adapter", "codex"]);
});

test("T2.2a a parent that cannot be restored: the old heartbeat is removed first and not rewritten", (t) => {
  const ctx = fixture(t);
  const parent = path.join(ctx.hookDir, "fixture-hook.mts");
  fs.writeFileSync(parent, BROKEN);
  wire(ctx, parent);
  fs.mkdirSync(ctx.cache, { recursive: true });
  fs.writeFileSync(beatFile(ctx), "{}\n");
  const then = new Date(Date.now() - 31 * 60_000);
  fs.utimesSync(beatFile(ctx), then, then);
  const run = integrity(ctx);
  const line = run.lines.find((l) => l.startsWith("kherep-maestro/fixture-hook.mts: ")) ?? "";
  assert.match(line, /NOT restored \(versioned source claude\/hooks\/fixture-hook\.mts unreadable \(ENOENT\)\)/, run.lines.join("\n"));
  assert.ok(!ABSOLUTE_PATH.test(line) && !line.includes(REPO), line); // issue #576: not the checkout the installer named
  assert.equal(run.lines.at(-1), "heartbeat not written (kherep-maestro/fixture-hook.mts is not restored)");
  assert.equal(fs.existsSync(beatFile(ctx)), false);
});

test("T2.2b the revealed import is no regular file: the parent is restored, the import is named, no heartbeat", (t) => {
  const ctx = fixture(t);
  fs.writeFileSync(path.join(ctx.hookDir, "commit-guard.mts"), BROKEN);
  const dep = path.join(ctx.hookDir, "lib", "git-commit-match.mts");
  fs.rmSync(dep);
  fs.mkdirSync(dep);
  const run = integrity(ctx);
  assert.ok(same(path.join(ctx.hookDir, "commit-guard.mts"), "claude/hooks/commit-guard.mts"));
  assert.ok(run.lines.some((line) => line.startsWith("kherep-maestro/lib/git-commit-match.mts (imported by kherep-maestro/commit-guard.mts): UNCHECKED")), run.lines.join("\n"));
  assert.equal(run.lines.at(-1), "heartbeat not written (kherep-maestro/lib/git-commit-match.mts is unchecked)");
  assert.equal(fs.existsSync(beatFile(ctx)), false);
});

test("T2.3 a closure that keeps revealing broken files does not settle within three passes", (t) => {
  const ctx = fixture(t);
  const checkout = path.join(ctx.root, "checkout");
  fs.mkdirSync(path.join(checkout, "claude", "hooks"), { recursive: true });
  const chain = ["chain-a", "chain-b", "chain-c", "chain-d", "chain-e"];
  chain.forEach((name, i) => {
    fs.writeFileSync(path.join(checkout, "claude", "hooks", `${name}.mts`), chain[i + 1] ? `import "./${chain[i + 1]}.mts";\nexport {};\n` : "export {};\n");
    fs.writeFileSync(path.join(ctx.hookDir, `${name}.mts`), BROKEN);
  });
  wire(ctx, path.join(ctx.hookDir, "chain-a.mts"));
  fs.writeFileSync(path.join(ctx.codexHome, "orchestra", "control-plane-source.json"), JSON.stringify({ version: 1, root: checkout, kind: "checkout", verified: true }));
  const run = integrity(ctx);
  assert.equal(run.lines.at(-1), "heartbeat not written (the import closure did not settle)", run.lines.join("\n"));
  assert.equal(journal(ctx).length, 3, "three passes repaired one file each");
});

test("T2.4 a heartbeat that cannot be removed blocks the repair", (t) => {
  const ctx = fixture(t);
  fs.mkdirSync(path.join(beatFile(ctx), "inside"), { recursive: true });
  const lib = path.join(ctx.hookDir, "lib", "git-commit-match.mts");
  fs.writeFileSync(lib, "");
  const run = integrity(ctx);
  assert.ok(run.lines.some((line) => /NOT restored \(heartbeat could not be removed: [A-Z_]+\)/.test(line)), run.lines.join("\n"));
  assert.equal(fs.statSync(lib).size, 0);
  assert.equal(run.lines.at(-1), "heartbeat not written (kherep-maestro/lib/git-commit-match.mts is not restored)");
  assert.equal(journal(ctx)[0]?.restoreProven, false);
});

// The lock lives in the same directory, so the write failure comes from the target, not a read-only directory.
test("T2.5 a heartbeat write that fails is reported, never as refreshed", (t) => {
  const ctx = fixture(t);
  fs.mkdirSync(path.join(beatFile(ctx), "inside"), { recursive: true });
  const run = integrity(ctx);
  assert.match(String(run.lines.at(-1)), /^heartbeat not written \(heartbeat write failed: [A-Z]+\)$/);
});

test("T3.1 a foreign run.lock and a broken own lib: reported, nothing restored or journalled", async (t) => {
  const ctx = fixture(t);
  const lib = path.join(ctx.hookDir, "lib", "integrity-verdict.mts");
  fs.writeFileSync(lib, "");
  await holdLock(t, ctx.codexHome);
  const run = integrity(ctx);
  assert.equal(run.lines[0], `own import lib/integrity-verdict.mts cannot be loaded (no function classify); nothing was verified this session -> NOT restored (${BUSY}). ENFORCEMENT IS OFF for this hook`);
  assert.equal(fs.statSync(lib).size, 0);
  assert.deepEqual(journal(ctx), []);
  assert.equal(fs.existsSync(beatFile(ctx)), false);
});

test("T3.2 the same without a foreign lock: restored with proof and journalled as self, no heartbeat, lock released", (t) => {
  const ctx = fixture(t);
  fs.writeFileSync(path.join(ctx.hookDir, "lib", "integrity-verdict.mts"), "");
  const run = integrity(ctx);
  assert.match(run.lines[0]!, /^own import lib\/integrity-verdict\.mts cannot be loaded .* -> RESTORED from the repo, verified at the target/);
  assert.equal(run.lines.at(-1), "heartbeat not written (own import lib/integrity-verdict.mts cannot be loaded)");
  assert.ok(same(path.join(ctx.hookDir, "lib", "integrity-verdict.mts"), "claude/hooks/lib/integrity-verdict.mts"));
  assert.deepEqual(journal(ctx).map((e) => [e.kind, e.trigger, e.restoreProven]), [["self", "hook-adapter", true]]);
  assert.equal(fs.existsSync(beatFile(ctx)), false);
  assert.equal(tryLock(ctx.codexHome).result, "owner", "the lock was released");
});

// Issue #564: the trigger output reaches the adapters' notices; no line names a path or carries Node's message.
test("T3.2b a deleted own lib, an unreadable config.toml, nothing wired: lines with codes and no path", (t) => {
  const deleted = fixture(t);
  fs.rmSync(path.join(deleted.hookDir, "lib", "integrity-verdict.mts"));
  const unreadable = fixture(t);
  fs.rmSync(unreadable.config);
  fs.mkdirSync(unreadable.config);
  const unwired = fixture(t);
  fs.writeFileSync(unwired.config, "");
  const [a, b, c] = [integrity(deleted).lines, integrity(unreadable).lines, integrity(unwired).lines];
  assert.match(String(a[0]), /^own import lib\/integrity-verdict\.mts cannot be loaded \(ERR_MODULE_NOT_FOUND\); nothing was verified this session -> RESTORED /);
  assert.match(String(b[0]), /^config\.toml unreadable \([A-Z]+\), so WHICH hooks are wired is UNKNOWN here$/);
  assert.equal(c[0], "no hook file under hooks/ is wired in config.toml, so WHICH hooks run is UNKNOWN here");
  for (const [ctx, lines] of [[deleted, a], [unreadable, b], [unwired, c]] as const) {
    for (const line of lines) assert.ok(!ABSOLUTE_PATH.test(line) && !line.includes(ctx.root), line);
  }
});

test("T3.3 a broken lib/integrity-heartbeat.mts is reported, not repaired; nothing is written", (t) => {
  const ctx = fixture(t);
  const lib = path.join(ctx.hookDir, "lib", "integrity-heartbeat.mts");
  fs.writeFileSync(lib, "");
  const run = integrity(ctx);
  assert.match(run.lines[0]!, /^own import lib\/integrity-heartbeat\.mts cannot be loaded .*NOT restored \(the restore itself needs workspace-scope, orchestra-checkout, restore-write and integrity-heartbeat \(run\.lock\)\)/);
  assert.equal(fs.statSync(lib).size, 0);
  assert.equal(fs.existsSync(ctx.cache), false, "no journal, lock or heartbeat");
});

test("T3.4 a healthy install while another run holds run.lock: nothing checked, nothing written, the lock untouched", async (t) => {
  const ctx = fixture(t);
  await holdLock(t, ctx.codexHome);
  const run = integrity(ctx);
  assert.deepEqual(run.lines, [`${BUSY}; nothing checked, heartbeat not written`]);
  assert.deepEqual(journal(ctx), []);
  assert.equal(fs.existsSync(beatFile(ctx)), false);
  assert.equal(tryLock(ctx.codexHome).result, BUSY, "the holder still holds");
});

test("T3.5 two runs started together: one repair, one journal entry, both exit 0, one heartbeat", async (t) => {
  const ctx = fixture(t);
  fs.writeFileSync(path.join(ctx.hookDir, "lib", "git-commit-match.mts"), "");
  // Each run's stdout is kept, so a failure names the path each run took (issue #620).
  const start = (): Promise<{ code: number | null; out: string }> => new Promise((resolve) => {
    const child = spawn(process.execPath, hookArgs(ctx), { env: ctx.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.on("close", (code) => resolve({ code, out: out.trim() }));
    child.stdin.end(INPUT(ctx));
  });
  const runs = await Promise.all([start(), start()]);
  const paths = runs.map((run) => `[exit ${run.code}] ${run.out || "(no output)"}`).join("\n---\n");
  assert.deepEqual(runs.map((run) => run.code), [0, 0], paths);
  // One run repaired; the other was told busy, or, started after the repair, found everything OK. Never both busy.
  const lasts = runs.map((run) => run.out.split(/\r?\n/).at(-1) ?? "");
  assert.ok(lasts.some((line) => /^all \d+ files OK \(1 restored\), heartbeat refreshed$/.test(line)), paths);
  assert.ok(lasts.some((line) => line === `${BUSY}; nothing checked, heartbeat not written` || /^all \d+ files OK \(0 restored\), heartbeat refreshed$/.test(line)), paths);
  assert.equal(journal(ctx).length, 1, paths);
  assert.ok(fs.existsSync(beatFile(ctx)), paths);
});

test("T4.5 a Node without node:sqlite: report only, nothing restored or written", (t) => {
  const ctx = fixture(t);
  const lib = path.join(ctx.hookDir, "lib", "git-commit-match.mts");
  fs.writeFileSync(lib, "");
  const run = integrity(ctx, ["--no-experimental-sqlite"]);
  assert.deepEqual(run.lines, ["run.lock unavailable (node:sqlite is not available in this Node); nothing checked, heartbeat not written"]);
  assert.equal(fs.statSync(lib).size, 0);
  assert.equal(fs.existsSync(ctx.cache), false);
});
