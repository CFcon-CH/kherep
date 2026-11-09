// Issue #568. mergeHooks replaces an existing entry-form hook that runs the
// same managed main in the same event and matcher group, whatever else
// differs, and reports each replaced entry whose identity differed. The
// template invariants the rule relies on, and its parity with the gate's
// coordinated() shape, are checked here too.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { wiredFiles } from "../claude/hooks/lib/hook-inventory.mts";
import { normalizePathLike } from "../claude/hooks/lib/workspace-scope.mts";
import { managedHookKey } from "./managed-hook-key.mts";
import { substituteTemplatePaths } from "./render-profile-paths.mts";
import { mergeHooks, normalizeHookCommand, type HookCommand, type HookEntry } from "./render-profile-settings.mts";

// A synthetic user home: os.homedir() reads HOME, on Windows USERPROFILE. No live file is read.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "managed-hook-home-"));
const SAVED_HOME = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
after(() => {
  for (const [name, value] of Object.entries(SAVED_HOME)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

const ENTRY = 'node "~/.claude/kherep/hook-runtime/entry.mts"';
const hook = (mode: string, main: string, extra: Record<string, unknown> = {}): HookCommand =>
  ({ type: "command", command: `${ENTRY} ${mode} "~/.claude/hooks/${main}"`, ...extra });

function merge(source: Record<string, HookEntry[]>, existing: Record<string, HookEntry[]>) {
  const replaced: string[] = [];
  const merged = mergeHooks(source, existing, (event, matcher, main) => replaced.push(`${event}|${matcher}|${main}`));
  return { merged, replaced, commands: (event: string) => merged[event]!.map((group) => (group.hooks || []).map((h) => `${h.command}${h.timeout === undefined ? "" : ` t=${h.timeout}`}`)) };
}

test("same main, another timeout: one entry with the template's fields, reported once", () => {
  const r = merge({ SubagentStop: [{ matcher: "claude-obs", hooks: [hook("reader", "o.mts", { timeout: 30 })] }] },
    { SubagentStop: [{ matcher: "claude-obs", hooks: [hook("reader", "o.mts")] }] });
  assert.deepEqual(r.commands("SubagentStop"), [[`${ENTRY} reader "~/.claude/hooks/o.mts" t=30`]]);
  assert.deepEqual(r.replaced, ["SubagentStop|claude-obs|o.mts"]);
});

test("same main, another mode or other arguments: one entry; an identical copy goes silently", () => {
  const r = merge({ PreToolUse: [{ matcher: "Bash", hooks: [hook("pretool", 'd.mts" "~/.claude/hooks/g1.mts')] }] },
    { PreToolUse: [{ matcher: "Bash", hooks: [hook("reader", "d.mts"), hook("pretool", 'd.mts" "~/.claude/hooks/g1.mts'),
      hook("pretool", 'd.mts" "~/.claude/hooks/g0.mts')] }] });
  assert.deepEqual(r.commands("PreToolUse"), [[`${ENTRY} pretool "~/.claude/hooks/d.mts" "~/.claude/hooks/g1.mts"`]]);
  assert.deepEqual(r.replaced, ["PreToolUse|Bash|d.mts", "PreToolUse|Bash|d.mts"]);
});

test("a .js entry and main from before the rename are the managed .mts entry", () => {
  const r = merge({ Stop: [{ matcher: "", hooks: [hook("reader", "o.mts")] }] },
    { Stop: [{ matcher: "", hooks: [{ type: "command", command: 'node "~/.claude/kherep/hook-runtime/entry.js" reader "~/.claude/hooks/o.js"', timeout: 5 }] }] });
  assert.deepEqual(r.commands("Stop"), [[`${ENTRY} reader "~/.claude/hooks/o.mts"`]]);
  assert.deepEqual(r.replaced, ["Stop||o.mts"]);
});

test("another main in the group, the same main at another matcher, and other forms stay", () => {
  const other = { type: "command", command: 'node "/other/.claude/kherep/hook-runtime/entry.mts" reader "/other/.claude/hooks/o.mts"' };
  const r = merge({ SubagentStop: [{ matcher: "claude-obs", hooks: [hook("reader", "o.mts")] }] },
    { SubagentStop: [{ matcher: "claude-obs", hooks: [hook("reader", "mine.mts"), other, { type: "command", command: "claude-baton x" }] },
      { matcher: "my-agent", hooks: [hook("reader", "o.mts", { timeout: 5 })] }] });
  assert.equal(r.merged.SubagentStop!.length, 2);
  assert.equal(r.merged.SubagentStop![0]!.hooks!.length, 4);
  assert.deepEqual(r.commands("SubagentStop")[1], [`${ENTRY} reader "~/.claude/hooks/o.mts" t=5`]);
  assert.deepEqual(r.replaced, []);
});

test("an entry command followed by a shell control operator stays next to the template entry", () => {
  const chained = { type: "command", command: `${ENTRY} reader "~/.claude/hooks/o.mts" ; other` };
  const r = merge({ SubagentStop: [{ matcher: "claude-obs", hooks: [hook("reader", "o.mts")] }] },
    { SubagentStop: [{ matcher: "claude-obs", hooks: [chained] }] });
  assert.deepEqual(r.commands("SubagentStop"), [[`${ENTRY} reader "~/.claude/hooks/o.mts"`, chained.command]]);
  assert.deepEqual(r.replaced, []);
});

test("two existing groups with the template's matcher keep the operator's main in both (map from the template group)", () => {
  const r = merge({ SubagentStop: [{ matcher: "claude-obs", hooks: [hook("reader", "o.mts")] }] },
    { SubagentStop: [{ matcher: "claude-obs", hooks: [hook("reader", "mine.mts", { timeout: 1 })] },
      { matcher: "claude-obs", hooks: [hook("reader", "mine.mts", { timeout: 2 })] }] });
  assert.equal(r.commands("SubagentStop")[0]!.filter((c) => c.includes("mine.mts")).length, 2);
  assert.deepEqual(r.replaced, []);
});

test("a backslash and %USERPROFILE% spelling of the rendered home is the managed entry", () => {
  const home = os.homedir();
  const rendered = `node "${home}/.claude/kherep/hook-runtime/entry.mts" reader "${home}/.claude/hooks/o.mts"`;
  const r = merge({ Stop: [{ matcher: "", hooks: [{ type: "command", command: rendered }] }] },
    { Stop: [{ matcher: "", hooks: [{ type: "command", command: 'node "%USERPROFILE%\\.claude\\kherep\\hook-runtime\\entry.mts" reader "%USERPROFILE%\\.claude\\hooks\\o.mts"', timeout: 4 }] }] });
  assert.deepEqual(r.commands("Stop"), [[rendered]]);
  assert.deepEqual(r.replaced, ["Stop||o.mts"]);
});

test("control-plane scripts stay with the #31 rule; without a callback nothing is reported", () => {
  const wake = (t: number) => ({ type: "command", command: `node "/repo/modules/control-plane/node/wake-hook.mts" --timeout ${t}`, timeout: t });
  assert.equal(managedHookKey(normalizeHookCommand(wake(1).command)), undefined);
  const merged = mergeHooks({ Stop: [{ matcher: "", hooks: [wake(2)] }] }, { Stop: [{ matcher: "", hooks: [wake(1), hook("reader", "o.mts")] }] });
  assert.deepEqual(merged.Stop!.map((g) => (g.hooks || []).map((h) => h.timeout ?? "-")), [[2, "-"]]);
});

// T6. The rule keys on (event, matcher, main) and finds the template group by
// matcher, so the template must hold each key once and each matcher once per
// event, and render no shell control operator; and it must recognise exactly
// what live-hook-integrity calls coordinated.
const SOURCE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "claude", "settings.user.json"), "utf8"));
const HOMES = process.platform === "win32"
  ? ["C:\\Users\\x\\.claude", "D:\\Claude Home\\.claude", "D:\\R&D\\.claude", path.join(os.homedir(), ".claude")]
  : ["/example/.claude", path.join(os.homedir(), ".claude"), "/Volumes/My Disk/.claude", "/Volumes/R&D;x|y/.claude"];
