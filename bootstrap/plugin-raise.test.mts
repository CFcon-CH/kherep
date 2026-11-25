// Issue #1010. The raise rule and its reading of the re-read state, with a
// synthetic plugin list and recorded mutators. The whole reconcile run is in
// reconcile-plugins.test.mts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { ReconcileError, parsePluginManifest, type ClaudeState, type PluginEntry } from "./plugin-contract.mts";
import { needsRaise, parseVersionManifest, raisePlugins } from "./plugin-raise.mts";

const manifest = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "manifest", name), "utf8"));

test("a different version needs a raise unless two release numbers show it is newer", () => {
  const cases: [unknown, string, boolean][] = [
    ["1.0.0", "1.0.0", false], ["1.0.0", "1.0.1", true], ["1.9.0", "1.10.0", true], ["2.0.0", "10.0.0", true],
    ["1.0.2", "1.0.1", false], ["1.10.0", "1.9.9", false], ["7.0.2", "6.9.9", false],
    ["aaaaaaaaaaaa", "aaaaaaaaaaaa", false], ["aaaaaaaaaaaa", "bbbbbbbbbbbb", true], ["5.1.0", "bbbbbbbbbbbb", true],
    ["unknown", "1.0.0", true], [undefined, "1.0.0", true], [42, "1.0.0", true], ["2.0.0-beta", "1.0.0", true],
  ];
  for (const [installed, reviewed, expected] of cases) {
    assert.equal(needsRaise(installed, reviewed), expected, `${String(installed)} against ${reviewed}`);
  }
});

test("the version manifest refuses every shape it does not know", () => {
  for (const [raw, message] of [
    [null, /must contain a versions object/], [{ versions: [] }, /must contain a versions object/],
    [{ versions: { alpha: "1.0.0" } }, /invalid plugin id/], [{ versions: { "alpha@main": 1 } }, /invalid version: alpha@main/],
    [{ versions: { "alpha@main": "" } }, /invalid version: alpha@main/], [{ versions: { "alpha@main": "1\n2" } }, /invalid version: alpha@main/],
  ] as [unknown, RegExp][]) {
    assert.throws(() => parseVersionManifest(raw), (error: unknown) => error instanceof ReconcileError && message.test(error.message));
  }
  assert.deepEqual([...parseVersionManifest({ versions: { "alpha@main": "1.0.0" } })], [["alpha@main", "1.0.0"]]);
});

test("the shipped manifest names a version for exactly the declared plugins, and the bundled versions", () => {
  const reviewed = parseVersionManifest(manifest("plugin-versions.json"));
  const plugins = manifest("plugins.json") as { enabledPlugins: Record<string, boolean> };
  assert.deepEqual([...reviewed.keys()], Object.keys(plugins.enabledPlugins));
  assert.ok(parsePluginManifest(plugins, new Set(["claude-plugins-official", "caveman", "karpathy-skills"])).length > 0);
  const bundled = JSON.parse(fs.readFileSync(
    path.join(import.meta.dirname, "..", "codex", "parity", "plugin-sources", "manifest.json"), "utf8",
  )) as { plugins: { id: string; version: string }[] };
  for (const { id, version } of bundled.plugins) assert.equal(reviewed.get(id), version, id);
});

interface Run { failed: string[]; calls: string[]; reads: number; out: string }

// `after` is the plugin list Claude reports once the mutators ran.
function run(
  t: TestContext, installed: Record<string, unknown>, after: Record<string, unknown>, reviewed: Record<string, string>,
  failing: RegExp = /^$/,
): Run {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-plugin-raise-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = (versions: Record<string, unknown>): ClaudeState => ({
    marketplaces: new Map(),
    plugins: new Map(Object.entries(versions).map(([id, version]): [string, PluginEntry] =>
      [`${id}\0user`, { id, scope: "user", enabled: true, installPath: path.join(home, "plugins", id), version }])),
  });
  const calls: string[] = [];
  let reads = 0;
  let out = "";
  const write = t.mock.method(process.stdout, "write", (text: string) => { out += text; return true; });
  const failed = raisePlugins(state(installed), new Map(Object.entries(reviewed)), home, {
    mutate: (args) => { const call = args.slice(1).join(" "); calls.push(call); return !failing.test(call); },
    readState: () => { reads += 1; return state(after); },
  });
  write.mock.restore();
  return { failed, calls, reads, out };
}

test("an unchanged version after a clean update is the marketplace's current one, not a failure", (t) => {
  const result = run(t, { "alpha@main": "aaaaaaaaaaaa" }, { "alpha@main": "aaaaaaaaaaaa" }, { "alpha@main": "bbbbbbbbbbbb" });
  assert.deepEqual(result.failed, []);
  assert.match(result.out, /plugin alpha@main is current at its marketplace \(installed aaaaaaaaaaaa, reviewed bbbbbbbbbbbb\)/);
});

test("a changed version counts as raised whatever the exit status, also past the reviewed one", (t) => {
  const result = run(t, { "alpha@main": "1.0.0" }, { "alpha@main": "3.0.0" }, { "alpha@main": "2.0.0" }, /./);
  assert.deepEqual(result.failed, []);
  assert.match(result.out, /raised plugin alpha@main from 1\.0\.0 to 3\.0\.0 \(reviewed 2\.0\.0\)/);
});

test("a failed marketplace update without a change is a failure even when the plugin update exits 0", (t) => {
  const result = run(t, { "alpha@main": "1.0.0", "beta@other": "1.0.0" }, { "alpha@main": "1.0.0", "beta@other": "2.0.0" },
    { "alpha@main": "2.0.0", "beta@other": "2.0.0" }, /^marketplace update main/);
  assert.deepEqual(result.calls, ["marketplace update main", "marketplace update other",
    "update --scope user alpha@main", "update --scope user beta@other"]);
  assert.deepEqual(result.failed, ["alpha@main (installed 1.0.0, reviewed 2.0.0)"]);
  assert.equal(result.reads, 1);
});

test("a plugin that is gone afterwards is a failure", (t) => {
  assert.deepEqual(run(t, { "alpha@main": "1.0.0" }, {}, { "alpha@main": "2.0.0" }).failed,
    ["alpha@main (installed 1.0.0, reviewed 2.0.0)"]);
});

test("a version that is no one-line string is never printed", (t) => {
  const result = run(t, { "alpha@main": "1\nFORGED", "beta@main": 7 }, { "alpha@main": "2\nFORGED" }, { "alpha@main": "2.0.0", "beta@main": "2.0.0" });
  assert.deepEqual(result.failed, ["beta@main (installed unknown, reviewed 2.0.0)"]);
  assert.match(result.out, /raised plugin alpha@main from unknown to unknown \(reviewed 2\.0\.0\)/);
  assert.doesNotMatch(result.out, /FORGED/);
});

test("nothing behind means no call and no read; a plugin without a user-scope row is left alone", (t) => {
  const result = run(t, { "alpha@main": "2.0.0" }, {}, { "alpha@main": "2.0.0", "beta@main": "1.0.0" });
  assert.deepEqual([result.failed, result.calls, result.reads, result.out], [[], [], 0, ""]);
});
