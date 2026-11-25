import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { loadCanonicalPluginSources } from "../lib/canonical-plugin-sources.mts";
import { componentHash } from "../lib/component-hash.mts";
import type { Capabilities } from "../lib/contracts.mts";
import type { OverlayManifest } from "../lib/plugin-source-overlay.mts";
import { normalizeTextTree, snapshot } from "./snapshot-plugin-sources.mts";

test("normalizes UTF-8 text to LF without changing binary files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-snapshot-normalize-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  fs.writeFileSync(path.join(root, "text.md"), "one\r\ntwo\r\n");
  fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 13, 10, 255]));
  normalizeTextTree(root);
  assert.equal(fs.readFileSync(path.join(root, "text.md"), "utf8"), "one\ntwo\n");
  assert.deepEqual(fs.readFileSync(path.join(root, "binary.bin")), Buffer.from([0, 13, 10, 255]));
});

test("failed snapshot generation leaves no final or staging directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-snapshot-atomic-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const destination = path.join(root, "plugin-sources");
  assert.throws(() => snapshot({}, destination), /Installed Claude plugin source missing/);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("rejects a malformed installed plugin path without leaving state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-snapshot-invalid-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const destination = path.join(root, "plugin-sources");
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const capabilities = JSON.parse(fs.readFileSync(path.join(repoRoot, "codex", "parity", "capabilities.json"), "utf8")) as Capabilities;
  const first = capabilities.plugins.find((entry) => ["agent", "project"].includes(entry.mode));
  assert.ok(first, "the manifest declares at least one projected plugin");
  assert.throws(() => snapshot({ [first.id]: [{ installPath: "", version: "fixture" }] }, destination),
    /Installed Claude plugin path is invalid/);
  assert.deepEqual(fs.readdirSync(root), []);
});

// Issue #1010. Selection and overlay on a synthetic plugin: never the host registry.
function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function tree(root: string): string[] {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort((left, right) => Number(left > right) - Number(left < right));
}

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-snapshot-fixture-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const plugin = path.join(root, "installed");
  for (const [file, content] of Object.entries({
    "LICENSE": "licence\r\n", "LICENSE-MIT": "mit\n", "NOTICE": "notice\n", "COPYING.txt": "copying\n",
    "LICENSING.md": "not a licence text\n", "package.json": "{}\n",
    "agents/helper.md": "agent\n", "agents/profile.json": "{}\n", "agents/build.mjs": "0;\n", "agents/nested/deep.md": "deep\n",
    "commands/run.md": "run\n", "commands/go.toml": "go\n", "commands/tool.mjs": "0;\n", "commands/nested/deep.md": "deep\n",
    "skills/README.md": "loose\n", "skills/one/SKILL.md": "first\r\nsecond\r\nthird\r\n", "skills/one/scripts/tool.py": "pass\n",
    "skills/one/references/copy.md": "copy\n", "skills/two/notes.md": "no skill file\n", "skills/v1/inner/SKILL.md": "nested\n",
  })) write(path.join(plugin, file), content);
  const destination = path.join(root, "plugin-sources");
  const run = (overlay: OverlayManifest = {}) => snapshot(
    { "demo@market": [{ installPath: plugin, version: "1.2.3" }], "other@market": [{ installPath: plugin, version: "9" }] },
    destination,
    { capabilities: { plugins: [{ id: "demo@market", mode: "project" }, { id: "other@market", mode: "native" }] }, overlay },
  );
  const load = () => loadCanonicalPluginSources({
    capabilities: { plugins: [{ id: "demo@market", mode: "project" }] } as Capabilities,
    pluginSourceRoot: destination, repoRoot: root,
  });
  return { root, plugin, destination, bundled: path.join(destination, "demo_market"), run, load };
}

test("bundles only what the projection reads, with every licence file", (t) => {
  const ctx = fixture(t);
  const entries = ctx.run();
  assert.deepEqual(entries.map(({ id, version, path: name }) => [id, version, name]), [["demo@market", "1.2.3", "demo_market"]]);
  assert.deepEqual(tree(ctx.bundled), [
    ".canonical-source", "COPYING.txt", "LICENSE", "LICENSE-MIT", "NOTICE",
    "agents/helper.md", "commands/go.toml", "commands/run.md",
    "skills/one/SKILL.md", "skills/one/references/copy.md", "skills/one/scripts/tool.py",
  ]);
  assert.equal(fs.readFileSync(path.join(ctx.bundled, "LICENSE"), "utf8"), "licence\n");
  assert.equal(ctx.load().get("demo@market")?.contentSha256, entries[0].contentSha256);
});

test("the loader refuses a bundled file outside the selection, even with a matching hash", (t) => {
  const ctx = fixture(t);
  const [entry] = ctx.run();
  write(path.join(ctx.bundled, "skills", "loose.mjs"), "0;\n");
  write(path.join(ctx.destination, "manifest.json"),
    JSON.stringify({ plugins: [{ ...entry, contentSha256: componentHash(ctx.bundled) }] }));
  assert.throws(() => ctx.load(), /outside the snapshot selection: demo@market\/skills\/loose\.mjs/);
});

test("the overlay removes files and replaces text before the content hash is taken", (t) => {
  const ctx = fixture(t);
  const [entry] = ctx.run({ "demo@market": {
    exclude: ["skills/one/references"],
    replace: [{ file: "skills/one/SKILL.md", find: "second\n", with: "" }, { file: "agents/helper.md", find: "agent", with: "$& kept" }],
  } });
  assert.equal(fs.existsSync(path.join(ctx.bundled, "skills", "one", "references")), false);
  assert.equal(fs.readFileSync(path.join(ctx.bundled, "skills", "one", "SKILL.md"), "utf8"), "first\nthird\n");
  assert.equal(fs.readFileSync(path.join(ctx.bundled, "agents", "helper.md"), "utf8"), "$& kept\n");
  assert.equal(entry.contentSha256, componentHash(ctx.bundled));
});

test("an overlay entry that no longer matches stops the snapshot and leaves nothing behind", (t) => {
  const replace = (file: string, find: string): OverlayManifest => ({ "demo@market": { replace: [{ file, find, with: "x" }] } });
  const cases: [OverlayManifest, RegExp][] = [
    [{ "demo@market": { exclude: ["skills/gone"] } }, /does not exist in the source: skills\/gone/],
    [{ "demo@market": { exclude: ["../../installed"] } }, /does not exist in the source: \.\.\/\.\.\/installed/],
    [replace("skills/gone/SKILL.md", "first"), /does not exist in the source: skills\/gone\/SKILL\.md/],
    [replace("skills/one/SKILL.md", "absent"), /exactly once, found 0: skills\/one\/SKILL\.md/],
    [replace("skills/one/SKILL.md", "ir"), /exactly once, found 2: skills\/one\/SKILL\.md/],
    [{ "absent@market": {} }, /not bundled: absent@market/],
  ];
  for (const [overlay, message] of cases) {
    const ctx = fixture(t);
    assert.throws(() => ctx.run(overlay), message);
    assert.deepEqual(fs.readdirSync(ctx.root), ["installed"]);
  }
});

test("a linked component directory is refused", (t) => {
  const ctx = fixture(t);
  fs.rmSync(path.join(ctx.plugin, "agents"), { recursive: true });
  fs.symlinkSync(path.join(ctx.plugin, "commands"), path.join(ctx.plugin, "agents"), "junction");
  assert.throws(() => ctx.run(), /component link is not allowed/);
});
