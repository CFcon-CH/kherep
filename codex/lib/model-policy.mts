import { createHash } from "node:crypto";
import type { Capabilities } from "./contracts.mts";
import type { AgentIdentity, AgentInventory } from "./model-agent-inventory.mts";
import type { ModelChoice, ModelMetadata, UserModelPolicy } from "./model-policy-user.mts";

export const ROLES = ["root", "designer", "builder", "support", "researcher", "observer", "broker"] as const;
const FAMILIES = ["astra", "sol", "terra", "luna"] as const;
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
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

// PR-A V2 seams are deliberately not connected to any installer or runtime.
export interface ModelEffort { model: string; effort: string }
export interface CatalogSupport {
  catalog: ModelCatalog; digest: string; byAlias: ReadonlyMap<string, CatalogModel>;
  supportedModels: Readonly<Record<string, readonly string[]>>;
}
export interface FieldProvenance {
  origin: "shipped-role" | "shipped-agent" | "retained-managed" | "user-role" | "user-agent";
  inputKey: string; inputDigest: string;
}
export interface DefaultRealization { model: string | null; effort: string | null }
export interface EffectiveSelection {
  defaultRealization: DefaultRealization; effective: ModelEffort;
  defaultProvenance: { model: FieldProvenance; effort: FieldProvenance };
  provenance: { model: FieldProvenance; effort: FieldProvenance };
}
export interface RetainedAgentDefault extends AgentIdentity { defaultRealization: DefaultRealization }
export interface RetainedSelections {
  selectionId: string; roles: ReadonlyMap<ModelRole, DefaultRealization>; agents: ReadonlyMap<string, RetainedAgentDefault>;
}
export interface ResolutionInputs {
  policy: ModelPolicy; inventory: AgentInventory; user: UserModelPolicy; catalog: CatalogSupport;
  agentDefaults?: ReadonlyMap<string, ModelChoice>; retained?: RetainedSelections; refresh?: boolean;
}
export interface EffectiveResolutionV2 {
  schemaVersion: 2; policySha256: string; inventoryDigest: string; catalogDigest: string;
  userIdentity: { present: boolean; byteSha256: string | null; semanticSha256: string };
  agentDefaultsDigest: string; roles: Record<ModelRole, EffectiveSelection>;
  agents: readonly (AgentIdentity & EffectiveSelection)[];
  supportedModels: Readonly<Record<string, readonly string[]>>;
}
function conflict(code: string, path = "selection"): never { throw new Error(`model-resolution: ${path}: ${code}`); }
const modelToken = (value: string): boolean => value.length <= 200 && value !== "inherit"
  && /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/.test(value) && !["__proto__", "prototype", "constructor"].includes(value);

export function buildCatalogSupport(raw: unknown): CatalogSupport {
  const catalog = validateCatalog(raw);
  const identities = new Map<string, CatalogModel>(), byAlias = new Map<string, CatalogModel>();
  const supportedModels: Record<string, readonly string[]> = Object.create(null) as Record<string, readonly string[]>;
  for (const entry of catalog.models) {
    if (!modelToken(entry.id) || !modelToken(entry.model)) conflict("invalid-catalog-identity", "catalog");
    for (const alias of [entry.id, entry.model]) {
      if (identities.has(alias) && identities.get(alias)!.model !== entry.model) conflict("ambiguous-catalog-identity", "catalog");
      identities.set(alias, entry);
    }
    if (!entry.hidden) {
      byAlias.set(entry.id, entry); byAlias.set(entry.model, entry);
      supportedModels[entry.model] = Object.freeze(entry.supportedReasoningEfforts.map(row => row.reasoningEffort).sort());
    }
  }
  const canonical = { complete: true, models: [...catalog.models].sort((a, b) => a.model < b.model ? -1 : a.model > b.model ? 1 : 0)
    .map(entry => ({ ...entry, supportedReasoningEfforts: [...entry.supportedReasoningEfforts]
      .sort((a, b) => a.reasoningEffort < b.reasoningEffort ? -1 : a.reasoningEffort > b.reasoningEffort ? 1 : 0) })) };
  return { catalog, digest: hash(canonical), byAlias, supportedModels: Object.freeze(supportedModels) };
}

export function validateSupportedPair(pair: ModelEffort, catalog: CatalogSupport): void {
  const entry = catalog.byAlias.get(pair.model);
  if (!entry) conflict("unsupported-model");
  if (!entry.supportedReasoningEfforts.some(row => row.reasoningEffort === pair.effort)) conflict("unsupported-effort");
}

