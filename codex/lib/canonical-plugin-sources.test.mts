import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { loadCanonicalPluginSources } from "./canonical-plugin-sources.mts";
import type { Capabilities } from "./contracts.mts";

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
