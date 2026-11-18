// Issue #507, part 4. The installed Codex hook-integrity hook records the three
// dispatcher files in heartbeat.json "peers" from fd-bound snapshots of the bytes
// its final pass judged (amendment B1); nothing is recorded without a proven run.
// The installed adapter's gate then sees a peer that changed after that run, and
// its re-check restores it. Fixture: install() into a temp Codex home, as
// hook-integrity-trigger.test.mts (kept separate: another change owns that file).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { install } from "../install.mts";
import { declareInstalled } from "./hook-adapter.fixture.mts";
import { fixtureModelOptions } from "../lib/model-policy.fixture.mts";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const DISPATCHERS = ["codex-hook-adapter.mts", "codex-shell-checks.mts", "hook-adapter.mts"];
const BROKEN = "export const broken = ;\n";

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-peers-")));
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
  declareInstalled(codexHome, ["codex-shell-checks.mts"]); // T15 replaces the shell dispatcher
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_HOME: path.join(root, "no-claude-home"), KHEREP_WORKSPACE: path.join(root, "no-workspace") };
  delete env.CODEX_HOME;
  const hookDir = path.join(codexHome, "hooks", "kherep-maestro");
  return { root, codexHome, hookDir, env, beat: path.join(codexHome, ".cache", "hook-integrity", "heartbeat.json"),
    journal: path.join(codexHome, ".cache", "hook-integrity", "incidents.jsonl") };
}
type Ctx = ReturnType<typeof fixture>;

function integrity(ctx: Ctx): string[] {
  const run = spawnSync(process.execPath, [path.join(ctx.hookDir, "codex-hook-integrity.mts"), "--trigger", "hook-adapter"],
    { input: JSON.stringify({ cwd: ctx.root }), encoding: "utf8", env: ctx.env, windowsHide: true, timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.split(/\r?\n/).filter(Boolean);
}
type Tuple = { dev: string; ino: string; size: string; mtimeNs: string; sha256: string };
const peers = (ctx: Ctx): Record<string, Tuple> => JSON.parse(fs.readFileSync(ctx.beat, "utf8")).peers;
function tupleOf(file: string): Tuple {
  const s = fs.statSync(file, { bigint: true });
  return { dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs),
    sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
}
// The installed adapter with the installed privacy guard on a Read: allowed, so only the re-check speaks.
function adapter(ctx: Ctx): { additionalContext?: string } {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", cwd: ctx.root,
    tool_input: { file_path: path.join(ctx.root, "workspace", "Kherep", "README.md") } });
  const run = spawnSync(process.execPath, [path.join(ctx.hookDir, "codex-hook-adapter.mts"), path.join(ctx.hookDir, "codex-privacy-boundary-guard.mts"), "pre-privacy"],
    { input, encoding: "utf8", env: ctx.env, windowsHide: true, timeout: 15_000 });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout ? (JSON.parse(run.stdout) as { hookSpecificOutput: { additionalContext?: string } }).hookSpecificOutput : {};
}
const shell = (ctx: Ctx): string => path.join(ctx.hookDir, "codex-shell-checks.mts");
const restored = (ctx: Ctx): boolean => fs.readFileSync(shell(ctx)).equals(fs.readFileSync(path.join(REPO, "codex", "hooks", "shell-checks.mts")));

test("T14a a proven run records exactly the three dispatcher files, each equal to a fresh bigint stat and sha256", (t) => {
  const ctx = fixture(t);
  assert.match(String(integrity(ctx).at(-1)), /^all \d+ files OK \(0 restored\), heartbeat refreshed$/);
  const record = peers(ctx);
  assert.deepEqual(Object.keys(record).sort(), DISPATCHERS);
  for (const name of DISPATCHERS) assert.deepEqual(record[name], tupleOf(path.join(ctx.hookDir, name)), name);
  assert.equal(adapter(ctx).additionalContext, undefined, "the gate passes: no re-check");
});

test("T14b a dispatcher the syntax check leaves UNCHECKED: no heartbeat, so no tuple, and a journal line", (t) => {
  const ctx = fixture(t);
  const real = pathToFileURL(path.join(REPO, "claude", "hooks", "lib", "hook-syntax.mts")).href;
  fs.writeFileSync(path.join(ctx.hookDir, "lib", "hook-syntax.mts"), `import { syntaxVerdict as real } from ${JSON.stringify(real)};
export * from ${JSON.stringify(real)};
export async function syntaxVerdict(file, source) {
  return file.endsWith("codex-shell-checks.mts") ? { state: "UNGEPRUEFT", detail: "fixture" } : real(file, source);
}
`);
  const lines = integrity(ctx);
  assert.ok(lines.some((line) => /codex-shell-checks\.mts.*: UNCHECKED - /.test(line)), lines.join("\n"));
  assert.match(String(lines.at(-1)), /^heartbeat not written \(kherep-maestro\/codex-shell-checks\.mts is unchecked\)$/);
  assert.equal(fs.existsSync(ctx.beat), false);
  assert.ok(fs.readFileSync(ctx.journal, "utf8").includes('"state":"UNGEPRUEFT"'));
});

test("T15a end state of the ABA: the record holds B, the path holds a defective A; the gate sees it, the re-check restores A", (t) => {
  const ctx = fixture(t);
  integrity(ctx);
  const aside = path.join(ctx.root, "a.mts");
  fs.writeFileSync(aside, BROKEN);
  fs.renameSync(aside, shell(ctx)); // A, by rename, after B was recorded
  const notice = String(adapter(ctx).additionalContext);
  assert.ok(notice.startsWith("kherep-maestro/codex-shell-checks.mts cannot be trusted (inode changed since the last proven check)\n"), notice);
  assert.ok(restored(ctx), "the re-check restored A from the checkout");
  assert.deepEqual(peers(ctx)["codex-shell-checks.mts"], tupleOf(shell(ctx)), "and recorded the restored bytes");
});

test("T15b end state with no tuple for the peer: the next call treats it as broken and restores it", (t) => {
  const ctx = fixture(t);
  integrity(ctx);
  const beat = JSON.parse(fs.readFileSync(ctx.beat, "utf8"));
  delete beat.peers["codex-shell-checks.mts"];
  const when = fs.statSync(ctx.beat).mtime;
  fs.writeFileSync(ctx.beat, `${JSON.stringify(beat)}\n`);
  fs.utimesSync(ctx.beat, when, when);
  fs.writeFileSync(shell(ctx), BROKEN);
  const notice = String(adapter(ctx).additionalContext);
  assert.ok(notice.startsWith("kherep-maestro/codex-shell-checks.mts cannot be trusted (no proven record)\n"), notice);
  assert.ok(restored(ctx));
});
