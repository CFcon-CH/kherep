#!/usr/bin/env node
// Issue #737. One-time migration into <claude-home>/kherep/model-policy.user.json.
//
//   migrate-model-policy.mts <claude-home> <shipped.json> <out.json>
//
// Runs only on a host the policy installer has never touched: no user file and
// no installed shipped policy. Only then were the live agent files written
// verbatim by the earlier installer, so a frontmatter value can be told apart
// from a managed one. Explicit inputs are captured even when they equal the
// old default: the deprecated KHEREP_ALLOWED_MODELS and
// KHEREP_AGENT_MODEL_POLICY, and every frontmatter model or effort that differs
// from what the earlier installer wrote. Writes <out.json> only when something
// was captured, and prints each captured and each skipped value.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { EFFORTS, INHERIT, loadModelPolicy, ModelPolicyError, readPolicyJson, SHIPPED_FILE, USER_FILE } from "../claude/hooks/lib/model-policy.mts";
import { isModelName, parseShipped, type ShippedLayer } from "../claude/hooks/lib/model-policy-validate.mts";

// The frontmatter every installer before issue #737 wrote, unchanged since the
// first public release: claude-obs and atlassian-broker declared `model: haiku`,
// no other agent declared a model and none declared an effort.
export const LEGACY_FRONTMATTER: Readonly<Record<string, { model?: string; effort?: string }>> = {
  "claude-obs": { model: "haiku" },
  "atlassian-broker": { model: "haiku" },
};

type Entry = { model?: string; effort?: string };
export interface Capture {
  policy: { schema_version: 1; agents: Record<string, Entry>; models: Record<string, { dispatchable?: boolean }> };
  notes: string[];
}

export function liveFrontmatter(text: string): Entry {
  const lines = text.split(/\r?\n/);
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  const found: Entry = {};
  for (const line of end > 0 ? lines.slice(1, end) : []) {
    const match = /^(model|effort):\s*(.*?)\s*$/.exec(line);
    if (match && found[match[1] as keyof Entry] === undefined) found[match[1] as keyof Entry] = match[2];
  }
  return found;
}

function entry(capture: Capture, agent: string): Entry {
  return (capture.policy.agents[agent] ??= {});
}

function inCatalog(capture: Capture, shipped: ShippedLayer, model: string): boolean {
  return shipped.models.has(model) || model in capture.policy.models;
}

function captureEnvironment(capture: Capture, shipped: ShippedLayer, env: Record<string, string | undefined>): void {
  if (env.KHEREP_ALLOWED_MODELS !== undefined) {
    const names = env.KHEREP_ALLOWED_MODELS.split(",").map((name) => name.trim()).filter((name) => name && name !== INHERIT);
    for (const name of names) {
      if (!isModelName(name)) { capture.notes.push("not captured: KHEREP_ALLOWED_MODELS lists a value that is not one model name"); continue; }
      capture.policy.models[name] = { dispatchable: true };
      capture.notes.push(`captured models.${name} (dispatchable) from KHEREP_ALLOWED_MODELS`);
    }
    const dropped = [...shipped.models.keys()].filter((name) => !names.includes(name));
    if (dropped.length) capture.notes.push(`not captured: KHEREP_ALLOWED_MODELS left out ${dropped.join(", ")}; the policy only adds models`);
  }
  if (env.KHEREP_AGENT_MODEL_POLICY === undefined) return;
  let parsed: unknown;
  try { parsed = JSON.parse(env.KHEREP_AGENT_MODEL_POLICY); } catch { parsed = undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    capture.notes.push("not captured: KHEREP_AGENT_MODEL_POLICY is not a JSON object");
    return;
  }
  for (const [agent, raw] of Object.entries(parsed)) {
    const models = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
    const model = models[0];
    if (!shipped.agentRoles.has(agent)) { capture.notes.push(`not captured: KHEREP_AGENT_MODEL_POLICY names ${agent}, which is not a Kherep agent`); continue; }
    if (typeof model !== "string" || !inCatalog(capture, shipped, model)) { capture.notes.push(`not captured: KHEREP_AGENT_MODEL_POLICY gives ${agent} a model outside the catalog`); continue; }
    entry(capture, agent).model = model;
    capture.notes.push(`captured agents.${agent}.model = ${model} from KHEREP_AGENT_MODEL_POLICY${models.length > 1 ? ` (first of ${models.length})` : ""}`);
  }
}

