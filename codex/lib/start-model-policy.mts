import { buildCatalogSupport, compareGeneration, generation, MODEL_FAMILIES, ROLES,
  type CatalogSupport, type EffectiveResolutionV2, type ModelEffort, type ModelPolicy, type ModelRole, type RolePolicy } from "./model-policy.mts";
import { ModelSelectionRefusal } from "./model-selection-git.mts";
import type { UserModelPolicy } from "./model-policy-user.mts";

export function refuseStart(code: string): never { throw new ModelSelectionRefusal(`codex-start-${code}`); }

type Family = RolePolicy["family"];
interface StableCandidate { model: string; version: bigint[] }

function newestFamilyModels(catalog: CatalogSupport): Map<Family, StableCandidate> {
  return new Map(MODEL_FAMILIES.map((family) => {
    const candidates = Object.keys(catalog.supportedModels).flatMap((model) => {
      const version = generation(model, family);
      return version ? [{ model, version }] : [];
    }).sort((a, b) => compareGeneration(b.version, a.version));
    const [latest, next] = candidates;
    if (!latest) refuseStart("family-missing");
    if (next && compareGeneration(latest.version, next.version) === 0) refuseStart("family-ambiguous");
    return [family, latest];
  }));
}

export function readStartCatalog(raw: unknown): CatalogSupport {
  try { return buildCatalogSupport(raw); }
  catch { return refuseStart("catalog-invalid"); }
}

// Select candidates by numeric stable family first. The ordinary installer's
// effort-filtered planner remains the receipt authority. A different outcome
// from either policy is a refusal, never a fallback to the older candidate.
export function strictStartSelection(catalog: CatalogSupport, previous: EffectiveResolutionV2, policy: ModelPolicy, user: UserModelPolicy) {
  const newest = newestFamilyModels(catalog);
  const installed = [...Object.values(previous.roles), ...previous.agents];
  for (const family of MODEL_FAMILIES) for (const role of installed) {
    for (const pair of [role.defaultRealization, role.effective]) {
      const version = pair.model && generation(pair.model, family);
      if (version && compareGeneration(newest.get(family)!.version, version) < 0) refuseStart("catalog-regressed");
    }
  }

  const select = (role: ModelRole, sourceAgentId?: string): ModelEffort => {
    const wanted = policy.roles[role];
    const roleChoice = user.roles.get(role);
    const agentChoice = sourceAgentId === undefined ? undefined : user.agents.get(sourceAgentId);
    const pin = agentChoice?.model ?? roleChoice?.model;
    const effort = agentChoice?.effort ?? roleChoice?.effort ?? wanted.reasoning;
    let model = newest.get(wanted.family)!.model;
    if (pin !== undefined) {
      const canonical = catalog.byAlias.get(pin)?.model;
      if (!canonical || ![...newest.values()].some((entry) => entry.model === canonical)) refuseStart("model-pin-conflict");
      model = canonical;
    }
    if (!catalog.supportedModels[model]!.includes(effort)) refuseStart("latest-effort-unsupported");
    return { model, effort };
  };

  const roles = new Map(ROLES.map((role) => [role, select(role)]));
  const agents = new Map(previous.agents.map((agent) => [agent.bindingId, select(agent.role, agent.sourceAgentId)]));
  return (proposed: EffectiveResolutionV2): void => {
    const same = (pair: ModelEffort, expected: ModelEffort | undefined) => pair.model === expected?.model && pair.effort === expected.effort;
    if (ROLES.some((role) => !same(proposed.roles[role].effective, roles.get(role))) || proposed.agents.length !== agents.size
      || proposed.agents.some((agent) => !same(agent.effective, agents.get(agent.bindingId)))) refuseStart("latest-selection-conflict");
    if (ROLES.some((role) => previous.roles[role].defaultRealization.effort !== proposed.roles[role].defaultRealization.effort)) {
      refuseStart("effort-default-changed");
    }
  };
}
