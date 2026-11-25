import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { readJson } from "./capability-check.mts";
import { activeMcpEntries, allMcpEntries, hasCredentialArg } from "./capability-mcp.mts";

test("credential matcher detects common argv secret transports", () => {
  const unsafe = [
    { command: "npx", args: ["supergateway", "--oauth2Bearer", "opaque-value"] },
    { command: "npx", args: ["tool", "--header", "X-API-Key: opaque-value"] },
    { command: "sh", args: ["-lc", "tool --token opaque-value"] },
    { command: "tool", args: ["https://example.test/mcp?access_token=opaque-value"] },
    { command: "tool", args: ["API_KEY=opaque-value"] },
    { command: "tool", args: ["https://user:password@example.test/mcp"] },
    { command: "tool", args: [`${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`] },
  ];
  unsafe.forEach((server) => assert.equal(hasCredentialArg(server), true, JSON.stringify(server)));
});

test("credential matcher avoids long-hostname and native-header false positives", () => {
  assert.equal(hasCredentialArg({
    command: "tool",
    args: ["https://longsubdomain.longcompanyname.longinternaldomain.example/mcp", "--header", "Accept: application/json"],
  }), false);
  assert.equal(hasCredentialArg({
    type: "http",
    url: "https://example.test/mcp",
    headers: { Authorization: "Bearer stored-outside-argv" },
  }), false);
});

test("credential matcher fails closed for malformed command arguments", () => {
  assert.equal(hasCredentialArg({ command: "tool", args: "--token opaque" }), true);
  assert.equal(hasCredentialArg({ command: "tool", args: [42] }), true);
  assert.equal(hasCredentialArg({ command: { nested: true }, args: [] }), true);
});

test("active names merge exact registry project and supplemental MCP files", () => {
  const config = {
    mcpServers: { shared: { command: "global" }, overridden: { command: "global" } },
    projects: {
      "/workspace": { mcpServers: { overridden: { command: "project" }, exact: { command: "exact" } } },
      "/inactive": { mcpServers: { inactive: { command: "inactive" } } },
    },
  };
  const active = activeMcpEntries(config, "/workspace", [
    { source: "workspace", value: { mcpServers: { projectFile: { command: "file" } } } },
  ]);
  assert.deepEqual([...active.keys()].sort(), ["exact", "overridden", "projectFile", "shared"]);
  assert.deepEqual(active.get("overridden"), { command: "project" });
});

test("host-wide argv audit retains inactive and shadowed registry definitions", () => {
  const config = {
    mcpServers: { duplicate: { command: "global" } },
    projects: {
      "/inactive": { mcpServers: { duplicate: { command: "unsafe" }, inactive: { command: "unsafe" } } },
    },
  };
  const entries = allMcpEntries(config, [
    { source: "workspace", value: { mcpServers: { fileServer: { command: "file" } } } },
  ]);
  assert.deepEqual(entries.map(({ source, name }) => `${source}:${name}`).sort(), [
    "registry-project:duplicate",
    "registry-project:inactive",
    "user:duplicate",
    "workspace:fileServer",
  ]);
});

test("JSON parser errors never reproduce adjacent file content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-json-"));
  const sentinel = "SENTINEL_SECRET_MUST_NOT_APPEAR";
  const file = path.join(root, "broken.json");
  try {
    fs.writeFileSync(file, `{"token":"${sentinel}"`);
    assert.throws(() => readJson(file), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid JSON file broken\.json/);
      assert.doesNotMatch(error.message, new RegExp(sentinel));
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("source-only capability check does not require operator plugin enablement", () => {
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "capability-check.mts"), "win", "--source-only"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS \| plugin contract equals install manifest/);
  assert.doesNotMatch(result.stdout, /plugin contract equals settings/);
});