function captureFrontmatter(capture: Capture, shipped: ShippedLayer, agentsDir: string): void {
  for (const agent of shipped.agentRoles.keys()) {
    let text: string;
    try { text = fs.readFileSync(path.join(agentsDir, `${agent}.md`), "utf8"); } catch { continue; }
    const live = liveFrontmatter(text);
    const legacy = LEGACY_FRONTMATTER[agent] ?? {};
    if (live.model !== legacy.model) {
      const model = live.model ?? INHERIT;
      if (!isModelName(model)) {
        capture.notes.push(`not captured: agents/${agent}.md model is not one model name`);
      } else if (capture.policy.agents[agent]?.model !== undefined) {
        capture.notes.push(`not captured: agents/${agent}.md model; KHEREP_AGENT_MODEL_POLICY, which dispatch enforced, is kept`);
      } else {
        if (model !== INHERIT && !inCatalog(capture, shipped, model)) capture.policy.models[model] = {};
        entry(capture, agent).model = model;
        capture.notes.push(`captured agents.${agent}.model = ${model} from the edited agents/${agent}.md`);
      }
    }
    if (live.effort !== legacy.effort && live.effort !== undefined) {
      if (EFFORTS.includes(live.effort)) {
        entry(capture, agent).effort = live.effort;
        capture.notes.push(`captured agents.${agent}.effort = ${live.effort} from the edited agents/${agent}.md`);
      } else {
        capture.notes.push(`not captured: agents/${agent}.md effort is outside ${EFFORTS.join("|")}`);
      }
    }
  }
}

export function migrate(claudeHome: string, shippedFile: string, env: Record<string, string | undefined>): Capture | null {
  const kherep = path.join(claudeHome, "kherep");
  if (fs.existsSync(path.join(kherep, USER_FILE)) || fs.existsSync(path.join(kherep, SHIPPED_FILE))) return null;
  const shipped = parseShipped(shippedFile, readPolicyJson(shippedFile, true));
  const capture: Capture = { policy: { schema_version: 1, agents: {}, models: {} }, notes: [] };
  captureEnvironment(capture, shipped, env);
  captureFrontmatter(capture, shipped, path.join(claudeHome, "agents"));
  return capture;
}

function main(argv: string[]): number {
  if (argv.length !== 3) {
    console.error("usage: migrate-model-policy.mts <claude-home> <shipped.json> <out.json>");
    return 2;
  }
  const [claudeHome, shippedFile, out] = argv;
  const capture = migrate(claudeHome, shippedFile, process.env);
  if (!capture) {
    console.log("model policy: no migration (the policy installer ran here before, or a user override exists)");
    return 0;
  }
  for (const note of capture.notes) console.log(`model policy: ${note}`);
  const noModels = Object.keys(capture.policy.models).length === 0;
  if (Object.keys(capture.policy.agents).length === 0 && noModels) {
    console.log("model policy: nothing to migrate");
    return 0;
  }
  if (noModels) delete (capture.policy as Partial<Capture["policy"]>).models;
  fs.writeFileSync(out, `${JSON.stringify(capture.policy, null, 2)}\n`);
  // The result must load exactly as the guard will load it.
  loadModelPolicy({ files: { shipped: shippedFile, user: out }, env: {} });
  console.log(`model policy: user override prepared -> ${path.join(claudeHome, "kherep", USER_FILE)}`);
  return 0;
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
    if (!(error instanceof ModelPolicyError)) throw error;
    console.error(`FATAL: ${error.message}`);
    process.exitCode = 1;
  }
}
