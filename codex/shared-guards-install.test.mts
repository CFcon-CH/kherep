// Issue #237, batch 2. The Codex installer copies three Claude guards by name
// (commit-guard, deploy-guard, playwright-file-guard) into
// hooks/kherep-maestro and wires them in config.toml. After their move from .js
// to .mts each one has to still block, run exactly the way Codex runs it: the
// command string from the installed config.toml (through codex-hook-adapter.mts
// where the projection wires it so), under its wired event and matcher. A wiring
// that points at a missing or empty shell guard must deny through the dispatcher.
// An upgrade over a block the previous
// installer wrote (.js names) must replace that block and remove the old copies.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";

import { install } from "./install.mts";
import { fixtureModelOptions } from "./lib/model-policy.fixture.mts";
import { command, contextCommand } from "./lib/parity-config.mts";
import { InstallTransaction } from "./lib/install-transaction.mts";
import { declareCopy } from "../bootstrap/coverage-copy-fixture.mts";

const GUARDS = ["commit-guard", "deploy-guard", "playwright-file-guard"] as const;

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-guards-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "home with spaces", ".codex");
  const claudeRegistryFile = path.join(root, "home with spaces", ".claude.json");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(claudeRegistryFile, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
  const options = {
    ...fixtureModelOptions(),
    codexHome, claudeRegistryFile,
    claudeConfigDir: path.join(root, "home with spaces", ".claude"),
    workspace: path.join(root, "workspace", "Kherep"),
    nodePath: process.execPath,
    log: (): void => {},
    resolveRegistryRuntime: () => "fixture",
    runCodex: (args: string[]): string => {
      if (args[0] === "--version") return "codex-cli 0.144.6";
      if (args.join(" ") === "plugin marketplace list --json") return '{"marketplaces":[]}';
      return "ok";
    },
    controlPlaneOutbox: path.join(root, "kherep config", "control-plane", "outbox"),
  };
  return { hookDir: path.join(codexHome, "hooks", "kherep-maestro"), options };
}

interface WiredHook { event: string; matcher: string; command: string; commandWindows?: string }

// Every hook in the installed config.toml with the event and matcher of its group.
function wiredHooks(config: string): WiredHook[] {
  const found: WiredHook[] = [];
  for (const group of config.split(/^(?=\[\[hooks\.[A-Za-z]+\]\]$)/m).slice(1)) {
    const event = /^\[\[hooks\.([A-Za-z]+)\]\]$/m.exec(group)![1]!;
    const [header, ...blocks] = group.split(/^\[\[hooks\.[A-Za-z]+\.hooks\]\]$/m);
    const matcherLine = /^matcher = (".*")$/m.exec(header!);
    const matcher = matcherLine ? JSON.parse(matcherLine[1]!) as string : "";
    for (const block of blocks) {
      const line = /^command = (".*")$/m.exec(block);
      const windows = /^commandWindows = (".*")$/m.exec(block);
      if (line) found.push({
        event, matcher, command: JSON.parse(line[1]!) as string,
        ...(windows ? { commandWindows: JSON.parse(windows[1]!) as string } : {}),
      });
    }
  }
  return found;
}

// Shell guards run through one installed dispatcher; Playwright through the adapter (issue #507, part 4).
function wiredGuard(config: string, hookDir: string, guard: string): WiredHook {
  const target = guard === "playwright-file-guard" ? `${guard}.mts` : "codex-shell-checks.mts";
  const script = `"${path.join(hookDir, target)}"`;
  const hits = wiredHooks(config).filter((hook) => hook.command.includes(script));
  assert.equal(hits.length, 1, `config.toml wires ${guard}.mts exactly once`);
  return hits[0]!;
}

interface HookDecision { permissionDecision?: unknown; permissionDecisionReason?: unknown; hookEventName?: unknown }

