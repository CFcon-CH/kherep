import fs from "node:fs";
import type { ModelResolution, ModelRole } from "./model-policy.mts";
import path from "node:path";

import { loadCanonicalPluginSources } from "./canonical-plugin-sources.mts";
import {
  adaptCodexText, adaptSkillText, normalizeName, parseFrontmatter, renderAgent, renderCommandSkill, renderTomlCommandSkill,
} from "./component-render.mts";
import type {
  AgentRenderOptions, CanonicalSource, CapabilityPlugin, PluginStatus, ProjectionContext, ProjectionReceipt,
} from "./contracts.mts";
import type { InstallTransaction } from "./install-transaction.mts";
import { previousManaged, removeStaleManaged, reservePersonalTargets } from "./managed-projection.mts";
const SKILL_NAME_LINE = /^name:\s*(?:\S.*)?$/m;

// A row of Claude's installed_plugins.json; only the fields read here are typed.
export interface InstalledPlugin {
  installPath?: unknown;
  version?: unknown;
  lastUpdated?: unknown;
  installedAt?: unknown;
}

function directories(root: string): string[] {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
}
function files(root: string, extension = ".md"): string[] {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(root, entry.name));
}
function stamp(entry: InstalledPlugin): string {
  return String(entry.lastUpdated || entry.installedAt || "");
}
export function newest(entries: unknown): InstalledPlugin | null {
  const list: InstalledPlugin[] = Array.isArray(entries) ? [...entries] : entries ? [entries as InstalledPlugin] : [];
  return list.sort((a, b) => stamp(b).localeCompare(stamp(a)))[0] || null;
}

function pluginShort(id: string): string {
  return normalizeName(String(id).split("@")[0]);
}

export function uniqueName(preferred: string, used: Set<string>, prefix: string): string {
  let name = normalizeName(preferred);
  if (!used.has(name)) { used.add(name); return name; }
  name = normalizeName(`${prefix}-${preferred}`);
  let candidate = name;
  let index = 2;
  while (used.has(candidate)) candidate = `${name.slice(0, 60)}-${index++}`;
  used.add(candidate);
  return candidate;
}

function adaptSkillTree(transaction: InstallTransaction, root: string): void {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) adaptSkillTree(transaction, target);
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      const source = fs.readFileSync(target, "utf8");
      transaction.writeFile(target, entry.name === "SKILL.md" ? adaptSkillText(source) : adaptCodexText(source));
    }
  }
}

function installKherepSkills(context: ProjectionContext, usedSkills: Set<string>, receipt: ProjectionReceipt): void {
  const { capabilities, codexHome, repoRoot, transaction } = context;
  const activeRoot = path.join(repoRoot, "claude", "skills");
  const compatibilityRoot = path.join(repoRoot, "claude", "_deprecated", "skills");
  for (const name of capabilities.kherepSkills.active) {
    const target = path.join(codexHome, "skills", name);
    const existed = Boolean(fs.statSync(target, { throwIfNoEntry: false }));
    transaction.installDir(path.join(activeRoot, name), target);
    adaptSkillTree(transaction, target);
    usedSkills.add(name);
    receipt.skills.push({ name, source: "kherep", status: existed ? "replaced-with-backup" : "installed" });
  }
  for (const name of capabilities.kherepSkills.compatibility) {
    const target = path.join(codexHome, "skills", name);
    const existed = Boolean(fs.statSync(target, { throwIfNoEntry: false }));
    transaction.installDir(path.join(compatibilityRoot, name), target);
    adaptSkillTree(transaction, target);
    const skillFile = path.join(target, "SKILL.md");
    const skillContent = fs.readFileSync(skillFile, "utf8").replace(SKILL_NAME_LINE, `name: ${name}`);
    transaction.writeFile(skillFile, skillContent);
    transaction.writeFile(path.join(target, "agents", "openai.yaml"), [
      "interface:",
      `  display_name: ${JSON.stringify(name)}`,
      `  short_description: ${JSON.stringify("Claude compatibility skill (explicit only)")}`,
      `  default_prompt: ${JSON.stringify(`Use $${name} for this explicit compatibility workflow.`)}`,
      "policy:",
      "  allow_implicit_invocation: false",
      "",
    ].join("\n"));
    usedSkills.add(name);
    receipt.skills.push({
      name, source: "kherep-compatibility",
      status: existed ? "replaced-with-backup-explicit-only" : "installed-explicit-only",
    });
  }
}

