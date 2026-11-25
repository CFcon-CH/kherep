// Issue #1010. THIRD-PARTY-NOTICES.md is the inventory of what this repository
// redistributes, so its tables must describe the bundled trees exactly: the
// manifest beside them, the declared changes and the licence files.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { readOverlay } from "../codex/lib/plugin-source-overlay.mts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(repoRoot, "codex", "parity", "plugin-sources");
const notices = fs.readFileSync(path.join(repoRoot, "THIRD-PARTY-NOTICES.md"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, "manifest.json"), "utf8")) as {
  plugins: { id: string; version: string; path: string; contentSha256: string }[];
};

function section(heading: string): string {
  const start = notices.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, heading);
  const end = notices.indexOf("\n## ", start + 1);
  return notices.slice(start, end < 0 ? undefined : end);
}

// Table rows of a section whose first cell is a plugin id, as plain cell text.
function pluginRows(heading: string): string[][] {
  return section(heading).split("\n").filter((line) => /^\| `[^`]+@[^`]+` \|/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim().replaceAll("`", "")));
}

test("the component table names every bundled plugin with its bundled version", () => {
  assert.deepEqual(pluginRows("Bundled plugin sources").map(([id, version]) => [id, version]),
    manifest.plugins.map((entry) => [entry.id, entry.version]));
  for (const row of pluginRows("Bundled plugin sources")) {
    assert.equal(row.length, 6, row[0]);
    assert.match(row[3], /^(?:[0-9a-f]{12}|v\d+(?:\.\d+)*)$/, row[0]);
  }
});

test("the content pins are the manifest's", () => {
  assert.deepEqual(pluginRows("Content pins"), manifest.plugins.map((entry) => [entry.id, entry.path, entry.contentSha256]));
});

test("every component carries a licence file unless its text is reproduced in the notices", () => {
  for (const entry of manifest.plugins) {
    const present = fs.existsSync(path.join(sourceRoot, entry.path, "LICENSE"));
    assert.equal(present || section("andrej-karpathy-skills licence text").includes(entry.id), true, entry.id);
  }
  for (const file of ["LICENSE-MIT", "NOTICE"]) assert.equal(fs.existsSync(path.join(sourceRoot, "caveman_caveman", file)), true, file);
});

test("every declared change is listed", () => {
  const changes = section("Changes to bundled files");
  for (const [id, overlay] of Object.entries(readOverlay(repoRoot))) {
    assert.ok(changes.includes(`\`${id}\``), id);
    for (const file of [...overlay.exclude ?? [], ...(overlay.replace ?? []).map((change) => change.file)]) {
      assert.ok(changes.includes(`\`${file}\``), file);
    }
  }
});
