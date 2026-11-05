import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, type TestContext } from "node:test";

import { renderSettings } from "./render-profile.mts";
import { mergeSettings, type Settings } from "./render-profile-settings.mts";
import { retireCodexPlugin } from "./codex-plugin-retirement.mts";

const repo = path.resolve(import.meta.dirname, "..");
const retired = "codex@openai-codex";
const read = (file: string): Settings => JSON.parse(fs.readFileSync(file, "utf8")) as Settings;

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-797-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.json");
  fs.writeFileSync(source, "{}\n");
  const render = (profile: string, user: Settings, project: Settings = {}) => {
    const userFile = path.join(root, "user.json");
    const projectFile = path.join(root, "project.json");
    fs.writeFileSync(userFile, JSON.stringify(user, null, 2));
    fs.writeFileSync(projectFile, JSON.stringify(project, null, 2));
    renderSettings([profile, `${root}/workspace`, `${root}/synthetic`, `${root}/claude`, source, source,
      userFile, projectFile, `${root}/out-user.json`, `${root}/out-project.json`]);
    return [read(`${root}/out-user.json`), read(`${root}/out-project.json`)];
  };
  return { root, render };
}

test("manifest omission alone preserves historical plugin enablement", () => {
  assert.equal(mergeSettings({}, { enabledPlugins: { [retired]: true } }).enabledPlugins?.[retired], true);
});

test("retirement leaves absent and already disabled settings byte-identical", () => {
  const unchanged: Settings[] = [{}, { enabledPlugins: {} }, { enabledPlugins: { [retired]: false } },
    { enabledPlugins: { "codex@operator": true, "other@openai-codex": true } }];
  for (const settings of unchanged) {
    const before = JSON.stringify(settings);
    assert.equal(retireCodexPlugin(settings), settings);
    assert.equal(JSON.stringify(settings), before);
  }
  const existing = { enabledPlugins: { "other@market": true, [retired]: true }, fixturePreference: [1, "ß"] };
  assert.equal(JSON.stringify(retireCodexPlugin(existing)), JSON.stringify(existing).replace(`"${retired}":true`, `"${retired}":false`));
});

for (const profile of ["win", "mac"]) {
  test(`${profile}: upgrade disables the exact plugin in both settings scopes and is idempotent`, (t) => {
    const { render } = fixture(t);
    const existing: Settings = {
      fixturePreference: { ordered: ["keep", 1], text: "ä ß" },
      enabledPlugins: { "other@openai-codex": true, [retired]: true, "codex@operator": true, "disabled@own": false },
      extraKnownMarketplaces: { "openai-codex": { source: { source: "github", repo: "openai/codex-plugin-cc" } } },
      hooks: { Notification: [{ matcher: "operator", hooks: [{ type: "command", command: "operator-fixture" }] }] },
    };
    const baseline = render(profile, { ...existing, enabledPlugins: { ...existing.enabledPlugins, [retired]: false } },
      { ...existing, enabledPlugins: { ...existing.enabledPlugins, [retired]: false } });
    const actual = render(profile, existing, existing);
    assert.equal(actual[0].enabledPlugins?.[retired], false);
    assert.equal(actual[1].enabledPlugins?.[retired], false);
    assert.equal(JSON.stringify(actual), JSON.stringify(baseline), "no unrelated serialized setting changes");
    assert.equal(JSON.stringify(actual[0].fixturePreference), JSON.stringify(existing.fixturePreference));
    assert.equal(JSON.stringify(actual[0].extraKnownMarketplaces), JSON.stringify(existing.extraKnownMarketplaces));
    assert.equal(existing.enabledPlugins?.[retired], true, "input is not mutated");
    assert.deepEqual(render(profile, actual[0], actual[1]), actual, "second upgrade is a fixed point");
  });
}

test("a host that never had the plugin gets no retirement setting or marketplace", (t) => {
  const { render } = fixture(t);
  const first = render("mac", { enabledPlugins: { "codex@operator": true } });
  assert.equal(Object.hasOwn(first[0].enabledPlugins ?? {}, retired), false);
  assert.equal(first[0].extraKnownMarketplaces, undefined);
  assert.deepEqual(render("mac", first[0], first[1]), first);
});

test("a retained registry without a settings key gets an explicit disable; malformed registry fails before output", (t) => {
  const { root, render } = fixture(t);
  const registry = path.join(root, "claude/plugins/installed_plugins.json");
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  const bytes = '{ "plugins": { "codex@openai-codex": [{"scope":"user"}] } }\n';
  fs.writeFileSync(registry, bytes);
  const first = render("win", { fixturePreference: "kept" });
  assert.equal(first[0].enabledPlugins?.[retired], false);
  assert.equal(first[1].enabledPlugins, undefined, "no unnecessary project override");
  assert.equal(fs.readFileSync(registry, "utf8"), bytes);
  assert.deepEqual(render("win", first[0], first[1]), first);
  const before = fs.readFileSync(path.join(root, "out-user.json"));
  fs.writeFileSync(registry, "{malformed");
  assert.throws(() => render("win", {}), /Cannot read required JSON configuration/);
  assert.deepEqual(fs.readFileSync(path.join(root, "out-user.json")), before, "preflight failure writes no output");
  for (const shape of [{}, { plugins: null }, { plugins: [] }, null, [], 7, "registry"]) {
    fs.writeFileSync(registry, JSON.stringify(shape));
    assert.throws(() => render("win", {}), /Cannot read installed plugin registry shape/);
    assert.deepEqual(fs.readFileSync(path.join(root, "out-user.json")), before, "invalid registry shape writes no output");
  }
  fs.writeFileSync(registry, '{"plugins":{}}');
  assert.equal(render("win", {})[0].enabledPlugins, undefined, "a valid empty registry adds no tombstone");
});

