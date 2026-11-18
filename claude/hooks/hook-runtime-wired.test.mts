// Issue #507, part 2, end to end through the rendered wiring (R6, R7, R8). A
// temporary Claude home holds copies of this checkout's hooks and hook runtime;
// claude/settings.user.json is rendered for it and its commands run through a
// shell as Claude Code runs them. This checkout is the restore source, read only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { initialize, openDatabase } from "../kherep/hook-runtime/coordinator-db.mts";
import { copyTreeDeclared } from "./copy-declare-fixture.mts";
import { copyRuntime } from "./hook-runtime-fixture.mts";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hook-runtime-wired-")));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
let seq = 0;

interface Home { claude: string; settings: { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> } }

// `edited`: hooks/ files the case alters afterwards, left undeclared (issue #965).
function home(edited: string[] = []): Home {
  const claude = path.join(TMP, `case-${++seq}`, ".claude");
  copyTreeDeclared(path.join(REPO, "claude", "hooks"), path.join(claude, "hooks"), edited);
  copyRuntime(path.join(claude, "kherep", "hook-runtime"));
  const text = fs.readFileSync(path.join(REPO, "claude", "settings.user.json"), "utf8").replaceAll("__KHEREP_CLAUDE_HOME__", claude.replace(/\\/g, "/"));
  fs.writeFileSync(path.join(claude, "settings.user.json"), text);
  const recorded = spawnSync(process.execPath, [path.join(REPO, "bootstrap", "record-install-source.mts"), claude, REPO], { encoding: "utf8" });
  assert.equal(recorded.status, 0, recorded.stderr);
  return { claude, settings: JSON.parse(text) };
}

const commandOf = (h: Home, event: string, matcher: string, file: string): string => {
  const command = h.settings.hooks[event]!.filter((group) => (group.matcher ?? "") === matcher)
    .flatMap((group) => group.hooks.map((hook) => hook.command)).find((candidate) => candidate.includes(`/hooks/${file}`));
  assert.ok(command, `${event} ${matcher} ${file} is wired`);
  return command;
};

interface Out { status: number | null; stdout: string; stderr: string; output?: Record<string, string> }
function runCommand(h: Home, command: string, payload: Record<string, unknown>, env: NodeJS.ProcessEnv = { CLAUDE_HOME: h.claude }): Out {
  const result = spawnSync(command, { shell: true, encoding: "utf8", input: JSON.stringify(payload), windowsHide: true, timeout: 40_000,
    env: { ...process.env, CLAUDE_HOME: undefined, ...env, KHEREP_WORKSPACE: path.join(TMP, "no-workspace"), KHEREP_WORK_ITEM_REQUIRED: "" } });
  let output: Record<string, string> | undefined;
  try { output = JSON.parse(result.stdout).hookSpecificOutput; } catch { /* no JSON */ }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output };
}
const bash = (command: string) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: TMP });
const heartbeat = (h: Home): string => path.join(h.claude, ".cache", "hook-integrity", "heartbeat.json");

for (const [label, breakIt] of [
  ["0 bytes", (file: string) => fs.writeFileSync(file, "")],
  ["missing", (file: string) => fs.rmSync(file)],
  ["syntax-broken", (file: string) => fs.writeFileSync(file, "export const x = ;\n")],
] as const) {
  test(`R6: a ${label} guard-dispatch.mts denies through the rendered command, is restored, and the next call runs`, () => {
    const h = home(["guard-dispatch.mts"]);
    const dispatcher = path.join(h.claude, "hooks", "guard-dispatch.mts");
    const original = fs.readFileSync(dispatcher);
    breakIt(dispatcher);
    const command = commandOf(h, "PreToolUse", "Bash", "commit-guard.mts");
    const first = runCommand(h, command, bash("git status"));
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.output?.permissionDecision, "deny", first.stdout);
    assert.match(String(first.output?.permissionDecisionReason), /guard-dispatch\.mts cannot run/);
    assert.match(String(first.output?.additionalContext), /hook integrity re-check \(hook entry\)[\s\S]*guard-dispatch\.mts: .*RESTORED/);
    assert.deepEqual(fs.readFileSync(dispatcher), original);
    const second = runCommand(h, command, bash("git status"));
    assert.equal(second.status, 0, second.stderr);
    assert.notEqual(second.output?.permissionDecision, "deny", second.stdout);
  });
}

