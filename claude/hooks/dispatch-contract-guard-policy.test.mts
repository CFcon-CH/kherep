#!/usr/bin/env node
// Issue #737. dispatch-contract-guard.mts end to end against a resolved model
// policy: a user override in <claude-home>/kherep/model-policy.user.json, the
// effort of a call when tool_input carries one, and fail-closed loading.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";

const HOOKS = import.meta.dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-policy-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const SHA = "2733b35e2c102ac54295568509c68b18b6d92cab";
const BRIEF = `revision: kherep@${SHA}\ndecided: none\nBuild it.`;
let homes = 0;

// A throwaway <claude-home> laid out like an install: hooks/, hooks/lib/, kherep/.
function home(user?: string, shipped = true): string {
  const root = path.join(TMP, String(homes++));
  fs.mkdirSync(path.join(root, "kherep"), { recursive: true });
  fs.cpSync(path.join(HOOKS, "lib"), path.join(root, "hooks", "lib"), { recursive: true });
  fs.copyFileSync(path.join(HOOKS, "dispatch-contract-guard.mts"), path.join(root, "hooks", "dispatch-contract-guard.mts"));
  if (shipped) fs.copyFileSync(path.join(HOOKS, "..", "kherep", "model-policy.json"), path.join(root, "kherep", "model-policy.json"));
  if (user !== undefined) fs.writeFileSync(path.join(root, "kherep", "model-policy.user.json"), user);
  return root;
}

interface Outcome { decision: unknown; reason: string; context: string }

function dispatch(root: string, input: Record<string, unknown>): Outcome {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.KHEREP_ALLOWED_MODELS;
  delete env.KHEREP_AGENT_MODEL_POLICY;
  const result = spawnSync(process.execPath, [path.join(root, "hooks", "dispatch-contract-guard.mts")], {
    input: JSON.stringify({ tool_name: "Agent", tool_input: { prompt: BRIEF, ...input } }), encoding: "utf8", env,
  });
  assert.equal(result.status, 0, result.stderr);
  const hso = (JSON.parse(result.stdout || "{}") as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput ?? {};
  return { decision: hso.permissionDecision ?? null, reason: String(hso.permissionDecisionReason ?? ""), context: String(hso.additionalContext ?? "") };
}

const builder = (model: string, extra: Record<string, unknown> = {}) => ({ subagent_type: "kherep-builder", model, ...extra });

test("a malformed user override denies every dispatch, naming the file and not its content", () => {
  const root = home("{ SECRET-CANARY");
  const outcome = dispatch(root, builder("opus"));
  assert.equal(outcome.decision, "deny");
  assert.match(outcome.reason, /\[dispatch-contract:DISPATCH_POLICY_INVALID\]/);
  assert.match(outcome.reason, /model-policy\.user\.json is not valid JSON/);
  assert.ok(!outcome.reason.includes("SECRET-CANARY"), outcome.reason);
});

test("a user override with an adapter-owned key or an unknown agent fails closed by key", () => {
  for (const [user, key] of [
    [{ agents: { "kherep-builder": { tools: "Bash" } } }, "agents.kherep-builder.tools"],
    [{ agents: { "kherep-builder": { role: "observer" } } }, "agents.kherep-builder.role"],
    [{ agents: { "general-purpose": { model: "opus" } } }, "agents.general-purpose"],
    [{ roles: { observer: { effort: "ultra" } } }, "roles.observer.effort"],
    [{ roles: { builder: { model: "gpt-unknown" } } }, "roles.builder.model"],
  ] as const) {
    const outcome = dispatch(home(JSON.stringify(user)), builder("opus"));
    assert.equal(outcome.decision, "deny", key);
    assert.ok(outcome.reason.includes("DISPATCH_POLICY_INVALID") && outcome.reason.includes(`key ${key}`), outcome.reason);
  }
});

test("a valid user override is honoured: a declared alias becomes dispatchable, defaults are not pins", () => {
  const root = home(JSON.stringify({ models: { "opus-next": { dispatchable: true } }, agents: { "kherep-builder": { model: "opus-next" } } }));
  assert.equal(dispatch(root, builder("opus-next")).decision, null);
  assert.equal(dispatch(root, builder("haiku")).decision, null, "the resolved default is not enforced");
  assert.match(dispatch(root, builder("opus-later")).reason, /DISPATCH_MODEL_UNKNOWN/);
});

test("a missing shipped default fails closed", () => {
  assert.match(dispatch(home(undefined, false), builder("opus")).reason, /DISPATCH_POLICY_INVALID.*model-policy\.json is missing/);
});

test("the effort of a call is checked only when tool_input carries one", () => {
  const root = home();
  assert.equal(dispatch(root, builder("opus")).decision, null, "absent effort");
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) assert.equal(dispatch(root, builder("opus", { effort })).decision, null, effort);
  for (const effort of ["ultra", "", 3, null]) {
    const outcome = dispatch(root, builder("opus", { effort }));
    assert.equal(outcome.decision, "deny", String(effort));
    assert.match(outcome.reason, /\[dispatch-contract:DISPATCH_EFFORT_UNSUPPORTED\]/);
  }
});

test("a user-declared per-model effort table cannot widen the vocabulary and only warns", () => {
  const root = home(JSON.stringify({ models: { haiku: { efforts: ["low"] } } }));
  const warned = dispatch(root, { subagent_type: "general-purpose", model: "haiku", effort: "high", prompt: "Look it up." });
  assert.equal(warned.decision, null);
  assert.match(warned.context, /DISPATCH_EFFORT_UNLISTED/);
  assert.match(dispatch(root, builder("haiku", { effort: "ultra" })).reason, /DISPATCH_EFFORT_UNSUPPORTED/);
  const widened = dispatch(home(JSON.stringify({ models: { haiku: { efforts: ["ultra"] } } })), builder("haiku", { effort: "ultra" }));
  assert.match(widened.reason, /DISPATCH_POLICY_INVALID.*key models\.haiku\.efforts/);
});
