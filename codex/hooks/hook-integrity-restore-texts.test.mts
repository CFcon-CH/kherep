// Issue #576. The restore texts of the installed Codex hook-integrity hook name no
// absolute path: a versioned source by its path inside the checkout, a linked hooks
// subdirectory by the hook runtime's own sentence. The journal keeps which checkout
// was tried. Fixture: install() into a temp Codex home, as hook-integrity-trigger.test.mts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { ABSOLUTE_PATH } from "../../claude/hooks/lib/denial-journal.mts";
import { killHolders } from "../../claude/hooks/lib/lock-holder.fixture.mts";
import { install } from "../install.mts";
import { declareInstalled } from "./hook-adapter.fixture.mts";
import { fixtureModelOptions } from "../lib/model-policy.fixture.mts";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BROKEN = "export const = ;\n";
const slash = (p: string): string => p.replace(/\\/g, "/");

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-restore-texts-"));
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
  return { root, codexHome, config: path.join(codexHome, "config.toml"), hookDir: path.join(codexHome, "hooks", "kherep-maestro"), env };
}
type Ctx = ReturnType<typeof fixture>;

// A config.toml Stop entry that wires one more file under the hooks directory.
function wire(ctx: Ctx, file: string): void {
  const command = `"${process.execPath}" "${file}"`;
  fs.appendFileSync(ctx.config, `\n[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\ntimeout = 30\n`);
}

// The --trigger form prints plain lines; the session-start form prints the JSON notice.
function integrity(ctx: Ctx, trigger = true): { status: number | null; stderr: string; stdout: string; lines: string[] } {
  const args = [path.join(ctx.hookDir, "codex-hook-integrity.mts"), ...(trigger ? ["--trigger", "hook-adapter"] : [])];
  const input = JSON.stringify({ hook_event_name: trigger ? "PreToolUse" : "SessionStart", cwd: ctx.root });
  const run = spawnSync(process.execPath, args, { input, encoding: "utf8", env: ctx.env, windowsHide: true, timeout: 60_000 });
  return { status: run.status, stderr: run.stderr, stdout: run.stdout, lines: run.stdout.split(/\r?\n/).filter(Boolean) };
}

const journal = (ctx: Ctx): Record<string, unknown>[] => {
  const file = path.join(ctx.codexHome, ".cache", "hook-integrity", "incidents.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
};

// No absolute path, no fixture root, checkout or temp directory, no `..` escape.
function pathFree(ctx: Ctx, text: string): void {
  assert.doesNotMatch(text, ABSOLUTE_PATH, text);
  for (const root of [ctx.root, REPO, os.tmpdir(), slash(ctx.root), slash(REPO)]) assert.ok(!text.includes(root), text);
  assert.doesNotMatch(text, /(^|[\s(])\.\.[\\/]/, text);
}

test("a versioned source the checkout lacks is named inside the checkout", (t) => {
  const ctx = fixture(t);
  const parent = path.join(ctx.hookDir, "fixture-hook.mts");
  fs.writeFileSync(parent, BROKEN);
  wire(ctx, parent);
  const run = integrity(ctx);
  assert.equal(run.status, 0, run.stderr);
  const line = run.lines.find((l) => l.startsWith("kherep-maestro/fixture-hook.mts: ")) ?? "";
  assert.ok(line.endsWith(" -> NOT restored (versioned source claude/hooks/fixture-hook.mts unreadable (ENOENT)). ENFORCEMENT IS OFF for this hook"), run.stdout);
  for (const l of run.lines) pathFree(ctx, l);
  assert.equal(journal(ctx)[0]?.checkout, slash(REPO));
});

test("an empty versioned source, session start: the notice and its system message name no path", (t) => {
  const ctx = fixture(t);
  const checkout = path.join(ctx.root, "checkout");
  fs.mkdirSync(path.join(checkout, "claude", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "claude", "hooks", "fixture-hook.mts"), "");
  const pointer = path.join(ctx.codexHome, "orchestra", "control-plane-source.json");
  fs.writeFileSync(pointer, JSON.stringify({ version: 1, root: checkout, kind: "checkout", verified: false }));
  const parent = path.join(ctx.hookDir, "fixture-hook.mts");
  fs.writeFileSync(parent, "");
  wire(ctx, parent);
  const run = integrity(ctx, false);
  assert.equal(run.status, 0, run.stderr);
  const notice = JSON.parse(run.stdout) as { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } };
  const context = String(notice.hookSpecificOutput?.additionalContext);
  assert.ok(context.includes("NOT restored (versioned source claude/hooks/fixture-hook.mts is itself 0 bytes)"), context);
  pathFree(ctx, context);
  pathFree(ctx, String(notice.systemMessage));
  const entry = journal(ctx).find((e) => e.file === "kherep-maestro/fixture-hook.mts");
  assert.equal(entry?.checkout, slash(checkout));
});

test("a linked hooks subdirectory is refused with the hook runtime's sentence", (t) => {
  const ctx = fixture(t);
  const outside = path.join(ctx.root, "elsewhere-lib");
  fs.renameSync(path.join(ctx.hookDir, "lib"), outside);
  try {
    fs.symlinkSync(outside, path.join(ctx.hookDir, "lib"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    const { code, syscall } = error as NodeJS.ErrnoException;
    if (code !== "EPERM" || syscall !== "symlink") throw error;
    t.skip("directory link creation unavailable (EPERM)");
    return;
  }
  fs.writeFileSync(path.join(outside, "git-commit-match.mts"), "");
  const run = integrity(ctx);
  assert.equal(run.status, 0, run.stderr);
  const line = run.lines.find((l) => l.startsWith("kherep-maestro/lib/git-commit-match.mts ")) ?? "";
  assert.ok(line.includes("NOT restored (hooks directory or its subdirectory resolves outside the hooks root)"), run.stdout);
  for (const l of run.lines) pathFree(ctx, l);
  assert.equal(fs.statSync(path.join(outside, "git-commit-match.mts")).size, 0);
});