// Second review of 1dd1ca9 (P3-2): Claude Code sets no CLAUDE_HOME, so the entry's one
// repair must find the home it belongs to by itself, also when it is not ~/.claude.
test("R6: without CLAUDE_HOME, a broken dispatcher of a home other than ~/.claude is still restored", () => {
  const h = home(["guard-dispatch.mts"]);
  const dispatcher = path.join(h.claude, "hooks", "guard-dispatch.mts");
  const original = fs.readFileSync(dispatcher);
  fs.writeFileSync(dispatcher, "");
  const elsewhere = fs.mkdtempSync(path.join(TMP, "other-user-"));
  const run = runCommand(h, commandOf(h, "PreToolUse", "Bash", "commit-guard.mts"), bash("git status"), { HOME: elsewhere, USERPROFILE: elsewhere });
  assert.equal(run.output?.permissionDecision, "deny", run.stdout);
  assert.match(String(run.output?.additionalContext), /hook integrity re-check \(hook entry\)[\s\S]*guard-dispatch\.mts: .*RESTORED/);
  assert.deepEqual(fs.readFileSync(dispatcher), original);
  assert.equal(fs.readdirSync(elsewhere).length, 0, "nothing was written under the other home");
});

test("R7: a stale heartbeat re-checks after the guards, as the admitted writer, and refreshes it", () => {
  const h = home();
  const run = runCommand(h, commandOf(h, "PreToolUse", "Bash", "commit-guard.mts"), bash("git status"));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.output?.permissionDecision, undefined, run.stdout);
  assert.match(String(run.output?.additionalContext), /hook integrity re-check \(no heartbeat, last OK none\):\n {2}- all \d+ files OK \(0 restored\), heartbeat refreshed/);
  assert.equal(JSON.parse(fs.readFileSync(heartbeat(h), "utf8")).trigger, "guard-dispatch");
});

test("R7: a guard's deny survives a writer that cannot be admitted, and says so", async () => {
  const h = home();
  // A reader held here admits the dispatcher and its guards but keeps the writer out.
  const opened = await openDatabase(path.join(h.claude, "hooks"));
  initialize(opened.conn);
  opened.conn.exec("BEGIN");
  opened.conn.prepare("SELECT count(*) FROM pending").get();
  let run: Out;
  try { run = runCommand(h, commandOf(h, "PreToolUse", "", "secret-output-guard.mts"), bash("printenv")); } finally {
    opened.conn.exec("ROLLBACK");
    opened.conn.close();
  }
  assert.equal(run.output?.permissionDecision, "deny", run.stdout);
  assert.match(String(run.output?.permissionDecisionReason), /secret-output-guard/);
  // The holder is a plain reader here: the notice must not guess that it is another integrity run.
  assert.match(String(run.output?.additionalContext), /re-check not admitted \(busy\): the hooks directory is in use, holder UNKNOWN; the next matching call re-checks/);
  assert.doesNotMatch(String(run.output?.additionalContext), /integrity run holds|already running/);
  assert.match(run.stderr, /re-check not admitted \(busy\)/);
});

test("R8: the SessionStart writer runs through its rendered command and publishes a heartbeat", () => {
  const h = home();
  const run = runCommand(h, commandOf(h, "SessionStart", "", "live-hook-integrity.mts"), { hook_event_name: "SessionStart", cwd: TMP });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "", "silent when everything is OK");
  assert.equal(JSON.parse(fs.readFileSync(heartbeat(h), "utf8")).trigger, "session-start");
});

test("R8: a reader hook runs through its rendered command with its own output", () => {
  const h = home();
  const run = runCommand(h, commandOf(h, "Stop", "", "maestro-banner-gate.mts"), { hook_event_name: "Stop", stop_hook_active: true });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /PreToolUse/);
});
