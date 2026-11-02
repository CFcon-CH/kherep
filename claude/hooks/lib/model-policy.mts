// Issue #737. Model and effort per role and agent are user-overridable
// defaults, not pins. This module loads, merges, validates and resolves them;
// the dispatch guard, the hook texts and the installer share it.
//
// Precedence, per field independently (later wins):
//   shipped role < shipped agent < environment (deprecated) < user role < user agent
// Missing fields inherit. The final merged pair is validated.
//
// Claude adapter limitation: Claude Code exposes no queryable model catalog.
// A model is valid when it is `inherit` or a catalog entry (shipped `models`
// plus user additions); a dispatch must name an entry marked dispatchable,
// because the Agent tool takes aliases only. Effort is checked against the
// vocabulary low|medium|high|xhigh|max. A per-model `efforts` table is static
// and unmeasured, so a pair outside it only warns, never denies.

import fs from "node:fs";
import path from "node:path";

import {
  EFFORTS, INHERIT, ModelPolicyError, parseEnvironment, parseShipped, parseUser,
  type ModelChoice, type ModelEntry, type PolicyLayer, type ShippedLayer,
} from "./model-policy-validate.mts";

export { EFFORTS, INHERIT, ModelPolicyError };
export type { ModelChoice, ModelEntry };

export const SHIPPED_FILE = "model-policy.json";
export const USER_FILE = "model-policy.user.json";
// This module lives in <claude-home>/hooks/lib; the policy in <claude-home>/kherep.
export const POLICY_DIR = path.join(import.meta.dirname, "..", "..", "kherep");

export interface ResolvedChoice extends ModelChoice {
  // Which layer supplied each field: the shipped file, an environment
  // variable or the user file.
  modelFrom?: string;
  effortFrom?: string;
}

export interface ResolvedAgent extends ResolvedChoice {
  role: string;
  // True while the model is only the shipped role default. The installer then
  // leaves the frontmatter without a model line (native inherit); a model the
  // shipped agent entry, the environment or the user names is rendered.
  roleDefaultModel: boolean;
}

export interface ResolvedPolicy {
  roles: Map<string, ResolvedChoice>;
  agents: Map<string, ResolvedAgent>;
  models: Map<string, ModelEntry>;
  warnings: string[];
}

export interface PolicyFiles { shipped: string; user: string }

export function policyFiles(dir: string = POLICY_DIR): PolicyFiles {
  return { shipped: path.join(dir, SHIPPED_FILE), user: path.join(dir, USER_FILE) };
}

// Reads one JSON file. An absent optional file is undefined; anything else
// that cannot be read or parsed is an error naming the file, never its text.
export function readPolicyJson(file: string, required: boolean): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !required) return undefined;
    throw new ModelPolicyError(file, "", code === "ENOENT" ? "is missing" : "cannot be read");
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new ModelPolicyError(file, "", "is not valid JSON");
  }
}

function apply(target: ResolvedChoice, choice: ModelChoice | undefined, source: string): void {
  if (choice?.model !== undefined) { target.model = choice.model; target.modelFrom = source; }
  if (choice?.effort !== undefined) { target.effort = choice.effort; target.effortFrom = source; }
}

function check(choice: ResolvedChoice, key: string, models: Map<string, ModelEntry>, warnings: string[]): void {
  const { model, effort } = choice;
  if (model !== undefined && model !== INHERIT && !models.has(model)) {
    throw new ModelPolicyError(choice.modelFrom ?? "", `${key}.model`,
      "names a model that is not in the catalog; add it under models or choose a listed one");
  }
  const listed = model === undefined ? undefined : models.get(model)?.efforts;
  if (effort !== undefined && listed && !listed.includes(effort)) {
    warnings.push(`${key}: effort ${effort} is not listed for model ${model} in the static per-model table (warning only, unverified)`);
  }
}

