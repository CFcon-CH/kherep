import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

const subject = path.join(import.meta.dirname, "reconcile-plugins.mts");
const SECRET = "SECRET_MUST_NOT_LEAK_7cfa";

// The fake `claude` is plain JavaScript on purpose: a runtime fixture written
// into a throwaway directory, not a versioned source file.
const fakeClaudeSource = String.raw`
"use strict";
const fs = require("node:fs");
const statePath = process.env.FAKE_CLAUDE_STATE;
const logPath = process.env.FAKE_CLAUDE_LOG;
const args = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify(args) + "\n");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const emitList = (key) => {
  const sequenceKey = key === "plugins" ? "pluginListResponses" : "marketplaceListResponses";
  let value = state[key];
  if (Array.isArray(state[sequenceKey]) && state[sequenceKey].length > 0) {
    value = state[sequenceKey].shift();
    save();
  }
  process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
};
if (args.join(" ") === "plugin marketplace list --json") {
  emitList("marketplaces");
  process.exit(0);
}
if (args.join(" ") === "plugin list --json") {
  emitList("plugins");
  process.exit(0);
}
const signature = args.join(" ");
const outcome = (state.outcomes && state.outcomes[signature]) || { exit: 0, apply: true };
const shouldApply = outcome.apply !== false;
if (args.slice(0, 5).join(" ") === "plugin marketplace add --scope user") {
  const ref = args[5];
  const entry = state.catalog.marketplaces[ref];
  if (shouldApply && entry) {
    state.marketplaces = state.marketplaces.filter((item) => item.name !== entry.name);
    state.marketplaces.push(entry);
  }
} else if (args.slice(0, 4).join(" ") === "plugin install --scope user") {
  const id = args[4];
  const entry = state.catalog.plugins[id];
  if (shouldApply && entry) {
    state.plugins = state.plugins.filter((item) => !(item.id === id && item.scope === "user"));
    state.plugins.push(entry);
  }
} else if (args.slice(0, 4).join(" ") === "plugin enable --scope user") {
  const id = args[4];
  if (shouldApply) {
    const entry = state.plugins.find((item) => item.id === id && item.scope === "user");
    if (entry) entry.enabled = true;
  }
} else if (args.slice(0, 4).join(" ") === "plugin update --scope user") {
  const entry = state.plugins.find((item) => item.id === args[4] && item.scope === "user");
  const version = state.catalog.versions && state.catalog.versions[args[4]];
  if (shouldApply && entry && version) entry.version = version;
} else if (args.slice(0, 3).join(" ") !== "plugin marketplace update" || args.length !== 4) {
  process.stderr.write("unexpected fake command");
  process.exit(64);
}
save();
if (outcome.stderr) process.stderr.write(outcome.stderr);
process.exit(Number.isInteger(outcome.exit) ? outcome.exit : 0);
`;

interface Marketplace {
  name: string;
  source: string;
  repo: string;
  installLocation: string;
}

interface Plugin {
  id: string;
  version: string;
  scope: string;
  enabled: boolean;
  installPath: string;
  mcpServers: Record<string, unknown>;
}

interface Outcome {
  exit: number;
  apply?: boolean;
  stderr?: string;
}

interface FakeState {
  marketplaces: Marketplace[];
  plugins: Plugin[];
  catalog: { marketplaces: Record<string, Marketplace>; plugins: Record<string, Plugin>; versions?: Record<string, string> };
  outcomes: Record<string, Outcome>;
  pluginListResponses?: unknown[];
  marketplaceListResponses?: unknown[];
}

