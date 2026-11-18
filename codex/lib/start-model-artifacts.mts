import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { sha256, type AnchoredState } from "./model-selection-anchor.mts";
import type { InstallSelection } from "./model-selection-install.mts";
import { dispatchModelSelection } from "./model-resolution-receipt.mts";
import { record, type ModelEffort } from "./model-policy.mts";
import { parseModelPolicyJson } from "./model-policy-user.mts";
import { refuseStart } from "./start-model-policy.mts";
import { setTopLevelSetting, topLevelSetting } from "./text-merge.mts";

export const PARITY = "orchestra/parity-receipt.json";
export const CONFIG = "config.toml";
const DOCUMENT_LIMIT = 1_048_576;

// Never follow a link at a managed target. Check parent directories separately
// before the anchored reader or the transaction can reach a target through one.
export function assertRegular(target: string, directory = false, optional = false): void {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat && optional) return;
  if (!stat || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) refuseStart("target-not-regular");
  if (!directory && stat.size > DOCUMENT_LIMIT) refuseStart("target-unreadable");
}

export function readManagedText(file: string): string {
  assertRegular(file);
  const bytes = fs.readFileSync(file);
  const text = bytes.toString("utf8");
  if (bytes.length > DOCUMENT_LIMIT || !Buffer.from(text, "utf8").equals(bytes)) refuseStart("target-unreadable");
  return text;
}

