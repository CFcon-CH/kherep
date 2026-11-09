// Issue #568. The recogniser of a managed entry-form hook command, fed the
// command as normalizeHookCommand() leaves it. It loads nothing but its own
// module, so these cases pin the shape without the merge around it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { controlPlaneHookKey, managedHookKey } from "./managed-hook-key.mts";

const entry = (home: string, mode: string, main: string, ext = "mts") =>
  `node "${home}/kherep/hook-runtime/entry.${ext}" ${mode} "${home}/hooks/${main}"`;

test("a quoted entry command yields <home>/hooks/<main> without the extension, and the main as written", () => {
  assert.deepEqual(managedHookKey(entry("~/.claude", "reader", "obs-result-check.mts"), "darwin"),
    { key: "~/.claude/hooks/obs-result-check", main: "obs-result-check.mts" });
});

test("mode and later arguments are not part of the key", () => {
  const keys = [
    entry("~/.claude", "reader", "obs-result-check.mts"),
    entry("~/.claude", "writer", "obs-result-check.mts"),
    entry("~/.claude", "pretool", "obs-result-check.mts"),
    `${entry("~/.claude", "pretool", "obs-result-check.mts")} "~/.claude/hooks/commit-guard.mts"`,
  ].map((command) => managedHookKey(command, "darwin")?.key);
  assert.deepEqual(new Set(keys), new Set(["~/.claude/hooks/obs-result-check"]));
});

test("every entry extension and a .js main from before the rename are one key", () => {
  for (const ext of ["js", "mjs", "cjs", "mts"]) {
    assert.equal(managedHookKey(entry("~/.claude", "reader", "x.js", ext), "darwin")?.key, "~/.claude/hooks/x", ext);
  }
  assert.equal(managedHookKey(entry("~/.claude", "reader", "x.js"), "darwin")?.main, "x.js");
});

test("the bare form is recognised with the same home on both sides", () => {
  assert.equal(managedHookKey("node ~/.claude/kherep/hook-runtime/entry.js reader ~/.claude/hooks/x.js", "darwin")?.key,
    "~/.claude/hooks/x");
  assert.equal(managedHookKey("node ~/.claude/kherep/hook-runtime/entry.js reader /b/.claude/hooks/x.js", "darwin"), undefined);
});

test("a quoted Claude home with a space outside the user home is recognised", () => {
  assert.equal(managedHookKey(entry("/Volumes/My Disk/.claude", "reader", "x.mts"), "darwin")?.key,
    "/Volumes/My Disk/.claude/hooks/x");
});

test("a main under another home, or one that only borrows the empty home, is not managed", () => {
  assert.equal(managedHookKey('node "/a/.claude/kherep/hook-runtime/entry.mts" reader "/b/.claude/hooks/x.mts"', "darwin"), undefined);
  assert.equal(managedHookKey('node "/h/.claude/kherep/hook-runtime/entry.mts" reader "/hooks/x.mts"', "darwin"), undefined);
});

test("forms the template never renders stay unrecognised (documented limits)", () => {
  const home = "~/.claude";
  for (const command of [
    `node "${home}/kherep/hook-runtime/entry.mts" reader ${home}/hooks/x.mts`,
    `node ${home}/kherep/hook-runtime/entry.mts reader "${home}/hooks/x.mts"`,
    `node '${home}/kherep/hook-runtime/entry.mts' reader '${home}/hooks/x.mts'`,
    `& ${entry(home, "reader", "x.mts")}`,
    `node --no-warnings "${home}/kherep/hook-runtime/entry.mts" reader "${home}/hooks/x.mts"`,
    `node "${home}/kherep/hook-runtime/entry.mts" other "${home}/hooks/x.mts"`,
    `${entry(home, "reader", "x.mts")};`,
    'node "/repo/modules/control-plane/node/wake-hook.mts" --timeout 86400',
    "node ~/.claude/hooks/x.js",
    "node $(npm root -g)/claude-baton/bin/claude-baton.js auto-checkpoint",
  ]) assert.equal(managedHookKey(command, "darwin"), undefined, command);
});

test("a shell control operator after the main makes the command operator-shaped, never managed", () => {
  const managed = entry("~/.claude", "pretool", "guard-dispatch.mts");
  for (const tail of [" ; other", " && other", " || other", " | other", " & other", "\nother", "\r\nother",
    ' "~/.claude/hooks/g.mts" ; other', ' "~/.claude/hooks/g.mts"&other']) {
    assert.equal(managedHookKey(`${managed}${tail}`, "darwin"), undefined, JSON.stringify(tail));
  }
});