const PROFILE = process.platform === "win32" ? "win" : "mac";

for (const home of HOMES) {
  const rendered = substituteTemplatePaths(SOURCE, PROFILE, "/example/Kherep", "/example/credentials", home) as { hooks: Record<string, HookEntry[]> };
  const label = home === path.join(os.homedir(), ".claude") ? "<HOME>/.claude" : home;

  test(`T6 template invariants hold for ${label}`, () => {
    const keys = new Set<string>();
    let entries = 0;
    for (const [event, groups] of Object.entries(rendered.hooks)) {
      const matchers = groups.map((group) => group.matcher ?? "");
      assert.equal(new Set(matchers).size, matchers.length, `${event}: two groups share a matcher`);
      for (const group of groups) for (const h of group.hooks || []) {
        const found = managedHookKey(normalizeHookCommand(h.command!));
        // Outside double quotes: a home such as R&D sits inside the quoted paths.
        assert.doesNotMatch(h.command!.replace(/"[^"]*"/g, ""), /[;&|<>\r\n`]|\$\(/,
          `${event}: the template renders a shell control operator`);
        if (/[\\/]kherep[\\/]hook-runtime[\\/]entry\.mts"/.test(h.command!)) {
          entries++;
          assert.ok(found, `${event}: entry-form command not recognised`);
        } else assert.equal(found, undefined, `${event}: non-entry command recognised`);
        if (!found) continue;
        const key = `${event}|${group.matcher ?? ""}|${found.key}`;
        assert.ok(!keys.has(key), `duplicate managed key ${key}`);
        keys.add(key);
      }
    }
    assert.ok(entries > 0, "the template rendered no entry-form command");
    assert.equal(keys.size, entries);
  });

  test(`coordinated() parity for ${label}`, () => {
    const gateHome = normalizePathLike(home);
    const enoent = Object.assign(new Error("absent"), { code: "ENOENT" });
    for (const [event, groups] of Object.entries(rendered.hooks)) for (const group of groups) for (const h of group.hooks || []) {
      const { files, uncoordinated } = wiredFiles(gateHome, (name) => {
        if (name === "settings.json") return JSON.stringify({ hooks: { [event]: [{ hooks: [h] }] } });
        throw enoent;
      });
      const coordinated = files.length > 0 && uncoordinated.length === 0;
      assert.equal(managedHookKey(normalizeHookCommand(h.command!)) !== undefined, coordinated, `${event} [${group.matcher}]`);
    }
  });
}

