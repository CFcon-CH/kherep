import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { fixtureModels, fixtureResolution, policyText } from "../lib/model-policy.fixture.mts";
import { parseModelPolicy, resolveCapabilities, resolveModels } from "../lib/model-policy.mts";
import { renderAgent } from "../lib/component-render.mts";
import type { Capabilities } from "../lib/contracts.mts";
import { agentSourcePath } from "../lib/parity-projection.mts";
import { advise, CAPABILITIES_FILE, decide, dispatchPins, dispatchPolicy, loadPolicy, validate } from "./dispatch-contract-guard.mts";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const GUARD = path.join(import.meta.dirname, "dispatch-contract-guard.mts");
const MANIFEST = path.join(REPO, "codex", "parity", "capabilities.json");
const capabilities = resolveCapabilities(JSON.parse(fs.readFileSync(MANIFEST, "utf8")), fixtureResolution());
const POLICY = dispatchPolicy(capabilities);
const PINS = POLICY.pins;
const OBS_MODEL = PINS.get("codex-obs") ?? "";
// Issue #331: a codex-obs message must be a well-formed observation brief.
// Issue #505: the finding names the commit it was measured against, so an
// allowed dispatch of this brief is silent. Issue #701: the default message is
// a well-formed worker brief, so a code-bound role reaches its model checks.
const SHA = "2733b35e2c102ac54295568509c68b18b6d92cab";
const BRIEF = `- measured: code kherep@${SHA} -- x.test.mts \`node x.test.mts\` -> 12 pass, 0 fail\n- relayed: the operator, in chat`;

function spawnDispatch(input: Record<string, unknown>, tool = "spawn_agent") {
  return { tool_name: tool, tool_input: { task_name: "t", message: `revision: kherep@${SHA}\ndecided: none`, ...input } };
}

function runGuard(stdin: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-guard-cli-"));
  try {
    const hookDir = path.join(root, "hooks", "kherep-maestro");
    fs.mkdirSync(path.join(hookDir, "lib"), { recursive: true });
    fs.mkdirSync(path.join(root, "hooks", "parity"));
    const guard = path.join(hookDir, "codex-dispatch-contract-guard.mts");
    fs.copyFileSync(GUARD, guard);
    fs.copyFileSync(path.join(REPO, "claude", "hooks", "lib", "obs-brief-policy.mts"), path.join(hookDir, "lib", "obs-brief-policy.mts"));
    fs.writeFileSync(path.join(root, "hooks", "parity", "capabilities.json"), JSON.stringify(capabilities));
    const result = spawnSync(process.execPath, [guard], { encoding: "utf8", input: stdin });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function denied(stdout: string): string {
  const output = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  return output.hookSpecificOutput.permissionDecisionReason;
}

test("accepts bounded Codex dispatches and inherited models", () => {
  assert.equal(validate({
    tool_name: "Agent",
    tool_input: { task_name: "review", message: "Review the stabilized diff." },
  }, POLICY), null);
  assert.equal(validate({
    tool_name: "spawn_agent",
    tool_input: {
      task_name: "build",
      message: "Implement the bounded scope.",
      model: "gpt-6.10-sol",
      reasoning_effort: "high",
    },
  }, POLICY), null);
});

test("rejects malformed or unsupported dispatch contracts", () => {
  assert.match(validate({ tool_name: "Agent", tool_input: {} }, POLICY) ?? "", /task_name/);
  assert.match(validate({
    tool_name: "Agent",
    tool_input: { task_name: "x", message: "y", model: "opus" },
  }, POLICY) ?? "", /Unsupported/);
  assert.match(validate(spawnDispatch({ reasoning_effort: "extreme" }), POLICY) ?? "", /reasoning effort/);
});

test("accepts an explicit supported cheap model pair", () => {
  assert.equal(validate({
    tool_name: "spawn_agent",
    tool_input: {
      task_name: "atlassian",
      message: "Read OP-1403 and report status.",
      model: "gpt-6-luna",
      reasoning_effort: "low",
    },
  }, POLICY), null);
  assert.match(validate({
    tool_name: "spawn_agent",
    tool_input: { task_name: "x", message: "y", model: "gpt-5.6-nonexistent" },
  }, POLICY) ?? "", /Unsupported/);
});

test("broker guard accepts supported dispatch pairs and rejects unsupported inherited Medium", () => {
  assert.deepEqual(POLICY.agentDefaults.get("atlassian-broker"), { model: "gpt-6-luna", reasoning: "medium" });
  const older = { id: "gpt-5-luna", model: "gpt-5-luna", hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }] };
  const resolution = resolveModels(parseModelPolicy(policyText), { complete: true, models: [...fixtureModels, older] });
  const policy = dispatchPolicy(resolveCapabilities(capabilities, resolution));
  const dispatch = (overrides: Record<string, unknown> = {}) => validate(spawnDispatch({ agent_type: "atlassian-broker", ...overrides }), policy);
  assert.equal(dispatch(), null);
  assert.equal(dispatch({ model: "gpt-6-luna" }), null);
  for (const reasoning_effort of ["low", "medium", "high"]) {
    assert.equal(dispatch({ reasoning_effort }), null);
    assert.equal(dispatch({ model: "gpt-6-luna", reasoning_effort }), null);
  }
  assert.equal(dispatch({ model: older.model, reasoning_effort: "low" }), null);
  assert.match(dispatch({ model: older.model }) ?? "", /reasoning effort/);
  assert.match(dispatch({ model: older.model, reasoning_effort: "high" }) ?? "", /reasoning effort/);
  assert.match(dispatch({ reasoning_effort: "ultra" }) ?? "", /reasoning effort/);
  assert.match(dispatch({ model: "gpt-99-luna", reasoning_effort: "medium" }) ?? "", /Unsupported/);
});