test("operator characters inside double quotes are part of a path, not an operator", () => {
  const home = "/Volumes/R&D;x|y/.claude";
  const dispatcher = `${entry(home, "pretool", "guard-dispatch.mts")} "${home}/hooks/commit-guard.mts" "${home}/hooks/a;b&c|d.mts"`;
  assert.equal(managedHookKey(dispatcher, "darwin")?.key, `${home}/hooks/guard-dispatch`);
  assert.equal(managedHookKey(`${dispatcher} ; other`, "darwin"), undefined);
});

test("command substitution after the main keeps the command: $(", () => {
  assert.equal(managedHookKey(`${entry("~/.claude", "reader", "x.mts")} $(other)`, "darwin"), undefined);
});

test("command substitution after the main keeps the command: backtick", () => {
  assert.equal(managedHookKey(`${entry("~/.claude", "reader", "x.mts")} \`other\``, "darwin"), undefined);
});

test("a redirection after the main keeps the command: >", () => {
  assert.equal(managedHookKey(`${entry("~/.claude", "reader", "x.mts")} > /tmp/out`, "darwin"), undefined);
});

test("a redirection after the main keeps the command: <", () => {
  assert.equal(managedHookKey(`${entry("~/.claude", "reader", "x.mts")} < /tmp/in`, "darwin"), undefined);
});

test("a line break between node, entry, mode and main is not the entry shape", () => {
  const quoted = ['node\n"~/.claude/kherep/hook-runtime/entry.mts" reader "~/.claude/hooks/x.mts"',
    'node "~/.claude/kherep/hook-runtime/entry.mts"\nreader "~/.claude/hooks/x.mts"',
    'node "~/.claude/kherep/hook-runtime/entry.mts" reader\n"~/.claude/hooks/x.mts"',
    "node ~/.claude/kherep/hook-runtime/entry.mts\treader\r\n~/.claude/hooks/x.mts"];
  for (const command of quoted) assert.equal(managedHookKey(command, "darwin"), undefined, JSON.stringify(command));
  assert.ok(managedHookKey('node\t"~/.claude/kherep/hook-runtime/entry.mts"\treader \t"~/.claude/hooks/x.mts"', "darwin"));
});

test("a main path with . or .. segments, and the Git Bash drive form, keep a key of their own", () => {
  assert.notEqual(managedHookKey(entry("~/.claude", "reader", "sub/../x.mts"), "darwin")?.key, "~/.claude/hooks/x");
  assert.notEqual(managedHookKey(entry("/c/Users/x/.claude", "reader", "x.mts"), "win32")?.key,
    managedHookKey(entry("C:/Users/x/.claude", "reader", "x.mts"), "win32")?.key);
});

test("on win32 the key is lower-cased before the extension is folded", () => {
  const rendered = managedHookKey(entry("C:/Users/x/.claude", "reader", "obs-result-check.mts"), "win32");
  assert.deepEqual(rendered, { key: "c:/users/x/.claude/hooks/obs-result-check", main: "obs-result-check.mts" });
  assert.equal(managedHookKey(entry("c:/USERS/x/.claude", "reader", "OBS-RESULT-CHECK.MTS"), "win32")?.key, rendered?.key);
});

test("on a case-sensitive host another case is another file", () => {
  assert.equal(managedHookKey(entry("/h/.claude", "reader", "X.MTS"), "darwin")?.key, "/h/.claude/hooks/X.MTS");
});

// Issue #590. The key of a control-plane hook is the script from
// modules/control-plane/node/ on: one key for every root, spelling and extension.
const CP = "modules/control-plane/node";

test("a control-plane script has one key whatever root it runs from, with or without quotes and arguments", () => {
  const keys = [
    `node "/Users/x/Workspaces/kherep/${CP}/deliver-hook.mts"`,
    `node "/Users/x/Library/Application Support/kherep/control-plane/service/source-pins/0123abcd/${CP}/deliver-hook.mts"`,
    `node /opt/kherep/${CP}/deliver-hook.mts`,
    `node "/Users/x/Workspaces/kherep/.claude/worktrees/agent-b/${CP}/deliver-hook.js" --timeout 86400`,
  ].map((command) => controlPlaneHookKey(command, "darwin"));
  assert.deepEqual(new Set(keys), new Set([`${CP}/deliver-hook`]));
  assert.equal(controlPlaneHookKey(`node "/r/${CP}/wake-hook.mts" --timeout 86400`, "darwin"), `${CP}/wake-hook`);
  assert.equal(controlPlaneHookKey(`node "/r/${CP}/attribution-hook.mts"`, "darwin"), `${CP}/attribution-hook`);
});

test("a Windows path with backslashes, another drive letter case or the Git Bash form is the same script", () => {
  const keys = [
    `node "D:/Tools/Kherep/${CP}/deliver-hook.mts"`,
    String.raw`node "d:\Work\kherep\modules\control-plane\node\deliver-hook.mts"`,
    `node "/d/Work/kherep/${CP}/Deliver-Hook.mts"`,
  ].map((command) => controlPlaneHookKey(command, "win32"));
  assert.deepEqual(new Set(keys), new Set([`${CP}/deliver-hook`]));
  assert.equal(controlPlaneHookKey(`node "/r/${CP}/Deliver-Hook.mts"`, "darwin"), `${CP}/Deliver-Hook`);
});