// The Codex PreToolUse JSON decision on stdout, or null when stdout holds none.
function decisionOf(stdout: string): HookDecision | null {
  try {
    return (JSON.parse(stdout) as { hookSpecificOutput?: HookDecision }).hookSpecificOutput ?? null;
  } catch {
    return null;
  }
}

// Runs the wired `command` through the shell, as Codex does on macOS and Linux.
function runWired(hook: WiredHook, payload: Record<string, unknown>, env: Record<string, string> = {}) {
  const input = JSON.stringify({ hook_event_name: hook.event, ...payload });
  const result = spawnSync(hook.command, { shell: true, input, encoding: "utf8", windowsHide: true,
    env: { ...process.env, ...env } });
  const decision = decisionOf(result.stdout);
  return { status: result.status, decision: decision?.permissionDecision ?? null, reason: decision?.permissionDecisionReason, stderr: result.stderr };
}

// Each guard, its wired matcher, a tool the matcher names, and a blocking and a
// benign input. Issue #258: commit-guard and deploy-guard block with exit 2, and
// the adapter answers Codex with the JSON deny on exit 0, the form that survives
// the Windows pwsh wrapper; playwright-file-guard denies through JSON itself.
const CASES = [
  {
    guard: "commit-guard", matcher: "Bash|shell_command|exec_command|functions\\.exec", tool: "shell_command",
    blocking: 'git commit -m "em — dash"', benign: 'git commit -m "plain subject\n\nCo-authored-by: Example <dev@example.com>"',
  },
  {
    guard: "deploy-guard", matcher: "Bash|shell_command|exec_command|functions\\.exec", tool: "shell_command",
    blocking: "git push --force", benign: "git push origin main",
  },
] as const;

