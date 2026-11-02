// Issue #737. Schema checks for the model policy layers: the shipped default
// (<claude-home>/kherep/model-policy.json), the deprecated environment inputs
// and the user override (<claude-home>/kherep/model-policy.user.json).
// Every error names the file or variable and the key, never the file content.

export const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
export const INHERIT = "inherit";
export const SCHEMA_VERSION = 1;

export interface ModelChoice { model?: string; effort?: string }
export interface ModelEntry { dispatchable?: boolean; efforts?: string[] }

// One parsed layer. Maps, so no key in a file can reach an object prototype.
export interface PolicyLayer {
  source: string;
  roles: Map<string, ModelChoice>;
  agents: Map<string, ModelChoice>;
  models: Map<string, ModelEntry>;
}

// The shipped layer also owns the role set and the agent -> role assignment.
export interface ShippedLayer extends PolicyLayer {
  agentRoles: Map<string, string>;
}

export class ModelPolicyError extends Error {
  readonly source: string;
  readonly key: string;
  constructor(source: string, key: string, problem: string) {
    super(`model policy ${source}${key ? `, key ${key}:` : ""} ${problem}`);
    this.name = "ModelPolicyError";
    this.source = source;
    this.key = key;
  }
}

type Json = Record<string, unknown>;
const TOP_KEYS = new Set(["schema_version", "roles", "agents", "models"]);

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectAt(source: string, key: string, value: unknown): Json {
  if (!isObject(value)) throw new ModelPolicyError(source, key, "must be a JSON object");
  return value;
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value === value.trim();
}

function parseChoice(source: string, key: string, value: unknown, extraKeys: ReadonlySet<string>): ModelChoice {
  const object = objectAt(source, key, value);
  const choice: ModelChoice = {};
  for (const [field, entry] of Object.entries(object)) {
    if (field === "model") {
      if (!isName(entry)) throw new ModelPolicyError(source, `${key}.model`, "must be a non-empty model name");
      choice.model = entry;
    } else if (field === "effort") {
      if (typeof entry !== "string" || !EFFORTS.includes(entry)) {
        throw new ModelPolicyError(source, `${key}.effort`, `must be one of ${EFFORTS.join("|")}`);
      }
      choice.effort = entry;
    } else if (!extraKeys.has(field)) {
      throw new ModelPolicyError(source, `${key}.${field}`, "is not a known key; an entry sets only model and effort");
    }
  }
  return choice;
}

function parseModels(source: string, value: unknown): Map<string, ModelEntry> {
  const models = new Map<string, ModelEntry>();
  for (const [id, raw] of Object.entries(objectAt(source, "models", value))) {
    const key = `models.${id}`;
    if (!isName(id) || id === INHERIT) throw new ModelPolicyError(source, key, "is not a usable model name");
    const entry: ModelEntry = {};
    for (const [field, item] of Object.entries(objectAt(source, key, raw))) {
      if (field === "dispatchable") {
        if (typeof item !== "boolean") throw new ModelPolicyError(source, `${key}.dispatchable`, "must be true or false");
        entry.dispatchable = item;
      } else if (field === "efforts") {
        if (!Array.isArray(item) || item.some((effort) => typeof effort !== "string" || !EFFORTS.includes(effort))) {
          throw new ModelPolicyError(source, `${key}.efforts`,
            `must list efforts from ${EFFORTS.join("|")}; a models entry cannot widen the effort vocabulary`);
        }
        entry.efforts = [...item] as string[];
      } else {
        throw new ModelPolicyError(source, `${key}.${field}`, "is not a known key; a models entry sets only dispatchable and efforts");
      }
    }
    models.set(id, entry);
  }
  return models;
}

function checkTop(source: string, object: Json, required: boolean): void {
  for (const key of Object.keys(object)) {
    if (!TOP_KEYS.has(key)) throw new ModelPolicyError(source, key, "is not a known key");
  }
  if (required || "schema_version" in object) {
    if (object.schema_version !== SCHEMA_VERSION) {
      throw new ModelPolicyError(source, "schema_version", `must be ${SCHEMA_VERSION}`);
    }
  }
}