// Issue #590. The template of an install from a service source pin, merged into
// settings written by an install from the checkout: one entry per control-plane
// script and event, whatever root the existing entry names. The replace is the
// #31 rule, so nothing is reported, and operator hooks stay as they are.
const PIN = "/Users/x/Library/Application Support/kherep/control-plane/service/source-pins/0123abcd";
const CHECKOUT = "/Users/x/Workspaces/kherep";
const cp = (root: string, script: string, args = ""): HookCommand =>
  ({ type: "command", command: `node "${root}/modules/control-plane/node/${script}"${args}` });
const cpWake = (root: string, t: number): HookCommand => ({ ...cp(root, "wake-hook.mts", ` --timeout ${t}`), asyncRewake: true, timeout: t });

test("a pin-root template replaces checkout-root entries of the same control-plane script and event; operator hooks stay", () => {
  const own = { type: "command", command: 'node "/opt/own/stop-note.mts"' };
  const ownGroup = { matcher: "Bash", hooks: [{ type: "command", command: "node /opt/own/bash-note.mts" }] };
  const source = {
    Stop: [{ matcher: "", hooks: [cp(PIN, "deliver-hook.mts"), cpWake(PIN, 86400)] }],
    PostToolUse: [{ matcher: "", hooks: [cp(PIN, "deliver-hook.mts")] }, { matcher: "Bash|PowerShell", hooks: [cp(PIN, "attribution-hook.mts")] }],
  };
  const existing = {
    Stop: [{ matcher: "", hooks: [own, cp(CHECKOUT, "deliver-hook.mts"), cpWake(CHECKOUT, 43200)] }, ownGroup],
    PostToolUse: [{ matcher: "", hooks: [cp(CHECKOUT, "deliver-hook.mts")] }, { matcher: "Bash|PowerShell", hooks: [cp(CHECKOUT, "attribution-hook.mts")] }],
  };
  const r = merge(source, existing);
  assert.deepEqual(r.merged.Stop, [{ matcher: "", hooks: [cp(PIN, "deliver-hook.mts"), cpWake(PIN, 86400), own] }, ownGroup]);
  assert.deepEqual(r.merged.PostToolUse, source.PostToolUse);
  assert.deepEqual(r.replaced, []);
});