function assertGuardsBlock(config: string, hookDir: string, unchanged = true): void {
  // Tests that replace or break this installed copy must not declare it.
  if (unchanged) declareCopy(path.resolve(import.meta.dirname, "../claude/hooks/playwright-file-guard.mts"), path.join(hookDir, "playwright-file-guard.mts"));
  for (const item of CASES) {
    const hook = wiredGuard(config, hookDir, item.guard);
    assert.equal(hook.event, "PreToolUse", item.guard);
    assert.equal(hook.matcher, item.matcher, item.guard);
    assert.ok(new RegExp(hook.matcher).test(item.tool), `${item.guard} matcher covers ${item.tool}`);
    assert.match(hook.command, /codex-shell-checks\.mts"/, `${item.guard} runs through the installed dispatcher`);
    const blocked = runWired(hook, { tool_name: item.tool, tool_input: { command: item.blocking }, cwd: hookDir });
    assert.equal(blocked.status, 0, `${item.guard} must answer ${item.blocking} on exit 0; stderr: ${blocked.stderr}`);
    assert.equal(blocked.decision, "deny", `${item.guard} must deny ${item.blocking}; stderr: ${blocked.stderr}`);
    assert.match(String(blocked.reason), new RegExp(`^${item.guard} blocked`));
    const allowed = runWired(hook, { tool_name: item.tool, tool_input: { command: item.benign }, cwd: hookDir });
    assert.equal(allowed.status, 0, `${item.guard} must allow ${item.benign}; stderr: ${allowed.stderr}`);
    assert.equal(allowed.decision, null, `${item.guard} must allow ${item.benign}`);
  }
  const playwright = wiredGuard(config, hookDir, "playwright-file-guard");
  assert.equal(playwright.event, "PreToolUse");
  assert.equal(playwright.matcher, "mcp__playwright__browser_navigate");
  const tool = "mcp__playwright__browser_navigate";
  const denied = runWired(playwright, { tool_name: tool, tool_input: { url: "file:///C:/report/index.html" } });
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(denied.decision, "deny", `playwright-file-guard must deny file://; stderr: ${denied.stderr}`);
  const served = runWired(playwright, { tool_name: tool, tool_input: { url: "http://localhost:8080/index.html" } });
  assert.equal(served.status, 0, served.stderr);
  assert.equal(served.decision, null);
}

test("each shared guard still blocks through its wired Codex command after an install", (t) => {
  const { hookDir, options } = fixture(t);
  const result = install(options);
  const config = fs.readFileSync(result.targets.config, "utf8");
  for (const guard of GUARDS) {
    assert.equal(fs.readFileSync(path.join(hookDir, `${guard}.mts`), "utf8"),
      fs.readFileSync(path.join(import.meta.dirname, "..", "claude", "hooks", `${guard}.mts`), "utf8"), guard);
    assert.equal(fs.existsSync(path.join(hookDir, `${guard}.js`)), false, `${guard}.js is not projected`);
    assert.doesNotMatch(config, new RegExp(`${guard}\\.js`), `config.toml does not wire ${guard}.js`);
  }
  assertGuardsBlock(config, hookDir);
});

test("upgrade preserves the exact attribution-denying guard and transaction rollback restores it", (t) => {
  const { hookDir, options } = fixture(t);
  install(options);
  const snapshot = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "bootstrap", "fixtures", "coauthor-ban-predecessor.json"), "utf8"));
  const predecessor = snapshot.files["claude/hooks/commit-guard.mts"] as { text: string; sha256: string };
  assert.equal(snapshot.baseline, "0c28fdd8f35b20ffd4ad9e34dcd3c0dfc639708f");
  assert.equal(createHash("sha256").update(predecessor.text).digest("hex"), predecessor.sha256);
  const target = path.join(hookDir, "commit-guard.mts");
  fs.writeFileSync(target, predecessor.text);
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: 'git commit -m "plain\n\nCo-authored-by: Example <dev@example.com>"' } });
  const direct = () => spawnSync(process.execPath, [target], { input, encoding: "utf8" });
  assert.equal(direct().status, 2, "exact predecessor denied attribution");
  const unrelated = fs.readFileSync(path.join(hookDir, "deploy-guard.mts"));
  const upgraded = install(options);
  const newBytes = fs.readFileSync(path.join(import.meta.dirname, "..", "claude", "hooks", "commit-guard.mts"));
  assert.deepEqual(fs.readFileSync(target), newBytes);
  assert.equal(fs.readFileSync(path.join(upgraded.backupRoot, "hooks", "kherep-maestro", "commit-guard.mts"), "utf8"), predecessor.text);
  assert.equal(direct().status, 0, "upgraded guard accepts attribution");
  assert.deepEqual(fs.readFileSync(path.join(hookDir, "deploy-guard.mts")), unrelated);
  assertGuardsBlock(fs.readFileSync(upgraded.targets.config, "utf8"), hookDir);
  // Exercise the existing transaction rollback on the same exact predecessor.
  fs.writeFileSync(target, predecessor.text);
  const transaction = new InstallTransaction(options.codexHome, path.join(options.codexHome, "backups", "rollback-attribution"));
  transaction.copyFile(path.join(import.meta.dirname, "..", "claude", "hooks", "commit-guard.mts"), target);
  assert.equal(direct().status, 0);
  transaction.rollback();
  assert.equal(fs.readFileSync(target, "utf8"), predecessor.text);
  assert.equal(direct().status, 2);
});

// Issue #258. Codex on Windows runs `commandWindows` as `pwsh -NoProfile -Command
// <commandWindows>`, and pwsh reports a native exit 2 as 1 (measured with pwsh
// 7.6.6), which Codex treats as a failed, non-blocking hook. The block has to
// reach Codex as the JSON deny on stdout, whatever exit code pwsh reports.
const PWSH = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { windowsHide: true }).status === 0;