test("a pinned agent dispatched without a model is denied and told its pin", () => {
  for (const tool of ["spawn_agent", "Agent"]) {
    const reason = validate(spawnDispatch({ agent_type: "codex-obs" }, tool), POLICY) ?? "";
    assert.match(reason, /codex-obs/, tool);
    assert.ok(reason.includes(OBS_MODEL), reason);
  }
});

test("a pinned agent dispatched with another model is denied and told its pin", () => {
  for (const model of ["gpt-6.10-sol", "gpt-5.6-terra", "opus"]) {
    const reason = validate(spawnDispatch({ agent_type: "codex-obs", model }), POLICY) ?? "";
    assert.ok(reason.includes(OBS_MODEL), `${model}: ${reason}`);
    assert.ok(reason.includes(model), reason);
  }
  assert.ok((validate(spawnDispatch({ agent_type: " codex-obs ", model: "gpt-6.10-sol" }), POLICY) ?? "").includes(OBS_MODEL));
});

test("a pinned agent dispatched with its pin is allowed", () => {
  assert.equal(validate(spawnDispatch({
    agent_type: "codex-obs", model: OBS_MODEL, reasoning_effort: "low", fork_turns: "none", message: BRIEF,
  }), POLICY), null);
});

test("a codex-obs dispatch with a malformed brief is denied and told the format", () => {
  const dispatch = (message: string) => validate(spawnDispatch({ agent_type: "codex-obs", model: OBS_MODEL, message }), POLICY) ?? "";
  assert.match(dispatch("MEASURED by running the tests: all green."), /marks no finding/);
  assert.match(dispatch("1. measured: ran the tests -> green"), /finding 1 \(measured:\) has no command/);
  assert.match(dispatch("- measured: `npm test` printed green"), /has no -> after the command/);
  const reason = dispatch("no markers");
  assert.ok(reason.includes("measured: `<command>` -> <deciding output excerpt>"), reason);
  assert.match(reason, /relayed: line/);
  assert.doesNotMatch(reason, /\[obs: none/, "Codex has no opt-out marker");
});

test("the brief check binds only the observation agent, named by the manifest", () => {
  assert.equal(POLICY.observationAgent, "codex-obs");
  assert.equal(validate(spawnDispatch({ agent_type: "personal-agent", message: "MEASURED by hand." }), POLICY), null);
  assert.equal(validate(spawnDispatch({ message: "MEASURED by hand." }), POLICY), null);
  const renamed = dispatchPolicy({ modelResolution: capabilities.modelResolution, projectedAgents: { "obs-x": { model: OBS_MODEL, reasoning: "low" } }, agents: { "claude-obs": { as: "obs-x", model: OBS_MODEL, reasoning: "low" } } });
  assert.equal(renamed.observationAgent, "obs-x");
  assert.match(validate(spawnDispatch({ agent_type: "obs-x", message: "prose" }), renamed) ?? "", /Observation brief format/);
  assert.equal(validate(spawnDispatch({ agent_type: "codex-obs", message: "prose" }), renamed), null);
  assert.equal(dispatchPolicy({ modelResolution: capabilities.modelResolution, projectedAgents: {}, agents: {} }).observationAgent, null);
});

test("the installed guard loads the brief check from its lib sibling and fails closed without it", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-dispatch-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hookDir = path.join(root, "hooks", "kherep-maestro");
  fs.mkdirSync(path.join(hookDir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "hooks", "parity"));
  const guard = path.join(hookDir, "codex-dispatch-contract-guard.mts");
  fs.copyFileSync(GUARD, guard);
  fs.writeFileSync(path.join(root, "hooks", "parity", "capabilities.json"), JSON.stringify(capabilities));
  const run = (message: string) => spawnSync(process.execPath, [guard], {
    encoding: "utf8", input: JSON.stringify(spawnDispatch({ agent_type: "codex-obs", model: OBS_MODEL, message })),
  }).stdout;
  assert.match(denied(run(BRIEF)), /failed unexpectedly/, "no lib: the observation dispatch is refused");
  fs.copyFileSync(path.join(REPO, "claude", "hooks", "lib", "obs-brief-policy.mts"), path.join(hookDir, "lib", "obs-brief-policy.mts"));
  assert.equal(run(BRIEF), "");
  assert.match(denied(run("All green.")), /Observation brief format/);
});

