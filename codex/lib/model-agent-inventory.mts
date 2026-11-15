import { createHash } from "node:crypto";
import { ROLES, record, type ModelRole } from "./model-policy.mts";

// These classifications are supplied by the adapter, never by the user layer.
export interface AgentSourceInput {
  sourcePath: string; sourceProvider: string; installedName: string; role: ModelRole;
  securityPolicyDigest: string; sourceSha256: string; codeBound: boolean; capabilityKey?: string;
}
export interface AgentIdentity extends AgentSourceInput { sourceAgentId: string; bindingId: string }
export interface AgentInventory {
  schemaVersion: 1; agents: readonly AgentIdentity[];
  bySourceId: ReadonlyMap<string, readonly AgentIdentity[]>; digest: string;
}
const FIELDS = new Set(["sourcePath", "sourceProvider", "installedName", "role", "securityPolicyDigest", "sourceSha256", "codeBound", "capabilityKey"]);
const RESERVED = new Set(["__proto__", "prototype", "constructor"]);
const token = (value: unknown): value is string => typeof value === "string" && value.length <= 200
  && /^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(value) && !RESERVED.has(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function fail(code: string): never { throw new Error(`agent-inventory: ${code}`); }

// Pure inventory construction. Source discovery, role assignment and collision-name
// allocation remain adapter responsibilities; no source or installed files are read.
export function buildAgentInventory(inputs: readonly AgentSourceInput[]): AgentInventory {
  if (!Array.isArray(inputs) || inputs.length > 512) fail("invalid-inventory-size");
  const bindings = new Set<string>(), aliases = new Set<string>();
  const agents: AgentIdentity[] = [];
  for (const raw of inputs) {
    if (!record(raw) || Object.keys(raw).some(key => !FIELDS.has(key))) fail("unknown-field");
    const input = raw as unknown as AgentSourceInput;
    if (typeof input.sourcePath !== "string") fail("invalid-source-classification");
    const parts = typeof input.sourcePath === "string" ? input.sourcePath.split("/") : [];
    const leaf = parts.at(-1) ?? "";
    const sourceAgentId = leaf.endsWith(".md") ? leaf.slice(0, -3) : "";
    if (!parts.length || parts.some(part => !token(part) || part === "." || part === "..") || !token(sourceAgentId)
      || !token(input.sourceProvider) || !token(input.installedName) || !ROLES.includes(input.role)
      || !digest(input.securityPolicyDigest) || !digest(input.sourceSha256) || typeof input.codeBound !== "boolean"
      || (input.capabilityKey !== undefined && !token(input.capabilityKey))) fail("invalid-source-classification");
    const bindingId = `${input.sourceProvider}:${input.sourcePath}`;
    if (bindings.has(bindingId)) fail("duplicate-source-binding");
    // Destination names must be unique on case-insensitive NTFS/APFS too.
    if (aliases.has(input.installedName.toLowerCase())) fail("duplicate-installed-name");
    bindings.add(bindingId); aliases.add(input.installedName.toLowerCase());
    agents.push(Object.freeze({ sourceAgentId, bindingId, sourcePath: input.sourcePath,
      sourceProvider: input.sourceProvider, installedName: input.installedName, role: input.role,
      securityPolicyDigest: input.securityPolicyDigest, sourceSha256: input.sourceSha256,
      codeBound: input.codeBound, ...(input.capabilityKey === undefined ? {} : { capabilityKey: input.capabilityKey }) }));
  }
  agents.sort((a, b) => a.bindingId < b.bindingId ? -1 : a.bindingId > b.bindingId ? 1 : 0);
  const bySourceId = new Map<string, readonly AgentIdentity[]>();
  for (const agent of agents) bySourceId.set(agent.sourceAgentId, Object.freeze([...(bySourceId.get(agent.sourceAgentId) ?? []), agent]));
  return { schemaVersion: 1, agents: Object.freeze(agents), bySourceId,
    digest: createHash("sha256").update(JSON.stringify(agents)).digest("hex") };
}

// Rebuild derived lookup state rather than trusting a caller-supplied digest/map.
export function verifyAgentInventory(inventory: AgentInventory): AgentInventory {
  if (!inventory || inventory.schemaVersion !== 1 || !Array.isArray(inventory.agents)) fail("inventory-digest-conflict");
  const checked = buildAgentInventory(inventory.agents.map(({ sourceAgentId: _id, bindingId: _binding, ...source }) => source));
  if (checked.digest !== inventory.digest || checked.agents.some(agent => !inventory.agents.some(row =>
    row.bindingId === agent.bindingId && row.sourceAgentId === agent.sourceAgentId))) fail("inventory-digest-conflict");
  return checked;
}
