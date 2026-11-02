// Issue #737. The hook texts name the resolved model policy, not fixed models:
// observation-stop names claude-obs's resolved default, orchestra-default lists
// every agent's default and names an invalid policy.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";

import { loadModelPolicy, policyFiles } from "./lib/model-policy.mts";
import { OBSERVATION_REASON, observationReason } from "./observation-stop.mts";

const HOOKS = import.meta.dirname;
const SHIPPED = path.join(HOOKS, "..", "kherep", "model-policy.json");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "model-policy-texts-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let n = 0;

// A <claude-home> with hooks/, hooks/lib/ and kherep/ like an install.
function home(user?: string): string {
  const root = path.join(TMP, String(n++));
  fs.mkdirSync(path.join(root, "kherep"), { recursive: true });
  fs.cpSync(path.join(HOOKS, "lib"), path.join(root, "hooks", "lib"), { recursive: true });
  fs.copyFileSync(path.join(HOOKS, "orchestra-default.mts"), path.join(root, "hooks", "orchestra-default.mts"));
  fs.copyFileSync(SHIPPED, path.join(root, "kherep", "model-policy.json"));
  if (user !== undefined) fs.writeFileSync(path.join(root, "kherep", "model-policy.user.json"), user);
  return root;
}

function sessionStart(root: string): string {
  const workspace = path.join(TMP, "workspace");
  const env: Record<string, string | undefined> = { ...process.env, KHEREP_WORKSPACE: workspace };
  delete env.KHEREP_ALLOWED_MODELS;
  delete env.KHEREP_AGENT_MODEL_POLICY;
  const result = spawnSync(process.execPath, [path.join(root, "hooks", "orchestra-default.mts")], {
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd: workspace }), encoding: "utf8", env,
  });
  assert.equal(result.status, 0, result.stderr);
  return String((JSON.parse(result.stdout || "{}") as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "");
}

const policyWith = (user: unknown) => {
  const root = home(JSON.stringify(user));
  return loadModelPolicy({ files: policyFiles(path.join(root, "kherep")), env: {} });
};

test("observation-stop names claude-obs's resolved default, not a fixed model", () => {
  assert.match(OBSERVATION_REASON, /subagent_type "claude-obs" and model "haiku", its model policy default/);
  assert.match(observationReason(policyWith({ agents: { "claude-obs": { model: "sonnet" } } })), /model "sonnet", its model policy default/);
  const undispatchable = observationReason(policyWith({ agents: { "claude-obs": { model: "inherit" } } }));
  assert.match(undispatchable, /an explicit dispatchable model of the model policy/);
  assert.ok(!undispatchable.includes("\"inherit\""));
  assert.match(observationReason(null), /an explicit dispatchable model/);
});

test("orchestra-default lists the resolved defaults and follows a user override", () => {
  const shipped = sessionStart(home());
  assert.match(shipped, /Every Agent\/Task call sets an explicit model\. Agent model defaults/);
  assert.match(shipped, /kherep-builder opus, /);
  assert.match(shipped, /claude-obs haiku\/medium/);
  assert.match(shipped, /any dispatchable model of that policy may be chosen instead/);
  const overridden = sessionStart(home(JSON.stringify({ roles: { observer: { effort: "low" } }, agents: { "kherep-builder": { model: "sonnet" } } })));
  assert.match(overridden, /kherep-builder sonnet, /);
  assert.match(overridden, /claude-obs haiku\/low/);
});

test("orchestra-default names an invalid policy instead of failing the session start", () => {
  const text = sessionStart(home("{ SECRET-CANARY"));
  assert.match(text, /The model policy is invalid, so every Agent\/Task call is denied until it is fixed: .*model-policy\.user\.json is not valid JSON/);
  assert.ok(!text.includes("SECRET-CANARY"));
  assert.match(text, /KHEREP ORCHESTRA ACTIVE/);
});