test("an unpinned agent keeps the model the Maestro selects from the allowed set", () => {
  assert.equal(PINS.has("kherep-builder"), false);
  assert.equal(validate(spawnDispatch({ agent_type: "kherep-builder", model: "gpt-5.6-terra" }), POLICY), null);
  assert.equal(validate(spawnDispatch({ agent_type: "kherep-builder" }), POLICY), null);
  assert.match(validate(spawnDispatch({ agent_type: "kherep-builder", model: "opus" }), POLICY) ?? "", /Unsupported/);
});

test("an agent_type that is not a string is refused instead of skipping the pin", () => {
  assert.match(validate(spawnDispatch({ agent_type: ["codex-obs"], model: "gpt-6.10-sol" }), POLICY) ?? "", /agent_type/);
});

test("hook input that does not name its tool is refused", () => {
  for (const payload of [null, [], "spawn_agent", 7, {}, { tool_input: {} }, { tool_name: 1 }]) {
    assert.match(validate(payload, POLICY) ?? "", /Malformed hook input/, JSON.stringify(payload));
  }
  assert.equal(validate({ tool_name: "Read", tool_input: {} }, POLICY), null);
});

test("unparseable stdin and an unreadable pin source fail closed", () => {
  assert.match(decide("{not json", () => POLICY) ?? "", /malformed JSON/);
  assert.match(decide("", () => POLICY) ?? "", /malformed JSON/);
  assert.match(decide(JSON.stringify(spawnDispatch({})), () => { throw new Error("gone"); }) ?? "", /pin policy/);
  assert.throws(() => dispatchPins({ modelResolution: capabilities.modelResolution, agents: { x: { enforcePin: true, model: "opus" } } }), /allowed model/);
  assert.throws(() => dispatchPins({}), /agents/);
});

test("the guard process denies malformed stdin and enforces the pin end to end", () => {
  assert.match(denied(runGuard("{not json")), /malformed JSON/);
  assert.match(denied(runGuard("")), /malformed JSON/);
  assert.ok(denied(runGuard(JSON.stringify(spawnDispatch({ agent_type: "codex-obs" })))).includes(OBS_MODEL));
  assert.equal(runGuard(JSON.stringify(spawnDispatch({ agent_type: "codex-obs", model: OBS_MODEL, message: BRIEF }))), "");
  assert.match(denied(runGuard(JSON.stringify(spawnDispatch({ agent_type: "codex-obs", model: OBS_MODEL, message: "All green." })))),
    /Observation brief format/);
});

test("the guard's pin map is exactly what the projection writes into the agent TOML", () => {
  // The guard reads the same manifest file the installer projects agents from.
  assert.equal(path.resolve(CAPABILITIES_FILE), MANIFEST);
  const capabilities = resolveCapabilities(JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as Capabilities, fixtureResolution());
  const field = (toml: string, key: string): string => {
    const line = toml.split("\n").find((entry) => entry.startsWith(`${key} = `));
    return line ? JSON.parse(line.slice(key.length + 3)) as string : "";
  };
  const projected = new Map<string, string>();
  for (const [name, options] of Object.entries(capabilities.agents)) {
    if (!options.enforcePin) continue;
    const toml = renderAgent(options.as || name, fs.readFileSync(agentSourcePath(REPO, name, options), "utf8"), options);
    projected.set(field(toml, "name"), field(toml, "model"));
  }
  assert.deepEqual([...PINS].sort(), [...projected].sort());
  // codex/ROUTING.md documents the observation agent's pin as enforced at dispatch.
  assert.equal(PINS.get("codex-obs"), capabilities.agents["claude-obs"].model);
});