type Fixture = ReturnType<typeof fixture>;

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-plugin-reconcile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installPath = path.join(root, "plugins", "cache", "alpha");
  fs.mkdirSync(installPath, { recursive: true });
  const marketplace: Marketplace = {
    name: "main",
    source: "github",
    repo: "example/main",
    installLocation: path.join(root, "marketplaces", "main"),
  };
  const plugin: Plugin = {
    id: "alpha@main",
    version: "1.0.0",
    scope: "user",
    enabled: true,
    installPath,
    mcpServers: { example: { env: { TOKEN: SECRET } } },
  };
  const marketplacesManifest = {
    main: { source: { source: "github", repo: "example/main" } },
  };
  const pluginsManifest = {
    enabledPlugins: { "alpha@main": true, "ignored@absent": false } as Record<string, unknown>,
  };
  const state: FakeState = {
    marketplaces: [marketplace],
    plugins: [plugin],
    catalog: {
      marketplaces: { "example/main": marketplace },
      plugins: { "alpha@main": plugin },
    },
    outcomes: {},
  };
  const files = {
    root,
    fake: path.join(root, "fake-claude.js"),
    log: path.join(root, "commands.log"),
    marketplaceManifest: path.join(root, "marketplaces.json"),
    pluginManifest: path.join(root, "plugins.json"),
    state: path.join(root, "state.json"),
  };
  fs.writeFileSync(files.fake, fakeClaudeSource);
  const save = (): void => {
    fs.writeFileSync(files.marketplaceManifest, JSON.stringify(marketplacesManifest));
    fs.writeFileSync(files.pluginManifest, JSON.stringify(pluginsManifest));
    fs.writeFileSync(files.state, JSON.stringify(state, null, 2));
  };
  save();
  return { files, installPath, marketplace, marketplacesManifest, plugin, pluginsManifest, save, state };
}

function invoke(ctx: Fixture, args: string[] = []) {
  return spawnSync(
    process.execPath,
    [subject, ctx.files.marketplaceManifest, ctx.files.pluginManifest, ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        KHEREP_CLAUDE_BIN: process.execPath,
        KHEREP_CLAUDE_BIN_ARGS_JSON: JSON.stringify([ctx.files.fake]),
        FAKE_CLAUDE_LOG: ctx.files.log,
        FAKE_CLAUDE_STATE: ctx.files.state,
      },
    },
  );
}

