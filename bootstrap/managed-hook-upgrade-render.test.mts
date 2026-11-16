// Issue #568. An upgrade renders template B over the settings template A (or a
// live edit of it) produced; a third render of B over its own output must be
// byte-identical and silent. A changed field, mode or dispatcher argument of a
// managed entry-form hook must leave one entry, not the old one beside the new.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { renderSettings } from "./render-profile.mts";

// A synthetic user home: os.homedir() reads HOME, on Windows USERPROFILE. No live file is read.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "managed-hook-home-"));
const SAVED_HOME = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
after(() => {
  for (const [name, value] of Object.entries(SAVED_HOME)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

interface Hook { type?: string; command?: string; timeout?: number; [key: string]: unknown }
interface Group { matcher?: string; hooks: Hook[] }
type Hooks = Record<string, Group[]>;

const SOURCE = path.join(import.meta.dirname, "..", "claude", "settings.user.json");
const TEMPLATE = JSON.parse(fs.readFileSync(SOURCE, "utf8")) as { hooks: Hooks };

const variant = (mutate: (hooks: Hooks) => void) => { const copy = structuredClone(TEMPLATE); mutate(copy.hooks); return copy; };
const group = (hooks: Hooks, event: string, matcher: string) => hooks[event]!.find((g) => (g.matcher ?? "") === matcher)!;
const obs = (hooks: Hooks) => group(hooks, "SubagentStop", "claude-obs").hooks[0]!;
const bash = (hooks: Hooks) => group(hooks, "PreToolUse", "Bash").hooks[0]!;
// The rendered Claude home, read back from a rendered command so the test holds on every host.
const homeOf = (hooks: Hooks) => /^node "(.+?)[\\/]kherep[\\/]hook-runtime/.exec(obs(hooks).command!)![1]!;
const entry = (home: string, mode: string, main: string, ...args: string[]) =>
  [`node "${home}/kherep/hook-runtime/entry.mts" ${mode} "${home}/hooks/${main}"`, ...args.map((a) => `"${home}/hooks/${a}"`)].join(" ");

interface Upgrade { hooks: Hooks; replaced: string[]; secondSilent: boolean; secondEqual: boolean }

function upgrade(before: unknown, after: unknown, live?: (hooks: Hooks) => void): Record<string, Upgrade> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-hook-upgrade-"));
  const results: Record<string, Upgrade> = {};
  try {
    const write = (name: string, value: unknown) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
    const project = write("project.src.json", {});
    const sources = { before: write("before.src.json", before), after: write("after.src.json", after) };
    for (const profile of ["win", "mac"]) {
      const out = (name: string) => path.join(dir, `${profile}.${name}.json`);
      const render = (source: string, existing: string, name: string): string[] => {
        const lines: string[] = [];
        const log = console.log;
        console.log = (...items: unknown[]) => { lines.push(items.join(" ")); };
        try {
          renderSettings([profile, "/example/Kherep", "/example/credentials", "/example/.claude", source, project,
            existing, "-", out(name), out(`${name}.project`)]);
        } finally { console.log = log; }
        return lines;
      };
      render(sources.before, "-", "before");
      if (live) {
        const seeded = JSON.parse(fs.readFileSync(out("before"), "utf8")) as { hooks: Hooks };
        live(seeded.hooks);
        fs.writeFileSync(out("before"), JSON.stringify(seeded));
      }
      const first = render(sources.after, out("before"), "after");
      const second = render(sources.after, out("after"), "again");
      results[profile] = {
        hooks: (JSON.parse(fs.readFileSync(out("after"), "utf8")) as { hooks: Hooks }).hooks,
        replaced: first.filter((line) => line.startsWith("hooks: replace ")),
        secondSilent: second.length === 0,
        secondEqual: fs.readFileSync(out("after"), "utf8") === fs.readFileSync(out("again"), "utf8"),
      };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

// Every hook of the rendered file that runs <main> through the entry, as "event[matcher] t=<timeout>".
const wired = (hooks: Hooks, main: string) => Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks
  .filter((h) => typeof h.command === "string" && h.command.includes(`/hooks/${main}"`) && h.command.includes("hook-runtime"))
  .map((h) => `${event}[${g.matcher ?? ""}] t=${h.timeout ?? "-"}`)));

function check(results: Record<string, Upgrade>, assertions: (r: Upgrade, profile: string) => void): void {
  for (const [profile, r] of Object.entries(results)) {
    assertions(r, profile);
    assert.ok(r.secondEqual, `${profile}: the second render changed the file`);
    assert.ok(r.secondSilent, `${profile}: the second render printed a line`);
  }
}

test("T1 SubagentStop obs-result-check gains a timeout: one entry, one replace line", () => {
  check(upgrade(TEMPLATE, variant((h) => { obs(h).timeout = 30; })), (r, p) => {
    assert.deepEqual(wired(r.hooks, "obs-result-check.mts"), ["SubagentStop[claude-obs] t=30"], p);
    assert.deepEqual(r.replaced, ["hooks: replace SubagentStop [claude-obs] hooks/obs-result-check.mts"], p);
  });
});

test("T2 the Bash dispatcher's timeout changes: one entry with the guards unchanged", () => {
  check(upgrade(TEMPLATE, variant((h) => { bash(h).timeout = 45; })), (r, p) => {
    const hooks = group(r.hooks, "PreToolUse", "Bash").hooks;
    assert.equal(hooks.length, 1, p);
    assert.equal(hooks[0]!.timeout, 45, p);
    assert.match(hooks[0]!.command!, /guard-dispatch\.mts" ".*commit-guard\.mts" ".*deploy-guard\.mts"$/, p);
    assert.deepEqual(r.replaced, ["hooks: replace PreToolUse [Bash] hooks/guard-dispatch.mts"], p);
  });
});

test("T3 the handback recorder loses its timeout: one entry without one", () => {
  check(upgrade(TEMPLATE, variant((h) => { delete group(h, "PostToolUse", "SubagentHandback").hooks[0]!.timeout; })), (r, p) => {
    assert.deepEqual(wired(r.hooks, "obs-handback-record.mts"), ["PostToolUse[SubagentHandback] t=-"], p);
    assert.deepEqual(r.replaced, ["hooks: replace PostToolUse [SubagentHandback] hooks/obs-handback-record.mts"], p);
  });
});

test("T4 and J2 a guard is added to or removed from the Bash dispatcher: one entry with the template's arguments", () => {
  const extra = '"__KHEREP_CLAUDE_HOME__/hooks/extra-guard.mts"';
  const deploy = ' "__KHEREP_CLAUDE_HOME__/hooks/deploy-guard.mts"';
  for (const [name, mutate, present, absent] of [
    ["added", (h: Hooks) => { bash(h).command += ` ${extra}`; }, /extra-guard\.mts"$/, undefined],
    ["removed", (h: Hooks) => { bash(h).command = bash(h).command!.replace(deploy, ""); }, /commit-guard\.mts"$/, /deploy-guard/],
  ] as const) {
    check(upgrade(TEMPLATE, variant(mutate)), (r, p) => {
      const hooks = group(r.hooks, "PreToolUse", "Bash").hooks;
      assert.equal(hooks.length, 1, `${name} ${p}`);
      assert.match(hooks[0]!.command!, present, `${name} ${p}`);
      if (absent) assert.doesNotMatch(hooks[0]!.command!, absent, `${name} ${p}`);
      assert.deepEqual(r.replaced, ["hooks: replace PreToolUse [Bash] hooks/guard-dispatch.mts"], `${name} ${p}`);
    });
  }
});

test("E the observation check changes its mode: one entry, writer", () => {
  check(upgrade(TEMPLATE, variant((h) => { obs(h).command = obs(h).command!.replace(" reader ", " writer "); })), (r, p) => {
    assert.deepEqual(wired(r.hooks, "obs-result-check.mts"), ["SubagentStop[claude-obs] t=-"], p);
    assert.match(obs(r.hooks).command!, / writer "/, p);
    assert.equal(r.replaced.length, 1, p);
  });
});

test("an empty-matcher group's entry gains a timeout: the replace line has no bracket", () => {
  const watch = (h: Hooks) => group(h, "PostToolUse", "").hooks.find((k) => k.command!.includes("manifest-watch"))!;
  check(upgrade(TEMPLATE, variant((h) => { watch(h).timeout = 12; })), (r, p) => {
    assert.deepEqual(wired(r.hooks, "manifest-watch.mts"), ["PostToolUse[] t=12"], p);
    assert.deepEqual(r.replaced, ["hooks: replace PostToolUse hooks/manifest-watch.mts"], p);
  });
});

test("T5 operator hooks outside the key stay: own main, same main at another matcher, other home, other command", () => {
  check(upgrade(TEMPLATE, TEMPLATE, (h) => {
    const home = homeOf(h);
    group(h, "SubagentStop", "claude-obs").hooks.push({ type: "command", command: entry(home, "reader", "my-own.mts"), timeout: 7 },
      { type: "command", command: entry("/other/.claude", "reader", "obs-result-check.mts"), timeout: 9 },
      { type: "command", command: "node $(npm root -g)/claude-baton/bin/claude-baton.js auto-checkpoint" });
    h.SubagentStop!.push({ matcher: "my-agent", hooks: [{ type: "command", command: entry(home, "reader", "obs-result-check.mts"), timeout: 5 }] });
  }), (r, p) => {
    assert.deepEqual(wired(r.hooks, "obs-result-check.mts"), ["SubagentStop[claude-obs] t=-", "SubagentStop[claude-obs] t=9", "SubagentStop[my-agent] t=5"], p);
    assert.deepEqual(wired(r.hooks, "my-own.mts"), ["SubagentStop[claude-obs] t=7"], p);
    assert.ok(JSON.stringify(r.hooks).includes("claude-baton"), p);
    assert.deepEqual(r.replaced, [], p);
  });
});

test("T5/M an operator's second dispatcher with its own guard in the Bash group is replaced", () => {
  check(upgrade(TEMPLATE, TEMPLATE, (h) => {
    group(h, "PreToolUse", "Bash").hooks.push({ type: "command", command: entry(homeOf(h), "pretool", "guard-dispatch.mts", "my-guard.mts"), timeout: 30 });
  }), (r, p) => {
    const hooks = group(r.hooks, "PreToolUse", "Bash").hooks;
    assert.equal(hooks.length, 1, p);
    assert.equal(hooks[0]!.command, bash(r.hooks).command, p);
    assert.doesNotMatch(JSON.stringify(r.hooks), /my-guard/, p);
    assert.deepEqual(r.replaced, ["hooks: replace PreToolUse [Bash] hooks/guard-dispatch.mts"], p);
  });
});

test("T7 an operator edit of a managed entry's timeout is replaced by the template's entry", () => {
  check(upgrade(TEMPLATE, TEMPLATE, (h) => { obs(h).timeout = 60; }), (r, p) => {
    assert.deepEqual(wired(r.hooks, "obs-result-check.mts"), ["SubagentStop[claude-obs] t=-"], p);
    assert.deepEqual(r.replaced, ["hooks: replace SubagentStop [claude-obs] hooks/obs-result-check.mts"], p);
  });
});

test("K a live file that already carries the duplicate heals to one entry", () => {
  check(upgrade(TEMPLATE, TEMPLATE, (h) => { group(h, "SubagentStop", "claude-obs").hooks.push({ ...obs(h), timeout: 30 }); }), (r, p) => {
    assert.deepEqual(wired(r.hooks, "obs-result-check.mts"), ["SubagentStop[claude-obs] t=-"], p);
    assert.deepEqual(r.replaced, ["hooks: replace SubagentStop [claude-obs] hooks/obs-result-check.mts"], p);
  });
});

test("O two live groups with the managed matcher keep the operator's main in both", () => {
  check(upgrade(TEMPLATE, TEMPLATE, (h) => {
    const mine = (timeout: number) => ({ type: "command", command: entry(homeOf(h), "reader", "my-own.mts"), timeout });
    group(h, "SubagentStop", "claude-obs").hooks.push(mine(1));
    h.SubagentStop!.push({ matcher: "claude-obs", hooks: [mine(2)] });
  }), (r, p) => {
    assert.deepEqual(wired(r.hooks, "my-own.mts"), ["SubagentStop[claude-obs] t=1", "SubagentStop[claude-obs] t=2"], p);
    assert.deepEqual(r.replaced, [], p);
  });
});

test("T8 a matcher move leaves the old group wired (documented limit)", () => {
  check(upgrade(TEMPLATE, variant((h) => { group(h, "SubagentStop", "claude-obs").matcher = "claude-obs|codex-obs"; })), (r, p) => {
    assert.deepEqual(wired(r.hooks, "obs-result-check.mts"), ["SubagentStop[claude-obs|codex-obs] t=-", "SubagentStop[claude-obs] t=-"], p);
    assert.deepEqual(r.replaced, [], p);
  });
});

// Issue #808. An upgrade from a template without the PowerShell group adds it as a
// group of its own: one guard-dispatch entry per shell matcher, nothing replaced, the
// "Bash" group untouched, and the second render silent and identical.
test("T9 the added PowerShell group is a purely additive upgrade", () => {
  const before = variant((h) => { h.PreToolUse = h.PreToolUse!.filter((g) => g.matcher !== "PowerShell"); });
  assert.equal(before.hooks.PreToolUse!.length, TEMPLATE.hooks.PreToolUse!.length - 1);
  check(upgrade(before, TEMPLATE), (r, p) => {
    const shell = wired(r.hooks, "guard-dispatch.mts").filter((w) => /^PreToolUse\[(Bash|PowerShell|Bash\|PowerShell)\]/.test(w));
    assert.deepEqual(shell, ["PreToolUse[Bash] t=30", "PreToolUse[PowerShell] t=30", "PreToolUse[Bash|PowerShell] t=30"], p);
    assert.equal(group(r.hooks, "PreToolUse", "PowerShell").hooks[0]!.command, bash(r.hooks).command, p);
    assert.deepEqual(r.replaced, [], p);
  });
});