test("commit-guard and deploy-guard deny through the rendered Windows command under pwsh",
  { skip: !PWSH && "pwsh is not on PATH; the Windows commandWindows form needs it" }, (t) => {
    const { hookDir, options } = fixture(t);
    const config = fs.readFileSync(install(options).targets.config, "utf8");
    for (const item of CASES) {
      const hook = wiredGuard(config, hookDir, item.guard);
      assert.equal(hook.commandWindows, `& ${hook.command}`, `${item.guard} carries the rendered Windows form`);
      const run = (command: string) => spawnSync("pwsh", ["-NoProfile", "-Command", hook.commandWindows!], {
        encoding: "utf8", windowsHide: true,
        input: JSON.stringify({ hook_event_name: hook.event, tool_name: item.tool, tool_input: { command }, cwd: hookDir }),
      });
      const blocked = run(item.blocking);
      const decision = decisionOf(blocked.stdout);
      assert.equal(decision?.hookEventName, "PreToolUse", `${item.guard}; pwsh exit ${blocked.status}; stderr: ${blocked.stderr}`);
      assert.equal(decision?.permissionDecision, "deny", `${item.guard}; pwsh exit ${blocked.status}`);
      assert.match(String(decision?.permissionDecisionReason), new RegExp(`^${item.guard} blocked`));
      const allowed = run(item.benign);
      assert.equal(allowed.status, 0, `${item.guard} allows ${item.benign}; stderr: ${allowed.stderr}`);
      assert.equal(allowed.stdout, "");
    }
  });

test("an upgrade over the .js projection replaces its block and removes the old copies", (t) => {
  const { hookDir, options } = fixture(t);
  const first = install(options);
  // Historical context commands were unbound; remove the new workspace pair
  // before reconstructing the three shared guards' .js projection.
  let previous = fs.readFileSync(first.targets.config, "utf8");
  const contextHook = path.join(path.dirname(hookDir), "kherep-maestro-context.mts");
  for (const prefix of ["", "& "]) {
    const bound = JSON.stringify(prefix + contextCommand(options.nodePath, contextHook, options.workspace));
    const unbound = JSON.stringify(prefix + command(options.nodePath, contextHook));
    assert.equal(previous.split(bound).length - 1, 2, "both context events carry the current workspace binding");
    previous = previous.replaceAll(bound, unbound);
    assert.equal(previous.split(unbound).length - 1, 2, "both historical context commands are unbound");
  }
  for (const guard of GUARDS) {
    previous = previous.replaceAll(`${guard}.mts`, `${guard}.js`);
    fs.rmSync(path.join(hookDir, `${guard}.mts`));
    fs.writeFileSync(path.join(hookDir, `${guard}.js`), `// stale ${guard}\n`);
  }
  fs.writeFileSync(first.targets.config, previous);

  const result = install(options);
  const config = fs.readFileSync(result.targets.config, "utf8");
  for (const guard of GUARDS) {
    assert.equal(fs.existsSync(path.join(hookDir, `${guard}.js`)), false, `the old ${guard}.js copy is gone`);
    assert.equal(fs.readFileSync(path.join(result.backupRoot, "hooks", "kherep-maestro", `${guard}.js`), "utf8"),
      `// stale ${guard}\n`, `${guard}.js is kept in the install backup`);
    assert.doesNotMatch(config, new RegExp(`${guard}\\.js`), `config.toml no longer wires ${guard}.js`);
  }
  assertGuardsBlock(config, hookDir, false);
});

