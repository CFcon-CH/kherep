// Issue #590. The duplicate check drift-check.sh runs on both settings files: a
// control-plane script wired more than once on one event, counted by the key
// the merge uses, so two roots of the same script are one script. Red on the
// state a node measured (every control-plane entry once per root), clean on an
// installed file, and silent about operator hooks and files that do not exist.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { duplicateControlPlaneHooks } from "./duplicate-hooks.mts";

const CHECKOUT = "/Users/x/Workspaces/kherep";
const PIN = "/Users/x/Library/Application Support/kherep/control-plane/service/source-pins/0123abcd";
const cp = (root: string, script: string, args = "") => ({ type: "command", command: `node "${root}/modules/control-plane/node/${script}"${args}` });
const own = { type: "command", command: 'node "/opt/own/stop-note.mts"' };

// The measured state: deliver, wake and attribution once per root over the five events.
const DUPLICATED = { hooks: {
  UserPromptSubmit: [{ matcher: "", hooks: [cp(CHECKOUT, "deliver-hook.mts"), cp(CHECKOUT, "wake-hook.mts", " --timeout 86400"),
    cp(PIN, "deliver-hook.mts"), cp(PIN, "wake-hook.mts", " --timeout 86400")] }],
  Stop: [{ matcher: "", hooks: [own, cp(CHECKOUT, "deliver-hook.mts"), cp(CHECKOUT, "wake-hook.mts", " --timeout 86400"),
    cp(PIN, "deliver-hook.mts"), cp(PIN, "wake-hook.mts", " --timeout 86400")] }],
  StopFailure: [{ matcher: "", hooks: [cp(CHECKOUT, "deliver-hook.mts"), cp(PIN, "deliver-hook.mts")] }],
  PostToolUse: [{ matcher: "", hooks: [own, cp(CHECKOUT, "deliver-hook.mts"), cp(PIN, "deliver-hook.mts")] },
    { matcher: "Bash|PowerShell", hooks: [cp(CHECKOUT, "attribution-hook.mts"), cp(PIN, "attribution-hook.mts")] }],
  SessionStart: [{ matcher: "", hooks: [own, cp(CHECKOUT, "wake-hook.mts", " --timeout 86400"), cp(PIN, "wake-hook.mts", " --timeout 86400")] }],
} };

test("every control-plane script once per root is reported per event and script, operator hooks are not", () => {
  const key = (script: string) => `modules/control-plane/node/${script}`;
  assert.deepEqual(duplicateControlPlaneHooks(DUPLICATED, "darwin"), [
    { event: "UserPromptSubmit", script: key("deliver-hook"), count: 2 }, { event: "UserPromptSubmit", script: key("wake-hook"), count: 2 },
    { event: "Stop", script: key("deliver-hook"), count: 2 }, { event: "Stop", script: key("wake-hook"), count: 2 },
    { event: "StopFailure", script: key("deliver-hook"), count: 2 },
    { event: "PostToolUse", script: key("deliver-hook"), count: 2 }, { event: "PostToolUse", script: key("attribution-hook"), count: 2 },
    { event: "SessionStart", script: key("wake-hook"), count: 2 },
  ]);
});

test("one entry per script and event is clean, as are an operator hook twice, no hooks and a malformed hooks value", () => {
  const installed = { hooks: {
    Stop: [{ matcher: "", hooks: [own, cp(PIN, "deliver-hook.mts"), cp(PIN, "wake-hook.mts", " --timeout 86400"), own] }],
    PostToolUse: [{ matcher: "", hooks: [cp(PIN, "deliver-hook.mts")] }, { matcher: "Bash|PowerShell", hooks: [cp(PIN, "attribution-hook.mts")] }],
    UserPromptSubmit: [{ matcher: "", hooks: [cp(PIN, "deliver-hook.mts")] }, { matcher: "x", hooks: [cp(PIN, "wake-hook.mts")] }],
  } };
  assert.deepEqual(duplicateControlPlaneHooks(installed, "darwin"), []);
  assert.deepEqual(duplicateControlPlaneHooks({}, "darwin"), []);
  assert.deepEqual(duplicateControlPlaneHooks({ hooks: { Stop: "x", Other: [null, { hooks: "y" }, { hooks: [null, {}] }] } }, "darwin"), []);
});

