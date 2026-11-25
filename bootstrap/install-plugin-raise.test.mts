// Issue #1010. The plugin step of install.sh: which runs pass the reviewed plugin
// versions to reconcile-plugins.mts, and the settings.json render that follows
// it. Both run as the shell text install.sh holds, against throwaway
// directories; no claude and no host configuration is involved.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, "..");
const INSTALL = fs.readFileSync(path.join(HERE, "install.sh"), "utf8");
const slash = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);

function between(from: string, to: string): string {
  const start = INSTALL.indexOf(from);
  const end = INSTALL.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `install.sh lost ${from} or ${to}`);
  return INSTALL.slice(start, end);
}

function bash(script: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", script.join("\n")], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
}

// Section C with every node call recorded instead of run.
function depsPhase(claudeHome: string, env: Record<string, string> = {}) {
  const run = bash([
    "set -euo pipefail",
    `. '${slash(path.join(HERE, "profile.sh"))}' || exit $?`,
    "node() { printf 'CALL %s\\n' \"$*\"; }",
    "settle_settings() { echo 'CALL settle_settings'; }",
    "REPO_ROOT=/repo", `CLAUDE_HOME='${claudeHome}'`, "SKIP_DEPS=0", "INSTALL_ATLASSIAN_TOOLS=0",
    between("# ---- C. deps", "# ---- C2."),
  ], { HOME: "/home/one", KHEREP_PROFILE: "mac", ...env });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.split(/\r?\n/);
  return {
    reconcile: lines.filter((line) => line.startsWith("CALL /repo/bootstrap/reconcile-plugins.mts ")),
    settled: lines.filter((line) => line === "CALL settle_settings").length,
    out: run.stdout,
  };
}

const PLAIN = "CALL /repo/bootstrap/reconcile-plugins.mts /repo/bootstrap/manifest/marketplaces.json /repo/bootstrap/manifest/plugins.json";
const RAISE = `${PLAIN} /repo/bootstrap/manifest/plugin-versions.json`;

test("an install of the default home raises plugins and settles settings.json once", () => {
  const run = depsPhase("/home/one/.claude");
  assert.deepEqual(run.reconcile, [`${RAISE} /home/one/.claude`]);
  assert.equal(run.settled, 1);
  assert.doesNotMatch(run.out, /SKIP_PLUGIN_RAISE/);
});

test("a candidate home raises nothing unless the operator allows the step for it", () => {
  const candidate = depsPhase("/candidate/claude");
  assert.deepEqual(candidate.reconcile, [PLAIN]);
  assert.match(candidate.out, /SKIP_PLUGIN_RAISE=1 \(by CLAUDE_HOME '\/candidate\/claude', not the default/);
  assert.deepEqual(depsPhase("/candidate/claude", { KHEREP_INSTALL_ALLOW_PLUGIN_RAISE: "1" }).reconcile,
    [`${RAISE} /candidate/claude`]);
});

test("the skip switch and the preview hold plugins at their versions, whatever is allowed", () => {
  for (const name of ["KHEREP_INSTALL_SKIP_PLUGIN_RAISE", "KHEREP_INSTALL_PREVIEW"]) {
    const run = depsPhase("/home/one/.claude", { KHEREP_INSTALL_ALLOW_PLUGIN_RAISE: "1", [name]: "1" });
    assert.deepEqual(run.reconcile, [PLAIN], name);
    assert.match(run.out, /installed plugins keep their versions/);
  }
  assert.deepEqual(depsPhase("/home/one/.claude", { KHEREP_INSTALL_SKIP_PLUGIN_RAISE: "yes" }).reconcile,
    [`${RAISE} /home/one/.claude`], "only the exact value 1 skips");
});

function settleFixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-settle-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ["home", "preflight", "ws/.claude"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const settings = path.join(root, "home", "settings.json");
  fs.writeFileSync(settings, "{}");
  const settle = () => bash([
    "set -euo pipefail", "KHEREP_PROFILE=win", `REPO_ROOT='${slash(REPO)}'`, 'CLAUDE_SRC="$REPO_ROOT/claude"',
    `CLAUDE_HOME='${slash(path.join(root, "home"))}'`, `WS='${slash(path.join(root, "ws"))}'`,
    `CREDENTIALS_ROOT='${slash(path.join(root, "creds"))}'`, `PREFLIGHT_DIR='${slash(path.join(root, "preflight"))}'`,
    between("settle_settings() {", "\nbootstrap_on_exit() {"), "settle_settings",
  ], { HOME: slash(root) });
  return { settings, settle };
}

test("settings.json returns to the rendered form after another writer reordered its hook entries", (t) => {
  const ctx = settleFixture(t);
  const first = ctx.settle();
  assert.equal(first.status, 0, first.stderr);
  const rendered = fs.readFileSync(ctx.settings, "utf8");
  // What the claude CLI does: the keys of every hook entry in another order.
  type Groups = Record<string, { hooks: object[] }[]>;
  const reorder = (events: Groups): Groups => Object.fromEntries(Object.entries(events).map(([event, groups]) =>
    [event, groups.map((group) => ({ ...group, hooks: group.hooks.map((entry) => Object.fromEntries(Object.entries(entry).reverse())) }))]));
  const { hooks } = JSON.parse(rendered) as { hooks: Groups };
  const live = { ...JSON.parse(rendered) as object, hooks: reorder(hooks), enabledPlugins: { "operator@elsewhere": true } };
  fs.writeFileSync(ctx.settings, JSON.stringify(live, null, 2));
  const second = ctx.settle();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /settings\.json rendered again after the plugin step/);
  const settled = fs.readFileSync(ctx.settings, "utf8");
  const after = JSON.parse(settled) as typeof live;
  assert.equal(JSON.stringify(after.hooks), JSON.stringify(hooks), "the hook entries are byte-equal to the first render");
  assert.deepEqual(after.enabledPlugins, { "operator@elsewhere": true }, "the operator's settings survive");
  const third = ctx.settle();
  assert.deepEqual([third.status, third.stdout, fs.readFileSync(ctx.settings, "utf8")], [0, "", settled]);
});

test("an unreadable settings.json is reported and left as it is", (t) => {
  const ctx = settleFixture(t);
  fs.writeFileSync(ctx.settings, "{not json");
  assert.notEqual(ctx.settle().status, 0);
  assert.equal(fs.readFileSync(ctx.settings, "utf8"), "{not json");
});