test("missing or empty installed shell guards deny benign commands", (t) => {
  const { hookDir, options } = fixture(t);
  const config = fs.readFileSync(install(options).targets.config, "utf8");
  for (const broken of ["missing", "empty"] as const) {
    for (const guard of [...GUARDS, "main-checkout-guard", "module-label-guard"]) {
      const file = path.join(hookDir, `${guard}.mts`);
      const original = fs.readFileSync(file);
      if (broken === "missing") fs.rmSync(file); else fs.writeFileSync(file, "");
      if (guard === "playwright-file-guard") {
        // Issue #507, part 4: through the adapter both navigations are denied naming the file. Broken
        // again before each call: the adapter's re-check may restore it from the checkout.
        for (const url of ["file:///C:/report/index.html", "http://localhost:8080/index.html"]) {
          if (broken === "missing") fs.rmSync(file, { force: true }); else fs.writeFileSync(file, "");
          const result = runWired(wiredGuard(config, hookDir, guard), { tool_name: "mcp__playwright__browser_navigate", tool_input: { url } });
          assert.deepEqual([result.status, result.decision], [0, "deny"], `${broken} ${guard} ${url}: ${result.stderr}`);
          assert.ok(String(result.reason).includes(`playwright-file-guard.mts cannot run (${broken === "missing" ? "missing" : "empty, 0 bytes"})`), String(result.reason));
        }
      } else {
        const result = runWired(wiredGuard(config, hookDir, guard), {
          tool_name: "shell_command", tool_input: { command: "git status --short" }, cwd: hookDir,
        });
        assert.deepEqual([result.status, result.decision], [0, "deny"], `${broken} ${guard}: ${result.stderr}`);
        assert.match(String(result.reason), new RegExp(guard));
      }
      fs.writeFileSync(file, original);
    }
  }
  assertGuardsBlock(config, hookDir, false);
});

// Issue #325. A fourth shared guard; it has no .js past, so it is not in GUARDS.
test("main-checkout-guard denies git switch feat in the main checkout through its wired Codex command", (t) => {
  const { hookDir, options } = fixture(t);
  const hook = wiredGuard(fs.readFileSync(install(options).targets.config, "utf8"), hookDir, "main-checkout-guard");
  assert.equal(fs.readFileSync(path.join(hookDir, "main-checkout-guard.mts"), "utf8"),
    fs.readFileSync(path.join(import.meta.dirname, "..", "claude", "hooks", "main-checkout-guard.mts"), "utf8"));
  assert.deepEqual([hook.event, hook.matcher, /codex-shell-checks\.mts"/.test(hook.command)],
    ["PreToolUse", "Bash|shell_command|exec_command|functions\\.exec", true]);
  const [main, linked] = [path.join(options.workspace, "repo"), path.join(options.workspace, "repo-wt")];
  fs.mkdirSync(main, { recursive: true });
  for (const args of [["init", "-q", "-b", "main"], ["commit", "-q", "--allow-empty", "-m", "init"], ["branch", "feat"],
    ["update-ref", "refs/remotes/origin/main", "HEAD"], ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
    ["worktree", "add", "-q", linked, "-b", "wt-branch"]]) {
    const result = spawnSync("git", ["-c", `core.hooksPath=${path.join(options.workspace, "no-hooks")}`,
      "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.com", ...args], { cwd: main, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  }
  const env = { KHEREP_WORKSPACE: options.workspace, KHEREP_MAIN_CHECKOUT: "" };
  const payload = (command: string, cwd = main) => ({ tool_name: "shell_command", tool_input: { command }, cwd });
  const denied = runWired(hook, payload("git switch feat"), env);
  assert.deepEqual([denied.status, denied.decision], [0, "deny"], denied.stderr);
  assert.match(String(denied.reason), /^main-checkout-guard blocked/);
  for (const [command, cwd] of [["git switch main", main], ["git switch feat", linked], ["git checkout -- a.txt", main]]) {
    const allowed = runWired(hook, payload(command!, cwd), env);
    assert.deepEqual([allowed.status, allowed.decision], [0, null], `${command} in ${cwd}: ${allowed.stderr}`);
  }
  assert.equal(hook.commandWindows, `& ${hook.command}`);
  if (!PWSH) return;
  const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", hook.commandWindows!], { encoding: "utf8", windowsHide: true,
    env: { ...process.env, ...env }, input: JSON.stringify({ hook_event_name: hook.event, ...payload("git switch feat") }) });
  assert.equal(decisionOf(pwsh.stdout)?.permissionDecision, "deny", `pwsh exit ${pwsh.status}; stderr: ${pwsh.stderr}`);
});
