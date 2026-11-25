import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { loadCanonicalPluginSources } from "./canonical-plugin-sources.mts";
import type { Capabilities } from "./contracts.mts";
import { readOverlay } from "./plugin-source-overlay.mts";

function files(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? files(target) : entry.isFile() ? [target] : [];
  });
}

test("versioned canonical plugin sources are complete, LF-stable, and hash-valid", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const capabilities = JSON.parse(fs.readFileSync(path.join(repoRoot, "codex", "parity", "capabilities.json"), "utf8")) as Capabilities;
  const canonicalRoot = path.join(repoRoot, "codex", "parity", "plugin-sources");
  const sources = loadCanonicalPluginSources({ capabilities, pluginSourceRoot: canonicalRoot, repoRoot });
  assert.equal(sources.size, 13);
  const crlfFiles = files(canonicalRoot).filter((file) => fs.readFileSync(file).includes(Buffer.from("\r\n")));
  assert.deepEqual(crlfFiles, []);
});

// Issue #1010. Every declared change is in the bundled tree, so a refresh that
// skipped the overlay cannot pass.
test("the bundled tree carries every declared overlay change", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const canonicalRoot = path.join(repoRoot, "codex", "parity", "plugin-sources");
  const manifest = JSON.parse(fs.readFileSync(path.join(canonicalRoot, "manifest.json"), "utf8")) as { plugins: { id: string; path: string }[] };
  for (const [id, overlay] of Object.entries(readOverlay(repoRoot))) {
    const entry = manifest.plugins.find((plugin) => plugin.id === id);
    assert.ok(entry, id);
    const root = path.join(canonicalRoot, entry.path);
    for (const relative of overlay.exclude ?? []) assert.equal(fs.existsSync(path.join(root, relative)), false, relative);
    for (const change of overlay.replace ?? []) {
      const text = fs.readFileSync(path.join(root, change.file), "utf8");
      assert.equal(text.includes(change.find), false, change.file);
      assert.equal(text.includes(change.with), true, change.file);
    }
  }
});