function installCommands(context: ProjectionContext, usedSkills: Set<string>, receipt: ProjectionReceipt): void {
  const { capabilities, codexHome, repoRoot, transaction } = context;
  for (const name of capabilities.commands) {
    const source = path.join(repoRoot, "codex", "commands", `${name}.md`);
    const content = fs.readFileSync(source, "utf8");
    const target = path.join(codexHome, "skills", name, "SKILL.md");
    const existed = Boolean(fs.statSync(path.dirname(target), { throwIfNoEntry: false }));
    transaction.writeFile(target, renderCommandSkill(name, content, `Kherep command ${name}`));
    usedSkills.add(name);
    receipt.commands.push({ name, status: existed ? "replaced-with-backup" : "installed-as-skill" });
  }
  transaction.copyFile(
    path.join(repoRoot, "codex", "session-kickoff", "protocol.md"),
    path.join(codexHome, "orchestra", "session-kickoff", "protocol.md"),
  );
}

// A capability entry projects claude/agents/<name>.md unless it names a
// runtime-specific source, repo-relative (OP-1432: codex-obs has its own text).
export function agentSourcePath(repoRoot: string, name: string, options: AgentRenderOptions): string {
  return options.source
    ? path.join(repoRoot, options.source)
    : path.join(repoRoot, "claude", "agents", `${name}.md`);
}

function installKherepAgents(context: ProjectionContext, usedAgents: Set<string>, receipt: ProjectionReceipt): void {
  const { capabilities, codexHome, repoRoot, transaction } = context;
  for (const [name, options] of Object.entries(capabilities.agents)) {
    const source = fs.readFileSync(agentSourcePath(repoRoot, name, options), "utf8");
    const projected = options.as || name;
    const target = path.join(codexHome, "agents", `${projected}.toml`);
    const existed = Boolean(fs.statSync(target, { throwIfNoEntry: false }));
    transaction.writeFile(target, renderAgent(projected, source, options));
    usedAgents.add(projected);
    receipt.agents.push({ name: projected, status: existed ? "replaced-with-backup" : "installed" });
    receipt.agentDefaults[projected] = { role: options.role!, model: options.model!, reasoning: options.reasoning! };
  }
}

function installPluginSkills(context: ProjectionContext, plugin: CapabilityPlugin, root: string, usedSkills: Set<string>, receipt: ProjectionReceipt): void {
  for (const skillDir of directories(path.join(root, "skills"))) {
    const skillFile = path.join(skillDir, "SKILL.md");
    if (!fs.statSync(skillFile, { throwIfNoEntry: false })?.isFile()) continue;
    const parsed = parseFrontmatter(fs.readFileSync(skillFile, "utf8"));
    const name = uniqueName(parsed.metadata.name || path.basename(skillDir), usedSkills, pluginShort(plugin.id));
    const target = path.join(context.codexHome, "skills", name);
    context.transaction.installDir(skillDir, target);
    adaptSkillTree(context.transaction, target);
    if (name !== normalizeName(parsed.metadata.name || path.basename(skillDir))) {
      const installedSkill = path.join(target, "SKILL.md");
      const content = fs.readFileSync(installedSkill, "utf8").replace(SKILL_NAME_LINE, `name: ${name}`);
      context.transaction.writeFile(installedSkill, content);
    }
    receipt.skills.push({ name, source: plugin.id, status: "projected" });
  }
}

function installPluginCommands(context: ProjectionContext, plugin: CapabilityPlugin, root: string, usedSkills: Set<string>, receipt: ProjectionReceipt): void {
  const commandRoot = path.join(root, "commands");
  const sources = [...files(commandRoot), ...files(commandRoot, ".toml")];
  for (const source of sources) {
    const extension = path.extname(source);
    const preferred = path.basename(source, extension);
    const name = uniqueName(preferred, usedSkills, pluginShort(plugin.id));
    const content = fs.readFileSync(source, "utf8");
    const rendered = extension === ".toml"
      ? renderTomlCommandSkill(name, content, plugin.id)
      : renderCommandSkill(name, content, plugin.id);
    context.transaction.writeFile(path.join(context.codexHome, "skills", name, "SKILL.md"), rendered);
    receipt.commands.push({ name, source: plugin.id, status: "projected-as-skill" });
  }
}

