import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  dispatchIssue, dispatchWarning, loadModelPolicy, ModelPolicyError, policyFiles, POLICY_DIR, type PolicyFiles,
} from "./model-policy.mts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "model-policy-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const SHIPPED = fs.readFileSync(path.join(POLICY_DIR, "model-policy.json"), "utf8");
const NO_ENV = {};
let count = 0;

// A policy directory with the shipped default and, optionally, a user file.
function dir(user?: unknown, shipped: string = SHIPPED): PolicyFiles {
  const root = path.join(TMP, String(count++));
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "model-policy.json"), shipped);
  if (user !== undefined) fs.writeFileSync(path.join(root, "model-policy.user.json"), typeof user === "string" ? user : JSON.stringify(user));
  return policyFiles(root);
}

function load(user?: unknown, env: Record<string, string | undefined> = NO_ENV, shipped?: string) {
  return loadModelPolicy({ files: dir(user, shipped), env });
}

function rejects(user: unknown, key: RegExp | null, env: Record<string, string | undefined> = NO_ENV): ModelPolicyError {
  let caught: unknown;
  try { load(user, env); } catch (error) { caught = error; }
  assert.ok(caught instanceof ModelPolicyError, `expected a ModelPolicyError for ${JSON.stringify(user)}`);
  if (key) assert.match(caught.key, key);
  return caught;
}

test("the shipped default resolves today's mapping and the observer default effort medium", () => {
  const policy = load();
  assert.deepEqual([...policy.roles.keys()], ["root", "designer", "builder", "support", "researcher", "observer", "broker"]);
  const observer = policy.roles.get("observer")!;
  assert.deepEqual([observer.model, observer.effort], ["haiku", "medium"]);
  const pairs = Object.fromEntries([...policy.agents].map(([agent, c]) => [agent, [c.model, c.effort]]));
  assert.deepEqual(pairs, {
    "kherep-builder": ["opus", undefined], "forge-deploy-validator": ["sonnet", undefined],
    "n8n-workflow-deploy-runner": ["sonnet", undefined], "dc-plugin-build-runner": ["sonnet", undefined],
    "win-agent": ["haiku", undefined], "mac-agent": ["haiku", undefined],
    "lmstudio-win-researcher": ["haiku", undefined], "lmstudio-mac-researcher": ["haiku", undefined],
    "claude-obs": ["haiku", "medium"], "atlassian-broker": ["haiku", undefined],
  });
  assert.deepEqual(policy.warnings, []);
});

test("every shipped agent key is a stable source agent name (claude/agents/<name>.md)", () => {
  const sources = new Set(fs.readdirSync(path.join(POLICY_DIR, "..", "agents")).map((f) => f.replace(/\.md$/, "")));
  for (const agent of load().agents.keys()) assert.ok(sources.has(agent), agent);
});

test("precedence is per field: shipped role < shipped agent < user role < user agent", () => {
  const shipped = JSON.parse(SHIPPED);
  shipped.agents["kherep-builder"] = { role: "builder", effort: "high" };
  const text = JSON.stringify(shipped);
  const both = loadModelPolicy({ files: dir({ roles: { builder: { model: "sonnet" } } }, text), env: NO_ENV }).agents.get("kherep-builder")!;
  assert.equal(both.model, "sonnet", "user role model beats the shipped role");
  assert.equal(both.effort, "high", "a missing user field inherits the shipped agent effort");
  const roleEffort = loadModelPolicy({ files: dir({ roles: { builder: { effort: "low" } } }, text), env: NO_ENV }).agents.get("kherep-builder")!;
  assert.deepEqual([roleEffort.model, roleEffort.effort], ["opus", "low"], "user role effort beats the shipped agent effort");
  const agent = loadModelPolicy({
    files: dir({ roles: { builder: { model: "sonnet", effort: "low" } }, agents: { "kherep-builder": { effort: "max" } } }, text), env: NO_ENV,
  }).agents.get("kherep-builder")!;
  assert.deepEqual([agent.model, agent.effort], ["sonnet", "max"], "user agent effort wins, model still from the user role");
  assert.match(agent.effortFrom!, /model-policy\.user\.json$/);
  assert.match(agent.modelFrom!, /model-policy\.user\.json$/);
  const untouched = loadModelPolicy({ files: dir({ agents: { "kherep-builder": { model: "haiku" } } }, text), env: NO_ENV });
  assert.equal(untouched.agents.get("dc-plugin-build-runner")!.model, "sonnet", "other agents keep their defaults");
});

