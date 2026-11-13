import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { canonicalizeOwnedRegistryTable } from "./mcp-legacy-repair.mts";

const START = "# >>> Kherep Codex Maestro >>>";
const END = "# <<< Kherep Codex Maestro <<<";
const root = path.resolve("fixture root");
const node = path.join(root, "runtime", process.platform === "win32" ? "node.exe" : "node");
const bridge = path.join(root, "orchestra", "registry-http-bridge.mts");

function table(extraEnv = ""): string {
  return [
    "[mcp_servers.legacy] # operator note",
    "enabled = false",
    "required = true",
    `command = ${JSON.stringify(node)}`,
    `args = [${JSON.stringify(bridge)}]`,
    `env = { LEGACY_MCP_REGISTRY_FILE = "private-registry", LEGACY_MCP_SERVER_NAME = "legacy-source", LEGACY_MCP_ALLOW_INSECURE_HTTP = "1"${extraEnv} }`,
    "startup_timeout_sec = 91.0",
    "tool_timeout_sec = 92.0",
    "",
    "[mcp_servers.legacy.tools.search]",
    'approval_mode = "prompt"',
    "",
  ].join("\n");
}

function subtable(extraEnv = ""): string {
  return [
    "[mcp_servers.legacy]",
    "enabled = false",
    `command = ${JSON.stringify(node)}`,
    `args = [${JSON.stringify(bridge)}]`,
    "startup_timeout_sec = 91.0",
    "tool_timeout_sec = 92.0",
    "",
    "[mcp_servers.legacy.env]",
    'LEGACY_MCP_ALLOW_INSECURE_HTTP = "1"',
    'LEGACY_MCP_REGISTRY_FILE = "private-registry"',
    `LEGACY_MCP_SERVER_NAME = "legacy-source"${extraEnv}`,
    "",
  ].join("\n");
}

test("canonicalizes only env keys in an owned wrapper and preserves all local policy", () => {
  const config = [table(), "[mcp_servers.custom]", 'url = "https://custom.example.invalid/mcp"', ""].join("\n");
  const result = canonicalizeOwnedRegistryTable(config, {
    name: "legacy", expectedNode: node, expectedBridge: bridge,
    expectedRegistry: "private-registry", expectedSourceName: "legacy-source",
    oldPrefix: "LEGACY_", newPrefix: "KHEREP_", startMarker: START, endMarker: END,
  });
  assert.equal(result.migrated, true);
  assert.doesNotMatch(result.config, /LEGACY_MCP_/);
  for (const suffix of ["REGISTRY_FILE", "SERVER_NAME", "ALLOW_INSECURE_HTTP"]) {
    assert.match(result.config, new RegExp(`KHEREP_MCP_${suffix}`));
  }
  assert.match(result.config, /enabled = false/);
  assert.match(result.config, /startup_timeout_sec = 91\.0/);
  assert.match(result.config, /\[mcp_servers\.legacy\.tools\.search\]/);
  assert.match(result.config, /url = "https:\/\/custom\.example\.invalid\/mcp"/);
});

test("canonicalizes the native Codex env subtable independent of key order", () => {
  const config = subtable();
  const result = canonicalizeOwnedRegistryTable(config, {
    name: "legacy", expectedNode: node, expectedBridge: bridge,
    expectedRegistry: "private-registry", expectedSourceName: "legacy-source",
    oldPrefix: "LEGACY_", newPrefix: "KHEREP_", startMarker: START, endMarker: END,
  });

  assert.equal(result.migrated, true);
  assert.match(result.config, /\[mcp_servers\.legacy\.env\]/);
  assert.doesNotMatch(result.config, /LEGACY_MCP_/);
  assert.equal((result.config.match(/KHEREP_MCP_/g) || []).length, 3);
  assert.match(result.config, /enabled = false/);
  assert.match(result.config, /tool_timeout_sec = 92\.0/);
});

test("preserves wrappers that are not unambiguously owned", () => {
  for (const config of [
    table().replace(JSON.stringify(node), JSON.stringify(path.join(root, "other-runtime"))),
    table(', EXTRA = "keep"'),
    table().replace(`args = [${JSON.stringify(bridge)}]`, `args = [${JSON.stringify(bridge)}, "extra"]`),
    subtable('\nEXTRA = "keep"'),
    subtable().replace('"private-registry"', '"other-registry"'),
  ]) {
    assert.deepEqual(canonicalizeOwnedRegistryTable(config, {
      name: "legacy", expectedNode: node, expectedBridge: bridge,
      expectedRegistry: "private-registry", expectedSourceName: "legacy-source",
      oldPrefix: "LEGACY_", newPrefix: "KHEREP_", startMarker: START, endMarker: END,
    }), { config, migrated: false });
  }
});

test("does not touch an owned-looking table inside the managed block", () => {
  const config = [START, table(), END, ""].join("\n");
  assert.deepEqual(canonicalizeOwnedRegistryTable(config, {
    name: "legacy", expectedNode: node, expectedBridge: bridge,
    expectedRegistry: "private-registry", expectedSourceName: "legacy-source",
    oldPrefix: "LEGACY_", newPrefix: "KHEREP_", startMarker: START, endMarker: END,
  }), { config, migrated: false });
});

// Issue #906: an inline env item takes one optional leading comma; the accepted forms are unchanged.
test("inline env items with and without blanks around their commas", () => {
  const options = {
    name: "legacy", expectedNode: node, expectedBridge: bridge,
    expectedRegistry: "private-registry", expectedSourceName: "legacy-source",
    oldPrefix: "LEGACY_", newPrefix: "KHEREP_", startMarker: START, endMarker: END,
  };
  const env = (items: string) => table().replace(/^env = \{.*\}$/m, () => `env = {${items}}`);
  const R = 'LEGACY_MCP_REGISTRY_FILE = "private-registry"', S = "LEGACY_MCP_SERVER_NAME = 'legacy-source'";
  const A = 'LEGACY_MCP_ALLOW_INSECURE_HTTP = "1"';
  for (const items of [` ,  ${R}, ${S}, ${A} `, `${R.replaceAll(" ", "")},${S} , ${A}`]) {
    assert.equal(canonicalizeOwnedRegistryTable(env(items), options).migrated, true, items);
  }
  for (const items of [`${R},, ${S}, ${A}`, `${R} ${S}, ${A}`]) {
    assert.equal(canonicalizeOwnedRegistryTable(env(items), options).migrated, false, items);
  }
  const started = performance.now();
  assert.equal(canonicalizeOwnedRegistryTable(env(`${" ".repeat(100_000)}! `), options).migrated, false);
  assert.ok(performance.now() - started < 200, "linear on a long blank run");
});
