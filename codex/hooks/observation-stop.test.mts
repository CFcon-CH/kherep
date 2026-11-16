import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { observationPrompt } from "./observation-stop.mts";

async function decision(input: unknown, env: NodeJS.ProcessEnv = {}) {
  const hook = await import("./observation-stop.mts").catch(() => null);
  assert.ok(hook, "Codex Mac observation Stop hook must exist");
  return hook.decision(input, env);
}

const workspace = "/synthetic/kherep";
const env = { KHEREP_WORKSPACE: workspace };
const firstStop = { turn_id: "synthetic-turn", stop_hook_active: false, cwd: workspace };

test("first Stop requests one pinned codex-obs dispatch without copying turn text", async () => {
  const result = await decision({ ...firstStop, last_assistant_message: "Synthetic private sentinel" }, env);
  assert.equal(result?.decision, "block");
  assert.match(result.reason, /codex-obs/);
  assert.match(result.reason, /installed agent TOML/);
  assert.match(result.reason, /low/);
  assert.match(result.reason, /Empty findings/i);
  assert.doesNotMatch(JSON.stringify(result), /Synthetic private sentinel/);
});

test("repeated Stop cannot request the observation agent again", async () => {
  assert.equal(await decision({ ...firstStop, stop_hook_active: true }, env), null);
});

test("missing Stop markers never request observation continuation", async () => {
  assert.equal(await decision({ ...firstStop, turn_id: "" }, env), null);
  assert.equal(await decision({ ...firstStop, stop_hook_active: undefined }, env), null);
  assert.equal(await decision({}, env), null);
});

test("acceptance requirement survives first and repeated Stop events", async () => {
  const input = { ...firstStop, last_assistant_message: "Work done." };
  const first = await decision(input, env);
  assert.equal(first?.decision, "block");
  assert.match(first.reason, /C1-C4/);
  assert.match(first.reason, /codex-obs/);
  const repeated = await decision({ ...input, stop_hook_active: true }, env);
  assert.equal(repeated?.decision, "block");
  assert.match(repeated.reason, /C1-C4/);
  assert.doesNotMatch(repeated.reason, /codex-obs/);
  assert.equal(await decision({ ...input, last_assistant_message: "C1 C2 C3 C4", stop_hook_active: true }, env), null);
});

test("observation prompt exposes only the narrow tool, independent of workspace shell syntax", () => {
  for(const platform of ["darwin","win32"] as const){
    const prompt=observationPrompt("/synthetic/space's $(throw expanded)",platform);
    assert.match(prompt,/mcp__kherep_observations__publish_observations/);
    assert.doesNotMatch(prompt,/atl-confluence|node '|throw expanded/);
    assert.match(prompt,/NO further publication/);
  }
});

// Issue #737 (Lead review L4): the Stop text follows the installed effective
// pair instead of naming an effort or a model family.
test("the Stop reminder takes the observer's model and effort from its installed agent TOML", () => {
  const prompt = observationPrompt();
  assert.match(prompt, /agent_type codex-obs \(its recorded installed name\), the exact model and model_reasoning_effort from its installed agent TOML/);
  assert.doesNotMatch(prompt, /reasoning_effort low|\bLuna\b/);
  assert.match(prompt, /The observer owns extraction and publication/);
});