test("reminders read the installed pin rather than hardcoding a concrete model", () => {
  for (const hook of ["kherep-maestro-context.mts", "observation-stop.mts"]) {
    const text = fs.readFileSync(path.join(import.meta.dirname, hook), "utf8");
    assert.doesNotMatch(text, /gpt-\d/);
    assert.match(text, /installed agent TOML/);
  }
});

test("reasoning is checked against the selected or inherited model's catalog support", () => {
  assert.match(validate(spawnDispatch({ model: "gpt-6-luna", reasoning_effort: "ultra" }), POLICY) ?? "", /reasoning effort/);
  assert.throws(() => dispatchPolicy({ agents: {} }), /resolution/);
});

test("explicit model override checks the inherited agent effort when no effort is supplied", () => {
  const fixture = structuredClone(capabilities);
  (fixture.modelResolution as ReturnType<typeof fixtureResolution>).supportedModels["gpt-6-luna"] = ["low", "medium"];
  const policy = dispatchPolicy(fixture);
  assert.match(validate(spawnDispatch({ agent_type: "kherep-builder", model: "gpt-6-luna" }), policy) ?? "", /reasoning effort/);
  assert.equal(validate(spawnDispatch({ agent_type: "kherep-builder", model: "gpt-6-luna", reasoning_effort: "low" }), policy), null);
});

test("generic and unknown agents inherit native parent settings without inventing policy-root defaults", () => {
  for (const agent_type of [undefined, "default", "personal-agent"]) {
    assert.equal(validate(spawnDispatch({ ...(agent_type ? { agent_type } : {}) }), POLICY), null);
  }
});

test("a generic model-only override requires the actual reasoning effort explicitly", () => {
  for (const agent_type of [undefined, "personal-agent"]) {
    assert.match(validate(spawnDispatch({ ...(agent_type ? { agent_type } : {}), model: "gpt-6-luna" }), POLICY) ?? "", /both.*model.*reasoning effort/i);
  }
});

test("a generic effort-only override requires the actual model explicitly", () => {
  assert.match(validate(spawnDispatch({ reasoning_effort: "high" }), POLICY) ?? "", /both.*model.*reasoning effort/i);
});

test("a generic complete explicit pair is checked against its exact model support", () => {
  const fixture = structuredClone(capabilities);
  (fixture.modelResolution as ReturnType<typeof fixtureResolution>).supportedModels["gpt-6-luna"] = ["low", "medium"];
  const policy = dispatchPolicy(fixture);
  assert.equal(validate(spawnDispatch({ model: "gpt-6-luna", reasoning_effort: "low" }), policy), null);
  assert.match(validate(spawnDispatch({ model: "gpt-6-luna", reasoning_effort: "high" }), policy) ?? "", /reasoning effort/);
});

test("older visible models remain explicit override choices without changing defaults or the observation pin", () => {
  const row = (model: string, hidden = false) => ({ id: model, model, hidden,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }] });
  const resolution = resolveModels(parseModelPolicy(policyText), { complete: true, models: [...fixtureModels,
    { ...fixtureModels[1], id: "gpt-5.6-sol", model: "gpt-5.6-sol" },
    row("gpt-5-sol"), row("gpt-4-sol", true), row("gpt-8-unknown"),
  ] });
  const policy = dispatchPolicy(resolveCapabilities(capabilities, resolution));
  assert.equal(resolution.roles.builder.model, "gpt-6.10-sol");
  for (const agent_type of [undefined, "kherep-builder"]) {
    const dispatch = (model: string, reasoning_effort: string) => validate(spawnDispatch({
      ...(agent_type ? { agent_type } : {}), model, reasoning_effort,
    }), policy);
    assert.equal(dispatch("gpt-5.6-sol", "high"), null);
    assert.equal(dispatch("gpt-5-sol", "low"), null);
    assert.match(dispatch("gpt-5-sol", "high") ?? "", /reasoning effort/);
    for (const model of ["gpt-4-sol", "gpt-8-unknown", "gpt-99-sol"]) assert.match(dispatch(model, "low") ?? "", /Unsupported/);
  }
  assert.match(validate(spawnDispatch({ agent_type: "codex-obs", model: "gpt-5.6-sol", reasoning_effort: "low", message: BRIEF }), policy) ?? "", /pinned/);
});

