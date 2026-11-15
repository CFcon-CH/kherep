import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentInventory, type AgentSourceInput } from "./model-agent-inventory.mts";

const digest = "a".repeat(64);
const observer: AgentSourceInput = { sourcePath: "codex/agents/codex-obs.md", sourceProvider: "kherep",
  installedName: "codex-obs", capabilityKey: "claude-obs", role: "observer", securityPolicyDigest: digest, sourceSha256: digest, codeBound: false };

test("source basename, legacy capability key and installed collision alias remain distinct", () => {
  const input = [{ ...observer, installedName: "personal-codex-obs" }];
  const before = structuredClone(input);
  const actual = buildAgentInventory(input);
  assert.equal(actual.agents[0]!.sourceAgentId, "codex-obs");
  assert.equal(actual.agents[0]!.capabilityKey, "claude-obs");
  assert.equal(actual.agents[0]!.installedName, "personal-codex-obs");
  assert.equal(actual.bySourceId.has("personal-codex-obs"), false);
  assert.deepEqual(input, before);
  assert.match(actual.digest, /^[a-f0-9]{64}$/);
});

test("provider collisions retain distinct identities while aliases and source bindings must be unique", () => {
  const other = { ...observer, sourcePath: "plugins/example/agents/codex-obs.md", sourceProvider: "example@plugins", installedName: "example-codex-obs" };
  const inventory = buildAgentInventory([observer, other]);
  assert.equal(inventory.bySourceId.get("codex-obs")!.length, 2);
  assert.notEqual(inventory.agents[0]!.bindingId, inventory.agents[1]!.bindingId);
  assert.equal(inventory.digest, buildAgentInventory([other, observer]).digest);
  assert.throws(() => buildAgentInventory([observer, { ...other, installedName: "codex-obs" }]), /duplicate-installed-name/);
  assert.throws(() => buildAgentInventory([observer, { ...observer, installedName: "another" }]), /duplicate-source-binding/);
});

test("inventory rejects unsafe paths, identity tokens and adapter-owned classification corruption", () => {
  for (const change of [{ sourcePath: "../agents/x.md" }, { sourcePath: "/private/x.md" },
    { sourcePath: "C:\\private\\x.md" }, { sourcePath: "agents/__proto__.md" },
    { installedName: "../escape" }, { sourceProvider: "provider:injected" },
    { role: "authority" }, { securityPolicyDigest: "invalid" }, { sourceSha256: "invalid" }, { codeBound: "yes" }]) {
    assert.throws(() => buildAgentInventory([{ ...observer, ...change } as AgentSourceInput]), /agent-inventory/);
  }
  assert.throws(() => buildAgentInventory([{ ...observer, permissions: ["all"] } as AgentSourceInput]), /unknown-field/);
});

test("F6 installed aliases reject case-insensitive NTFS and APFS collisions", () => {
  const other = { ...observer, sourcePath: "plugins/example/agents/other.md", sourceProvider: "example@plugins" };
  for (const names of [["Observer", "observer"], ["OBSERVER", "Observer"]]) {
    assert.throws(() => buildAgentInventory([{ ...observer, installedName: names[0]! },
      { ...other, installedName: names[1]! }]), /duplicate-installed-name/);
  }
  assert.equal(buildAgentInventory([{ ...observer, installedName: "Observer" }, { ...other, installedName: "Observer-2" }]).agents.length, 2);
});
