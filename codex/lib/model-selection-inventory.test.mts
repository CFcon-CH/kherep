import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type { SourceReader } from "./model-selection-git.mts";
import { buildSelectionInventory, readSourceSnapshot, securityPolicyDigest } from "./model-selection-inventory.mts";
import { planAgentNames } from "./parity-projection.mts";

function reader(files: Record<string, string>): SourceReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    read(relative) {
      reads.push(relative);
      if (!Object.hasOwn(files, relative)) throw new Error(`absent ${relative}`);
      return files[relative]!;
    },
    list(directory) {
      return Object.keys(files).filter((file) => file.startsWith(`${directory}/`) && !file.slice(directory.length + 1).includes("/"))
        .map((file) => file.slice(directory.length + 1)).sort();
    },
  };
}
const capabilities = (agents: object, plugins: object[] = []) => JSON.stringify({ agents, plugins });
const base = {
  "codex/parity/model-policy.toml": "policy\n",
  "claude/agents/kherep-builder.md": "---\nmodel: opus\n---\nBuild.\n",
  "codex/agents/codex-obs.md": "Observe.\n",
};

test("Kherep and plugin agents are classified by the adapter in one stable order", () => {
  const files = { ...base,
    "codex/parity/capabilities.json": capabilities({
      "kherep-builder": { role: "builder", codeBound: true },
      "claude-obs": { as: "codex-obs", source: "codex/agents/codex-obs.md", sandbox: "read-only", role: "observer" },
    }, [{ id: "feature-dev@claude-plugins-official", mode: "project" }, { id: "skills-only@x", mode: "native" },
      { id: "code-simplifier@claude-plugins-official", mode: "agent" }]),
    "codex/parity/plugin-sources/manifest.json": JSON.stringify({ plugins: [
      { id: "feature-dev@claude-plugins-official", path: "feature-dev" }, { id: "code-simplifier@claude-plugins-official", path: "simplifier" }] }),
    "codex/parity/plugin-sources/feature-dev/agents/code-reviewer.md": "---\nmodel: sonnet\n---\nReview.\n",
    "codex/parity/plugin-sources/feature-dev/agents/code-architect.md": "---\nmodel: opus\n---\nDesign.\n",
    "codex/parity/plugin-sources/feature-dev/agents/README.txt": "not an agent\n",
    "codex/parity/plugin-sources/simplifier/agents/code-simplifier.md": "Simplify.\n",
  };
  const snapshot = readSourceSnapshot(reader(files));
  assert.equal(snapshot.policyText, "policy\n");
  assert.deepEqual(snapshot.rows.map((row) => [row.bindingId, row.preferredName, row.role, row.codeBound, row.sandbox, row.capabilityKey]), [
    ["kherep:claude/agents/kherep-builder.md", "kherep-builder", "builder", true, null, "kherep-builder"],
    ["kherep:codex/agents/codex-obs.md", "codex-obs", "observer", false, "read-only", "claude-obs"],
    ["feature-dev@claude-plugins-official:codex/parity/plugin-sources/feature-dev/agents/code-architect.md", "code-architect", "designer", false, null, undefined],
    ["feature-dev@claude-plugins-official:codex/parity/plugin-sources/feature-dev/agents/code-reviewer.md", "code-reviewer", "support", false, null, undefined],
    ["code-simplifier@claude-plugins-official:codex/parity/plugin-sources/simplifier/agents/code-simplifier.md", "code-simplifier", "builder", false, null, undefined],
  ]);
  const names = new Map(snapshot.rows.map((row) => [row.bindingId, row.preferredName]));
  const inventory = buildSelectionInventory(snapshot.rows, names);
  const observer = inventory.agents.find((agent) => agent.sourceAgentId === "codex-obs")!;
  assert.equal(observer.securityPolicyDigest, securityPolicyDigest({ sandbox: "read-only", codeBound: false }));
  assert.notEqual(observer.securityPolicyDigest, securityPolicyDigest({ sandbox: null, codeBound: false }));
  assert.equal(observer.sourceSha256, createHash("sha256").update("Observe.\n").digest("hex"));
  assert.throws(() => buildSelectionInventory(snapshot.rows, new Map()), /alias-missing/);
});

test("a manifest without projected plugins never reads the plugin manifest", () => {
  const source = reader({ ...base, "codex/parity/capabilities.json": capabilities({ "kherep-builder": { role: "builder" } }, [{ id: "native@x", mode: "native" }]) });
  assert.equal(readSourceSnapshot(source).rows.length, 1);
  assert.ok(!source.reads.some((file) => file.includes("plugin-sources")));
});

test("unclassifiable manifests and plugin manifests fail closed", () => {
  const bad = (overrides: Record<string, string>) => () => readSourceSnapshot(reader({ ...base, ...overrides }));
  assert.throws(bad({ "codex/parity/capabilities.json": capabilities({ "kherep-builder": { role: "wizard" } }) }), /unknown-role/);
  assert.throws(bad({ "codex/parity/capabilities.json": capabilities({ "kherep-builder": null }) }), /unknown-role/);
  assert.throws(bad({ "codex/parity/capabilities.json": JSON.stringify({ agents: {} }) }), /manifest/);
  assert.throws(bad({ "codex/parity/capabilities.json": "[]" }), /manifest/);
  const plugin = capabilities({}, [{ id: "p@x", mode: "agent" }]);
  assert.throws(bad({ "codex/parity/capabilities.json": plugin, "codex/parity/plugin-sources/manifest.json": "{}" }), /plugin-manifest/);
  assert.throws(bad({ "codex/parity/capabilities.json": plugin, "codex/parity/plugin-sources/manifest.json": JSON.stringify({ plugins: [{ id: "other@x", path: "o" }] }) }), /plugin-manifest/);
  assert.throws(bad({ "codex/parity/capabilities.json": plugin, "codex/parity/plugin-sources/manifest.json": JSON.stringify({ plugins: [null, { id: "p@x" }] }) }), /plugin-manifest/);
});

test("the name plan keeps Kherep names and renames a colliding plugin agent", () => {
  const rows = readSourceSnapshot(reader({ ...base,
    "codex/parity/capabilities.json": capabilities({ "kherep-builder": { role: "builder" } }, [{ id: "feature-dev@claude-plugins-official", mode: "project" }]),
    "codex/parity/plugin-sources/manifest.json": JSON.stringify({ plugins: [{ id: "feature-dev@claude-plugins-official", path: "f" }] }),
    "codex/parity/plugin-sources/f/agents/kherep-builder.md": "---\nmodel: haiku\n---\nResearch.\n" })).rows;
  const names = planAgentNames(rows, "/nonexistent/kherep-codex-home");
  assert.deepEqual([...names.values()], ["kherep-builder", "feature-dev-kherep-builder"]);
});