// Issue #906: a frontmatter name is the first non-blank text after "name:", on the
// same or a later line. The live owned-agent check reads it; a synthetic home only.
test("live owned agents are named by their frontmatter, a name on a later line included", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-names-"));
  try {
    const preload = path.join(root, "cpu-preload.mjs");
    const cpuFile = path.join(root, "cpu-ms");
    fs.writeFileSync(preload, `import fs from "node:fs";
process.on("exit", () => {
  const usage = process.cpuUsage();
  fs.writeFileSync(process.env.KHEREP_TEST_CPU_FILE, String((usage.user + usage.system) / 1000));
});
`);
    function cpuMs(run: () => void): number {
      fs.rmSync(cpuFile, { force: true });
      run();
      try {
        const raw = fs.readFileSync(cpuFile, "utf8");
        const value = Number(raw);
        return /^\d+(?:\.\d+)?$/.test(raw) && Number.isFinite(value) ? value : NaN;
      } catch {
        return NaN;
      }
    }

    const claudeHome = path.join(root, ".claude");
    fs.mkdirSync(path.join(claudeHome, "agents"), { recursive: true });
    fs.mkdirSync(path.join(claudeHome, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, "settings.json"), "{}");
    fs.writeFileSync(path.join(claudeHome, "plugins", "installed_plugins.json"), "{}");
    fs.writeFileSync(path.join(root, ".claude.json"), "{}");
    fs.writeFileSync(path.join(claudeHome, "agents", "kherep-builder.md"), "---\nname:\n\n  kherep-builder\n---\n");
    fs.writeFileSync(path.join(claudeHome, "agents", "dc-plugin-build-runner.md"), "name:   ");
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_HOME: claudeHome };
    for (const key of ["KHEREP_USER_HOME", "KHEREP_WORKSPACE", "KHEREP_PROFILE", "CAPABILITY_STRICT"]) delete env[key];
    const check = () => {
      const result = spawnSync(process.execPath, [
        "--import", pathToFileURL(preload).href, path.join(import.meta.dirname, "capability-check.mts"), "--live", "--profile", "mac",
      ], { encoding: "utf8", env: { ...env, KHEREP_TEST_CPU_FILE: cpuFile } });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /^PASS \| live owned agent kherep-builder$/m);
      assert.match(result.stdout, /^FAIL \| live owned agent dc-plugin-build-runner$/m);
      return result.stdout;
    };
    // Subtract the short run's CPU time to account for CLI startup (#992).
    const control = cpuMs(check);
    fs.writeFileSync(path.join(claudeHome, "agents", "forge-deploy-validator.md"), `name:${"\n".repeat(100_000)}`);
    const subject = cpuMs(() => assert.match(check(), /^FAIL \| live owned agent forge-deploy-validator$/m));
    const beyond = subject - control;
    const diagnostic = `CPU frontmatter name control=${control} subject=${subject} delta=${beyond}`;
    console.log(diagnostic);
    assert.ok(beyond < 2000, `${diagnostic} (limit 2000 ms)`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Issue #1010. An optional plugin is managed: present it is information, absent
// it is nothing, and --strict fails on neither.
test("an installed optional plugin is information, never an unexpected plugin", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-optional-"));
  try {
    const claudeHome = path.join(root, ".claude");
    const id = "claude-security@claude-plugins-official";
    fs.mkdirSync(path.join(claudeHome, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude.json"), "{}");
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_HOME: claudeHome };
    for (const key of ["KHEREP_USER_HOME", "KHEREP_WORKSPACE", "KHEREP_PROFILE", "CAPABILITY_STRICT"]) delete env[key];
    const run = (present: boolean): string => {
      fs.writeFileSync(path.join(claudeHome, "settings.json"), JSON.stringify({ enabledPlugins: present ? { [id]: true } : {} }));
      fs.writeFileSync(path.join(claudeHome, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: present ? { [id]: [] } : {} }));
      const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "capability-check.mts"), "--live", "--strict", "--profile", "mac"],
        { encoding: "utf8", env });
      return result.stdout.split(/\r?\n/).filter((line) => line.includes(id)).join("\n");
    };
    assert.equal(run(true), `INFO | optional plugin present | ${id}`);
    assert.equal(run(false), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the optional plugin contract matches its manifest in the source check", () => {
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "capability-check.mts"), "--profile", "mac"], { encoding: "utf8" });
  assert.match(result.stdout, /^PASS \| optional plugin contract equals optional manifest$/m);
});
