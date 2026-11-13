// Issue #906. A projected skill's first `name:` line is rewritten to its projected
// name: "name:", the blanks after it (across lines, as before) and the rest of
// that line. Later name: lines and the line ends stay as they are.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { fixtureResolution } from "./model-policy.fixture.mts";
import { resolveCapabilities } from "./model-policy.mts";
import { componentHash } from "./component-hash.mts";
import type { Capabilities } from "./contracts.mts";
import { InstallTransaction } from "./install-transaction.mts";
import { project } from "./parity-projection.mts";

const PLUGIN = "ai-plugins@claude-plugins-official";
const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

// Projects one plugin whose skills are the given SKILL.md texts; returns the codex home. A personal
// skill of the same name makes the projected name a prefixed one, which rewrites the name: line.
function projectSkills(t: test.TestContext, skills: Record<string, string>, personal: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-skill-name-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const codexHome = path.join(root, ".codex");
  const pluginSourceRoot = path.join(root, "canonical-plugins");
  const pluginRoot = path.join(pluginSourceRoot, "ai-plugins");
  for (const [name, text] of Object.entries(skills)) write(path.join(pluginRoot, "skills", name, "SKILL.md"), text);
  write(path.join(codexHome, "skills", personal, "SKILL.md"), `---\nname: ${personal}\ndescription: Personal.\n---\nPersonal.\n`);
  write(path.join(pluginSourceRoot, "manifest.json"), JSON.stringify({
    plugins: [{ id: PLUGIN, version: "1.0.0", path: "ai-plugins", contentSha256: componentHash(pluginRoot) }],
  }));
  const capabilities = resolveCapabilities(JSON.parse(fs.readFileSync(path.join(repoRoot, "codex", "parity", "capabilities.json"), "utf8")) as Capabilities,
    fixtureResolution());
  capabilities.plugins = [{ id: PLUGIN, mode: "project" }];
  const transaction = new InstallTransaction(codexHome, path.join(codexHome, "backups", "test"));
  project({ capabilities, claudeHome: path.join(root, ".claude"), codexHome, pluginSourceRoot, repoRoot, transaction });
  return codexHome;
}

test("the first name: line becomes the projected name; blanks, CRLF and later name: lines are kept", (t) => {
  const codexHome = projectSkills(t, { demo: "---\r\nname:   old-name   \r\ndescription: Demo.\r\n---\r\nBody\r\nname: second\r\n" }, "old-name");
  // The projection inserts its safety section after the frontmatter; only the name: line changes.
  const text = fs.readFileSync(path.join(codexHome, "skills", "ai-plugins-old-name", "SKILL.md"), "utf8");
  assert.ok(text.startsWith("---\r\nname: ai-plugins-old-name\r\ndescription: Demo.\r\n---\r\n"), JSON.stringify(text.slice(0, 80)));
  assert.ok(text.endsWith("\nBody\r\nname: second\r\n"), JSON.stringify(text.slice(-40)));
});

test("an empty name: takes the blanks after it up to the next text, as before, in linear time", (t) => {
  const started = performance.now();
  const codexHome = projectSkills(t, { demo: `---\nname:${" ".repeat(100_000)}\n---\nBody\n` }, "demo");
  const elapsed = performance.now() - started;
  const text = fs.readFileSync(path.join(codexHome, "skills", "ai-plugins-demo", "SKILL.md"), "utf8");
  // The blanks, the line end and the closing --- were the old match; the inserted section follows.
  assert.ok(text.startsWith("---\nname: ai-plugins-demo\n\n<!-- kherep-codex-projection -->\n"), JSON.stringify(text.slice(0, 80)));
  assert.ok(text.endsWith("\nBody\n") && text.length < 1_000, `${text.length} characters`);
  assert.ok(elapsed < 2000, `the projection took ${elapsed.toFixed(1)} ms`);
});
