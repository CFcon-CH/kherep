import fs from "node:fs";
import path from "node:path";

import { componentHash } from "./component-hash.mts";
import type { Capabilities, CanonicalEntry, CanonicalSource } from "./contracts.mts";

export interface CanonicalSourceContext {
  capabilities: Capabilities;
  pluginSourceRoot?: string;
  repoRoot: string;
}

export function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function validateDirectory(canonicalRoot: string, entry: CanonicalEntry): CanonicalSource {
  const sourcePath = String(entry.path || "");
  const root = path.resolve(canonicalRoot, sourcePath);
  if (!sourcePath || path.isAbsolute(sourcePath) || !contained(canonicalRoot, root)) {
    throw new Error(`Invalid canonical plugin source path: ${entry.id}`);
  }
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Canonical plugin source directory missing or linked: ${entry.id}`);
  }
  const canonicalReal = fs.realpathSync(canonicalRoot);
  if (!contained(canonicalReal, fs.realpathSync(root))) {
    throw new Error(`Canonical plugin source escapes snapshot root: ${entry.id}`);
  }
  for (const name of ["agents", "commands", "skills"]) {
    const stat = fs.lstatSync(path.join(root, name), { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`Canonical plugin component link is not allowed: ${entry.id}/${name}`);
  }
  const actualHash = componentHash(root);
  if (actualHash !== entry.contentSha256) {
    throw new Error(`Canonical plugin source hash mismatch: ${entry.id}`);
  }
  return { ...entry, root, contentSha256: actualHash };
}

export function loadCanonicalPluginSources(context: CanonicalSourceContext): Map<string, CanonicalSource> {
  const canonicalRoot = context.pluginSourceRoot
    || path.join(context.repoRoot, "codex", "parity", "plugin-sources");
  const manifestFile = path.join(canonicalRoot, "manifest.json");
  if (!fs.statSync(manifestFile, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Canonical plugin source manifest missing: ${manifestFile}`);
  }
  // The snapshot manifest is versioned beside the sources it describes; each
  // entry is verified against the directory hash below, never trusted as is.
  const parsed = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { plugins?: unknown };
  if (!Array.isArray(parsed.plugins)) throw new Error("Canonical plugin source manifest is invalid");
  const plugins = parsed.plugins as CanonicalEntry[];
  const expected = context.capabilities.plugins
    .filter((entry) => ["agent", "project"].includes(entry.mode))
    .map((entry) => entry.id).sort((left, right) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    });
  const actual = plugins.map((entry) => entry.id).sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Canonical plugin source manifest does not match required projection plugins");
  }
  return new Map(plugins.map((entry) => [entry.id, validateDirectory(canonicalRoot, entry)]));
}
