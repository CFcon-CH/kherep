import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAgentInventory } from "./model-agent-inventory.mts";
import { fixtureModels, policyText } from "./model-policy.fixture.mts";
import { buildCatalogSupport, parseModelPolicy, resolveEffectiveSelections, resolveModels } from "./model-policy.mts";
import { parseUserModelPolicy } from "./model-policy-user.mts";
import { strictStartSelection } from "./start-model-policy.mts";

const digest = "1".repeat(64);
const inventory = buildAgentInventory([{ sourcePath: "claude/agents/kherep-builder.md", sourceProvider: "kherep", installedName: "kherep-builder",
  role: "builder", sourceSha256: digest, securityPolicyDigest: digest, codeBound: true }]);
const policy = parseModelPolicy(policyText);
const models = fixtureModels.map((row) => row.model === "gpt-6-luna" ? { ...row, id: "fixture-luna-alias" } : row);
const catalog = buildCatalogSupport({ complete: true, models });
const noUser = parseUserModelPolicy(undefined, inventory);
const current = resolveEffectiveSelections({ catalog, policy, inventory, user: noUser });

test("keeps eligible alternate-family pins and gives each managed agent its own supported effort", () => {
  const user = parseUserModelPolicy(JSON.stringify({
    roles: { builder: { model: "fixture-luna-alias", effort: "medium" } },
    agents: { "kherep-builder": { model: "gpt-5.6-terra", effort: "low" } },
  }), inventory);
  const next = resolveEffectiveSelections({ catalog, policy, inventory, user });
  assert.deepEqual(next.roles.builder.effective, { model: "gpt-6-luna", effort: "medium" });
  assert.deepEqual(next.agents[0]!.effective, { model: "gpt-5.6-terra", effort: "low" });
  assert.doesNotThrow(() => strictStartSelection(catalog, current, policy, user)(next));
});

test("rejects a proposed older role or changed managed agent membership and defaults", () => {
  const validate = strictStartSelection(catalog, current, policy, noUser);
  const olderRole = structuredClone(current);
  olderRole.roles.builder.effective.model = "gpt-6.9-sol";
  assert.throws(() => validate(olderRole), { message: "codex-start-latest-selection-conflict" });
  assert.throws(() => validate({ ...current, agents: [] }), { message: "codex-start-latest-selection-conflict" });
  const differentAgent = structuredClone(current);
  differentAgent.agents[0]!.effective.effort = "low";
  assert.throws(() => validate(differentAgent), { message: "codex-start-latest-selection-conflict" });
  const changedDefault = structuredClone(current);
  changedDefault.roles.builder.defaultRealization.effort = "low";
  assert.throws(() => validate(changedDefault), { message: "codex-start-effort-default-changed" });
});

test("an equal numeric stable generation in the legacy resolver remains ambiguous", () => {
  const alias = { ...fixtureModels[0]!, id: "gpt-6.0-astra", model: "gpt-6.0-astra" };
  assert.throws(() => resolveModels(policy, { complete: true, models: [...fixtureModels, alias] }), /Ambiguous model generation for family astra/);
});
