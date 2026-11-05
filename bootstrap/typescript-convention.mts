import fs from "node:fs";
import path from "node:path";

import { verifyCompiledOutput, type CompilerLimits } from "./typescript-output-proof.mts";

const SKIPPED_DIRS = new Set([".git", ".worktrees", "node_modules", "_deprecated"]);
const RUNTIME_FIXTURE_DIR = /^\.hook-adapter-/;
// .claude/worktrees is the second worktree root, the one the agent runtime
// creates. It holds full repository copies exactly like .worktrees does, and it
// is excluded in .gitignore for the same reason. It was missing here, so a merge
// made from such a worktree broke this test on main over files that are not part
// of the repository at all. A path exclusion, not a directory name: only this
// location is a worktree root, a directory called "worktrees" elsewhere is not.
const SKIPPED_PATHS = new Set(["codex/parity/plugin-sources", ".claude/worktrees"]);
const JAVASCRIPT = /\.(?:js|mjs|cjs)$/;
// Packages whose dist/ tree is compiler output and is proven against a fresh
// emission instead of being listed as legacy JavaScript. None is left since the
// Central Brain package moved to _deprecated/; a new one is named here.
export const COMPILED_MODULES: readonly (readonly string[])[] = [];

export interface TypeScriptConventionState {
  inventory: string[];
  onDisk: string[];
  unlisted: string[];
  stale: string[];
}

function javascriptFiles(dir: string, rel: string, generated: Set<string>, found: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name) || SKIPPED_PATHS.has(childRel) || RUNTIME_FIXTURE_DIR.test(entry.name)) continue;
      javascriptFiles(path.join(dir, entry.name), childRel, generated, found);
    } else if (entry.isFile() && JAVASCRIPT.test(entry.name) && !generated.has(childRel)) {
      found.push(childRel);
    }
  }
}

export function loadTypeScriptConvention(
  repo: string, limits: CompilerLimits = {}, compiledModules: readonly (readonly string[])[] = COMPILED_MODULES,
): TypeScriptConventionState {
  // Output validation deliberately precedes the inventory read: inventory edits
  // cannot turn altered or unexpected compiler output into legacy source.
  const generated = new Set(compiledModules.flatMap((modulePath) => [...verifyCompiledOutput(repo, modulePath, limits)]));
  const inventoryFile = path.join(repo, "bootstrap", "manifest", "legacy-javascript.txt");
  const inventory = fs.readFileSync(inventoryFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const onDisk: string[] = [];
  javascriptFiles(repo, "", generated, onDisk);
  const listed = new Set(inventory);
  const present = new Set(onDisk);
  return {
    inventory,
    onDisk,
    unlisted: onDisk.filter((file) => !listed.has(file)).sort((left, right) => Number(left > right) - Number(left < right)),
    stale: inventory.filter((file) => !present.has(file)).sort(),
  };
}