// Issue #505. A code-bound finding without an exact binding is a report after
// a null validate, never a deny; a stale installed lib reports nothing.
const BARE_CODE = "- measured: code `npm test` -> 42 pass";
const obsDispatch = (message: string, extra: Record<string, unknown> = {}) =>
  spawnDispatch({ agent_type: "codex-obs", model: OBS_MODEL, reasoning_effort: "low", message, ...extra });

test("advise reports an incomplete code binding for the observation agent only", () => {
  assert.match(advise(obsDispatch(BARE_CODE), POLICY) ?? "", /finding 1 \(measured:\) is code-bound but names no repository/);
  assert.equal(advise(obsDispatch(BRIEF), POLICY), null);
  assert.equal(advise(spawnDispatch({ agent_type: "kherep-builder", message: BARE_CODE }), POLICY), null);
  assert.equal(advise(obsDispatch(BARE_CODE, { model: "gpt-6.10-sol" }), POLICY), null, "a pin deny reports nothing");
  assert.equal(advise(obsDispatch("All green."), POLICY), null, "a format deny reports nothing");
  assert.equal(advise({ tool_name: "Read", tool_input: "x" }, POLICY), null);
});

test("a pasted tool output block never binds a finding; only the prefix after measured: does", () => {
  const pasted = `Tool output:\n\`\`\`\nHEAD is now at ${SHA}\nkherep@${SHA}\n42 pass\n\`\`\`\n`;
  assert.match(advise(obsDispatch(`${pasted}${BARE_CODE}`), POLICY) ?? "", /is code-bound but names no repository/);
  assert.match(advise(obsDispatch(`${pasted}- measured: \`npm test\` -> 42 pass`), POLICY) ?? "",
    /names no repository and commit SHA\. If it is about repository code/);
  assert.equal(advise(obsDispatch(`${pasted}- measured: code kherep@${SHA} -- package.json \`npm test\` -> 42 pass`), POLICY), null);
});

test("the installed guard writes the notice as context and a system message, and a stale lib stays silent", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-dispatch-notice-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hookDir = path.join(root, "hooks", "kherep-maestro");
  fs.mkdirSync(path.join(hookDir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "hooks", "parity"));
  const guard = path.join(hookDir, "codex-dispatch-contract-guard.mts");
  fs.copyFileSync(GUARD, guard);
  fs.writeFileSync(path.join(root, "hooks", "parity", "capabilities.json"), JSON.stringify(capabilities));
  const lib = fs.readFileSync(path.join(REPO, "claude", "hooks", "lib", "obs-brief-policy.mts"), "utf8");
  const run = (message: string, model = OBS_MODEL) => spawnSync(process.execPath, [guard], {
    encoding: "utf8", input: JSON.stringify(spawnDispatch({ agent_type: "codex-obs", model, message })),
  }).stdout;
  fs.writeFileSync(path.join(hookDir, "lib", "obs-brief-policy.mts"), lib);
  const output = JSON.parse(run(BARE_CODE)) as { hookSpecificOutput: Record<string, unknown>; systemMessage: unknown };
  assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(String(output.hookSpecificOutput.additionalContext), /^Observation brief revision: finding 1 \(measured:\) is code-bound/);
  assert.equal(output.systemMessage, output.hookSpecificOutput.additionalContext);
  assert.ok(!("permissionDecision" in output.hookSpecificOutput), "a notice is no permission decision");
  assert.equal(run(BRIEF), "");
  assert.ok(denied(run(BARE_CODE, "gpt-6.10-sol")).includes(OBS_MODEL), "the pin deny comes first and alone");
  const stale = lib.replace("export function observationBriefNotice", "function observationBriefNotice");
  assert.notEqual(stale, lib);
  fs.writeFileSync(path.join(hookDir, "lib", "obs-brief-policy.mts"), stale);
  assert.equal(run(BARE_CODE), "", "a stale lib: allowed, no notice, no deny");
  assert.match(denied(run("All green.")), /Observation brief format/, "a stale lib keeps the format deny");
});
