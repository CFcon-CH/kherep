import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

import { install, type InstallOptions } from "./install.mts";
import type { Capabilities } from "./lib/contracts.mts";
import { fixtureModels } from "./lib/model-policy.fixture.mts";
import { modelSelectionGit, ModelSelectionRefusal, type ModelSelectionGit, type SourceReader } from "./lib/model-selection-git.mts";

export const repoRoot = path.resolve(import.meta.dirname, "..");
export const catalog = () => ({ complete: true, models: structuredClone(fixtureModels) });
export const newerCatalog = () => ({ complete: true, models: [...structuredClone(fixtureModels), {
  ...structuredClone(fixtureModels[1]!), id: "gpt-7-sol", model: "gpt-7-sol",
}] });
export const files = {
  anchor: "orchestra/model-selection-anchor.json", receipt: "orchestra/model-selection-receipt.json",
  overlay: "orchestra/model-selection-overlay.json", user: "kherep/model-policy.user.json",
  snapshot: "hooks/parity/capabilities.json", parity: "orchestra/parity-receipt.json", lock: "orchestra/model-selection.lock",
};
export const refusal = (code: string) => (error: unknown) => error instanceof ModelSelectionRefusal && error.code === code;

export function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
}

// Synthetic revisions and file overlays on top of the real checkout. Every
// unnamed revision falls through to the real repository, so an unknown SHA
// still yields the adapter's own revision-absent refusal.
export function overlayReader(base: SourceReader, overrides: Record<string, string>): SourceReader {
  return { read: (relative) => Object.hasOwn(overrides, relative) ? overrides[relative]! : base.read(relative), list: (directory) => base.list(directory) };
}
export interface FakeGit {
  head?: string | (() => string); revisions?: Record<string, SourceReader>; workingTree?: SourceReader;
  assertClean?: () => void; at?: (revision: string) => void;
}
export function fakeGit(spec: FakeGit = {}): ModelSelectionGit {
  const real = modelSelectionGit(repoRoot);
  return {
    head: () => typeof spec.head === "function" ? spec.head() : spec.head ?? real.head(),
    assertClean: () => (spec.assertClean ?? (() => real.assertClean()))(),
    at: (revision) => { spec.at?.(revision); return spec.revisions?.[revision] ?? real.at(revision); },
    workingTree: () => spec.workingTree ?? real.workingTree(),
  };
}
export const policyWith = (role: string, effort: string): string => fs.readFileSync(path.join(repoRoot, "codex/parity/model-policy.toml"), "utf8")
  .replace(new RegExp(`(\\[roles\\.${role}\\]\\s+family = "[a-z]+"\\s+reasoning = )"[a-z]+"`), `$1"${effort}"`);

export function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "kherep-selection-install-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const codexHome = path.join(root, "codex home");
  const workspace = path.join(root, "workspace");
  const registryFile = path.join(root, "registry.json");
  const capabilities = JSON.parse(fs.readFileSync(path.join(repoRoot, "codex/parity/capabilities.json"), "utf8")) as Capabilities;
  write(registryFile, JSON.stringify({ mcpServers: Object.fromEntries(capabilities.mcpServers.map((name) => [name, {
    type: "http", url: `https://example.invalid/${name}`,
  }])) }));
  write(path.join(codexHome, "config.toml"), 'model_reasoning_effort = "xhigh"\n');
  const options: InstallOptions = {
    codexHome, workspace, registryFile, claudeRegistryFile: registryFile,
    claudeConfigDir: path.join(root, "claude home"), homeDir: root,
    memoryProvider: { provider: "unconfigured" }, nodePath: process.execPath,
    controlPlaneOutbox: path.join(root, "outbox"), installAtlassianTools: false,
    skipPluginRegistration: true, resolveRegistryRuntime: () => "synthetic-runtime", log: () => {},
    runCodex: () => { throw new Error("no runtime call in the synthetic fixture"); },
  };
  const file = (relative: string) => path.join(codexHome, ...relative.split("/"));
  const read = (relative: string) => fs.readFileSync(file(relative), "utf8");
  const run = (overrides: InstallOptions = {}) => install({ ...options, ...overrides });
  const field = (agent: string, key: string): string => {
    const line = read(`agents/${agent}.toml`).split("\n").find((row) => row.startsWith(`${key} = `))!;
    return JSON.parse(line.slice(key.length + 3)) as string;
  };
  return { root, codexHome, workspace, options, file, read, run, field };
}

// Every file under a root, by content hash; backups are part of the tree, so a
// refusal that created a backup directory shows up as a difference.
export function tree(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name), relative = path.relative(root, target);
      if (entry.isDirectory()) { entries[relative] = "directory"; walk(target); }
      else entries[relative] = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    }
  };
  if (fs.existsSync(root)) walk(root);
  return entries;
}

export function assertNoWrites(f: ReturnType<typeof fixture>, act: (afterWrite: () => void) => void, matcher: RegExp | ((error: unknown) => boolean)): void {
  const before = tree(f.root);
  let writes = 0;
  assert.throws(() => act(() => { writes++; }), matcher);
  assert.equal(writes, 0, "refused before any write");
  assert.deepEqual(tree(f.root), before, "no file, directory, backup or lock is left behind");
}
