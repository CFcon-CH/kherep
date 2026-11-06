// Issue #507, part 1. The PreToolUse guards move from direct entries into
// arguments of guard-dispatch.mts. mergeHooks replaces an entry only when it
// runs the template's main in the same group (#568), and an old direct guard
// entry does not, so without unwiring an upgraded host would run each guard
// twice: once through the dispatcher, once through its old direct entry.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { renderSettings } from "./render-profile.mts";
import { resolveProfilePath } from "./render-profile-paths.mts";
import type { HookEntry, Settings } from "./render-profile-settings.mts";
import { unwireMovedHooks } from "./retired-hooks.mts";

const repo = path.resolve(import.meta.dirname, "..");
const winHome = "C:/Users/Example/.claude";
const run = (command: string) => ({ type: "command", command });
const at = (name: string) => `"${winHome}/hooks/${name}"`;
const DISPATCH = `node ${at("guard-dispatch.mts")} ${at("commit-guard.mts")} ${at("deploy-guard.mts")}`;

test("a guard the template passes to the dispatcher loses its direct entry", () => {
  const source: Settings = { hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ ...run(DISPATCH), timeout: 30 }] }],
    Stop: [{ matcher: "", hooks: [run(`node ${at("clq-accept-gate.mts")}`)] }],
  } };
  const existing: Settings = { hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [run(`node ${at("commit-guard.mts")}`), run(`node ${at("deploy-guard.js")}`)] },
      { matcher: "Write", hooks: [run(`node "C:\\Users\\Example\\.claude\\hooks\\commit-guard.mts"`), run(`node ${at("own.mts")}`)] },
      { matcher: "Edit", hooks: [run("node ~/.claude/hooks/deploy-guard.mts"), { ...run(DISPATCH), timeout: 30 }] },
    ],
    Stop: [{ matcher: "", hooks: [run(`node ${at("clq-accept-gate.mts")}`)] }],
  } };
  const { settings, removed } = unwireMovedHooks(existing, source, winHome);
  assert.deepEqual(removed.map((item) => `${item.event} [${item.managedAt.join(",")}] ${item.command}`), [
    `PreToolUse [PreToolUse via hooks/guard-dispatch.mts] node ${at("commit-guard.mts")}`,
    `PreToolUse [PreToolUse via hooks/guard-dispatch.mts] node ${at("deploy-guard.js")}`,
    'PreToolUse [PreToolUse via hooks/guard-dispatch.mts] node "C:\\Users\\Example\\.claude\\hooks\\commit-guard.mts"',
  ]);
  assert.deepEqual(settings.hooks, {
    PreToolUse: [
      { matcher: "Write", hooks: [run(`node ${at("own.mts")}`)] },
      { matcher: "Edit", hooks: [run("node ~/.claude/hooks/deploy-guard.mts"), { ...run(DISPATCH), timeout: 30 }] },
    ],
    Stop: [{ matcher: "", hooks: [run(`node ${at("clq-accept-gate.mts")}`)] }],
  }, "the dispatcher itself, an unmanaged hook and a hand-written ~ form stay");
  assert.equal(unwireMovedHooks(settings, source, winHome).settings, settings);
});

test("a script that is both wired directly and passed as an argument keeps its direct event", () => {
  const source: Settings = { hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [run(DISPATCH)] }],
    Stop: [{ matcher: "", hooks: [run(`node ${at("commit-guard.mts")}`)] }],
  } };
  const existing: Settings = { hooks: { Stop: [{ matcher: "", hooks: [run(`node ${at("commit-guard.mts")}`)] }] } };
  assert.equal(unwireMovedHooks(existing, source, winHome).removed.length, 0);
});

// Part 2. Behind kherep/hook-runtime/entry.mts a command counts by the main it
// starts: a raw command for a wrapped main goes, a wrapped one stays only at an
// event where the template runs it (review of #254).
test("a command through the runtime entry counts by its main", () => {
  const entry = (mode: string, rest: string) => `node "${winHome}/kherep/hook-runtime/entry.mts" ${mode} ${rest}`;
  const source: Settings = { hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [run(entry("pretool", DISPATCH.slice(5)))] }],
    Stop: [{ matcher: "", hooks: [run(entry("reader", at("clq-accept-gate.mts")))] }],
  } };
  const existing: Settings = { hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [run(entry("pretool", DISPATCH.slice(5))), run(`node ${at("commit-guard.mts")}`),
      run(entry("reader", at("clq-accept-gate.mts")))] }],
    Stop: [{ matcher: "", hooks: [run(`node ${at("clq-accept-gate.mts")}`), run(entry("reader", at("clq-accept-gate.mts"))),
      run('node "C:\\Users\\Example\\.claude\\hooks\\clq-accept-gate.mts"')] }],
  } };
  const { removed } = unwireMovedHooks(existing, source, winHome);
  assert.deepEqual(removed.map((item) => `${item.event} [${item.managedAt.join(",")}] ${item.command}`), [
    `PreToolUse [PreToolUse via hooks/guard-dispatch.mts] node ${at("commit-guard.mts")}`,
    `PreToolUse [Stop] ${entry("reader", at("clq-accept-gate.mts"))}`,
    `Stop [Stop] node ${at("clq-accept-gate.mts")}`,
    'Stop [Stop] node "C:\\Users\\Example\\.claude\\hooks\\clq-accept-gate.mts"',
  ]);
});