test("the same script in two groups of one event, or spelled with backslashes, is a duplicate", () => {
  const two = { hooks: { Stop: [{ matcher: "", hooks: [cp(PIN, "deliver-hook.mts")] }, { matcher: "", hooks: [cp(PIN, "deliver-hook.mts")] }],
    UserPromptSubmit: [{ hooks: [cp("D:/Tools/Kherep", "deliver-hook.mts"), { type: "command", command: String.raw`node "d:\Work\kherep\modules\control-plane\node\deliver-hook.mts"` }] }] } };
  assert.deepEqual(duplicateControlPlaneHooks(two, "win32").map((item) => `${item.event} x${item.count}`), ["Stop x2", "UserPromptSubmit x2"]);
});

// Review of #590, P3-3: only what an install replaces is a finding, so the
// advice to install again holds. The installer template wires deliver-hook on
// UserPromptSubmit, Stop, StopFailure and PostToolUse, wake-hook on
// SessionStart, UserPromptSubmit and Stop, attribution-hook on PostToolUse.
// Issue #592. The stable entry form has the key of the script its name selects:
// the path form and the stable form of one script on one event are one script
// twice; the stable set alone is clean.
const STABLE = 'node "/Users/x/.claude/kherep/control-plane/claude-control-plane-hook.mts"';
const stable = (name: string, args = "") => ({ type: "command", command: `${STABLE} ${name}${args}` });

test("the path form and the stable form of one script on one event are a duplicate; the stable set alone is clean", () => {
  const mixed = { hooks: { Stop: [{ matcher: "", hooks: [cp(PIN, "deliver-hook.mts"), stable("deliver"), stable("wake", " --timeout 86400")] }] } };
  assert.deepEqual(duplicateControlPlaneHooks(mixed, "darwin").map((item) => `${item.event} ${item.script} x${item.count}`),
    ["Stop modules/control-plane/node/deliver-hook x2"]);
  const installed = { hooks: {
    SessionStart: [{ matcher: "", hooks: [stable("wake", " --timeout 86400")] }],
    UserPromptSubmit: [{ matcher: "", hooks: [stable("deliver"), stable("wake", " --timeout 86400")] }],
    Stop: [{ matcher: "", hooks: [own, stable("deliver"), stable("wake", " --timeout 86400")] }],
    StopFailure: [{ matcher: "", hooks: [stable("deliver")] }],
    PostToolUse: [{ matcher: "", hooks: [stable("deliver")] }, { matcher: "Bash|PowerShell", hooks: [stable("attribution")] }],
  } };
  assert.deepEqual(duplicateControlPlaneHooks(installed, "darwin"), []);
});

test("a control-plane script twice on an event the template does not wire it for, or an unmanaged script, is no finding", () => {
  const twice = (script: string) => [{ matcher: "", hooks: [cp(CHECKOUT, script), cp(PIN, script)] }];
  assert.deepEqual(duplicateControlPlaneHooks({ hooks: {
    PreToolUse: twice("deliver-hook.mts"), StopFailure: twice("wake-hook.mts"), SessionStart: twice("attribution-hook.mts"),
    Stop: twice("own-note.mts"), Notification: twice("deliver-hook.mts"),
  } }, "darwin"), []);
});

test("the command prints one DUPLICATE-HOOK line per finding and exits 3; a clean or absent file exits 0", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-duplicate-hooks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(import.meta.dirname, "duplicate-hooks.mts");
  const run = (file: string) => spawnSync(process.execPath, [script, file], { encoding: "utf8" });
  const file = path.join(root, "settings.json");
  fs.writeFileSync(file, JSON.stringify(DUPLICATED));
  const red = run(file);
  assert.equal(red.status, 3, red.stderr);
  const lines = red.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 8);
  assert.ok(lines.includes("DUPLICATE-HOOK Stop modules/control-plane/node/deliver-hook x2"), red.stdout);
  assert.ok(lines.includes("DUPLICATE-HOOK SessionStart modules/control-plane/node/wake-hook x2"), red.stdout);
  assert.ok(!red.stdout.includes(PIN) && !red.stdout.includes("/opt/own"), "a root or an operator command was printed");
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [cp(PIN, "deliver-hook.mts")] }] } }));
  const clean = run(file);
  assert.deepEqual([clean.status, clean.stdout], [0, ""]);
  assert.equal(run(path.join(root, "absent.json")).status, 0);
  fs.writeFileSync(file, "{");
  assert.equal(run(file).status, 1);
});
