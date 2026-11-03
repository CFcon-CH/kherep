// Issue #761. The Claude lead and team-lead profiles ship like every owned
// agent: listed in the file manifest and in ownedAgents, rendered from the model
// policy by install.sh, and compared by drift-check.sh's cmp_agent. Role `root`
// keeps native inherit, so the rendered frontmatter has no model or effort line.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repo = path.resolve(import.meta.dirname, "..");
const AGENTS = ["kherep-lead", "kherep-team-lead"];
const manifestDir = path.join(repo, "bootstrap", "manifest");
const posix = (file: string): string => file.replace(/\\/g, "/");

test("the file manifest, ownedAgents and the model policy list both team profiles", () => {
  const files = fs.readFileSync(path.join(manifestDir, "files.txt"), "utf8").split(/\r?\n/).map((line) => line.trim());
  const capabilities = JSON.parse(fs.readFileSync(path.join(manifestDir, "capabilities.json"), "utf8")) as {
    ownedAgents: Record<string, string>;
  };
  const policy = JSON.parse(fs.readFileSync(path.join(repo, "claude", "kherep", "model-policy.json"), "utf8")) as {
    agents: Record<string, { role: string; model?: string }>;
  };
  for (const agent of AGENTS) {
    assert.ok(files.includes(`agents/${agent}.md`), `files.txt lists agents/${agent}.md`);
    assert.equal(capabilities.ownedAgents[agent], `${agent}.md`);
    assert.deepEqual(policy.agents[agent], { role: "root" }, `${agent} inherits the session model`);
    assert.ok(fs.statSync(path.join(repo, "claude", "agents", `${agent}.md`)).isFile());
  }
});

test("the installer render keeps the body and drift-check covers the installed file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-761-claude-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudeHome = path.join(root, "claude-home");
  const rendered = path.join(root, "rendered");
  const render = spawnSync(process.execPath, [path.join(repo, "bootstrap", "model-policy-render.mts"), "agents",
    path.join(repo, "claude", "agents"), rendered, path.join(repo, "claude", "kherep", "model-policy.json"),
    path.join(claudeHome, "kherep", "model-policy.user.json")], { encoding: "utf8" });
  assert.equal(render.status, 0, render.stderr);
  fs.mkdirSync(path.join(claudeHome, "agents"), { recursive: true });
  for (const agent of AGENTS) {
    const source = fs.readFileSync(path.join(repo, "claude", "agents", `${agent}.md`), "utf8");
    const installed = fs.readFileSync(path.join(rendered, `${agent}.md`), "utf8");
    assert.equal(installed, source.replace("model: __KHEREP_MODEL__\neffort: __KHEREP_EFFORT__\n", ""), agent);
    fs.copyFileSync(path.join(rendered, `${agent}.md`), path.join(claudeHome, "agents", `${agent}.md`));
  }

  // The real cmp_agent and its helpers, driven by the manifest entries.
  const harness = path.join(root, "harness.sh");
  fs.writeFileSync(harness, `#!/usr/bin/env bash
set -uo pipefail
SCRIPT="$1"; HERE="$2"; CLAUDE_SRC="$3"; CLAUDE_HOME="$4"; MANIFEST="$5"
FUNCTIONS="$(mktemp)"
for name in normalize_file cmp_file cmp_agent; do sed -n "/^$name() {/,/^}/p" "$SCRIPT" >> "$FUNCTIONS"; done
source "$FUNCTIONS"; rm -f "$FUNCTIONS"
EXPECTED_DIR="$(mktemp -d)"; trap 'rm -rf "$EXPECTED_DIR"' EXIT
drift=0
while IFS= read -r rel || [ -n "$rel" ]; do
  rel="\${rel%$'\\r'}"
  case "$rel" in agents/kherep-lead.md|agents/kherep-team-lead.md) cmp_agent "$rel" "$CLAUDE_SRC/$rel" "$CLAUDE_HOME/$rel" ;; esac
done < "$MANIFEST"
echo "drift=$drift"
`);
  const run = () => spawnSync("bash", [posix(harness), posix(path.join(repo, "bootstrap", "drift-check.sh")),
    posix(path.join(repo, "bootstrap")), posix(path.join(repo, "claude")), posix(claudeHome),
    posix(path.join(manifestDir, "files.txt"))], { encoding: "utf8", timeout: 30_000 });

  const clean = run();
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /^ok\s+agents\/kherep-lead\.md$/m);
  assert.match(clean.stdout, /^ok\s+agents\/kherep-team-lead\.md$/m);
  assert.match(clean.stdout, /^drift=0$/m);

  fs.appendFileSync(path.join(claudeHome, "agents", "kherep-lead.md"), "\nhand edit\n");
  fs.rmSync(path.join(claudeHome, "agents", "kherep-team-lead.md"));
  const drifted = run();
  assert.match(drifted.stdout, /^DRIFT\s+agents\/kherep-lead\.md$/m);
  assert.match(drifted.stdout, /^MISSING-LIVE\s+agents\/kherep-team-lead\.md/m);
  assert.match(drifted.stdout, /^drift=1$/m);
});
