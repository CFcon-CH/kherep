#!/usr/bin/env node
// Issue #737. Renders the model and effort of each Claude agent from the
// resolved model policy into its frontmatter. The source in claude/agents/
// carries `model: __KHEREP_MODEL__` and `effort: __KHEREP_EFFORT__` as the last
// frontmatter lines; install.sh and drift-check.sh render them the same way, so
// a user override is installed and is not drift.
//
//   model-policy-render.mts agents <source-dir> <out-dir> <shipped.json> <user.json>
//   model-policy-render.mts agent <source.md> <out.md> <shipped.json> <user.json>
//   model-policy-render.mts portable <agents-dir>      (capture: back to placeholders)
//
// <user.json> may be absent. A line drops when its value is unresolved: no
// effort, or a model that is only a shipped role default (native inherit).
// A placeholder left in the output, or an agent the policy does not know, is fatal.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadModelPolicy, ModelPolicyError, type ResolvedAgent, type ResolvedPolicy } from "../claude/hooks/lib/model-policy.mts";

export const MODEL_PLACEHOLDER = "__KHEREP_MODEL__";
export const EFFORT_PLACEHOLDER = "__KHEREP_EFFORT__";

export class RenderError extends Error {}

function frontmatterEnd(lines: string[], label: string): number {
  const end = lines[0]?.replace(/\r$/, "") === "---" ? lines.findIndex((line, i) => i > 0 && line.replace(/\r$/, "") === "---") : -1;
  if (end < 0) throw new RenderError(`${label}: no frontmatter`);
  return end;
}

export function renderAgentText(text: string, agent: ResolvedAgent | undefined, label: string): string {
  const lines = text.split("\n");
  const end = frontmatterEnd(lines, label);
  const out: string[] = [];
  for (const [index, line] of lines.entries()) {
    const bare = line.replace(/\r$/, "");
    const eol = line.endsWith("\r") ? "\r" : "";
    if (index > 0 && index < end && (bare === `model: ${MODEL_PLACEHOLDER}` || bare === `effort: ${EFFORT_PLACEHOLDER}`)) {
      if (!agent) throw new RenderError(`${label}: the model policy has no entry for this agent`);
      const field = bare.startsWith("model:") ? "model" : "effort";
      const value = field === "model" ? (agent.roleDefaultModel ? undefined : agent.model) : agent.effort;
      if (value !== undefined) out.push(`${field}: ${value}${eol}`);
      continue;
    }
    out.push(line);
  }
  const rendered = out.join("\n");
  if (rendered.includes(MODEL_PLACEHOLDER) || rendered.includes(EFFORT_PLACEHOLDER)) {
    throw new RenderError(`${label}: unresolved model policy placeholder`);
  }
  return rendered;
}

// Capture copies a rendered live agent back into the source: its model and
// effort lines become the two placeholders again, at the end of the frontmatter.
export function portableAgentText(text: string, label: string): string {
  const lines = text.split("\n");
  const end = frontmatterEnd(lines, label);
  const eol = lines[0].endsWith("\r") ? "\r" : "";
  const front = lines.slice(1, end).filter((line) => !/^(model|effort):/.test(line));
  return ["---" + eol, ...front, `model: ${MODEL_PLACEHOLDER}${eol}`, `effort: ${EFFORT_PLACEHOLDER}${eol}`, ...lines.slice(end)].join("\n");
}

export function renderAgentFile(source: string, out: string, policy: ResolvedPolicy): void {
  const text = fs.readFileSync(source, "utf8");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderAgentText(text, policy.agents.get(path.basename(source, ".md")), `agents/${path.basename(source)}`));
}

function agentFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
}

function load(shipped: string, user: string): ResolvedPolicy {
  return loadModelPolicy({ files: { shipped, user } });
}

function main(argv: string[]): number {
  const [command, ...args] = argv;
  if (command === "agents" && args.length === 4) {
    const [sourceDir, outDir, shipped, user] = args;
    const policy = load(shipped, user);
    for (const warning of policy.warnings) console.error(`model policy: WARNING ${warning}`);
    for (const name of agentFiles(sourceDir)) {
      renderAgentFile(path.join(sourceDir, name), path.join(outDir, name), policy);
    }
    return 0;
  }
  if (command === "agent" && args.length === 4) {
    const [source, out, shipped, user] = args;
    renderAgentFile(source, out, load(shipped, user));
    return 0;
  }
  if (command === "portable" && args.length === 1) {
    for (const name of agentFiles(args[0])) {
      const file = path.join(args[0], name);
      fs.writeFileSync(file, portableAgentText(fs.readFileSync(file, "utf8"), `agents/${name}`));
    }
    return 0;
  }
  console.error("usage: model-policy-render.mts agents <source-dir> <out-dir> <shipped> <user> | agent <source> <out> <shipped> <user> | portable <dir>");
  return 2;
}

// argv[1] counts as given and as its real path (see bootstrap/ci-shard.mts).
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof ModelPolicyError || error instanceof RenderError)) throw error;
    console.error(`FATAL: ${error.message}`);
    process.exitCode = 1;
  }
}