test("fresh-install manifests and Codex parity omit the retired plugin and marketplace; npm Codex stays", () => {
  const plugins = read(path.join(repo, "bootstrap/manifest/plugins.json"));
  const markets = read(path.join(repo, "bootstrap/manifest/marketplaces.json"));
  const capabilities = read(path.join(repo, "bootstrap/manifest/capabilities.json"));
  const parity = read(path.join(repo, "codex/parity/capabilities.json"));
  assert.equal(Object.hasOwn(plugins.enabledPlugins ?? {}, retired), false);
  assert.equal(Object.hasOwn(plugins.extraKnownMarketplaces ?? {}, "openai-codex"), false);
  assert.equal(Object.hasOwn(markets, "openai-codex"), false);
  assert.equal((capabilities.plugins as string[]).includes(retired), false);
  assert.equal(Object.hasOwn(capabilities.pluginEntrypoints as object, retired), false);
  assert.equal((parity.plugins as { id: string }[]).some((entry) => entry.id === retired), false);
  assert.match(fs.readFileSync(path.join(repo, "bootstrap/manifest/npm-globals.txt"), "utf8"), /^@openai\/codex@/m);
});

test("strict capability check accepts retained disabled registry but fails a reenabled or unretired install", (t) => {
  const { root } = fixture(t);
  const home = path.join(root, "claude");
  const pluginRoot = path.join(root, "cached-plugin");
  const capabilities = read(path.join(repo, "bootstrap/manifest/capabilities.json"));
  const write = (relative: string, text = "fixture\n") => {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  for (const [name, file] of Object.entries(capabilities.ownedAgents as Record<string, string>)) {
    write(`agents/${file}`, `---\nname: ${name}\n---\n`);
  }
  const baseline = (capabilities.profileBaselines as Record<string, { skills: string[] }>).mac;
  for (const name of [...capabilities.skills as string[], ...baseline.skills]) write(`skills/${name}/SKILL.md`);
  for (const file of capabilities.commands as string[]) write(`commands/${file}`);
  for (const file of capabilities.runtimeFiles as string[]) write(file);
  for (const file of capabilities.requiredHooks as string[]) write(`hooks/${file}`);
  for (const files of Object.values(capabilities.pluginEntrypoints as Record<string, string[]>)) {
    for (const relative of files) {
      const file = path.join(pluginRoot, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "fixture\n");
    }
  }
  const ids = capabilities.plugins as string[];
  const installed = Object.fromEntries([...ids, retired].map((id) => [id, [{ installPath: pluginRoot }]]));
  write("plugins/installed_plugins.json", JSON.stringify({ plugins: installed }));
  fs.writeFileSync(path.join(root, ".claude.json"), JSON.stringify({
    mcpServers: Object.fromEntries((capabilities.mcpServers as string[]).map((name) => [name, { command: process.execPath }])),
  }));
  for (const [enabled, projectEnabled, registered = true] of [[false, undefined], [false, false], [false, true], [true, false],
    [undefined, false], [undefined, undefined, false], [undefined, true, false]]) {
    write("plugins/installed_plugins.json", JSON.stringify({ plugins: registered ? installed : Object.fromEntries(ids.map((id) => [id, installed[id]])) }));
    write("settings.json", JSON.stringify({ enabledPlugins: {
      ...Object.fromEntries(ids.map((id) => [id, true])), ...(enabled === undefined ? {} : { [retired]: enabled }),
    } }));
    const workspaceFile = path.join(root, "workspace/.claude/settings.local.json");
    fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
    if (projectEnabled === undefined) fs.rmSync(workspaceFile, { force: true });
    else fs.writeFileSync(workspaceFile, JSON.stringify({ enabledPlugins: { [retired]: projectEnabled } }));
    const result = spawnSync(process.execPath, [path.join(repo, "bootstrap/capability-check.mts"), "--live", "--strict", "--profile", "mac"], {
      encoding: "utf8", env: { ...process.env, CLAUDE_HOME: home, HOME: root, USERPROFILE: root,
        KHEREP_USER_HOME: root, KHEREP_WORKSPACE: `${root}/workspace` },
    });
    const passed = (enabled === false || !registered) && projectEnabled !== true;
    assert.equal(result.status, passed ? 0 : 1, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(`${passed ? "PASS" : "FAIL"} | retired plugin disabled ${retired}`), result.stdout);
  }
});
