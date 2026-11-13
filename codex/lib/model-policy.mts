import { createHash } from "node:crypto";
import type { Capabilities } from "./contracts.mts";

const ROLES = ["root", "designer", "builder", "support", "researcher", "observer", "broker"] as const;
const FAMILIES = ["astra", "sol", "terra", "luna"] as const;
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export type ModelRole = typeof ROLES[number];
export interface RolePolicy { family: typeof FAMILIES[number]; reasoning: string }
export interface ModelPolicy { schemaVersion: 1; sourceSha256: string; roles: Record<ModelRole, RolePolicy> }
export interface CatalogModel { id: string; model: string; hidden: boolean; supportedReasoningEfforts: { reasoningEffort: string }[] }
export interface ModelCatalog { complete: true; models: CatalogModel[] }
export interface ResolvedRole { model: string; reasoning: string }
export interface ModelResolution {
  schemaVersion: 1;
  policySha256: string;
  catalogSha256: string;
  resolvedAt: string;
  roles: Record<ModelRole, ResolvedRole>;
  supportedModels: Record<string, string[]>;
}
export const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Deliberately small TOML schema: known role tables, basic string values and one integer.
// Reject unsupported TOML rather than interpreting ambiguous or duplicate settings.
export function parseModelPolicy(text: string): ModelPolicy {
  const roles: Record<string, Partial<RolePolicy>> = {};
  let current: Partial<RolePolicy> | null = null;
  let schema = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(?<!\s)\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    if (/^schema_version\s*=\s*1$/.test(line) && !schema && current === null) { schema = true; continue; }
    const table = line.match(/^\[roles\.([a-z]+)\]$/);
    if (table && ROLES.includes(table[1] as ModelRole) && !roles[table[1]]) {
      current = roles[table[1]] = {}; continue;
    }
    const setting = line.match(/^(family|reasoning)\s*=\s*"([a-z]+)"$/);
    if (!setting || !current || setting[1] in current) throw new Error("Invalid or duplicate model policy setting");
    Object.assign(current, { [setting[1]]: setting[2] });
  }
  if (!schema || ROLES.some((role) => !roles[role] || !FAMILIES.includes(roles[role].family as RolePolicy["family"])
    || !EFFORTS.includes(roles[role].reasoning ?? ""))) throw new Error("Incomplete or unsupported model policy");
  return { schemaVersion: 1, sourceSha256: createHash("sha256").update(text).digest("hex"), roles: roles as ModelPolicy["roles"] };
}

export function validateCatalog(value: unknown): ModelCatalog {
  if (!record(value) || value.complete !== true || !Array.isArray(value.models) || !value.models.length) {
    throw new Error("A complete nonempty model catalog is required");
  }
  const ids = new Set<string>();
  const models = new Set<string>();
  const sanitized: CatalogModel[] = [];
  for (const entry of value.models) {
    if (!record(entry) || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)
      || typeof entry.model !== "string" || !entry.model || models.has(entry.model) || typeof entry.hidden !== "boolean"
      || !Array.isArray(entry.supportedReasoningEfforts) || !entry.supportedReasoningEfforts.length) throw new Error("Malformed or duplicate model catalog entry");
    ids.add(entry.id); models.add(entry.model);
    const efforts = new Set<string>();
    for (const effort of entry.supportedReasoningEfforts) {
      if (!record(effort) || typeof effort.reasoningEffort !== "string" || !EFFORTS.includes(effort.reasoningEffort)
        || efforts.has(effort.reasoningEffort)) throw new Error("Malformed model reasoning support");
      efforts.add(effort.reasoningEffort);
    }
    sanitized.push({ id: entry.id, model: entry.model, hidden: entry.hidden,
      supportedReasoningEfforts: [...efforts].map((reasoningEffort) => ({ reasoningEffort })) });
  }
  return { complete: true, models: sanitized };
}

function generation(model: string, family: string): bigint[] | null {
  const match = model.match(/^gpt-([1-9]\d?(?:\.(?:0|[1-9]\d?))?)-(astra|sol|terra|luna)$/);
  return match?.[2] === family ? match[1].split(".").map(BigInt) : null;
}
function compare(a: bigint[], b: bigint[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index] ?? 0n, right = b[index] ?? 0n;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

export function resolveModels(policy: ModelPolicy, rawCatalog: unknown): ModelResolution {
  const catalog = validateCatalog(rawCatalog);
  const roles = {} as ModelResolution["roles"];
  const supportedModels: Record<string, string[]> = {};
  const families = [...new Set(Object.values(policy.roles).map((role) => role.family))];
  for (const entry of catalog.models) {
    if (!entry.hidden && families.some((family) => generation(entry.model, family) !== null)) {
      supportedModels[entry.model] = entry.supportedReasoningEfforts.map((effort) => effort.reasoningEffort);
    }
  }
  for (const role of ROLES) {
    const wanted = policy.roles[role];
    const candidates = catalog.models.filter((entry) => !entry.hidden && generation(entry.model, wanted.family) !== null
      && entry.supportedReasoningEfforts.some((effort) => effort.reasoningEffort === wanted.reasoning))
      .sort((a, b) => compare(generation(b.model, wanted.family)!, generation(a.model, wanted.family)!));
    const chosen = candidates[0];
    if (!chosen) throw new Error(`No visible model with supported reasoning for role ${role}, family ${wanted.family}`);
    if (candidates[1] && compare(generation(chosen.model, wanted.family)!, generation(candidates[1].model, wanted.family)!) === 0) {
      throw new Error(`Ambiguous model generation for family ${wanted.family}`);
    }
    roles[role] = { model: chosen.model, reasoning: wanted.reasoning };
  }
  return { schemaVersion: 1, policySha256: policy.sourceSha256, catalogSha256: hash(catalog), resolvedAt: new Date().toISOString(), roles, supportedModels };
}

export function resolveCapabilities(source: Capabilities, resolution: ModelResolution): Capabilities {
  const agents = Object.fromEntries(Object.entries(source.agents).map(([name, entry]) => {
    const role = entry.role && resolution.roles[entry.role as ModelRole];
    if (!role) throw new Error(`Agent ${name} has an unknown model role`);
    return [name, { ...entry, ...role }];
  }));
  const projectedAgents = Object.fromEntries(Object.entries(agents).map(([name, entry]) => [entry.as || name, {
    role: entry.role!, model: entry.model, reasoning: entry.reasoning,
  }]));
  return { ...source, agents, projectedAgents, modelResolution: resolution };
}
