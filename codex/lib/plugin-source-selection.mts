// Issue #1010. The plugin files Kherep bundles are exactly the ones the Codex
// projection reads (parity-projection.mts): agent and command files directly in
// their directory, and whole skill directories that hold a SKILL.md. Everything
// else in a plugin (build tooling, loose files, nested collections) stays out.
import fs from "node:fs";
import path from "node:path";

export const COMPONENTS = ["agents", "commands", "skills"] as const;

export interface ComponentSelection {
  selected: string[];
  dropped: string[];
}

function isSelected(component: typeof COMPONENTS[number], directory: string, entry: fs.Dirent): boolean {
  if (component === "skills") {
    return entry.isDirectory()
      && fs.statSync(path.join(directory, entry.name, "SKILL.md"), { throwIfNoEntry: false })?.isFile() === true;
  }
  return entry.isFile() && (entry.name.endsWith(".md") || (component === "commands" && entry.name.endsWith(".toml")));
}

// Both lists hold paths relative to the plugin root, with forward slashes.
export function selectComponents(root: string): ComponentSelection {
  const selection: ComponentSelection = { selected: [], dropped: [] };
  for (const component of COMPONENTS) {
    const directory = path.join(root, component);
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`Plugin component link is not allowed: ${directory}`);
    if (!stat?.isDirectory()) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const list = isSelected(component, directory, entry) ? selection.selected : selection.dropped;
      list.push(`${component}/${entry.name}`);
    }
  }
  return selection;
}