test("a user can replace the model and effort of any role or agent, including the observer", () => {
  const policy = load({ roles: { observer: { effort: "low" } }, agents: { "claude-obs": { model: "sonnet" } } });
  assert.deepEqual([policy.agents.get("claude-obs")!.model, policy.agents.get("claude-obs")!.effort], ["sonnet", "low"]);
  assert.equal(load({ agents: { "claude-obs": { model: "inherit" } } }).agents.get("claude-obs")!.model, "inherit");
});

test("a malformed override fails closed and names the file, never its content", () => {
  for (const text of ["{not json SECRET-CANARY", "", "[]", "\"x\""]) {
    const error = rejects(text, null);
    assert.match(error.message, /model-policy\.user\.json/);
    assert.ok(!error.message.includes("SECRET-CANARY"), error.message);
  }
});

test("an unknown key, role or agent in the override is rejected by file and key", () => {
  assert.equal(rejects({ agents: { "kherep-builder": { role: "observer" } } }, /^agents\.kherep-builder\.role$/).source.endsWith("model-policy.user.json"), true);
  rejects({ agents: { "kherep-builder": { tools: "Bash" } } }, /^agents\.kherep-builder\.tools$/);
  rejects({ roles: { builder: { sandbox: "none" } } }, /^roles\.builder\.sandbox$/);
  rejects({ roles: { wizard: { model: "opus" } } }, /^roles\.wizard$/);
  rejects({ agents: { "kherep-builder-alias": { model: "opus" } } }, /^agents\.kherep-builder-alias$/);
  rejects({ permissions: {} }, /^permissions$/);
  rejects({ schema_version: 2 }, /^schema_version$/);
  rejects({ roles: [] }, /^roles$/);
  const error = rejects({ agents: { "claude-obs": { model: "", effort: "medium" } } }, /^agents\.claude-obs\.model$/);
  assert.ok(!/medium/.test(error.message));
});

test("an unknown model fails closed with the key that named it", () => {
  const error = rejects({ roles: { support: { model: "gpt-unknown" } } }, /^roles\.support\.model$/);
  assert.match(error.message, /not in the catalog/);
  assert.ok(!error.message.includes("gpt-unknown"), "the message names the key, not the value");
  rejects({ agents: { "win-agent": { model: "claude-opus-4-8" } } }, /^agents\.win-agent\.model$/);
});

test("a model name is one token, so no override can inject frontmatter", () => {
  rejects({ agents: { "claude-obs": { model: "haiku\ntools: Bash, Write" } } }, /^agents\.claude-obs\.model$/);
  rejects({ models: { "x: y": {} } }, /^models\.x: y$/);
  rejects(undefined, null, { KHEREP_AGENT_MODEL_POLICY: JSON.stringify({ "claude-obs": "haiku\neffort: max" }) });
});

test("only a shipped role default leaves an agent on native inherit", () => {
  const policy = load();
  assert.equal(policy.agents.get("kherep-builder")!.roleDefaultModel, true);
  assert.equal(policy.agents.get("claude-obs")!.roleDefaultModel, false, "the shipped agent entry declares its model");
  assert.equal(load({ roles: { builder: { model: "sonnet" } } }).agents.get("kherep-builder")!.roleDefaultModel, false);
  assert.equal(load({ agents: { "kherep-builder": { effort: "high" } } }).agents.get("kherep-builder")!.roleDefaultModel, true);
  assert.equal(load({ roles: { observer: { model: "sonnet" } } }).agents.get("claude-obs")!.model, "sonnet", "user role beats the shipped agent");
});

test("an effort outside the vocabulary fails closed", () => {
  rejects({ roles: { observer: { effort: "ultra" } } }, /^roles\.observer\.effort$/);
  rejects({ agents: { "claude-obs": { effort: 3 } } }, /^agents\.claude-obs\.effort$/);
});

