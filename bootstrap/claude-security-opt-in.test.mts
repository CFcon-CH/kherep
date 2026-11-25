// Issue #1010. The Claude Security plugin is an operator opt-in for Claude. The
// repository names its id and nothing else of it, Codex never receives it, and
// no file of the plugin is part of this distribution.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { parsePluginManifest } from "./plugin-contract.mts";

const REPO = path.resolve(import.meta.dirname, "..");
const ID = "claude-security@claude-plugins-official";
const json = (relative: string): unknown => JSON.parse(fs.readFileSync(path.join(REPO, relative), "utf8"));

function files(root: string): string[] {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test("the optional manifest holds the plugin id and nothing else, and the required one does not", () => {
  assert.deepEqual(json("bootstrap/manifest/plugins.optional.json"), { enabledPlugins: { [ID]: true } });
  assert.deepEqual(parsePluginManifest(json("bootstrap/manifest/plugins.optional.json"), new Set(["claude-plugins-official"])), [ID]);
  const required = json("bootstrap/manifest/plugins.json") as { enabledPlugins: Record<string, boolean> };
  assert.equal(ID in required.enabledPlugins, false);
  const versions = json("bootstrap/manifest/plugin-versions.json") as { versions: Record<string, string> };
  assert.equal(ID in versions.versions, false, "Kherep reviews no version of it");
});

test("nothing under codex/ or claude/ names the plugin, in a path or in content", () => {
  const needle = ID.split("@")[0];
  for (const root of ["codex", "claude"]) {
    for (const file of files(path.join(REPO, root))) {
      const relative = path.relative(REPO, file);
      assert.equal(relative.includes(needle), false, relative);
      assert.equal(fs.readFileSync(file).includes(needle), false, relative);
    }
  }
});
