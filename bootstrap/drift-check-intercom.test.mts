// Issue #436. CLAUDE.md and teams/kherep/ROUTING.md name the stable intercom
// command through the __KHEREP_NODE__ placeholder, so drift-check renders the
// source for this host before it compares, as it does for settings.json. A
// rendered live file is in sync; a hand-edited command line or an unrendered
// placeholder is drift. The functions run from the real script in a harness;
// every path is a fresh temp directory and the config root is KHEREP_CONFIG_DIR.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { intercomValues, renderIntercom } from "./render-intercom.mts";

const HERE = import.meta.dirname;
const slash = (value: string): string => value.replace(/\\/g, "/");
const TEMPLATE = "# Kherep\nOperator text.\n__KHEREP_NODE__ msg sessions\n"
  + "Example: __KHEREP_NODE__ msg send __KHEREP_EXAMPLE_TARGET__ -- hi\n";
const rendered = (dir: string): string => renderIntercom(TEMPLATE, intercomValues(dir));

function harness(t: test.TestContext, live: string | null, configDir: string): { status: number | null; out: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-drift-intercom-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "CLAUDE.user.md");
  const liveFile = path.join(root, "CLAUDE.md");
  fs.writeFileSync(repo, TEMPLATE);
  if (live !== null) fs.writeFileSync(liveFile, live);
  const script = path.join(root, "harness.sh");
  fs.writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
FUNCTIONS_FILE="$(mktemp)"
for fn in normalize_file cmp_file cmp_rendered; do sed -n "/^$fn() {/,/^}/p" "$1/drift-check.sh" >> "$FUNCTIONS_FILE"; done
source "$FUNCTIONS_FILE"
rm -f "$FUNCTIONS_FILE"
HERE="$1"
EXPECTED_DIR="$(mktemp -d)"
trap 'rm -rf "$EXPECTED_DIR"' EXIT
CLAUDE_HOME="$2/home/.claude"
drift=0
cmp_rendered CLAUDE.md "$3" "$4"
exit "$drift"
`);
  const result = spawnSync("bash", [slash(script), slash(HERE), slash(root), slash(repo), slash(liveFile)], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, KHEREP_CONFIG_DIR: configDir } });
  assert.ifError(result.error);
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

function configDir(t: test.TestContext): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-drift-intercom-config-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a live file rendered for this config root is in sync", (t) => {
  const dir = configDir(t);
  const result = harness(t, rendered(dir), dir);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /^ok +CLAUDE\.md$/m);
});

test("a hand-edited command line or an unrendered placeholder is drift", (t) => {
  const dir = configDir(t);
  const edited = rendered(dir).replace("kherep-node.mjs", "kherep-node-old.mjs");
  for (const live of [edited, TEMPLATE, rendered(dir).replace("peer/session", "other/session")]) {
    const result = harness(t, live, dir);
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /^DRIFT +CLAUDE\.md$/m);
  }
  const missing = harness(t, null, dir);
  assert.match(missing.out, /^MISSING-LIVE +CLAUDE\.md /m);
});

test("a config root the command cannot quote fails the render instead of passing", (t) => {
  const dir = path.join(configDir(t), process.platform === "win32" ? "100%" : "back\\slash");
  const result = harness(t, TEMPLATE, dir);
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /^RENDER-FAIL +CLAUDE\.md$/m);
});

test("the manifest loop compares CLAUDE.md and the Kherep routing file through the renderer", () => {
  const script = fs.readFileSync(path.join(HERE, "drift-check.sh"), "utf8");
  assert.match(script, /cmp_rendered "\$rel" "\$CLAUDE_SRC\/CLAUDE\.user\.md" "\$CLAUDE_HOME\/CLAUDE\.md"/);
  assert.match(script, /if \[\[ "\$rel" = "teams\/kherep\/ROUTING\.md" \]\]; then\n\s+cmp_rendered "\$rel" "\$CLAUDE_SRC\/teams\/kherep\/ROUTING\.md" "\$CLAUDE_HOME\/teams\/kherep\/ROUTING\.md"/);
  assert.doesNotMatch(script, /cmp_file "\$rel" "\$CLAUDE_SRC\/CLAUDE\.user\.md"/);
});
