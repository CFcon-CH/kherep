// Issue #533. The adapter entry imports modules from its own directory, so a test that
// runs a copy of it copies the whole set. Self-maintaining: the set is read from the imports.
import fs from "node:fs";
import path from "node:path";

import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";
import { relativeSpecifiers } from "../../claude/hooks/lib/hook-inventory.mts";
import { sourceOf } from "./hook-integrity-sources.mts";

const HERE = import.meta.dirname;

// The transitive same-directory ./hook-adapter-*.mts imports of a file, in first-seen order.
function closure(file: string, seen: string[] = []): string[] {
  for (const specifier of relativeSpecifiers(fs.readFileSync(path.join(HERE, file), "utf8"))) {
    const name = /^\.\/(hook-adapter-[a-z-]+\.mts)$/.exec(specifier)?.[1];
    if (name && !seen.includes(name)) { seen.push(name); closure(name, seen); }
  }
  return seen;
}

export const ADAPTER_MODULES: string[] = closure("hook-adapter.mts");

// Issue #965. A byte-for-byte copy of a codex/hooks source, declared for coverage
// (bootstrap/coverage-copy-fixture.mts). Only for a copy the test never edits afterwards.
export function copySource(name: string, copy: string): void {
  fs.copyFileSync(path.join(HERE, name), copy);
  declareCopy(path.join(HERE, name), copy);
}

// Issue #965. After codex/install.mts into <home>: declares every file of <home>/hooks and
// <home>/hooks/kherep-maestro whose versioned source is in codex/hooks and whose bytes equal it
// (a rendered file differs and stays undeclared). edited: names the test changes afterwards.
export function declareInstalled(home: string, edited: string[] = []): void {
  const hooks = path.join(home, "hooks");
  for (const rel of [...fs.readdirSync(hooks), ...fs.readdirSync(path.join(hooks, "kherep-maestro")).map((name) => `kherep-maestro/${name}`)]) {
    const source = sourceOf(rel), copy = path.join(hooks, rel);
    if (!("from" in source) || !source.from.startsWith("codex/hooks/") || edited.includes(path.basename(rel)) || !fs.statSync(copy).isFile()) continue;
    const original = path.join(HERE, path.basename(source.from));
    if (fs.readFileSync(copy).equals(fs.readFileSync(original))) declareCopy(original, copy);
  }
}

// The entry under entryName and every module under its own name. declare: false for a test
// that edits one of these copies afterwards (issue #965).
export function copyAdapter(dir: string, entryName = "hook-adapter.mts", declare = true): void {
  const copy = declare ? copySource : (name: string, to: string): void => fs.copyFileSync(path.join(HERE, name), to);
  copy("hook-adapter.mts", path.join(dir, entryName));
  for (const name of ADAPTER_MODULES) copy(name, path.join(dir, name));
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  for (const lib of ["tool-event-shape.mts", "tool-event-contract.mts"]) fs.copyFileSync(path.resolve(HERE, "../../claude/hooks/lib", lib), path.join(dir, "lib", lib));
  fs.copyFileSync(path.resolve(HERE, "../../claude/hooks/lib/stdin-reader.mts"), path.join(dir, "stdin-reader.mts"));
}
