// Issue #965. The Confluence delivery check as the SessionStart hook process: stdin, scope,
// the line it prints, the announcement state it keeps, and the home fallbacks of its paths.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { ENTRY, isKherepScope, statePath, toolsDir } from "./confluence-delivery-check.mts";

const HOOK = path.join(import.meta.dirname, "confluence-delivery-check.mts");

function box(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-delivery-main-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "Kherep"), codexHome = path.join(root, "codex");
  fs.mkdirSync(workspace);
  const env = { ...process.env, KHEREP_WORKSPACE: workspace, CODEX_HOME: codexHome };
  const run = (input: string, extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", HOOK],
    { input, encoding: "utf8", env: { ...env, ...extra }, windowsHide: true, timeout: 30_000 });
  const start = (cwd = workspace) => JSON.stringify({ hook_event_name: "SessionStart", cwd });
  return { root, workspace, codexHome, run, start, state: path.join(codexHome, "orchestra", "confluence-delivery.json") };
}

test("no JSON, another event or a cwd outside the workspace: silent, nothing written", (t) => {
  const b = box(t);
  for (const input of ["{not json", JSON.stringify({ hook_event_name: "Stop", cwd: b.workspace }), b.start(b.root), ""]) {
    const result = b.run(input);
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, "", ""], input);
  }
  assert.equal(fs.existsSync(b.state), false);
});

test("nothing delivered: the not-installed line on every start, and no state written", (t) => {
  const b = box(t);
  for (let i = 0; i < 2; i++) assert.match(b.run(b.start()).stdout, /^CONFLUENCE DELIVERY: observation adapter not installed in tools\/\./);
  assert.equal(fs.existsSync(b.state), false);
});

test("a complete closure is announced once, recorded, and announced again only after it broke", (t) => {
  const b = box(t);
  fs.mkdirSync(path.join(b.workspace, "tools"));
  fs.writeFileSync(path.join(b.workspace, "tools", ENTRY), "export {};\n");
  assert.match(b.run(b.start()).stdout, /^CONFLUENCE DELIVERY: observation adapter import closure is installed\./);
  assert.deepEqual(JSON.parse(fs.readFileSync(b.state, "utf8")), { announcedComplete: true });
  assert.equal(b.run(b.start()).stdout, "", "announced: silent");
  fs.rmSync(path.join(b.workspace, "tools", ENTRY));
  assert.match(b.run(b.start()).stdout, /not installed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(b.state, "utf8")), { announcedComplete: false });
});

test("an unreadable or unwritable state file repeats the line and never fails the hook", (t) => {
  const b = box(t);
  fs.mkdirSync(path.join(b.workspace, "tools"));
  fs.writeFileSync(path.join(b.workspace, "tools", ENTRY), "export {};\n");
  const blocker = path.join(b.root, "a-file");
  fs.writeFileSync(blocker, "");
  for (let i = 0; i < 2; i++) {
    const result = b.run(b.start(), { CODEX_HOME: blocker });
    assert.deepEqual([result.status, result.stderr], [0, ""]);
    assert.match(result.stdout, /import closure is installed/);
  }
});

test("imported, with an argv[1] that is no file, the module runs no hook", () => {
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(HOOK).href)});`, "no-such-entry.mts"],
    { input: JSON.stringify({ hook_event_name: "SessionStart", cwd: process.cwd() }), encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.deepEqual([result.status, result.stdout], [0, ""], result.stderr);
});

test("without KHEREP_WORKSPACE or CODEX_HOME the paths fall back to USERPROFILE, HOME, then the OS home", () => {
  const home = path.join(os.tmpdir(), "profile");
  assert.equal(toolsDir({ USERPROFILE: home, HOME: "/elsewhere" }), path.join(home, "Kherep", "tools"));
  assert.equal(toolsDir({ KHEREP_WORKSPACE: "", HOME: home }), path.join(home, "Kherep", "tools"), "an empty workspace is unset");
  assert.equal(toolsDir({}), path.join(os.homedir(), "Kherep", "tools"));
  assert.equal(statePath({ HOME: home }), path.join(home, ".codex", "orchestra", "confluence-delivery.json"));
  assert.equal(statePath({}), path.join(os.homedir(), ".codex", "orchestra", "confluence-delivery.json"));
  assert.equal(isKherepScope({ cwd: path.join(home, "Kherep", "x") }, { USERPROFILE: home }), true);
  assert.equal(isKherepScope({ cwd: path.join(os.homedir(), "Kherep") }, {}), true);
  assert.equal(isKherepScope({ cwd: home }, { KHEREP_WORKSPACE: "" }), false, "an empty configured workspace matches nothing");
  assert.equal(isKherepScope(null, {}), false);
});
