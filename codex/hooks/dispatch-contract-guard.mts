import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DISPATCH_TOOLS = new Set(["Agent", "spawn_agent"]);

// The installed dispatch snapshot: the parity manifest plus the installed model
// selection (issue #737). The installer copies it to the same place relative to
// the installed guard, so the repository and an installation each read one file.
// Model choice is support-checked only: a native agent TOML carries the effective
// model and effort, and no argument equality is enforced as a pin.
export const CAPABILITIES_FILE = path.join(import.meta.dirname, "..", "parity", "capabilities.json");

// The projected name of the observation agent, whose brief format is checked at
// dispatch (issue #331); null when the manifest projects none.
export interface DispatchPolicy {
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
const statePolicy = () => { try { return hookLib<typeof import("../../claude/hooks/lib/obs-handback-state.mts")>("obs-handback-state.mts"); } catch { return null; } };
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

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
// Any runtime-visible catalog model the installer recorded; no family shape.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,199}$/;
type Pair = { model: string; reasoning: string };

function modelSupport(resolution: Record<string, unknown>): Map<string, ReadonlySet<string>> {
  const supported = resolution.supportedModels;
  if (!isRecord(supported) || !Object.keys(supported).length) throw new Error("Installed model resolution is missing");
  const models = new Map<string, ReadonlySet<string>>();
  for (const [model, values] of Object.entries(supported)) {
    if (!MODEL_ID.test(model) || model === "inherit" || !Array.isArray(values) || !values.length
      || values.some((value) => typeof value !== "string" || !EFFORTS.has(value)) || new Set(values).size !== values.length) {
      throw new Error("Installed model resolution is malformed");
    }
    models.set(model, new Set(values as string[]));
  }
  return models;
}

// The V2 selection (issue #737) carries its own agent rows; the projected
// defaults must be exactly that generation, so a mixed snapshot fails closed.
// A V1 resolution is read only for compatibility during a complete upgrade.
function rootAndAgents(resolution: Record<string, unknown>, projected: Record<string, unknown>): Pair {
  const roles = isRecord(resolution.roles) ? resolution.roles : {};
  if (resolution.schemaVersion === 1) {
    const root = roles.root;
    return isRecord(root) ? root as unknown as Pair : { model: "", reasoning: "" };
  }
  const agents = resolution.agents;
  if (resolution.schemaVersion !== 2 || typeof resolution.selectionId !== "string" || !/^[a-f0-9]{64}$/.test(resolution.selectionId)
    || !Array.isArray(agents) || agents.length !== Object.keys(projected).length) throw new Error("Installed model selection generation is inconsistent");
  for (const agent of agents) {
    const row = isRecord(agent) ? projected[String(agent.installedName)] : undefined;
    const effective = isRecord(agent) && isRecord(agent.effective) ? agent.effective : {};
    if (!isRecord(row) || !Object.hasOwn(projected, String(agent.installedName)) || row.role !== agent.role
      || row.model !== effective.model || row.reasoning !== effective.effort) throw new Error("Installed model selection generation is inconsistent");
  }
  const root = isRecord(roles.root) && isRecord(roles.root.effective) ? roles.root.effective : {};
  return { model: String(root.model), reasoning: String(root.effort) };
}

export function dispatchPolicy(capabilities: unknown): DispatchPolicy {
  const manifest = isRecord(capabilities) ? capabilities : {};
  if (!isRecord(manifest.agents)) throw new Error("The parity manifest has no agents table.");
  if (!isRecord(manifest.modelResolution)) throw new Error("Installed model resolution is missing");
  const supportedModels = modelSupport(manifest.modelResolution);
  if (!isRecord(manifest.projectedAgents)) throw new Error("Installed projected agent defaults are missing");
  const rootDefault = rootAndAgents(manifest.modelResolution, manifest.projectedAgents);
  if (!supportedModels.get(rootDefault.model)?.has(rootDefault.reasoning)) throw new Error("Installed root model resolution is missing");
  const agentDefaults = new Map<string, Pair>();
  for (const [name, agent] of Object.entries(manifest.projectedAgents)) {
    if (!isRecord(agent) || typeof agent.model !== "string" || typeof agent.reasoning !== "string"
      || !supportedModels.get(agent.model)?.has(agent.reasoning)) {
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
  const entry = manifest.agents[OBSERVATION_ENTRY];
  return { supportedModels, agentDefaults, codeBoundAgents, observationAgent: isRecord(entry) ? projectedName(OBSERVATION_ENTRY, entry) : null };
}

export function loadPolicy(): DispatchPolicy {
  return dispatchPolicy(JSON.parse(fs.readFileSync(CAPABILITIES_FILE, "utf8")));
}

export function validate(payload: unknown, { observationAgent, supportedModels, agentDefaults, codeBoundAgents }: DispatchPolicy): string | null {
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
  // An installed agent TOML's own model and effort take precedence over spawn
  // arguments, so supplied fields are support-checked, never compared as a pin.
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
// installed lib yields no notice and no deny. Issue #731 PR-B: for an allowed
// observation dispatch it also records the brief's measured: positions for the
// payload session_id under the hook's parent directory; without the lib, nothing.
export function advise(payload: unknown, policy: DispatchPolicy, home = path.dirname(import.meta.dirname)): string | null {
  if (validate(payload, policy) !== null || !isRecord(payload) || !DISPATCH_TOOLS.has(payload.tool_name as string)) return null;
  const input = payload.tool_input;
  if (!isRecord(input) || typeof input.message !== "string") return null;
  const agent = typeof input.agent_type === "string" ? input.agent_type.trim() : "";
  if (policy.codeBoundAgents.has(agent)) return null;
  if (agent === policy.observationAgent) statePolicy()?.recordBrief(home, payload.session_id, input.message);
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
    return "Kherep dispatch policy is unreadable; refusing the agent dispatch.";
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
