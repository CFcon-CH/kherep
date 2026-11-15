// Issue #533. The adapter entry imports modules from its own directory, so a test that
// runs a copy of it copies the whole set. Self-maintaining: the set is read from the imports.
import fs from "node:fs";
import path from "node:path";

import { relativeSpecifiers } from "../../claude/hooks/lib/hook-inventory.mts";

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

// The entry under entryName and every module under its own name.
export function copyAdapter(dir: string, entryName = "hook-adapter.mts"): void {
  fs.copyFileSync(path.join(HERE, "hook-adapter.mts"), path.join(dir, entryName));
  for (const name of ADAPTER_MODULES) fs.copyFileSync(path.join(HERE, name), path.join(dir, name));
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync(path.resolve(HERE, "../../claude/hooks/lib/tool-event-shape.mts"), path.join(dir, "lib/tool-event-shape.mts"));
  fs.copyFileSync(path.resolve(HERE, "../../claude/hooks/lib/stdin-reader.mts"), path.join(dir, "stdin-reader.mts"));
}