export function pluginAgentRole(plugin: CapabilityPlugin, name: string, source: string): ModelRole {
  if (plugin.id === "feature-dev@claude-plugins-official" && name === "code-architect") return "designer";
  const model = parseFrontmatter(source).metadata.model;
  if (plugin.id.startsWith("code-simplifier@") || model === "opus") return "builder";
  if (model === "haiku") return "researcher";
  return "support";
}

function agentOptions(context: ProjectionContext, plugin: CapabilityPlugin, name: string, source: string): AgentRenderOptions {
  const role = pluginAgentRole(plugin, name, source);
  const resolution = context.capabilities.modelResolution as ModelResolution | undefined;
  if (!resolution?.roles[role]) throw new Error("Plugin projection requires a resolved model policy");
  return { role, ...resolution.roles[role] };
}

function installPluginAgents(context: ProjectionContext, plugin: CapabilityPlugin, root: string, usedAgents: Set<string>, receipt: ProjectionReceipt): void {
  for (const sourceFile of files(path.join(root, "agents"))) {
    const preferred = path.basename(sourceFile, ".md");
    const name = uniqueName(preferred, usedAgents, pluginShort(plugin.id));
    const source = fs.readFileSync(sourceFile, "utf8");
    const options = agentOptions(context, plugin, preferred, source);
    context.transaction.writeFile(
      path.join(context.codexHome, "agents", `${name}.toml`),
      renderAgent(name, source, options),
    );
    receipt.agents.push({ name, source: plugin.id, status: "projected" });
    receipt.agentDefaults[name] = { role: options.role!, model: options.model!, reasoning: options.reasoning! };
  }
}

function initialStatus(plugin: CapabilityPlugin, entry: CanonicalSource | undefined): string {
  if (plugin.mode === "not-applicable") return "not-applicable";
  if (plugin.mode === "native") return "target-declared-restart-required";
  if (plugin.mode === "mcp") return "configured";
  return entry ? "source-found" : "source-missing";
}

function installPlugins(context: ProjectionContext, usedSkills: Set<string>, usedAgents: Set<string>, receipt: ProjectionReceipt): void {
  const canonical = loadCanonicalPluginSources(context);
  for (const plugin of context.capabilities.plugins) {
    const entry = canonical.get(plugin.id);
    const status: PluginStatus = {
      id: plugin.id, mode: plugin.mode, target: plugin.target || null, status: initialStatus(plugin, entry),
    };
    if (entry?.version) status.version = String(entry.version);
    receipt.plugins.push(status);
    if (!entry || !["project", "agent"].includes(plugin.mode)) continue;
    const root = entry.root;
    status.contentSha256 = entry.contentSha256;
    status.source = "repository-canonical";
    if (plugin.mode === "project") {
      installPluginSkills(context, plugin, root, usedSkills, receipt);
      installPluginCommands(context, plugin, root, usedSkills, receipt);
    }
    installPluginAgents(context, plugin, root, usedAgents, receipt);
    status.status = "projected";
  }
}

export function project(context: ProjectionContext): ProjectionReceipt {
  const receipt: ProjectionReceipt = { agents: [], agentDefaults: {}, commands: [], plugins: [], skills: [] };
  const usedSkills = new Set<string>();
  const usedAgents = new Set<string>();
  const prior = previousManaged(context.codexHome);
  installKherepSkills(context, usedSkills, receipt);
  installCommands(context, usedSkills, receipt);
  installKherepAgents(context, usedAgents, receipt);
  reservePersonalTargets(context.codexHome, usedSkills, usedAgents, prior);
  installPlugins(context, usedSkills, usedAgents, receipt);
  removeStaleManaged(context, prior, receipt);
  return receipt;
}
