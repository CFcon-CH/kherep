// Issue #737. The one-time migration into model-policy.user.json keeps every
// explicit value, even one equal to the old default, and drops only values the
// earlier installer wrote.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";

import { loadModelPolicy } from "../claude/hooks/lib/model-policy.mts";
import { LEGACY_FRONTMATTER, migrate } from "./migrate-model-policy.mts";

const REPO = path.resolve(import.meta.dirname, "..");
const SHIPPED = path.join(REPO, "claude", "kherep", "model-policy.json");
const CLI = path.join(import.meta.dirname, "migrate-model-policy.mts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-model-policy-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let n = 0;

// The frontmatter the pre-#737 installer wrote: `model: haiku` only on the two.
function legacyAgent(agent: string, extra: string[] = []): string {
  const model = LEGACY_FRONTMATTER[agent]?.model;
  return ["---", `name: ${agent}`, "description: x", "tools: Bash, Read", ...(model ? [`model: ${model}`] : []), ...extra, "---", "", "Body.", ""].join("\n");
}

// A legacy Claude home: every Kherep agent as the earlier installer wrote it.
function legacyHome(edits: Record<string, string> = {}): string {
  const home = path.join(TMP, String(n++));
  fs.mkdirSync(path.join(home, "agents"), { recursive: true });
  for (const name of fs.readdirSync(path.join(REPO, "claude", "agents"))) {
    const agent = name.replace(/\.md$/, "");
    fs.writeFileSync(path.join(home, "agents", name), edits[agent] ?? legacyAgent(agent));
  }
  return home;
}

test("an untouched legacy host captures nothing", () => {
  const capture = migrate(legacyHome(), SHIPPED, {})!;
  assert.deepEqual(capture.policy.agents, {});
  assert.deepEqual(capture.policy.models, {});
});

test("environment values are explicit and kept even when they equal the old default", () => {
  const capture = migrate(legacyHome(), SHIPPED, {
    KHEREP_ALLOWED_MODELS: "opus,sonnet,operator-model",
    KHEREP_AGENT_MODEL_POLICY: JSON.stringify({ "kherep-builder": ["opus", "fable"], "claude-obs": "haiku", "general-purpose": "opus" }),
  })!;
  assert.deepEqual(capture.policy.agents, { "kherep-builder": { model: "opus" }, "claude-obs": { model: "haiku" } });
  assert.deepEqual(capture.policy.models, { opus: { dispatchable: true }, sonnet: { dispatchable: true }, "operator-model": { dispatchable: true } });
  const notes = capture.notes.join("\n");
  assert.match(notes, /captured agents\.kherep-builder\.model = opus from KHEREP_AGENT_MODEL_POLICY \(first of 2\)/);
  assert.match(notes, /not captured: KHEREP_AGENT_MODEL_POLICY names general-purpose/);
  assert.match(notes, /left out haiku, fable; the policy only adds models/);
});

test("edited frontmatter is explicit, including a value equal to a default", () => {
  const capture = migrate(legacyHome({
    "claude-obs": legacyAgent("claude-obs", ["effort: medium"]),
    "kherep-builder": legacyAgent("kherep-builder", ["model: sonnet", "effort: high"]),
    "atlassian-broker": legacyAgent("atlassian-broker").replace("model: haiku\n", ""),
    "win-agent": legacyAgent("win-agent", ["model: claude-haiku-4-5"]),
    "mac-agent": legacyAgent("mac-agent", ["effort: ultra"]),
  }), SHIPPED, {})!;
  assert.deepEqual(capture.policy.agents, {
    "claude-obs": { effort: "medium" },
    "kherep-builder": { model: "sonnet", effort: "high" },
    "atlassian-broker": { model: "inherit" },
    "win-agent": { model: "claude-haiku-4-5" },
  });
  assert.deepEqual(capture.policy.models, { "claude-haiku-4-5": {} }, "a full id the frontmatter used joins the catalog, not dispatch");
  assert.match(capture.notes.join("\n"), /not captured: agents\/mac-agent\.md effort is outside/);
});

test("the deprecated environment wins over frontmatter for the same agent model", () => {
  const capture = migrate(legacyHome({ "claude-obs": legacyAgent("claude-obs").replace("model: haiku", "model: sonnet") }), SHIPPED,
    { KHEREP_AGENT_MODEL_POLICY: JSON.stringify({ "claude-obs": "haiku" }) })!;
  assert.deepEqual(capture.policy.agents, { "claude-obs": { model: "haiku" } });
  assert.match(capture.notes.join("\n"), /not captured: agents\/claude-obs\.md model/);
});

test("a host the policy installer reached, or with a user file, is never migrated", () => {
  const installed = legacyHome({ "kherep-builder": legacyAgent("kherep-builder", ["model: sonnet"]) });
  fs.mkdirSync(path.join(installed, "kherep"));
  fs.copyFileSync(SHIPPED, path.join(installed, "kherep", "model-policy.json"));
  assert.equal(migrate(installed, SHIPPED, { KHEREP_AGENT_MODEL_POLICY: "{\"kherep-builder\":\"opus\"}" }), null);
  const owned = legacyHome();
  fs.mkdirSync(path.join(owned, "kherep"));
  fs.writeFileSync(path.join(owned, "kherep", "model-policy.user.json"), "{}");
  assert.equal(migrate(owned, SHIPPED, { KHEREP_ALLOWED_MODELS: "x" }), null);
});

function cli(home: string, env: Record<string, string | undefined>) {
  const out = path.join(home, "migrated.json");
  const result = spawnSync(process.execPath, [CLI, home, SHIPPED, out], {
    encoding: "utf8", env: { ...process.env, KHEREP_ALLOWED_MODELS: undefined, KHEREP_AGENT_MODEL_POLICY: undefined, ...env },
  });
  return { ...result, out };
}

test("the CLI writes a loadable override only when it captured something and prints each value", () => {
  const nothing = cli(legacyHome(), {});
  assert.equal(nothing.status, 0, nothing.stderr);
  assert.match(nothing.stdout, /nothing to migrate/);
  assert.ok(!fs.existsSync(nothing.out));
  const home = legacyHome({ "claude-obs": legacyAgent("claude-obs", ["effort: low"]) });
  const some = cli(home, { KHEREP_AGENT_MODEL_POLICY: "{not json" });
  assert.equal(some.status, 0, some.stderr);
  assert.match(some.stdout, /captured agents\.claude-obs\.effort = low/);
  assert.match(some.stdout, /not captured: KHEREP_AGENT_MODEL_POLICY is not a JSON object/);
  assert.deepEqual(JSON.parse(fs.readFileSync(some.out, "utf8")), { schema_version: 1, agents: { "claude-obs": { effort: "low" } } });
  const policy = loadModelPolicy({ files: { shipped: SHIPPED, user: some.out }, env: {} });
  assert.deepEqual([policy.agents.get("claude-obs")!.model, policy.agents.get("claude-obs")!.effort], ["haiku", "low"]);
});