export function parseShipped(source: string, value: unknown): ShippedLayer {
  const object = objectAt(source, "", value);
  checkTop(source, object, true);
  const roles = new Map<string, ModelChoice>();
  for (const [role, raw] of Object.entries(objectAt(source, "roles", object.roles))) {
    if (!isName(role)) throw new ModelPolicyError(source, `roles.${role}`, "is not a usable role name");
    roles.set(role, parseChoice(source, `roles.${role}`, raw, new Set()));
  }
  const agents = new Map<string, ModelChoice>();
  const agentRoles = new Map<string, string>();
  for (const [agent, raw] of Object.entries(objectAt(source, "agents", object.agents))) {
    const key = `agents.${agent}`;
    if (!isName(agent)) throw new ModelPolicyError(source, key, "is not a usable agent name");
    agents.set(agent, parseChoice(source, key, raw, new Set(["role"])));
    const role = (raw as Json).role;
    if (typeof role !== "string" || !roles.has(role)) throw new ModelPolicyError(source, `${key}.role`, "must name a role of this policy");
    agentRoles.set(agent, role);
  }
  return { source, roles, agents, agentRoles, models: parseModels(source, object.models) };
}

// The user override is deep-partial. Role assignment, tools and authority stay
// adapter-owned: an entry may set only model and effort, for a known role or
// a stable source agent name (claude/agents/<name>.md).
export function parseUser(source: string, value: unknown, shipped: ShippedLayer): PolicyLayer {
  const object = objectAt(source, "", value);
  checkTop(source, object, false);
  const layer: PolicyLayer = { source, roles: new Map(), agents: new Map(), models: new Map() };
  for (const [section, known] of [["roles", shipped.roles], ["agents", shipped.agentRoles]] as const) {
    if (!(section in object)) continue;
    for (const [name, raw] of Object.entries(objectAt(source, section, object[section]))) {
      const key = `${section}.${name}`;
      if (!known.has(name)) throw new ModelPolicyError(source, key, `is not a ${section === "roles" ? "role" : "agent"} of the shipped policy`);
      layer[section].set(name, parseChoice(source, key, raw, new Set()));
    }
  }
  if ("models" in object) layer.models = parseModels(source, object.models);
  return layer;
}

// Deprecated for one release (issue #737): KHEREP_ALLOWED_MODELS adds
// dispatchable aliases, KHEREP_AGENT_MODEL_POLICY sets agent models below the
// user file. Pins for agents the shipped policy does not know carry no meaning
// any more and are ignored. Set-but-empty or malformed input still fails closed.
export function parseEnvironment(env: Record<string, string | undefined>, shipped: ShippedLayer): PolicyLayer | null {
  const allowed = env.KHEREP_ALLOWED_MODELS;
  const agentPolicy = env.KHEREP_AGENT_MODEL_POLICY;
  if (allowed === undefined && agentPolicy === undefined) return null;
  const layer: PolicyLayer = { source: "environment", roles: new Map(), agents: new Map(), models: new Map() };
  if (allowed !== undefined) {
    const source = "environment variable KHEREP_ALLOWED_MODELS";
    const names = allowed.split(",").map((name) => name.trim()).filter(Boolean);
    if (names.length === 0) throw new ModelPolicyError(source, "", "is set but names no model");
    for (const name of names) {
      if (name === INHERIT) throw new ModelPolicyError(source, "", "cannot list inherit as a dispatch model");
      layer.models.set(name, { dispatchable: true });
    }
  }
  if (agentPolicy !== undefined) {
    const source = "environment variable KHEREP_AGENT_MODEL_POLICY";
    let parsed: unknown;
    try { parsed = JSON.parse(agentPolicy); } catch { throw new ModelPolicyError(source, "", "is not valid JSON"); }
    const object = objectAt(source, "", parsed);
    if (Object.keys(object).length === 0) throw new ModelPolicyError(source, "", "is an empty object");
    for (const [agent, raw] of Object.entries(object)) {
      const models = typeof raw === "string" ? [raw] : raw;
      if (!isName(agent) || !Array.isArray(models) || models.length === 0 || !models.every(isName)) {
        throw new ModelPolicyError(source, agent, "must map an agent name to a model or a non-empty model list");
      }
      if (shipped.agentRoles.has(agent)) layer.agents.set(agent, { model: models[0] as string });
    }
  }
  return layer;
}