function output(result: { stdout: string; stderr: string }): string {
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function commands(ctx: Fixture): string[][] {
  if (!fs.existsSync(ctx.files.log)) return [];
  return fs.readFileSync(ctx.files.log, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

function mutations(ctx: Fixture): string[][] {
  return commands(ctx).filter((args) => {
    const command = args.join(" ");
    return command !== "plugin marketplace list --json" && command !== "plugin list --json";
  });
}

test("converged state performs zero mutators and ignores enabled=false", (t) => {
  const ctx = fixture(t);
  const result = invoke(ctx);
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(mutations(ctx), []);
  assert.doesNotMatch(output(result), new RegExp(SECRET));
});

test("manifest omission leaves an old enabled plugin and marketplace untouched", (t) => {
  const ctx = fixture(t);
  const old = { ...ctx.plugin, id: "codex@openai-codex" };
  ctx.state.plugins.push(old);
  ctx.state.marketplaces.push({ ...ctx.marketplace, name: "openai-codex", repo: "openai/codex-plugin-cc" });
  ctx.save();
  const before = fs.readFileSync(ctx.files.state);
  const result = invoke(ctx);
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(mutations(ctx), []);
  assert.deepEqual(fs.readFileSync(ctx.files.state), before, "omission is not a retirement mechanism");
});

test("adds a missing marketplace and installs its missing user plugin", (t) => {
  const ctx = fixture(t);
  ctx.state.marketplaces = [];
  ctx.state.plugins = [];
  ctx.save();
  const result = invoke(ctx);
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(mutations(ctx), [
    ["plugin", "marketplace", "add", "--scope", "user", "example/main"],
    ["plugin", "install", "--scope", "user", "alpha@main"],
  ]);
});

test("enables an installed but disabled user-scope plugin", (t) => {
  const ctx = fixture(t);
  ctx.state.plugins[0].enabled = false;
  ctx.save();
  const result = invoke(ctx);
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(mutations(ctx), [
    ["plugin", "enable", "--scope", "user", "alpha@main"],
  ]);
});

test("malformed manifest fails before any Claude invocation", (t) => {
  const ctx = fixture(t);
  ctx.pluginsManifest.enabledPlugins["alpha@main"] = "yes";
  ctx.save();
  const result = invoke(ctx);
  assert.notEqual(result.status, 0);
  assert.deepEqual(commands(ctx), []);
});

test("malformed list JSON fails without leaking captured content", (t) => {
  const ctx = fixture(t);
  ctx.state.pluginListResponses = [`{not-json:${SECRET}`];
  ctx.save();
  const result = invoke(ctx);
  assert.notEqual(result.status, 0);
  assert.deepEqual(mutations(ctx), []);
  assert.doesNotMatch(output(result), new RegExp(SECRET));
});

test("same marketplace name with another source fails before mutation", (t) => {
  const ctx = fixture(t);
  ctx.state.marketplaces[0].repo = "attacker/other";
  ctx.save();
  const result = invoke(ctx);
  assert.notEqual(result.status, 0);
  assert.match(output(result), /source collision: main/);
  assert.deepEqual(mutations(ctx), []);
});

test("real mutator failure remains nonzero and hides child stderr", (t) => {
  const ctx = fixture(t);
  ctx.state.plugins = [];
  ctx.state.outcomes["plugin install --scope user alpha@main"] = {
    exit: 42,
    apply: false,
    stderr: SECRET,
  };
  ctx.save();
  const result = invoke(ctx);
  assert.notEqual(result.status, 0);
  assert.match(output(result), /install failed without required state/);
  assert.doesNotMatch(output(result), new RegExp(SECRET));
});

test("successful mutator without post-state is rejected", (t) => {
  const ctx = fixture(t);
  ctx.state.plugins = [];
  ctx.state.outcomes["plugin install --scope user alpha@main"] = { exit: 0, apply: false };
  ctx.save();
  const result = invoke(ctx);
  assert.notEqual(result.status, 0);
  assert.match(output(result), /success without installed state/);
});

test("nonzero race is accepted only when the exact state appeared", (t) => {
  const ctx = fixture(t);
  ctx.state.plugins = [];
  ctx.state.outcomes["plugin install --scope user alpha@main"] = {
    exit: 17,
    apply: true,
    stderr: SECRET,
  };
  ctx.save();
  const result = invoke(ctx);
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /converged after nonzero response/);
  assert.doesNotMatch(output(result), new RegExp(SECRET));
});

test("fresh final snapshot rejects a vanished or unusable installPath", (t) => {
  const ctx = fixture(t);
  const unusable = { ...ctx.plugin, installPath: path.join(ctx.files.root, "missing") };
  ctx.state.pluginListResponses = [[ctx.plugin], [unusable]];
  ctx.save();
  const result = invoke(ctx);
  assert.notEqual(result.status, 0);
  assert.match(output(result), /required plugin is not usable/);
  assert.deepEqual(mutations(ctx), []);
});

// Scopes Kherep does not manage (issue #338). `synced` rows come from claude.ai
// and are read for duplicate detection only; an unknown scope is skipped with
// one warning. Neither ever receives a mutator.
function syncedRow(ctx: Fixture, id: string, scope = "synced"): Plugin {
  return { ...ctx.plugin, id, scope, installPath: path.join(ctx.files.root, "synced", id) };
}

test("synced rows reconcile without FATAL, without a warning and without a mutator", (t) => {
  const ctx = fixture(t);
  ctx.state.plugins.push(syncedRow(ctx, "design@synced"), syncedRow(ctx, "forge-skills@synced"));
  ctx.save();
  const result = invoke(ctx);
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(mutations(ctx), []);
  assert.doesNotMatch(output(result), /malformed|not managed/);
});

test("an unknown future scope is skipped with one warning naming scope and id", (t) => {
  const ctx = fixture(t);
  ctx.state.plugins.push(syncedRow(ctx, "beta@org", "org"), syncedRow(ctx, "gamma@org", "org"));
  ctx.save();
  const result = invoke(ctx);
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(mutations(ctx), []);
  const warnings = output(result).split(/\r?\n/).filter((line) => /not managed/.test(line));
  assert.equal(warnings.length, 1, output(result));
  assert.match(warnings[0], /scope org: beta@org, gamma@org/);
});

test("a malformed row stays fatal before any mutator", (t) => {
  const ctx = fixture(t);
  ctx.state.plugins = [{ ...syncedRow(ctx, "design@synced"), scope: 42 as unknown as string }];
  ctx.save();
  const result = invoke(ctx);
  assert.notEqual(result.status, 0);
  assert.match(output(result), /malformed entry/);
  assert.deepEqual(mutations(ctx), []);
});

test("a declared plugin present only as a synced row gets its own user-scope install; the synced row is untouched", (t) => {
  const ctx = fixture(t);
  const synced = syncedRow(ctx, "alpha@main");
  ctx.state.plugins = [synced];
  ctx.save();
  const result = invoke(ctx);
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(mutations(ctx), [["plugin", "install", "--scope", "user", "alpha@main"]]);
  const final = JSON.parse(fs.readFileSync(ctx.files.state, "utf8")) as FakeState;
  assert.deepEqual(final.plugins.filter((item) => item.scope === "synced"), [synced]);
});

// Issue #1010. With the version manifest, an installed plugin that is not at the
// reviewed version is raised; the marketplace is refreshed once, before the update.
function invokeRaise(ctx: Fixture, versions: Record<string, unknown>, claudeHome = ctx.files.root) {
  const file = path.join(ctx.files.root, "plugin-versions.json");
  fs.writeFileSync(file, JSON.stringify({ versions }));
  return invoke(ctx, [file, claudeHome]);
}

const MARKETPLACE_UPDATE = ["plugin", "marketplace", "update", "main"];
const update = (id: string): string[] => ["plugin", "update", "--scope", "user", id];

test("a converged host performs zero mutators with the version manifest too", (t) => {
  const ctx = fixture(t);
  const result = invokeRaise(ctx, { "alpha@main": "1.0.0", "absent@main": "2.0.0" });
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(mutations(ctx), []);
});

test("plugins behind the reviewed version are raised after one marketplace update, and a second run is quiet", (t) => {
  const ctx = fixture(t);
  ctx.state.plugins.push({ ...ctx.plugin, id: "beta@main", version: "aaaaaaaaaaaa", enabled: false });
  ctx.state.catalog.versions = { "alpha@main": "1.2.0", "beta@main": "bbbbbbbbbbbb" };
  ctx.save();
  const reviewed = { "alpha@main": "1.2.0", "beta@main": "bbbbbbbbbbbb" };
  const result = invokeRaise(ctx, reviewed);
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(mutations(ctx), [MARKETPLACE_UPDATE, update("alpha@main"), update("beta@main")]);
  assert.match(output(result), /raised plugin alpha@main from 1\.0\.0 to 1\.2\.0 \(reviewed 1\.2\.0\)/);
  const state = JSON.parse(fs.readFileSync(ctx.files.state, "utf8")) as FakeState;
  assert.equal(state.plugins.find((item) => item.id === "beta@main")?.enabled, false, "a raise enables nothing");
  fs.rmSync(ctx.files.log);
  const second = invokeRaise(ctx, reviewed);
  assert.equal(second.status, 0, output(second));
  assert.deepEqual(mutations(ctx), []);
});

test("an update that fails without a change is reported after every plugin was attempted", (t) => {
  const ctx = fixture(t);
  ctx.state.plugins.push({ ...ctx.plugin, id: "beta@main" });
  ctx.state.catalog.versions = { "beta@main": "2.0.0" };
  ctx.state.outcomes[update("alpha@main").join(" ")] = { exit: 1, apply: false, stderr: SECRET };
  ctx.save();
  const result = invokeRaise(ctx, { "alpha@main": "2.0.0", "beta@main": "2.0.0" });
  assert.equal(result.status, 1);
  assert.deepEqual(mutations(ctx), [MARKETPLACE_UPDATE, update("alpha@main"), update("beta@main")]);
  assert.match(output(result), /FATAL: plugin not raised: alpha@main \(installed 1\.0\.0, reviewed 2\.0\.0\)$/m);
  assert.doesNotMatch(output(result), new RegExp(SECRET));
});

test("a plugin installed outside the Claude home of this run is never raised", (t) => {
  const ctx = fixture(t);
  ctx.state.catalog.versions = { "alpha@main": "2.0.0" };
  ctx.save();
  const candidate = path.join(ctx.files.root, "candidate");
  fs.mkdirSync(candidate);
  const result = invokeRaise(ctx, { "alpha@main": "2.0.0" }, candidate);
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(mutations(ctx), []);
  assert.match(output(result), /not raised, installed outside this Claude home: alpha@main/);
});

test("without the version manifest nothing is raised", (t) => {
  const ctx = fixture(t);
  ctx.state.catalog.versions = { "alpha@main": "2.0.0" };
  ctx.save();
  assert.equal(invoke(ctx).status, 0);
  assert.deepEqual(mutations(ctx), []);
});

test("a missing or malformed version manifest, or one without its home, fails before any Claude invocation", (t) => {
  const ctx = fixture(t);
  for (const args of [[path.join(ctx.files.root, "absent.json"), ctx.files.root], [ctx.files.pluginManifest, ctx.files.root],
    [ctx.files.pluginManifest], [ctx.files.pluginManifest, ctx.files.root, "extra"]]) {
    const result = invoke(ctx, args);
    assert.equal(result.status, 1, output(result));
    assert.match(output(result), /FATAL: (?:cannot read plugin versions manifest|plugin version manifest must contain|usage: )/);
  }
  assert.deepEqual(commands(ctx), []);
});
