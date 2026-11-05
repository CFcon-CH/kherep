// OP-1156, issue #737. Every dispatch names an explicit model. The resolved
// model policy (lib/model-policy.mts) decides which models are dispatchable and
// which efforts exist; it never requires a model to equal a shipped default.
// A missing, malformed or inconsistent policy fails closed.

import { dispatchIssue, dispatchWarning, loadModelPolicy, ModelPolicyError, type ResolvedPolicy } from "./model-policy.mts";
import { observationBriefIssue, observationBriefNotice } from "./obs-brief-policy.mts";
import { referencesArtifact, referencesCredentials } from "./private-path-policy.mts";
import { declaresRevision, workerBriefIssue, workerBriefNotice } from "./worker-brief-policy.mts";

export type CanonicalModel = string;
export type DispatchDecision = "allow" | "deny";

// Was ein Dispatch-Ereignis mitbringt, ist nicht garantiert: es kommt roh aus
// einem Hook-Payload. Deshalb unknown und das Normalisieren unten.
export interface DispatchEvent {
  kind?: unknown;
  agent?: unknown;
  model?: unknown;
  // Issue #737. Present only when the Agent/Task input carries it (unverified).
  effort?: unknown;
  prompt?: unknown;
  // The Agent tool's prompt alone, without its description (issue #331).
  brief?: unknown;
  privacy?: unknown;
  [key: string]: unknown;
}

interface NormalizedDispatch extends DispatchEvent {
  agent: string;
  model: string;
  prompt: string;
  privacy: boolean;
}

export interface DispatchMetadata {
  agent: string;
  model: string;
  privacy: boolean;
}

export interface DispatchResult {
  decision: DispatchDecision;
  ruleId?: string;
  reason?: string;
  // Issue #505. A report on an allowed dispatch, never a deny.
  notice?: string;
  // Issue #701. The rule the notice reports.
  noticeRuleId?: "OBS_BRIEF_REVISION" | "WORKER_BRIEF_REVISION" | "DISPATCH_EFFORT_UNLISTED";
  metadata?: DispatchMetadata;
}

// Issue #701. Agents whose brief must always carry revision: and decided:
// (worker-brief-policy.mts); codex/parity/capabilities.json marks the same
// agents "codeBound". Fixed: no environment override.
export const CODE_BOUND_AGENTS: ReadonlySet<string> = new Set(["kherep-builder", "dc-plugin-build-runner"]);

export const PRIVACY_PATTERN =
  /work-credentials|\b(?:host_vars|group_vars)\b|customer[ -]?internals?|forge service cred|<private>/i;

// Loaded per evaluation, never at import: codex/ imports CODE_BOUND_AGENTS.
function resolvedPolicy(): ResolvedPolicy | string {
  try {
    return loadModelPolicy();
  } catch (error) {
    return error instanceof ModelPolicyError ? error.message : "the model policy could not be resolved";
  }
}

function deny(ruleId: string, reason: string, event: NormalizedDispatch): DispatchResult {
  return {
    decision: "deny",
    ruleId,
    reason,
    metadata: {
      agent: event.agent || "unknown",
      model: event.model || "missing",
      privacy: Boolean(event.privacy),
    },
  };
}

export function evaluateDispatch(event: DispatchEvent | null | undefined): DispatchResult {
  if (!event || event.kind !== "dispatch") return { decision: "allow" };

  const prompt = String(event.prompt || "");
  const promptInput = { prompt };
  const normalized: NormalizedDispatch = {
    ...event,
    agent: String(event.agent || "").trim(),
    model: String(event.model || "").trim(),
    prompt,
    // Für die Pfad-Prüfung reicht das rohe Ereignis als Payload: gelesen wird
    // daraus nur cwd, und das Normalisieren oben rührt cwd nicht an.
    privacy: event.privacy === true
      || PRIVACY_PATTERN.test(prompt)
      || referencesCredentials(promptInput, event)
      || referencesArtifact(promptInput, event),
  };

  if (!normalized.agent) {
    return deny("DISPATCH_AGENT_REQUIRED", "Dispatch has no agent/subagent type.", normalized);
  }
  // Every Agent/Task is a Claude-cloud boundary, including owned agents that
  // merely call a local endpoint afterwards. Privacy work must use the local
  // runner directly from Bash, never a Claude subagent wrapper.
  if (normalized.privacy) {
    return deny(
      "PRIVACY_AGENT_FORBIDDEN",
      "Privacy-tagged input cannot cross any Agent/Task boundary; use the local-inference runner without reading its private artifact into Claude.",
      normalized
    );
  }
  if (/codex/i.test(normalized.agent)) {
    return deny("CODEX_AGENT_DIRECT_FORBIDDEN", "Use codex exec or the Control Plane intercom to reach Codex; Codex-labelled Agent dispatches are not supported.", normalized);
  }
  if (!normalized.model) {
    return deny("DISPATCH_MODEL_REQUIRED", "Dispatch has no explicit model.", normalized);
  }
  const policy = resolvedPolicy();
  if (typeof policy === "string") {
    return deny("DISPATCH_POLICY_INVALID", `The dispatch model policy is invalid: ${policy}.`, normalized);
  }
  // Issue #737. No equality to a default: any dispatchable model and any
  // effort of the vocabulary is the user's choice.
  const modelIssue = dispatchIssue(policy, normalized.model, event.effort);
  if (modelIssue) return deny(modelIssue.ruleId, modelIssue.reason, normalized);
  const effortWarning = dispatchWarning(policy, normalized.model, event.effort);
  // Issue #331. Only the prompt is the brief: the description is a short label
  // that must neither supply a finding marker nor be read as part of one.
  let notice: string | null = null;
  let noticeRuleId: DispatchResult["noticeRuleId"] = "OBS_BRIEF_REVISION";
  const brief = String(event.brief ?? "");
  if (normalized.agent === "claude-obs") {
    const issue = observationBriefIssue(brief);
    if (issue) return deny("OBS_BRIEF_FORMAT", issue, normalized);
    notice = observationBriefNotice(brief);
  } else if (CODE_BOUND_AGENTS.has(normalized.agent) || declaresRevision(brief)) {
    // Issue #701. Code-bound by role, or by declaring revision:.
    const issue = workerBriefIssue(brief, CODE_BOUND_AGENTS.has(normalized.agent));
    if (issue) return deny("WORKER_BRIEF_FORMAT", issue, normalized);
  } else {
    notice = workerBriefNotice(brief);
    noticeRuleId = "WORKER_BRIEF_REVISION";
  }
  if (effortWarning) {
    // A brief notice keeps its rule prefix; the effort warning names its own.
    if (notice) {
      notice = `${notice}\n[dispatch-contract:DISPATCH_EFFORT_UNLISTED] ${effortWarning}`;
    } else {
      notice = effortWarning;
      noticeRuleId = "DISPATCH_EFFORT_UNLISTED";
    }
  }
  return {
    decision: "allow",
    ...(notice ? { notice, noticeRuleId } : {}),
    metadata: { agent: normalized.agent, model: normalized.model, privacy: normalized.privacy },
  };
}