// The template as it stood before issue #507: one direct entry per guard.
function directTemplate(): Settings {
  const template = JSON.parse(fs.readFileSync(path.join(repo, "claude", "settings.user.json"), "utf8")) as Settings;
  template.hooks!.PreToolUse = template.hooks!.PreToolUse!.map((group: HookEntry) => ({
    ...group,
    // node, the runtime entry and its mode, the dispatcher: the guards follow.
    hooks: (group.hooks ?? []).flatMap((hook) => String(hook.command).split(/ (?=")/).slice(3)
      .map((guard) => run(`node ${guard}`))),
  }));
  return template;
}

test("an upgrade from direct guard entries leaves each guard in one dispatcher entry", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue507-render-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, ".claude");
  const savedHome = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; });
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(line); });
  const oldTemplate = path.join(dir, "settings.user.old.json");
  fs.writeFileSync(oldTemplate, JSON.stringify(directTemplate()));
  const project = path.join(repo, "claude", "settings.project.json");
  const render = (source: string, existing: string, output: string) => renderSettings(["win", "C:/Example/Kherep",
    "C:/Example/credentials", home, source, project, existing, "-", output, path.join(dir, "project.json")]);
  render(oldTemplate, "-", path.join(dir, "installed.json"));
  const installed = fs.readFileSync(path.join(dir, "installed.json"), "utf8");
  assert.equal(installed.match(/hooks\/commit-guard\.mts/g)?.length, 1);
  assert.doesNotMatch(installed, /guard-dispatch/);

  lines.length = 0;
  render(path.join(repo, "claude", "settings.user.json"), path.join(dir, "installed.json"), path.join(dir, "upgraded.json"));
  const upgraded = JSON.parse(fs.readFileSync(path.join(dir, "upgraded.json"), "utf8")) as Settings;
  const commands = upgraded.hooks!.PreToolUse!.flatMap((group) => (group.hooks ?? []).map((hook) => String(hook.command)));
  const guards = ["privacy-boundary-guard", "secret-output-guard", "playwright-file-guard", "dispatch-contract-guard",
    "commit-guard", "deploy-guard", "main-checkout-guard", "module-label-guard", "atlassian-destructive-guard", "obs-handback-gate"];
  for (const guard of guards) {
    const wiring = commands.filter((command) => command.includes(`/hooks/${guard}.mts`));
    assert.equal(wiring.length, 1, `${guard} is wired once: ${JSON.stringify(wiring)}`);
    assert.match(wiring[0]!, /^node "[^"]+\/kherep\/hook-runtime\/entry\.mts" pretool "[^"]+\/hooks\/guard-dispatch\.mts" /,
      `${guard} runs through the runtime and the dispatcher`);
  }
  assert.equal(commands.length, 6, `one dispatcher entry per group: ${JSON.stringify(commands)}`);
  const unwired = lines.filter((line) => line.startsWith("hooks: unwire PreToolUse "));
  assert.equal(unwired.length, guards.length, lines.join("\n"));
  for (const line of unwired) assert.match(line, /\(managed under PreToolUse via hooks\/guard-dispatch\.mts\)$/);
});

// Issue #507, part 2 (R8). Every managed command now runs through the hook runtime
// entry. An upgrade from the raw part-1 wiring removes each raw managed command, so
// none runs next to its wrapped form; a hand-written ~ form and the operator's own
// hooks stay (an unwrapped one makes repair unavailable, it is not rewritten).
test("an upgrade from raw managed commands leaves every managed hook once, wrapped", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue507-wrap-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, ".claude");
  const savedHome = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; });
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(line); });
  const template = fs.readFileSync(path.join(repo, "claude", "settings.user.json"), "utf8");
  const raw = JSON.parse(template.replace(/node \\"__KHEREP_CLAUDE_HOME__\/kherep\/hook-runtime\/entry\.mts\\" [a-z]+ /g, "node "));
  raw.hooks.Stop.push({ matcher: "", hooks: [run("node ~/.claude/hooks/custom-reader.mts"), run("echo operator-hook")] });
  fs.writeFileSync(path.join(dir, "raw.json"), JSON.stringify(raw));
  const project = path.join(repo, "claude", "settings.project.json");
  // The host's own profile, so a Windows host renders and matches its drive form.
  const profile = process.platform === "win32" ? "win" : "mac";
  const base = process.platform === "win32" ? "C:/Example" : "/Example";
  const render = (source: string, existing: string, output: string) => renderSettings([profile, `${base}/Kherep`,
    `${base}/credentials`, home, source, project, existing, "-", output, path.join(dir, "project.json")]);
  render(path.join(dir, "raw.json"), "-", path.join(dir, "installed.json"));
  lines.length = 0;
  render(path.join(repo, "claude", "settings.user.json"), path.join(dir, "installed.json"), path.join(dir, "upgraded.json"));
  const upgraded = JSON.parse(fs.readFileSync(path.join(dir, "upgraded.json"), "utf8")) as Settings;
  const commands = Object.values(upgraded.hooks ?? {}).flatMap((groups) => groups.flatMap((group) => (group.hooks ?? []).map((hook) => String(hook.command))));
  const managed = commands.filter((command) => command.includes(`${resolveProfilePath(profile, home)}/hooks/`));
  const managedTemplate = (template.match(/__KHEREP_CLAUDE_HOME__\/kherep\/hook-runtime\/entry\.mts/g) ?? []).length;
  assert.equal(managed.length, managedTemplate, JSON.stringify(managed, null, 1));
  for (const command of managed) assert.match(command, /^node "[^"]+\/kherep\/hook-runtime\/entry\.mts" (pretool|reader|writer) "/);
  assert.equal(lines.filter((line) => line.startsWith("hooks: unwire ")).length, managedTemplate, lines.join("\n"));
  assert.ok(commands.includes("node ~/.claude/hooks/custom-reader.mts") && commands.includes("echo operator-hook"));
});
