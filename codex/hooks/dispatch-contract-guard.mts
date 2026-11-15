import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DISPATCH_TOOLS = new Set(["Agent", "spawn_agent"]);

// The pins come from the parity manifest the installer projects the agent TOML from:
// an agents entry with "enforcePin": true pins its projected name (`as`, else its key)
// to its `model`. The installer copies the manifest to the same place relative to the
// installed guard, so the repository and an installation each read one file.
export const CAPABILITIES_FILE = path.join(import.meta.dirname, "..", "parity", "capabilities.json");

export type Pins = ReadonlyMap<string, string>;
// The pins plus the projected name of the observation agent, whose brief format
// is checked at dispatch (issue #331); null when the manifest projects none.
export interface DispatchPolicy {
  pins: Pins;
  observationAgent: string | null;
  // Issue #701. Projected names of the agents marked "codeBound", whose brief
  // must carry revision: and decided: (claude/hooks/lib/worker-brief-policy.mts).
  codeBoundAgents: ReadonlySet<string>;
  supportedModels: ReadonlyMap<string, ReadonlySet<string>>;
  agentDefaults: ReadonlyMap<string, { model: string; reasoning: string }>;
}
// The manifest key of the observation agent; the projected name is its `as`.
const OBSERVATION_ENTRY = "claude-obs";

// The brief checks are Claude hook libs, found the way privacy-boundary-guard.mts
// finds its libs: beside this file at the install target (hookDir/lib, copied from
// claude/hooks/lib), else in the checkout under claude/hooks/lib. The observation
// lib is loaded only for an observation dispatch and the worker lib (issue #701)
// is required only for a code-bound one, so a missing lib refuses that dispatch
// (main fails closed) and no other.
type ObsBriefPolicy = typeof import("../../claude/hooks/lib/obs-brief-policy.mts");
type WorkerBriefPolicy = typeof import("../../claude/hooks/lib/worker-brief-policy.mts");
const require = createRequire(import.meta.url);
function hookLib<T>(name: string): T {
  const local = path.join(import.meta.dirname, "lib", name);
  return require(fs.existsSync(local) ? local : path.resolve(import.meta.dirname, "..", "..", "claude", "hooks", "lib", name)) as T;
}
const obsBriefPolicy = () => hookLib<ObsBriefPolicy>("obs-brief-policy.mts");
const workerBriefPolicy = () => hookLib<WorkerBriefPolicy>("worker-brief-policy.mts");
// A dispatch that is not code-bound is checked only when the lib is there.
function optionalWorkerBriefPolicy(): WorkerBriefPolicy | null {
  try { return workerBriefPolicy(); } catch { return null; }
}

function deny(reason: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
    systemMessage: reason,
  }));
}

// Issue #505. A brief notice is context for the Maestro and a line for the
// operator, never a permission decision.
function report(notice: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: notice,
    },
    systemMessage: notice,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function projectedName(name: string, entry: Record<string, unknown>): string {
  return typeof entry.as === "string" && entry.as ? entry.as : name;
}

function modelSupport(capabilities: unknown): Map<string, ReadonlySet<string>> {
  const resolution = isRecord(capabilities) ? capabilities.modelResolution : undefined;
  const supported = isRecord(resolution) ? resolution.supportedModels : undefined;
  if (!isRecord(supported) || !Object.keys(supported).length) throw new Error("Installed model resolution is missing");
  const models = new Map<string, ReadonlySet<string>>();
  const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  for (const [model, values] of Object.entries(supported)) {
    if (!/^gpt-\d+(?:\.\d+)?-(?:astra|sol|terra|luna)$/.test(model) || !Array.isArray(values) || !values.length
      || values.some((value) => typeof value !== "string" || !efforts.has(value)) || new Set(values).size !== values.length) {
      throw new Error("Installed model resolution is malformed");
    }
    models.set(model, new Set(values as string[]));
  }
  return models;
}

export function dispatchPins(capabilities: unknown): Pins {
  const agents = isRecord(capabilities) ? capabilities.agents : undefined;
  if (!isRecord(agents)) throw new Error("The parity manifest has no agents table.");
  const models = modelSupport(capabilities);
  const pins = new Map<string, string>();
  for (const [name, entry] of Object.entries(agents)) {
    if (!isRecord(entry) || entry.enforcePin !== true) continue;
    if (typeof entry.model !== "string" || !models.has(entry.model)) {
      throw new Error(`Pinned agent ${name} has no allowed model.`);
    }
    pins.set(projectedName(name, entry), entry.model);
  }
  return pins;
}

export function dispatchPolicy(capabilities: unknown): DispatchPolicy {
  const pins = dispatchPins(capabilities);
  const entry = (capabilities as { agents: Record<string, unknown> }).agents[OBSERVATION_ENTRY];
  const supportedModels = modelSupport(capabilities);
  const manifest = capabilities as { agents: Record<string, unknown>; projectedAgents?: unknown;
    modelResolution: { roles: { root: { model: string; reasoning: string } } } };
  const rootDefault = manifest.modelResolution.roles?.root;
  if (!rootDefault || !supportedModels.get(rootDefault.model)?.has(rootDefault.reasoning)) throw new Error("Installed root model resolution is missing");
  if (!isRecord(manifest.projectedAgents)) throw new Error("Installed projected agent defaults are missing");
  const agentDefaults = new Map<string, { model: string; reasoning: string }>();
  for (const [name, agent] of Object.entries(manifest.projectedAgents)) {
    if (!isRecord(agent) || typeof agent.model !== "string" || !supportedModels.has(agent.model)
      || typeof agent.reasoning !== "string" || !supportedModels.get(agent.model)?.has(agent.reasoning)) {
      throw new Error(`Agent ${name} has an invalid installed model resolution`);
    }
    agentDefaults.set(name, { model: agent.model, reasoning: agent.reasoning });
  }
  const codeBoundAgents = new Set<string>();
  for (const [name, agent] of Object.entries(manifest.agents)) {
    if (!isRecord(agent)) throw new Error(`Agent ${name} is malformed`);
    const actual = agentDefaults.get(projectedName(name, agent));
    if (!actual || actual.model !== agent.model || actual.reasoning !== agent.reasoning) {
      throw new Error(`Agent ${name} differs from the installed defaults snapshot`);
    }
    if (agent.codeBound === true) codeBoundAgents.add(projectedName(name, agent));
  }
  return { pins, supportedModels, agentDefaults, codeBoundAgents, observationAgent: isRecord(entry) ? projectedName(OBSERVATION_ENTRY, entry) : null };
}