test("a user models entry extends the catalog but cannot widen what the runtime does", () => {
  const extended = load({ models: { "claude-opus-4-8": {}, "opus-next": { dispatchable: true } }, agents: { "claude-obs": { model: "claude-opus-4-8" } } });
  assert.equal(extended.agents.get("claude-obs")!.model, "claude-opus-4-8", "a full id is valid for frontmatter");
  assert.equal(dispatchIssue(extended, "claude-opus-4-8", undefined)?.ruleId, "DISPATCH_MODEL_UNKNOWN", "a full id is not an Agent-tool alias");
  assert.equal(dispatchIssue(extended, "opus-next", undefined), null, "a declared alias becomes dispatchable");
  rejects({ models: { haiku: { efforts: ["ultra"] } } }, /^models\.haiku\.efforts$/);
  rejects({ models: { inherit: { dispatchable: true } } }, /^models\.inherit$/);
  rejects({ models: { haiku: { aliases: ["h"] } } }, /^models\.haiku\.aliases$/);
  assert.equal(dispatchIssue(load({ models: { haiku: { efforts: ["low"] } } }), "haiku", "ultra")?.ruleId, "DISPATCH_EFFORT_UNSUPPORTED");
});

test("a per-model effort table only warns", () => {
  const policy = load({ models: { haiku: { efforts: ["low"] } } });
  assert.equal(policy.agents.get("claude-obs")!.effort, "medium");
  assert.equal(policy.warnings.length, 2, policy.warnings.join("\n"));
  assert.match(policy.warnings.join("\n"), /agents\.claude-obs: effort medium is not listed/);
  assert.equal(dispatchIssue(policy, "haiku", "high"), null);
  assert.match(dispatchWarning(policy, "haiku", "high") ?? "", /not listed for model 'haiku'/);
  assert.equal(dispatchWarning(policy, "haiku", "low"), null);
  assert.equal(dispatchWarning(policy, "haiku", undefined), null);
});

test("dispatch: unknown model, inherit and unsupported effort are named; an absent effort passes", () => {
  const policy = load();
  for (const model of ["opus", "sonnet", "haiku", "fable"]) assert.equal(dispatchIssue(policy, model, undefined), null, model);
  assert.equal(dispatchIssue(policy, "operator-model", undefined)?.ruleId, "DISPATCH_MODEL_UNKNOWN");
  assert.equal(dispatchIssue(policy, "inherit", undefined)?.ruleId, "DISPATCH_MODEL_UNKNOWN");
  assert.equal(dispatchIssue(policy, "toString", undefined)?.ruleId, "DISPATCH_MODEL_UNKNOWN");
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) assert.equal(dispatchIssue(policy, "haiku", effort), null, effort);
  assert.equal(dispatchIssue(policy, "haiku", "extreme")?.ruleId, "DISPATCH_EFFORT_UNSUPPORTED");
  assert.equal(dispatchIssue(policy, "haiku", 5)?.ruleId, "DISPATCH_EFFORT_UNSUPPORTED");
});

test("the deprecated environment inputs sit below the user file and still fail closed", () => {
  const env = { KHEREP_ALLOWED_MODELS: "operator-model", KHEREP_AGENT_MODEL_POLICY: JSON.stringify({ "kherep-builder": ["operator-model", "opus"], "general-purpose": "haiku" }) };
  const policy = load(undefined, env);
  assert.equal(policy.agents.get("kherep-builder")!.model, "operator-model");
  assert.equal(dispatchIssue(policy, "operator-model", undefined), null);
  assert.equal(dispatchIssue(policy, "opus", undefined), null, "the shipped aliases stay dispatchable");
  assert.equal(load({ agents: { "kherep-builder": { model: "sonnet" } } }, env).agents.get("kherep-builder")!.model, "sonnet");
  rejects(undefined, null, { KHEREP_ALLOWED_MODELS: "" });
  rejects(undefined, null, { KHEREP_AGENT_MODEL_POLICY: "" });
  rejects(undefined, null, { KHEREP_AGENT_MODEL_POLICY: "{}" });
  rejects(undefined, null, { KHEREP_AGENT_MODEL_POLICY: "{not-json" });
  rejects(undefined, null, { KHEREP_AGENT_MODEL_POLICY: JSON.stringify({ " kherep-builder": "haiku" }) });
  rejects(undefined, /^agents\.kherep-builder\.model$/, { KHEREP_AGENT_MODEL_POLICY: JSON.stringify({ "kherep-builder": "unknown-model" }) });
});

test("a missing or broken shipped default fails closed", () => {
  const files = policyFiles(path.join(TMP, "absent"));
  assert.throws(() => loadModelPolicy({ files, env: NO_ENV }), (e: unknown) => e instanceof ModelPolicyError && /is missing/.test(e.message));
  const shipped = JSON.parse(SHIPPED);
  shipped.agents["claude-obs"].role = "nobody";
  assert.throws(() => load(undefined, NO_ENV, JSON.stringify(shipped)), /agents\.claude-obs\.role/);
});
