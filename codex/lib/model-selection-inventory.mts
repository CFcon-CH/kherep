import { createHash } from "node:crypto";

import type { AgentRenderOptions, Capabilities, CapabilityPlugin } from "./contracts.mts";
import { buildAgentInventory, type AgentInventory } from "./model-agent-inventory.mts";
import { ROLES, record, type ModelRole } from "./model-policy.mts";
import type { SourceReader } from "./model-selection-git.mts";
import { pluginAgentRole } from "./parity-projection.mts";

export const CAPABILITIES_PATH = "codex/parity/capabilities.json";
export const MODEL_POLICY_PATH = "codex/parity/model-policy.toml";
const PLUGIN_ROOT = "codex/parity/plugin-sources";
export const KHEREP_PROVIDER = "kherep";

// One adapter-classified agent source. Role, sandbox and code binding come from
// the shipped manifest or the plugin role rule, never from the user layer.
export interface AgentSourceRow {
  bindingId: string; sourcePath: string; sourceProvider: string; preferredName: string;
  role: ModelRole; codeBound: boolean; sandbox: string | null; capabilityKey?: string; source: string;
}
export interface SourceSnapshot { capabilities: Capabilities; policyText: string; rows: readonly AgentSourceRow[] }

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
function fail(code: string): never { throw new Error(`model-selection-inventory: ${code}`); }

export function securityPolicyDigest(row: Pick<AgentSourceRow, "sandbox" | "codeBound">): string {
  return sha(JSON.stringify({ sandbox: row.sandbox, codeBound: row.codeBound }));
}

function kherepRows(reader: SourceReader, agents: Record<string, AgentRenderOptions>): AgentSourceRow[] {
  return Object.entries(agents).map(([key, options]: [string, AgentRenderOptions]) => {
    if (!record(options as unknown) || !ROLES.includes(options.role as ModelRole)) fail("unknown-role");
    const sourcePath = options.source ?? `claude/agents/${key}.md`;
    return { bindingId: `${KHEREP_PROVIDER}:${sourcePath}`, sourcePath, sourceProvider: KHEREP_PROVIDER,
      preferredName: options.as || key, role: options.role as ModelRole, codeBound: options.codeBound === true,
      sandbox: options.sandbox ?? null, capabilityKey: key, source: reader.read(sourcePath) };
  });
}

function pluginRows(reader: SourceReader, plugins: readonly CapabilityPlugin[]): AgentSourceRow[] {
  const projected = plugins.filter((plugin) => plugin.mode === "project" || plugin.mode === "agent");
  if (!projected.length) return [];
  const manifest: unknown = JSON.parse(reader.read(`${PLUGIN_ROOT}/manifest.json`));
  const entries = record(manifest) && Array.isArray(manifest.plugins) ? manifest.plugins as { id?: unknown; path?: unknown }[] : fail("plugin-manifest");
  return projected.flatMap((plugin) => {
    const entry = entries.find((row) => record(row) && row.id === plugin.id);
    if (!entry || typeof entry.path !== "string") fail("plugin-manifest");
    const directory = `${PLUGIN_ROOT}/${entry.path}/agents`;
    return reader.list(directory).filter((name) => name.endsWith(".md")).map((name) => {
      const sourcePath = `${directory}/${name}`, source = reader.read(sourcePath), preferredName = name.slice(0, -3);
      return { bindingId: `${plugin.id}:${sourcePath}`, sourcePath, sourceProvider: plugin.id, preferredName,
        role: pluginAgentRole(plugin, preferredName, source), codeBound: false, sandbox: null, source };
    });
  });
}

// Reads the manifest, the model policy and every agent source through one
// reader, so the working tree and a pinned commit are classified identically.
export function readSourceSnapshot(reader: SourceReader): SourceSnapshot {
  const capabilities = JSON.parse(reader.read(CAPABILITIES_PATH)) as Capabilities;
  if (!record(capabilities) || !record(capabilities.agents) || !Array.isArray(capabilities.plugins)) fail("manifest");
  return { capabilities, policyText: reader.read(MODEL_POLICY_PATH),
    rows: [...kherepRows(reader, capabilities.agents), ...pluginRows(reader, capabilities.plugins)] };
}

// Installed names are allocated by the projection plan (current revision) or
// taken from the pinned receipt's alias column (an earlier revision).
export function buildSelectionInventory(rows: readonly AgentSourceRow[], names: ReadonlyMap<string, string>): AgentInventory {
  return buildAgentInventory(rows.map((row) => {
    const installedName = names.get(row.bindingId);
    if (installedName === undefined) fail("alias-missing");
    return { sourcePath: row.sourcePath, sourceProvider: row.sourceProvider, installedName, role: row.role,
      securityPolicyDigest: securityPolicyDigest(row), sourceSha256: sha(row.source), codeBound: row.codeBound,
      ...(row.capabilityKey === undefined ? {} : { capabilityKey: row.capabilityKey }) };
  }));
}