// Preserve unrelated bytes even when a valid receipt uses different spacing
// or field order. The strict JSON walk rejects ambiguous or duplicate keys.
function jsonDocument(text: string) {
  const spans = new Map<string, { start: number; end: number }>();
  const data = parseModelPolicyJson(text, { maxBytes: DOCUMENT_LIMIT, maxDepth: 32 }, (keys, start, end) => {
    // Only the fields this action can own are relevant.
    if (["modelResolution", "projectedAgents", "rootModelPolicy", "reasoningEffort"].includes(keys[0]!) && keys.length <= 2
      || keys.length === 4 && keys[0] === "projection" && keys[1] === "agentDefaults" && ["model", "reasoning"].includes(keys[3]!)
      || keys.length === 3 && keys[0] === "agents" && ["model", "reasoning"].includes(keys[2]!)) {
      spans.set(JSON.stringify(keys), { start, end });
    }
  });
  if (!record(data)) refuseStart("json-invalid");
  return { data, edit(replacements: ReadonlyMap<string, unknown>, addRootFields: Record<string, string> = {}): string {
    const edits = [...replacements].map(([key, next]) => {
      const span = spans.get(key);
      if (!span) refuseStart("json-target-missing");
      const original = text.slice(span.start, span.end);
      if (isDeepStrictEqual(JSON.parse(original), next)) return { ...span, next: original };
      const indentation = /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", span.start) + 1, span.start))![0];
      const newline = text.includes("\r\n") ? "\r\n" : "\n";
      return { ...span, next: JSON.stringify(next, null, 2).replaceAll("\n", `${newline}${indentation}`) };
    });
    if (Object.keys(addRootFields).length) {
      const span = spans.get('["rootModelPolicy"]')!;
      const original = text.slice(span.start, span.end - 1).trimEnd();
      const start = span.start + original.length;
      const newline = text.includes("\r\n") ? "\r\n" : "\n";
      const fields = Object.entries(addRootFields).map(([key, value]) => `${newline}    ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
      edits.push({ start, end: start, next: `${original === "{" ? "" : ","}${fields.join(",")}` });
    }
    return edits.sort((a, b) => b.start - a.start).reduce((current, edit) =>
      current.slice(0, edit.start) + edit.next + current.slice(edit.end), text);
  }, spans };
}

function nonModelSnapshot(text: string): string {
  const { edit, spans } = jsonDocument(text);
  return edit(new Map([...spans.keys()].filter((key) => key === '["modelResolution"]' || key === '["projectedAgents"]'
    || key.startsWith('["agents",')).map((key) => [key, null])));
}

export function assertModelOnly(selection: InstallSelection, previous: AnchoredState): void {
  const before = new Map(previous.actualOutputs.map((row) => [row.target, row]));
  if (selection.plan.deletions.length || selection.outputs.length !== before.size
    || selection.resolution.policySha256 !== previous.verified.resolution.policySha256
    || selection.resolution.inventoryDigest !== previous.verified.resolution.inventoryDigest) refuseStart("source-or-target-drift");
  const body = (text: string) => text.replace(/^model(?:_reasoning_effort)? = .*\n/gm, "");
  for (const row of selection.outputs) {
    const existing = before.get(row.target);
    if (!existing || row.kind !== existing.kind || row.sourceBinding !== existing.sourceBinding) refuseStart("source-or-target-drift");
    const strip = row.kind === "agent-toml" ? body : nonModelSnapshot;
    if (strip(existing.content) !== strip(row.content)) refuseStart("source-or-target-drift");
  }
}

const MODEL_KEY = "model";
const EFFORT_KEY = "model_reasoning_effort";
const KEY_VALUE = /^[ \t]*(?:([\w-]+)|("(?:[^"\\]|\\.)*")|'([^']*)')[ \t]*(?=[.=])/u;

export function assertWorkspaceConfig(codexHome: string, workspace: string, platform: NodeJS.Platform = process.platform): void {
  const comparable = (value: string) => platform === "win32" ? value.toLowerCase() : value;
  const homeConfig = comparable(path.join(codexHome, CONFIG));
  const ancestors: string[] = [];
  for (let directory = workspace; ; directory = path.dirname(directory)) {
    ancestors.push(directory);
    if (fs.lstatSync(path.join(directory, ".git"), { throwIfNoEntry: false })) break;
    if (directory === path.dirname(directory)) { ancestors.splice(1); break; }
  }
  for (const directory of ancestors) {
    const projectConfig = path.join(directory, ".codex", CONFIG);
    // The user's own home may also be an ancestor of the workspace.
    if (comparable(projectConfig) !== homeConfig && fs.lstatSync(projectConfig, { throwIfNoEntry: false })) refuseStart("project-config");
  }
}

export function configureRoot(original: string, root: ModelEffort): string {
  if (original.startsWith("\uFEFF") || /\r(?!\n)/u.test(original)) refuseStart("root-config-ambiguous");
  const values = { [MODEL_KEY]: root.model, [EFFORT_KEY]: root.effort };
  const seen = new Set<string>();
  let providerSeen = false;
  const plain = /^([ \t]*(model|model_reasoning_effort)[ \t]*=[ \t]*)("[a-z0-9.-]+"|'[a-z0-9.-]+')([ \t]*(?:#.*)?)$/u;
  let rootTable = true;
  // A literal or escaped/quoted setting outside our supported root grammar
  // refuses before either root key can be inserted or changed.
  let next = original.split(/(\r?\n)/u).map((line) => {
    if (/^\s*#/u.test(line)) return line;
    if (/^\s*\[/u.test(line)) rootTable = false;
    const match = KEY_VALUE.exec(line);
    const key = match?.[1] ?? (match?.[2] ? JSON.parse(match[2]) as string : match?.[3]);
    if (key === "profile" || key === "model_catalog_json" || key === "project_root_markers"
      || /^\s*\[\s*["']?profiles[.\s\]"']|^\s*\[\s*(?:agents|"agents"|'agents')\s*\./u.test(line)) refuseStart("root-override-unsupported");
    if (!rootTable) return line;
    if (key === "openai_base_url" || key === "chatgpt_base_url") refuseStart("provider-unsupported");
    if (key === "model_provider") {
      if (providerSeen || !/^[ \t]*model_provider[ \t]*=[ \t]*(?:"openai"|'openai')[ \t]*(?:#.*)?$/u.test(line)) refuseStart("provider-unsupported");
      providerSeen = true;
    }
    if (key === "agents") refuseStart("root-override-unsupported");
    if (line.includes('"""') || line.includes("'''")) refuseStart("root-config-ambiguous");
    if (key !== MODEL_KEY && key !== EFFORT_KEY) return line;
    const setting = plain.exec(line);
    if (!setting || seen.has(key)) refuseStart("root-config-ambiguous");
    seen.add(key);
    if (setting[3]!.slice(1, -1) === values[key]) return line;
    const quote = setting[3]![0];
    return `${setting[1]}${quote}${values[key]}${quote}${setting[4]}`;
  }).join("");
  for (const key of [MODEL_KEY, EFFORT_KEY] as const) if (!seen.has(key)) next = setTopLevelSetting(next, key, JSON.stringify(values[key]));
  for (const key of [MODEL_KEY, EFFORT_KEY] as const) {
    const raw = topLevelSetting(next, key);
    const value = raw?.match(/^(?:"([a-z0-9.-]+)"|'([a-z0-9.-]+)')(?:[ \t]*#.*)?$/u);
    if ((value?.[1] ?? value?.[2]) !== values[key]) {
      refuseStart("root-config-ambiguous");
    }
  }
  return next;
}

export function updateParity(text: string, previous: AnchoredState, selection: InstallSelection, selectionId: string, config: string): string {
  const { data, edit } = jsonDocument(text);
  const oldPointer = { ...selection.pointer, selectionId: previous.verified.selectionId };
  // The anchored receipt authenticates only its immediate predecessor. A
  // lagging parity pointer can be repaired while preserving its exact schema.
  const predecessorId = previous.verified.receipt?.inputs.previousSelectionId;
  const ownsPointer = isDeepStrictEqual(data.modelResolution, oldPointer)
    || typeof predecessorId === "string" && isDeepStrictEqual(data.modelResolution, { ...oldPointer, selectionId: predecessorId });
  const { projectedAgents } = dispatchModelSelection(selection.resolution, selectionId);
  const projection = data.projection;
  if (data.schemaVersion !== 1 || !ownsPointer || !record(projection)
    || !record(projection.agentDefaults) || Object.keys(projection.agentDefaults).length !== Object.keys(projectedAgents).length) {
    refuseStart("parity-ownership-conflict");
  }
  const existingDefaults = projection.agentDefaults;
  const edits = new Map<string, unknown>([['["modelResolution","selectionId"]', selectionId]]);
  for (const [name, pair] of Object.entries(projectedAgents)) {
    const row = existingDefaults[name];
    if (!record(row) || row.role !== pair.role || typeof row.model !== "string" || typeof row.reasoning !== "string") refuseStart("parity-ownership-conflict");
    for (const key of ["model", "reasoning"] as const) edits.set(JSON.stringify(["projection", "agentDefaults", name, key]), pair[key]);
  }
  const root = selection.resolution.roles.root.effective;
  if (!record(data.rootModelPolicy) || !record(data.reasoningEffort)) refuseStart("parity-ownership-conflict");
  edits.set('["reasoningEffort","status"]', "applied");
  edits.set('["reasoningEffort","value"]', root.effort);
  const addRootFields: Record<string, string> = {};
  for (const [key, value] of Object.entries({ status: "applied", model: root.model, effort: root.effort, configSha256: sha256(config) })) {
    if (Object.hasOwn(data.rootModelPolicy, key)) edits.set(JSON.stringify(["rootModelPolicy", key]), value);
    else addRootFields[key] = value;
  }
  return edit(edits, addRootFields);
}
