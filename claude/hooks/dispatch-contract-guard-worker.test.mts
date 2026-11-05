#!/usr/bin/env node
// Issue #701. The worker brief check of dispatch-contract-guard.mts, end to end:
// a code-bound role needs revision: and decided:, any other dispatch that
// declares revision: is checked for well-formed fields (WORKER_BRIEF_FORMAT,
// denied from day one), and a review brief without revision: gets a context
// notice only (WORKER_BRIEF_REVISION). The observation brief keeps its rules.
import path from "node:path";
import { spawnSync } from "node:child_process";

const HOOK = path.join(import.meta.dirname, "dispatch-contract-guard.mts");
let pass = 0;
let fail = 0;

type Payload = Record<string, unknown>;
type Expected = "silent" | "notice" | { deny: string };

// The shipped default policy: the host's own policy settings must not decide these cases.
function run(payload: Payload): { status: number | null; stdout: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.KHEREP_ALLOWED_MODELS;
  delete env.KHEREP_AGENT_MODEL_POLICY;
  const result = spawnSync("node", [HOOK], { input: JSON.stringify(payload), encoding: "utf8", env });
  return { status: result.status, stdout: result.stdout };
}

function expectDecision(name: string, payload: Payload, expected: Expected): void {
  const actual = run(payload);
  let output: { hookSpecificOutput?: Record<string, unknown>; systemMessage?: unknown } = {};
  try { output = JSON.parse(actual.stdout || "{}"); } catch {}
  const hso = output.hookSpecificOutput ?? {};
  const context = typeof hso.additionalContext === "string" ? hso.additionalContext : "";
  const reason = typeof hso.permissionDecisionReason === "string" ? hso.permissionDecisionReason : "";
  const ok = actual.status === 0 && (expected === "silent" ? actual.stdout === ""
    : expected === "notice"
      ? context.startsWith("[dispatch-contract:WORKER_BRIEF_REVISION] Worker brief revision: ") && hso.hookEventName === "PreToolUse"
        && !("permissionDecision" in hso) && !("permissionDecisionReason" in hso) && !("systemMessage" in output)
      : hso.permissionDecision === "deny" && !context && reason.includes(expected.deny));
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} | expected ${typeof expected === "string" ? expected : `deny ${expected.deny}`}`);
}

const SHA = "2733b35e2c102ac54295568509c68b18b6d92cab";
const HEAD = "f0893d7e62823a48d89ec57f1e33f5c8f57eebca";
const WORKER = `revision: kherep@${SHA}\ndecided: none\n`;
const agent = (subagent_type: string, model: string, prompt: string, description = "Build it") =>
  ({ tool_name: "Agent", tool_input: { subagent_type, model, description, prompt } });
const deny = (needle: string) => ({ deny: needle });

// A code-bound role: both markers, well formed.
expectDecision("builder without markers denied", agent("kherep-builder", "opus", "Build it."), deny("WORKER_BRIEF_FORMAT"));
expectDecision("builder deny names the missing revision", agent("kherep-builder", "opus", "decided: none"), deny("the brief names no revision:"));
expectDecision("builder deny names the missing decided", agent("kherep-builder", "opus", `revision: kherep@${SHA}`), deny("the brief names no decided:"));
expectDecision("dc build runner is code-bound", agent("dc-plugin-build-runner", "sonnet", "Build the JAR."), deny("the brief names no revision:"));
expectDecision("malformed token denied by position", agent("kherep-builder", "opus", "revision: kherep@HEAD\ndecided: none"), deny("revision 1 has a malformed token"));
expectDecision("revision without a token denied", agent("kherep-builder", "opus", "revision:\ndecided: none"), deny("revision 1 names no repository"));
expectDecision("empty decided denied", agent("kherep-builder", "opus", `revision: kherep@${SHA}\ndecided:`), deny("decided 1 is empty"));
expectDecision("deny states the format", agent("kherep-builder", "opus", "Build it."), deny("or decided: none."));
expectDecision("deny never quotes the brief", agent("kherep-builder", "opus", "revision: secret-name@nope\ndecided: none"), deny("malformed token. A code-bound"));
expectDecision("builder with a full brief is silent", agent("kherep-builder", "fable", `Objective: x\n- revision: kherep@${SHA}-dirty\n- decided: keep the API`), "silent");
expectDecision("builder with a review range is silent", agent("kherep-builder", "opus", `revision: kherep@${SHA}..${HEAD}\ndecided:\n- a\n- b`), "silent");
expectDecision("the description never supplies a marker", agent("kherep-builder", "opus", "Build it.", WORKER), deny("WORKER_BRIEF_FORMAT"));
expectDecision("an unknown model is checked before the brief", agent("kherep-builder", "operator-model", "Build it."), deny("DISPATCH_MODEL_UNKNOWN"));
expectDecision("no default-model pin: builder on haiku reaches the brief check", agent("kherep-builder", "haiku", "Build it."), deny("WORKER_BRIEF_FORMAT"));
expectDecision("a code-bound review brief gets no notice", agent("kherep-builder", "opus", `${WORKER}Review your own diff.`), "silent");

// Any other dispatch: checked only when it declares revision:.
expectDecision("other agent without revision unchecked", agent("general-purpose", "sonnet", "decided:"), "silent");
expectDecision("other agent declaring a malformed revision denied", agent("general-purpose", "sonnet", "revision: kherep"), deny("WORKER_BRIEF_FORMAT"));
expectDecision("other agent declaring revision with an empty decided denied", agent("general-purpose", "sonnet", `revision: kherep@${SHA}\ndecided:`), deny("decided 1 is empty"));
expectDecision("other agent with a review range is silent", agent("general-purpose", "sonnet", `Review it.\nrevision: kherep@${SHA}..${HEAD}-dirty`), "silent");

// The review notice: never a deny, once per dispatch.
expectDecision("review brief without revision gets the notice", agent("general-purpose", "sonnet", "Review the guard diff. Then review it again."), "notice");
expectDecision("reviewer word gets the notice", agent("general-purpose", "sonnet", "Act as a reviewer."), "notice");
expectDecision("a brief without review is silent", agent("general-purpose", "sonnet", "Look it up."), "silent");
expectDecision("the description never triggers the notice", agent("general-purpose", "sonnet", "Look it up.", "Review"), "silent");

// Retired plugin names cannot bypass either model or worker-brief checks.
expectDecision("retired rescue with malformed brief is denied", { tool_name: "Agent", tool_input: { subagent_type: "codex:codex-rescue", prompt: "Review it.\nrevision: x@y" } }, deny("CODEX_AGENT_DIRECT_FORBIDDEN"));
expectDecision("retired rescue with valid model effort and brief is denied", {
  ...agent("codex:codex-rescue", "opus", WORKER),
  tool_input: { subagent_type: "codex:codex-rescue", model: "opus", effort: "high", prompt: WORKER },
}, deny("codex exec"));
const obs = (prompt: string) => agent("claude-obs", "haiku", prompt, "Record observations");
expectDecision("observation brief is not a worker brief", obs(`- measured: code kherep@${SHA} -- x.test.mts \`node x.test.mts\` -> 12 pass\nrevision: kherep`), "silent");
expectDecision("observation brief mentioning review gets no worker notice", obs("- relayed: the review session"), "silent");
expectDecision("observation brief keeps its own deny", obs("Review it.\nrevision: kherep"), deny("OBS_BRIEF_FORMAT"));

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
