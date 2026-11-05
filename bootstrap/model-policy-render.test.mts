// Issue #737. Rendering the model policy into Claude agent frontmatter.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";

import { loadModelPolicy } from "../claude/hooks/lib/model-policy.mts";
import { portableAgentText, renderAgentText, RenderError } from "./model-policy-render.mts";

const REPO = path.resolve(import.meta.dirname, "..");
const AGENTS = path.join(REPO, "claude", "agents");
const SHIPPED = path.join(REPO, "claude", "kherep", "model-policy.json");
const CLI = path.join(import.meta.dirname, "model-policy-render.mts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "model-policy-render-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let n = 0;

function userFile(content?: unknown): string {
  const file = path.join(TMP, `user-${n++}.json`);
  if (content !== undefined) fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}
const policy = (user?: unknown) => loadModelPolicy({ files: { shipped: SHIPPED, user: userFile(user) }, env: {} });
const source = (agent: string) => fs.readFileSync(path.join(AGENTS, `${agent}.md`), "utf8");
const render = (agent: string, user?: unknown) => renderAgentText(source(agent), policy(user).agents.get(agent), agent);
const frontmatter = (text: string) => text.split("\n---")[0];

test("every agent source ends its frontmatter with the two placeholders", () => {
  for (const name of fs.readdirSync(AGENTS)) {
    assert.match(frontmatter(fs.readFileSync(path.join(AGENTS, name), "utf8")), /\nmodel: __KHEREP_MODEL__\neffort: __KHEREP_EFFORT__$/, name);
  }
});

test("the shipped default renders today's frontmatter plus the observer effort medium", () => {
  const placeholders = /\nmodel: __KHEREP_MODEL__\neffort: __KHEREP_EFFORT__\n---/;
  for (const name of fs.readdirSync(AGENTS)) {
    const agent = name.replace(/\.md$/, "");
    const expected = agent === "claude-obs" ? "\nmodel: haiku\neffort: medium\n---"
      : agent === "atlassian-broker" ? "\nmodel: haiku\n---" : "\n---";
    assert.equal(render(agent), source(agent).replace(placeholders, expected), agent);
  }
  assert.match(frontmatter(render("claude-obs")), /\ntools: Bash, Read, Write\nmodel: haiku\neffort: medium$/);
  assert.ok(!/\nmodel:/.test(frontmatter(render("kherep-builder"))), "a role default alone keeps native inherit");
});

test("a user override renders into the frontmatter", () => {
  assert.match(frontmatter(render("kherep-builder", { agents: { "kherep-builder": { model: "sonnet", effort: "high" } } })),
    /\nmodel: sonnet\neffort: high$/);
  assert.match(frontmatter(render("kherep-builder", { roles: { builder: { model: "fable" } } })), /\nmodel: fable$/);
  assert.match(frontmatter(render("claude-obs", { roles: { observer: { effort: "low" } } })), /\nmodel: haiku\neffort: low$/);
  assert.match(frontmatter(render("claude-obs", { agents: { "claude-obs": { model: "inherit" } } })), /\nmodel: inherit\neffort: medium$/);
});

test("an unresolved placeholder is fatal", () => {
  const text = source("kherep-builder");
  assert.throws(() => renderAgentText(text, undefined, "agents/unknown.md"), RenderError);
  const misplaced = text.replace("model: __KHEREP_MODEL__", "model:  __KHEREP_MODEL__");
  assert.throws(() => renderAgentText(misplaced, policy().agents.get("kherep-builder"), "x"), /unresolved model policy placeholder/);
  const inBody = `${text}\nSee __KHEREP_EFFORT__.\n`;
  assert.throws(() => renderAgentText(inBody, policy().agents.get("kherep-builder"), "x"), /unresolved/);
  assert.throws(() => renderAgentText("no frontmatter\n", policy().agents.get("kherep-builder"), "x"), /no frontmatter/);
});

test("capture turns a rendered agent back into its source", () => {
  for (const name of fs.readdirSync(AGENTS)) {
    const agent = name.replace(/\.md$/, "");
    for (const user of [undefined, { agents: { [agent]: { model: "sonnet", effort: "max" } } }]) {
      assert.equal(portableAgentText(render(agent, user), name), source(agent), `${agent} ${JSON.stringify(user)}`);
    }
  }
  const crlf = source("claude-obs").replace(/\n/g, "\r\n");
  const rendered = renderAgentText(crlf, policy().agents.get("claude-obs"), "crlf");
  assert.match(rendered, /\r\nmodel: haiku\r\neffort: medium\r\n---\r\n/);
  assert.equal(portableAgentText(rendered, "crlf"), crlf);
});

test("the CLI renders every agent and fails closed on a malformed override without echoing it", () => {
  const out = path.join(TMP, "out");
  const ok = spawnSync(process.execPath, [CLI, "agents", AGENTS, out, SHIPPED, userFile()], { encoding: "utf8", env: { ...process.env, KHEREP_ALLOWED_MODELS: undefined, KHEREP_AGENT_MODEL_POLICY: undefined } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(), fs.readdirSync(AGENTS).sort());
  const bad = userFile("{ SECRET-CANARY");
  const failed = spawnSync(process.execPath, [CLI, "agents", AGENTS, path.join(TMP, "bad"), SHIPPED, bad], { encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /FATAL: model policy .*user-\d+\.json is not valid JSON/);
  assert.ok(!failed.stderr.includes("SECRET-CANARY"));
  assert.ok(!fs.existsSync(path.join(TMP, "bad")), "nothing is rendered from an invalid policy");
});

test("the environment never reaches the rendered frontmatter", () => {
  const out = path.join(TMP, `env-${n++}`);
  const env = { ...process.env, KHEREP_AGENT_MODEL_POLICY: JSON.stringify({ "kherep-builder": "sonnet" }), KHEREP_ALLOWED_MODELS: "" };
  const result = spawnSync(process.execPath, [CLI, "agents", AGENTS, out, SHIPPED, userFile()], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(frontmatter(fs.readFileSync(path.join(out, "kherep-builder.md"), "utf8")), /\nmodel:/);
  assert.match(result.stderr, /NOTE deprecated/);
  assert.doesNotMatch(result.stderr, /FATAL/);
});