export function resolveEffectiveSelections(input: ResolutionInputs): EffectiveResolutionV2 {
  const { policy, inventory, user, catalog, retained } = input;
  if (retained && !/^[a-f0-9]{64}$/.test(retained.selectionId)) conflict("invalid-retained-identity");
  const bindingIds = new Set(inventory.agents.map(row => row.bindingId));
  const shipped = input.agentDefaults ?? new Map<string, ModelChoice>();
  for (const [id, row] of shipped) if (!bindingIds.has(id) || !record(row)
    || Object.keys(row).some(key => key !== "model" && key !== "effort")
    || (row.model !== undefined && (typeof row.model !== "string" || !modelToken(row.model)))
    || (row.effort !== undefined && (typeof row.effort !== "string" || !EFFORTS.includes(row.effort)))) conflict("invalid-shipped-agent-default");
  const agentDefaultsDigest = hash([...shipped].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([id, row]) => [id, { model: row.model ?? null, effort: row.effort ?? null }]));
  const metadata = new Map<string, ModelMetadata>();
  for (const [id, row] of user.models) {
    const entry = catalog.byAlias.get(id);
    if (!entry) conflict("metadata-model-not-visible", "models.$key");
    if (metadata.has(entry.model)) conflict("duplicate-model-metadata", "models.$key");
    if (row.efforts?.some(effort => !entry.supportedReasoningEfforts.some(item => item.reasoningEffort === effort)))
      conflict("metadata-widens-support", "models.$key.efforts");
    metadata.set(entry.model, row);
  }
  const provenance = (origin: FieldProvenance["origin"], inputKey: string, inputDigest: string): FieldProvenance => ({ origin, inputKey, inputDigest });
  const fresh = {} as Record<ModelRole, DefaultRealization>;
  for (const role of ROLES) {
    const wanted = policy.roles[role];
    const candidates = catalog.catalog.models.filter(entry => !entry.hidden && generation(entry.model, wanted.family) !== null
      && entry.supportedReasoningEfforts.some(row => row.reasoningEffort === wanted.reasoning))
      .sort((a, b) => compare(generation(b.model, wanted.family)!, generation(a.model, wanted.family)!));
    const ambiguous = candidates[1] && compare(generation(candidates[0]!.model, wanted.family)!, generation(candidates[1].model, wanted.family)!) === 0;
    fresh[role] = { model: ambiguous ? null : candidates[0]?.model ?? null, effort: wanted.reasoning };
  }
  const retainedDefault = (value: DefaultRealization): DefaultRealization => {
    if (!record(value) || (value.model !== null && (typeof value.model !== "string" || !modelToken(value.model)))
      || (value.effort !== null && (typeof value.effort !== "string" || !EFFORTS.includes(value.effort))))
      conflict("retained-default-unresolved");
    return { model: value.model, effort: value.effort };
  };
  const select = (base: DefaultRealization, defaultProvenance: EffectiveSelection["defaultProvenance"], role: ModelRole, agent?: AgentIdentity): EffectiveSelection => {
    let model = base.model, effort = base.effort;
    const origins = { ...defaultProvenance };
    const overlay = (choice: ModelChoice | undefined, origin: "user-role" | "user-agent", key: string): void => {
      if (choice?.model !== undefined) { model = choice.model; origins.model = provenance(origin, `${key}.model`, user.byteSha256!); }
      if (choice?.effort !== undefined) { effort = choice.effort; origins.effort = provenance(origin, `${key}.effort`, user.byteSha256!); }
    };
    overlay(user.roles.get(role), "user-role", `roles.${role}`);
    if (agent) overlay(user.agents.get(agent.sourceAgentId), "user-agent", `agents.${agent.sourceAgentId}`);
    if (model === null) conflict("unresolved-default-model", `roles.${role}`);
    if (effort === null) conflict("unresolved-default-effort", `roles.${role}`);
    if (origins.model.origin === "retained-managed" && catalog.byAlias.get(model)?.model !== model)
      conflict("retained-model-not-visible", `roles.${role}`);
    const pair = { model, effort };
    validateSupportedPair(pair, catalog);
    pair.model = catalog.byAlias.get(pair.model)!.model;
    const narrowed = metadata.get(pair.model);
    if (narrowed?.dispatchable === false || narrowed?.efforts && !narrowed.efforts.includes(pair.effort)) conflict("selection-disabled-by-metadata");
    return { defaultRealization: { ...base }, effective: pair, defaultProvenance: { ...defaultProvenance }, provenance: origins };
  };
  const roles = {} as Record<ModelRole, EffectiveSelection>;
  for (const role of ROLES) {
    const old = !input.refresh && retained?.roles.get(role);
    const base = old ? retainedDefault(old) : fresh[role];
    const origin = old ? "retained-managed" : "shipped-role";
    const digest = old ? retained!.selectionId : policy.sourceSha256;
    roles[role] = select(base, { model: provenance(origin, `roles.${role}.model`, digest),
      effort: provenance(origin, `roles.${role}.effort`, digest) }, role);
  }
  const agents = inventory.agents.map(agent => {
    const previous = retained?.agents.get(agent.bindingId);
    if (previous && (previous.sourceAgentId !== agent.sourceAgentId || previous.role !== agent.role
      || previous.bindingId !== agent.bindingId || previous.sourcePath !== agent.sourcePath
      || previous.sourceProvider !== agent.sourceProvider || previous.securityPolicyDigest !== agent.securityPolicyDigest)) conflict("retained-binding-conflict");
    const old = !input.refresh && previous;
    const defaults = shipped.get(agent.bindingId);
    const base = old ? retainedDefault(old.defaultRealization) : {
      model: defaults?.model ?? fresh[agent.role].model, effort: defaults?.effort ?? fresh[agent.role].effort };
    if (!old && base.model !== null) base.model = catalog.byAlias.get(base.model)?.model ?? base.model;
    const field = (name: "model" | "effort"): FieldProvenance => old
      ? provenance("retained-managed", `agents.${agent.bindingId}.${name}`, retained!.selectionId)
      : provenance(defaults?.[name] === undefined ? "shipped-role" : "shipped-agent",
        defaults?.[name] === undefined ? `roles.${agent.role}.${name}` : `agents.${agent.bindingId}.${name}`,
        defaults?.[name] === undefined ? policy.sourceSha256 : agentDefaultsDigest);
    return { ...agent, ...select(base, { model: field("model"), effort: field("effort") }, agent.role, agent) };
  });
  return { schemaVersion: 2, policySha256: policy.sourceSha256, inventoryDigest: inventory.digest, catalogDigest: catalog.digest,
    userIdentity: { present: user.present, byteSha256: user.byteSha256, semanticSha256: user.semanticSha256 },
    agentDefaultsDigest, roles, agents, supportedModels: catalog.supportedModels };
}