export function resolveLayers(shipped: ShippedLayer, overrides: PolicyLayer[]): ResolvedPolicy {
  const layers: PolicyLayer[] = [shipped, ...overrides];
  const models = new Map<string, ModelEntry>();
  for (const layer of layers) {
    for (const [id, entry] of layer.models) models.set(id, { ...models.get(id), ...entry });
  }
  const roles = new Map<string, ResolvedChoice>();
  for (const role of shipped.roles.keys()) {
    const choice: ResolvedChoice = {};
    for (const layer of layers) apply(choice, layer.roles.get(role), layer.source);
    roles.set(role, choice);
  }
  const agents = new Map<string, ResolvedAgent>();
  for (const [agent, role] of shipped.agentRoles) {
    const choice: ResolvedAgent = { role, roleDefaultModel: false };
    for (const layer of layers) {
      for (const entry of [layer.roles.get(role), layer.agents.get(agent)]) {
        apply(choice, entry, layer.source);
        if (entry?.model !== undefined) choice.roleDefaultModel = layer === shipped && entry === shipped.roles.get(role);
      }
    }
    agents.set(agent, choice);
  }
  const warnings: string[] = [];
  for (const [role, choice] of roles) check(choice, `roles.${role}`, models, warnings);
  for (const [agent, choice] of agents) check(choice, `agents.${agent}`, models, warnings);
  return { roles, agents, models, warnings };
}

export interface PolicyInputs {
  files?: PolicyFiles;
  env?: Record<string, string | undefined>;
}

// Throws ModelPolicyError when any layer is missing (shipped only), unreadable,
// malformed, names an unknown key, role, agent or model, or an effort outside
// the vocabulary. Callers fail closed on it.
export function loadModelPolicy(inputs: PolicyInputs = {}): ResolvedPolicy {
  const files = inputs.files ?? policyFiles();
  const shipped = parseShipped(files.shipped, readPolicyJson(files.shipped, true));
  const overrides: PolicyLayer[] = [];
  const environment = parseEnvironment(inputs.env ?? process.env, shipped);
  if (environment) overrides.push(environment);
  const user = readPolicyJson(files.user, false);
  if (user !== undefined) overrides.push(parseUser(files.user, user, shipped));
  return resolveLayers(shipped, overrides);
}

// The resolved default of each agent for the hook texts, e.g. "claude-obs haiku/medium".
export function describeAgents(policy: ResolvedPolicy): string {
  return [...policy.agents].map(([agent, c]) => `${agent} ${c.model ?? INHERIT}${c.effort ? `/${c.effort}` : ""}`).join(", ");
}

// The model a hook text tells the Maestro to dispatch an agent with: its
// resolved default when the Agent tool can take it by name, otherwise null.
export function dispatchModelFor(policy: ResolvedPolicy, agent: string): string | null {
  const model = policy.agents.get(agent)?.model;
  return model !== undefined && policy.models.get(model)?.dispatchable === true ? model : null;
}

export interface DispatchCheck { ruleId: "DISPATCH_MODEL_UNKNOWN" | "DISPATCH_EFFORT_UNSUPPORTED"; reason: string }

function shown(value: unknown): string {
  return String(typeof value === "string" ? value : JSON.stringify(value)).slice(0, 60);
}

// The model of an Agent/Task call must be a dispatchable catalog entry. Whether
// PreToolUse tool_input carries `effort` is unverified, so both its presence
// and its absence are handled; only a present value is checked.
export function dispatchIssue(policy: ResolvedPolicy, model: string, effort: unknown): DispatchCheck | null {
  if (policy.models.get(model)?.dispatchable !== true) {
    return { ruleId: "DISPATCH_MODEL_UNKNOWN", reason: `Model '${shown(model)}' is not a dispatchable model of the resolved model policy.` };
  }
  if (effort !== undefined && (typeof effort !== "string" || !EFFORTS.includes(effort))) {
    return { ruleId: "DISPATCH_EFFORT_UNSUPPORTED", reason: `Effort '${shown(effort)}' is not one of ${EFFORTS.join("|")}.` };
  }
  return null;
}

export function dispatchWarning(policy: ResolvedPolicy, model: string, effort: unknown): string | null {
  const listed = policy.models.get(model)?.efforts;
  if (typeof effort !== "string" || !listed || listed.includes(effort)) return null;
  return `Effort '${effort}' is not listed for model '${model}' in the static per-model table; allowed, unverified.`;
}
