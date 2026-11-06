import type { AgentRenderOptions } from "./contracts.mts";

export interface Frontmatter {
  body: string;
  metadata: Record<string, string>;
}

export function adaptCodexText(value: unknown): string {
  return String(value || "")
    .replace(/~\/\.claude\/teams\/kherep\/ROUTING\.md/g, "~/.codex/orchestra/ROUTING.md")
    .replace(/\.claude\.local\.md/g, "AGENTS.override.md")
    .replace(/[A-Za-z]:\\Users\\[^\\]+\\\.claude(?=\\)/gi, "~/.codex")
    .replace(/~\/\.claude\b/g, "~/.codex")
    .replace(/([\\/])\.claude(?=[\\/])/g, "$1.codex")
    .replace(/(^|[\s`"'(])\.claude(?=[\\/])/gm, "$1.codex")
    .replace(/~\/\.codex\\/g, "~/.codex/")
    .replace(/CLAUDE\.md/g, "AGENTS.md")
    .replace(/CLAUDE_CONFIG_DIR/g, "CODEX_HOME")
    .replace(/Claude cloud subagent/g, "Codex cloud subagent")
    .replace(/Claude subagent/g, "Codex subagent")
    .replace(/Claude Agent wrappers/g, "Codex agent wrappers")
    .replace(/Claude Code/g, "Codex");
}

export function adaptSkillText(value: unknown): string {
  const content = adaptCodexText(value);
  if (content.includes("<!-- kherep-codex-projection -->")) return content;
  const safety = [
    "<!-- kherep-codex-projection -->",
    "## Codex projection safety",
    "",
    "Central memory is unconfigured. Do not assume memory access or a supported provider; stop when an operation requires an unavailable memory service.",
    "All raw Claude sessions, transcripts, configuration, plugins, or hooks remain forbidden. Do not read or modify Claude-private memory databases. Use Codex paths and tools for all other state; stop if no supported Codex equivalent exists.",
    "",
  ].join("\n");
  const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (frontmatter) return `${frontmatter[0]}\n${safety}${content.slice(frontmatter[0].length)}`;
  return `${safety}${content}`;
}

export function parseFrontmatter(text: unknown): Frontmatter {
  const source = String(text || "");
  if (!source.startsWith("---")) return { body: source.trim(), metadata: {} };
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { body: source.trim(), metadata: {} };
  const metadata: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (field) metadata[field[1]] = field[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return { body: source.slice(match[0].length).trim(), metadata };
}

export function normalizeName(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|(?<!-)-+$/g, "")
    .slice(0, 64);
}

export function renderCommandSkill(name: string, source: string, provenance: string): string {
  const parsed = parseFrontmatter(adaptCodexText(source));
  const skillName = normalizeName(name);
  const description = parsed.metadata.description ||
    `Use when the user explicitly invokes or asks for the ${skillName} workflow.`;
  const adapter = [
    "## Codex compatibility",
    "",
    `Source workflow: ${provenance}.`,
    "Translate Claude tool names to the available Codex tool or connector while preserving every safety and approval gate.",
    "Never write Claude session/configuration state from Codex. Use Codex task state and versioned Orchestra paths instead.",
  ].join("\n");
  return [
    "---",
    `name: ${skillName}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${skillName}`,
    "",
    adapter,
    "",
    parsed.body,
    "",
  ].join("\n");
}

export function renderTomlCommandSkill(name: string, source: string, provenance: string): string {
  const field = (key: string): string => {
    const match = String(source).match(new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")`, "m"));
    if (!match) return "";
    try { return JSON.parse(match[1]); } catch { return ""; }
  };
  const description = field("description") || `Use when the user explicitly invokes ${name}.`;
  const prompt = field("prompt") || String(source);
  return renderCommandSkill(name, `---\ndescription: ${description}\n---\n${prompt}`, provenance);
}

export function renderAgent(name: string, source: string, options: AgentRenderOptions = {}): string {
  const parsed = parseFrontmatter(adaptCodexText(source));
  const description = parsed.metadata.description || `Compatibility agent for ${name}.`;
  const lines = [
    `name = ${JSON.stringify(name)}`,
    `description = ${JSON.stringify(description)}`,
    `developer_instructions = ${JSON.stringify(parsed.body)}`,
  ];
  if (options.model) lines.push(`model = ${JSON.stringify(options.model)}`);
  if (options.reasoning) lines.push(`model_reasoning_effort = ${JSON.stringify(options.reasoning)}`);
  if (options.sandbox) lines.push(`sandbox_mode = ${JSON.stringify(options.sandbox)}`);
  return `${lines.join("\n")}\n`;
}