export function loadPolicy(): DispatchPolicy {
  return dispatchPolicy(JSON.parse(fs.readFileSync(CAPABILITIES_FILE, "utf8")));
}

export function validate(payload: unknown, { pins, observationAgent, supportedModels, agentDefaults, codeBoundAgents }: DispatchPolicy): string | null {
  // codex/lib/parity-config.mts registers this guard for Agent|spawn_agent only, so
  // input that does not name its tool is an unclassifiable dispatch.
  if (!isRecord(payload) || typeof payload.tool_name !== "string") {
    return "Malformed hook input; refusing an unclassifiable agent dispatch.";
  }
  if (!DISPATCH_TOOLS.has(payload.tool_name)) return null;
  const input = payload.tool_input;
  if (!isRecord(input)) return "Malformed agent dispatch.";
  if (typeof input.task_name !== "string" || !input.task_name.trim()) return "Agent dispatch requires task_name.";
  if (typeof input.message !== "string" || !input.message.trim()) return "Agent dispatch requires a bounded message.";
  if (input.agent_type != null && typeof input.agent_type !== "string") return "Malformed agent dispatch: agent_type must be a string.";
  const agent = typeof input.agent_type === "string" ? input.agent_type.trim() : "";
  const pin = pins.get(agent);
  if (pin !== undefined && input.model !== pin) {
    return `Kherep agent ${agent} is pinned to model ${pin}; got ${input.model || "no model"}.`;
  }
  if (input.model !== undefined && !(typeof input.model === "string" && supportedModels.has(input.model))) return `Unsupported Kherep agent model: ${input.model}`;
  const defaults = agentDefaults.get(agent);
  const overridesModel = input.model !== undefined, overridesEffort = input.reasoning_effort !== undefined;
  // Policy root defaults do not establish the active parent's model or effort:
  // operator configuration and turn overrides can change native inheritance.
  if (!defaults && overridesModel !== overridesEffort) {
    return "Generic agent overrides require both explicit model and reasoning effort.";
  }
  if (defaults || overridesModel) {
    const selectedModel = typeof input.model === "string" ? input.model : defaults!.model;
    const selectedEffort = overridesEffort ? input.reasoning_effort : defaults!.reasoning;
    if (!(typeof selectedEffort === "string" && supportedModels.get(selectedModel)?.has(selectedEffort))) {
      return `Unsupported Kherep reasoning effort: ${selectedEffort}`;
    }
  }
  if (agent === observationAgent) {
    const policy = obsBriefPolicy();
    return policy.observationBriefIssue(input.message, policy.CODEX_NOTHING_TO_FILE);
  }
  // Issue #701. Code-bound by role, or by declaring revision:.
  const codeBound = codeBoundAgents.has(agent);
  const worker = codeBound ? workerBriefPolicy() : optionalWorkerBriefPolicy();
  return worker ? worker.workerBriefIssue(input.message, codeBound) : null;
}

// Issue #505. The revision notice for an observation dispatch that validate
// allows; issue #701, the review notice for a dispatch that is neither code-bound
// nor an observation; null otherwise. A report, not a gate: a missing or older
// installed lib yields no notice and no deny.
export function advise(payload: unknown, policy: DispatchPolicy): string | null {
  if (validate(payload, policy) !== null || !isRecord(payload) || !DISPATCH_TOOLS.has(payload.tool_name as string)) return null;
  const input = payload.tool_input;
  if (!isRecord(input) || typeof input.message !== "string") return null;
  const agent = typeof input.agent_type === "string" ? input.agent_type.trim() : "";
  if (policy.codeBoundAgents.has(agent)) return null;
  const notice = agent === policy.observationAgent
    ? obsBriefPolicy().observationBriefNotice : optionalWorkerBriefPolicy()?.workerBriefNotice;
  return typeof notice === "function" ? notice(input.message) : null;
}

export function decide(raw: string, readPolicy: () => DispatchPolicy = loadPolicy): string | null {
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch {
    return "Dispatch hook received malformed JSON; refusing an unclassifiable agent dispatch.";
  }
  let policy: DispatchPolicy;
  try { policy = readPolicy(); } catch {
    return "Kherep dispatch pin policy is unreadable; refusing the agent dispatch.";
  }
  return validate(payload, policy);
}

async function main(): Promise<void> {
  let raw = "";
  let reason: string | null;
  try { raw = (await (await import("./stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8"); reason = decide(raw); } catch {
    reason = "Kherep dispatch guard failed unexpectedly; refusing the agent dispatch.";
  }
  if (reason) return deny(reason);
  let notice: string | null = null;
  try { notice = advise(JSON.parse(raw), loadPolicy()); } catch { /* a report is not a gate */ }
  if (notice) report(notice);
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) await main();
