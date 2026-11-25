// Issue #1010. Kherep's own changes to bundled plugin sources, declared in
// codex/parity/plugin-source-overlay.json and applied by the snapshot script
// after the copy. Every entry must still match: a path or text that upstream
// moved stops the snapshot instead of silently shipping without the change.
import fs from "node:fs";
import path from "node:path";

import { contained } from "./canonical-plugin-sources.mts";

export interface PluginOverlay {
  exclude?: string[];
  replace?: { file: string; find: string; with: string }[];
}

export type OverlayManifest = Record<string, PluginOverlay>;

export function readOverlay(repoRoot: string): OverlayManifest {
  const file = path.join(repoRoot, "codex", "parity", "plugin-source-overlay.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as OverlayManifest;
}

function existing(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  if (!contained(root, target) || !fs.existsSync(target)) {
    throw new Error(`Plugin overlay path does not exist in the source: ${relative}`);
  }
  return target;
}

export function applyOverlay(root: string, overlay: PluginOverlay): void {
  for (const relative of overlay.exclude ?? []) fs.rmSync(existing(root, relative), { recursive: true });
  for (const change of overlay.replace ?? []) {
    const target = existing(root, change.file);
    const parts = fs.readFileSync(target, "utf8").split(change.find);
    if (parts.length !== 2) {
      throw new Error(`Plugin overlay text must occur exactly once, found ${parts.length - 1}: ${change.file}`);
    }
    fs.writeFileSync(target, parts.join(change.with));
  }
}
