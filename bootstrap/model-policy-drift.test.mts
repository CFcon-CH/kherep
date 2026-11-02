// Issue #737. drift-check.sh compares an installed agent against its source
// rendered from the model policy: an overridden frontmatter is ok, a hand edit
// is DRIFT, an invalid user override is RENDER-FAIL naming the file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";

const posix = (p: string) => p.replace(/\\/g, "/");
const HERE = posix(import.meta.dirname);
const SRC = posix(path.resolve(import.meta.dirname, "..", "claude"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "model-policy-drift-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// Runs drift-check.sh's own normalize_file, cmp_file and cmp_agent on one agent.
function drift(home: string, agent: string): { status: number | null; stdout: string; stderr: string } {
  const harness = path.join(TMP, "harness.sh");
  fs.writeFileSync(harness, `#!/usr/bin/env bash
set -uo pipefail
FUNCTIONS_FILE="$(mktemp)"
for name in normalize_file cmp_file cmp_agent; do sed -n "/^$name() {/,/^}/p" "$HERE/drift-check.sh" >> "$FUNCTIONS_FILE"; done
source "$FUNCTIONS_FILE"; rm -f "$FUNCTIONS_FILE"
EXPECTED_DIR="$(mktemp -d)"; trap 'rm -rf "$EXPECTED_DIR"' EXIT
drift=0
cmp_agent "agents/$AGENT.md" "$CLAUDE_SRC/agents/$AGENT.md" "$CLAUDE_HOME/agents/$AGENT.md"
exit "$drift"
`);
  const env: Record<string, string | undefined> = { ...process.env, HERE, CLAUDE_SRC: SRC, CLAUDE_HOME: posix(home), AGENT: agent };
  delete env.KHEREP_ALLOWED_MODELS;
  delete env.KHEREP_AGENT_MODEL_POLICY;
  return spawnSync("bash", [posix(harness)], { encoding: "utf8", env, timeout: 30_000 });
}

function home(name: string, user: string | undefined, liveObs: string): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.mkdirSync(path.join(root, "kherep"), { recursive: true });
  if (user !== undefined) fs.writeFileSync(path.join(root, "kherep", "model-policy.user.json"), user);
  fs.writeFileSync(path.join(root, "agents", "claude-obs.md"), liveObs);
  return root;
}

const SOURCE = fs.readFileSync(path.join(SRC, "agents", "claude-obs.md"), "utf8");
const rendered = (model: string, effort: string) =>
  SOURCE.replace("model: __KHEREP_MODEL__", `model: ${model}`).replace("effort: __KHEREP_EFFORT__", `effort: ${effort}`);

test("an overridden agent frontmatter is ok, not DRIFT", () => {
  const user = JSON.stringify({ agents: { "claude-obs": { model: "sonnet", effort: "low" } } });
  const result = drift(home("override", user, rendered("sonnet", "low")), "claude-obs");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ok +agents\/claude-obs\.md$/m);
});

test("the shipped default without a user file is ok", () => {
  const result = drift(home("default", undefined, rendered("haiku", "medium")), "claude-obs");
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("a hand edit of the live frontmatter is DRIFT", () => {
  const result = drift(home("edited", undefined, rendered("sonnet", "medium")), "claude-obs");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^DRIFT +agents\/claude-obs\.md$/m);
});

test("an invalid user override is RENDER-FAIL naming the file, not its content", () => {
  const result = drift(home("invalid", "{ SECRET-CANARY", rendered("haiku", "medium")), "claude-obs");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^RENDER-FAIL +agents\/claude-obs\.md \(FATAL: model policy .*model-policy\.user\.json is not valid JSON\)$/m);
  assert.ok(!result.stdout.includes("SECRET-CANARY"));
});