test("settings that already hold both roots collapse to one set, also with backslashes and another drive case", () => {
  const both = { Stop: [{ matcher: "", hooks: [cp(CHECKOUT, "deliver-hook.mts"), cpWake(CHECKOUT, 86400), cp(PIN, "deliver-hook.mts"), cpWake(PIN, 86400)] }] };
  const r = merge({ Stop: [{ matcher: "", hooks: [cp(PIN, "deliver-hook.mts"), cpWake(PIN, 86400)] }] }, both);
  assert.deepEqual(r.merged.Stop, [{ matcher: "", hooks: [cp(PIN, "deliver-hook.mts"), cpWake(PIN, 86400)] }]);
  const win = merge({ Stop: [{ matcher: "", hooks: [cp("D:/Tools/Kherep", "deliver-hook.mts")] }] },
    { Stop: [{ matcher: "", hooks: [{ type: "command", command: String.raw`node "d:\Work\kherep\modules\control-plane\node\deliver-hook.mts"` }] }] });
  assert.deepEqual(win.merged.Stop, [{ matcher: "", hooks: [cp("D:/Tools/Kherep", "deliver-hook.mts")] }]);
});

// Review of #590, P3-2: an operator command that runs a control-plane script
// and more is not the managed hook, whatever root it names; it stays.
test("an operator command that chains a control-plane script stays next to the managed entry", () => {
  const chained = cp(CHECKOUT, "deliver-hook.mts", " && echo delivered >> /tmp/own.log");
  const r = merge({ Stop: [{ matcher: "", hooks: [cp(PIN, "deliver-hook.mts")] }] }, { Stop: [{ matcher: "", hooks: [chained] }] });
  assert.deepEqual(r.merged.Stop, [{ matcher: "", hooks: [cp(PIN, "deliver-hook.mts"), chained] }]);
});

// Issue #592. The stable template names the entry under the Claude home and the
// script by name; it replaces the path-form entries of every root, in every
// group of the event, because both forms have the key of the same script.
const STABLE = 'node "/Users/x/.claude/kherep/control-plane/claude-control-plane-hook.mts"';
const stable = (name: string, args = ""): HookCommand => ({ type: "command", command: `${STABLE} ${name}${args}` });
const stableWake = (): HookCommand => ({ ...stable("wake", " --timeout 86400"), asyncRewake: true, timeout: 86400 });

test("a stable-form template replaces path-form entries of two roots in every group of the event; operator hooks stay", () => {
  const own = { type: "command", command: 'node "/opt/own/stop-note.mts"' };
  const source = { Stop: [{ matcher: "", hooks: [stable("deliver"), stableWake()] }] };
  const existing = { Stop: [
    { matcher: "", hooks: [own, cp(CHECKOUT, "deliver-hook.mts"), cpWake(CHECKOUT, 86400)] },
    { matcher: "", hooks: [cp(PIN, "deliver-hook.mts"), cpWake(PIN, 86400)] },
  ] };
  const r = merge(source, existing);
  assert.deepEqual(r.merged.Stop, [{ matcher: "", hooks: [stable("deliver"), stableWake(), own] }]);
  assert.deepEqual(r.replaced, []);
});