test("the last modules/control-plane/node/ segment counts, and other scripts are not control-plane hooks", () => {
  assert.equal(controlPlaneHookKey(`node "/r/${CP}/x/${CP}/deliver-hook.mts"`, "darwin"), `${CP}/deliver-hook`);
  for (const command of [
    `node "~/.claude/hooks/deliver-hook.mts"`, `node "/r/modules/control-plane/deliver-hook.mts"`, `node "/r/${CP}/"`,
    `echo /r/${CP}/deliver-hook.mts`, `node --no-warnings "/r/${CP}/deliver-hook.mts"`, `& node "/r/${CP}/deliver-hook.mts"`,
    `node "~/.claude/kherep/hook-runtime/entry.mts" reader "~/.claude/hooks/o.mts"`,
  ]) assert.equal(controlPlaneHookKey(command, "darwin"), undefined, command);
});

// Review of #590, P3-1: on win32 the directory segment is found in any case.
test("on win32 a hand-written segment in another case is the same control-plane script", () => {
  const command = String.raw`node "C:\Users\U\Kherep\Modules\Control-Plane\Node\Deliver-Hook.mts"`;
  assert.equal(controlPlaneHookKey(command, "win32"), `${CP}/deliver-hook`);
  assert.equal(controlPlaneHookKey(command, "darwin"), undefined);
});

// Review of #590, P3-2: as for managedHookKey(), a shell control operator,
// substitution or redirection outside double quotes makes the command
// operator-shaped: it is not keyed, so the merge keeps it.
test("a control-plane command that runs more than the script is not keyed; a quoted & in the root is", () => {
  for (const command of [
    `node "/r/${CP}/deliver-hook.mts" && echo done`, `node /r/${CP}/deliver-hook.mts;echo done`,
    `node "/r/${CP}/deliver-hook.mts" | tee /tmp/x`, `node "/r/${CP}/deliver-hook.mts" > /tmp/x`,
    `node "/r/${CP}/wake-hook.mts" --timeout $(cat /tmp/t)`, `node "/r/${CP}/deliver-hook.mts" \`id\``,
  ]) assert.equal(controlPlaneHookKey(command, "darwin"), undefined, command);
  assert.equal(controlPlaneHookKey(`node "/Users/x/R&D/kherep/${CP}/deliver-hook.mts" --timeout 1`, "darwin"), `${CP}/deliver-hook`);
});

// Issue #592. The stable form names the entry under the Claude home and the
// script by its first argument; it has the key of the path form of that script,
// so the merge replaces path-form entries and the duplicate scan counts both.
const STABLE = "/h/.claude/kherep/control-plane/claude-control-plane-hook.mts";

test("the stable entry form has the key of the script its name selects", () => {
  assert.equal(controlPlaneHookKey(`node "${STABLE}" deliver`, "darwin"), `${CP}/deliver-hook`);
  assert.equal(controlPlaneHookKey(`node "${STABLE}" wake --timeout 86400`, "darwin"), `${CP}/wake-hook`);
  assert.equal(controlPlaneHookKey(`node "${STABLE}" attribution`, "darwin"), `${CP}/attribution-hook`);
  assert.equal(controlPlaneHookKey(`node ${STABLE} deliver`, "darwin"), `${CP}/deliver-hook`);
});

test("on win32 a stable entry with backslashes and another case is keyed", () => {
  const command = String.raw`node "C:\Users\U\.Claude\Kherep\Control-Plane\Claude-Control-Plane-Hook.mts" wake --timeout 86400`;
  assert.equal(controlPlaneHookKey(command, "win32"), `${CP}/wake-hook`);
});

// Review of #592, P3-1: the suffix decides, not the home (root neutrality as #595).
test("a stable entry under another home is keyed", () => {
  assert.equal(controlPlaneHookKey("node /other/home/kherep/control-plane/claude-control-plane-hook.mts deliver", "darwin"),
    `${CP}/deliver-hook`);
});

test("a stable entry without an admitted name, or in a shape the template never renders, is not keyed", () => {
  for (const command of [
    `node "${STABLE}" other`, `node "${STABLE}"`, `node "${STABLE}" deliver && echo done`,
    `node --disable-warning=ExperimentalWarning "${STABLE}" deliver`,
    // Documented limit (P3-1): the shell would unquote the name, the key does not.
    `node "${STABLE}" "deliver"`,
  ]) assert.equal(controlPlaneHookKey(command, "darwin"), undefined, command);
});
