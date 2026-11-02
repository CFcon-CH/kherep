#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";

const HOOK = path.join(import.meta.dirname, "dispatch-contract-guard.mts");
let pass = 0;
let fail = 0;

type Payload = string | Record<string, unknown>;
// A null value removes the variable from the hook's environment.
type EnvExtra = Record<string, string | null>;

function run(payload: Payload, envExtra: EnvExtra = {}): { denied: boolean; reason: string; status: number | null; stdout: string } {
  // The shipped default policy (claude/kherep/model-policy.json, no user file
  // beside it): the host's own policy settings must not decide these cases.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.KHEREP_ALLOWED_MODELS;
  delete env.KHEREP_AGENT_MODEL_POLICY;
  for (const [key, value] of Object.entries(envExtra)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync("node", [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env,
  });
  let output: { hookSpecificOutput?: { permissionDecision?: unknown; permissionDecisionReason?: string } } = {};
  try {
    output = JSON.parse(result.stdout || "{}");
  } catch {}
  return {
    denied: Boolean(
      output.hookSpecificOutput &&
        output.hookSpecificOutput.permissionDecision === "deny"
    ),
    reason:
      (output.hookSpecificOutput &&
        output.hookSpecificOutput.permissionDecisionReason) ||
      "",
    status: result.status,
    stdout: result.stdout,
  };
}

function check(name: string, payload: Payload, expectedDenied: boolean, reasonNeedle?: string, envExtra: EnvExtra = {}): void {
  const actual = run(payload, envExtra);
  const ok =
    actual.status === 0 &&
    actual.denied === expectedDenied &&
    (!reasonNeedle || actual.reason.includes(reasonNeedle));
  ok ? pass++ : fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"} | ${name} | expected ${
      expectedDenied ? "DENY" : "ALLOW"
    }, got ${actual.denied ? "DENY" : "ALLOW"}`
  );
}

// Issue #701: a well-formed worker brief, so a code-bound role reaches its model checks.
const WORKER_BRIEF = "revision: kherep@2733b35e2c102ac54295568509c68b18b6d92cab\ndecided: none\nBuild it.";
const call = (agent: string, model?: string, toolName = "Agent", field = "subagent_type") => ({
  tool_name: toolName,
  tool_input: { [field]: agent, ...(model === undefined ? {} : { model }), prompt: WORKER_BRIEF },
});
const ABSENT_MODEL_CONFIG = {
  KHEREP_ALLOWED_MODELS: null,
  KHEREP_AGENT_MODEL_POLICY: null,
};

check("Agent without model", call("kherep-builder"), true, "DISPATCH_MODEL_REQUIRED");
check("legacy Task without model", call("kherep-builder", undefined, "Task"), true);
check("missing agent role rejected", call("", "sonnet"), true, "DISPATCH_AGENT_REQUIRED");
check("full model id is not an Agent-tool alias", call("kherep-builder", "claude-opus-4-8"), true, "DISPATCH_MODEL_UNKNOWN");
check("inherit is not a dispatch model", call("general-purpose", "inherit"), true, "DISPATCH_MODEL_UNKNOWN");
check("unknown model deny names the model", call("general-purpose", "operator-model"), true, "Model 'operator-model' is not a dispatchable model");
check("unknown canonical agent allowed", call("general-purpose", "sonnet"), false);
check("fable alias allowed", call("general-purpose", "fable"), false);
// Issue #737: the shipped defaults are not pins. An owned agent runs on any
// dispatchable model the user chooses; only an unknown model is denied.
check("owned builder on its default", call("kherep-builder", "opus"), false);
check("owned builder on another alias", call("kherep-builder", "sonnet"), false);
check("owned builder on haiku", call("kherep-builder", "haiku"), false);
check("owned support agent on fable", call("forge-deploy-validator", "fable"), false);
check("owned agent still rejects an unknown model", call("kherep-builder", "claude-fable-5"), true, "DISPATCH_MODEL_UNKNOWN");
check("mac local wrapper on opus", call("mac-agent", "opus"), false);
check("agent_type field supported", call("mac-agent", "haiku", "Agent", "agent_type"), false);
check("legacy local wrapper on sonnet", call("lmstudio-win-researcher", "sonnet"), false);
check("no rule named OWNED_AGENT_MODEL_MISMATCH remains", call("lmstudio-mac-researcher", "fable"), false);
check("privacy prompt to cloud denied", { tool_name: "Agent", tool_input: { subagent_type: "kherep-builder", model: "opus", prompt: "Inspect D:/Work-credentials/customer.env" } }, true, "PRIVACY_AGENT_FORBIDDEN");
check("private tag to cloud denied", { tool_name: "Task", tool_input: { subagent_type: "general-purpose", model: "sonnet", prompt: "<private>customer internals</private>" } }, true, "PRIVACY_AGENT_FORBIDDEN");
check("privacy prompt to local wrapper still denied", { tool_name: "Agent", tool_input: { subagent_type: "win-agent", model: "haiku", prompt: "Inspect host_vars safely" } }, true, "PRIVACY_AGENT_FORBIDDEN");
check("custom credentials root cannot cross Agent boundary", {
  cwd: "/Users/example/Work",
  tool_name: "Agent",
  tool_input: { subagent_type: "general-purpose", model: "sonnet", prompt: "Inspect /Volumes/vault-17/plain-file" },
}, true, "PRIVACY_AGENT_FORBIDDEN", { KHEREP_CREDENTIALS_ROOT: "/Volumes/vault-17", HOME: "/Users/example" });
check("custom artifact root cannot cross Agent boundary", {
  cwd: "/Users/example/Work",
  tool_name: "Task",
  tool_input: { subagent_type: "general-purpose", model: "sonnet", prompt: "Summarize /Volumes/results-17/run.json" },
}, true, "PRIVACY_AGENT_FORBIDDEN", { KHEREP_LOCAL_OUTPUT_ROOT: "/Volumes/results-17", HOME: "/Users/example" });
check("plugin rescue forwarder exception", call("codex:codex-rescue"), false);
check("other direct codex agent denied", call("codex:other", "opus"), true, "CODEX_AGENT_DIRECT_FORBIDDEN");
// Issue #331. The observation brief format is checked at dispatch.
const obs = (prompt: string, description = "Record observations", model = "haiku") => ({
  tool_name: "Agent",
  tool_input: { subagent_type: "claude-obs", model, description, prompt },
});
const GOOD_BRIEF = "Scope: Kherep\n- measured: `node x.test.mts` -> 12 pass, 0 fail\n- relayed: the operator, in chat";
check("claude-obs prose brief denied", obs("MEASURED by running the tests: all green."), true, "OBS_BRIEF_FORMAT");
check("claude-obs measured without command denied", obs("1. measured: ran the tests -> green"), true, "finding 1 (measured:) has no command");
check("claude-obs deny states the format", obs("no markers"), true, "measured: `<command>` -> <deciding output excerpt>");
check("claude-obs well-formed brief allowed", obs(GOOD_BRIEF), false);
check("claude-obs marker in the description does not count", obs("All green.", "relayed: operator"), true, "OBS_BRIEF_FORMAT");
check("claude-obs description cannot break a good brief", obs(GOOD_BRIEF, "measured: tests"), false);
check("claude-obs runs on a user-chosen model", obs(GOOD_BRIEF, "Record observations", "sonnet"), false);
check("claude-obs unknown model is checked before the brief", obs("no markers", "Record observations", "operator-model"), true, "DISPATCH_MODEL_UNKNOWN");
check("other agent with a prose prompt unaffected", { tool_name: "Agent", tool_input: { subagent_type: "general-purpose", model: "sonnet", prompt: "MEASURED by hand." } }, false);
// Issue #505. An incomplete code binding is a context notice on an allowed
// dispatch: no permissionDecision, no systemMessage, no new deny.
const SHA = "2733b35e2c102ac54295568509c68b18b6d92cab";
const BARE_CODE = "- measured: code `node x.test.mts` -> 12 pass, 0 fail";
function noticeCheck(name: string, payload: Payload, expected: "notice" | "silent" | "deny"): void {
  const actual = run(payload);
  let output: { hookSpecificOutput?: Record<string, unknown>; systemMessage?: unknown } = {};
  try { output = JSON.parse(actual.stdout || "{}"); } catch {}
  const hso = output.hookSpecificOutput ?? {};
  const context = typeof hso.additionalContext === "string" ? hso.additionalContext : "";
  const ok = actual.status === 0 && (expected === "notice"
    ? context.startsWith("[dispatch-contract:OBS_BRIEF_REVISION] Observation brief revision: ") && hso.hookEventName === "PreToolUse"
      && !("permissionDecision" in hso) && !("permissionDecisionReason" in hso) && !("systemMessage" in output)
    : expected === "silent" ? actual.stdout === "" : actual.denied && !context && !actual.reason.includes("revision"));
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} | expected ${expected}`);
}
noticeCheck("claude-obs bare code brief allowed with a notice", obs(BARE_CODE), "notice");
noticeCheck("claude-obs unmarked brief gets the conditional notice", obs(GOOD_BRIEF), "notice");
noticeCheck("claude-obs complete binding is silent", obs(`- measured: code kherep@${SHA} -- x.test.mts \`node x.test.mts\` -> 12 pass`), "silent");
noticeCheck("other agent with a bare code prompt gets no notice", { tool_name: "Agent", tool_input: { subagent_type: "kherep-builder", model: "opus", prompt: `${WORKER_BRIEF}\n${BARE_CODE}` } }, "silent");
noticeCheck("claude-obs on another model keeps its notice", obs(BARE_CODE, "Record observations", "opus"), "notice");
noticeCheck("claude-obs unknown-model deny carries no notice", obs(BARE_CODE, "Record observations", "operator-model"), "deny");
check("claude-obs unknown-model deny keeps its rule", obs(BARE_CODE, "Record observations", "operator-model"), true, "DISPATCH_MODEL_UNKNOWN");
noticeCheck("claude-obs format deny carries no notice", obs("measured: code npm test -> green"), "deny");
// Issue #701: the worker brief cases are in dispatch-contract-guard-worker.test.mts.
check("non-dispatch tool ignored", { tool_name: "Bash", tool_input: { command: "echo ok" } }, false);
check("malformed dispatch input fails closed", "not-json", true, "HOOK_INPUT_INVALID");
check("missing tool_input fails closed", { tool_name: "Agent" }, true, "HOOK_SCHEMA_UNKNOWN");
const OWNED_AGENTS = ["kherep-builder", "forge-deploy-validator", "n8n-workflow-deploy-runner", "dc-plugin-build-runner",
  "win-agent", "mac-agent", "lmstudio-win-researcher", "lmstudio-mac-researcher", "claude-obs", "atlassian-broker"];
for (const agent of OWNED_AGENTS.filter((name) => name !== "claude-obs")) {
  for (const model of ["opus", "sonnet", "haiku", "fable"]) {
    check("absent model config allows " + agent + " on " + model, call(agent, model), false, "", ABSENT_MODEL_CONFIG);
  }
}
check("absent model config rejects unknown model", call("general-purpose", "operator-model"), true, "DISPATCH_MODEL_UNKNOWN", ABSENT_MODEL_CONFIG);
// The environment inputs are deprecated for one release (issue #737): an
// agent entry sets a default below the user file, never a pin; the allow-list
// is the complete dispatchable list. Set-but-empty or malformed input still fails closed.
const LEGACY_PIN = { KHEREP_ALLOWED_MODELS: null, KHEREP_AGENT_MODEL_POLICY: JSON.stringify({ "kherep-builder": "haiku" }) };
check("deprecated agent policy no longer pins the named agent", call("kherep-builder", "opus"), false, "", LEGACY_PIN);
check("deprecated agent policy leaves other agents unpinned", call("forge-deploy-validator", "fable"), false, "", LEGACY_PIN);
const customPolicy = JSON.stringify(Object.fromEntries(OWNED_AGENTS.map((agent) => [agent, "operator-model"])));
check("deprecated allow-list adds an operator alias", call("kherep-builder", "operator-model"), false, "", {
  KHEREP_ALLOWED_MODELS: "operator-model",
  KHEREP_AGENT_MODEL_POLICY: customPolicy,
});
check("deprecated allow-list still rejects an unknown model", call("general-purpose", "another-model"), true, "DISPATCH_MODEL_UNKNOWN", {
  KHEREP_ALLOWED_MODELS: "operator-model",
  KHEREP_AGENT_MODEL_POLICY: customPolicy,
});
check("deprecated allow-list is complete: an omitted shipped alias is denied", call("kherep-builder", "opus"), true, "DISPATCH_MODEL_UNKNOWN", {
  KHEREP_ALLOWED_MODELS: "sonnet",
  KHEREP_AGENT_MODEL_POLICY: JSON.stringify({ "kherep-builder": "sonnet" }),
});
check("deprecated allow-list still admits an alias it names", call("kherep-builder", "sonnet"), false, "", {
  KHEREP_ALLOWED_MODELS: "sonnet",
  KHEREP_AGENT_MODEL_POLICY: JSON.stringify({ "kherep-builder": "sonnet" }),
});
check("deprecated agent policy naming an unknown model fails closed", call("kherep-builder", "opus"), true, "DISPATCH_POLICY_INVALID", {
  KHEREP_ALLOWED_MODELS: null,
  KHEREP_AGENT_MODEL_POLICY: JSON.stringify({ "kherep-builder": "operator-model" }),
});
check("explicitly empty allow-list fails closed", call("kherep-builder", "opus"), true, "DISPATCH_POLICY_INVALID", {
  KHEREP_ALLOWED_MODELS: "",
  KHEREP_AGENT_MODEL_POLICY: null,
});
check("explicitly empty role policy fails closed", call("kherep-builder", "opus"), true, "DISPATCH_POLICY_INVALID", {
  KHEREP_ALLOWED_MODELS: null,
  KHEREP_AGENT_MODEL_POLICY: "",
});
check("empty role policy object fails closed", call("kherep-builder", "opus"), true, "DISPATCH_POLICY_INVALID", {
  KHEREP_ALLOWED_MODELS: null,
  KHEREP_AGENT_MODEL_POLICY: "{}",
});
check("malformed role policy fails closed", call("kherep-builder", "opus"), true, "DISPATCH_POLICY_INVALID", {
  KHEREP_ALLOWED_MODELS: null,
  KHEREP_AGENT_MODEL_POLICY: "{not-json",
});
check("role policy rejects whitespace-padded agent names", call("kherep-builder", "opus"), true, "DISPATCH_POLICY_INVALID", {
  KHEREP_ALLOWED_MODELS: null,
  KHEREP_AGENT_MODEL_POLICY: JSON.stringify({ " kherep-builder": "haiku" }),
});
check("privacy validation remains ahead of missing model policy", {
  tool_name: "Agent",
  tool_input: { subagent_type: "kherep-builder", model: "operator-model", prompt: "<private>restricted input</private>" },
}, true, "PRIVACY_AGENT_FORBIDDEN", {
  KHEREP_ALLOWED_MODELS: "",
  KHEREP_AGENT_MODEL_POLICY: "",
});

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
