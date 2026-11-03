// Issue #757. The usage-band mod may import only files of its own plugin, so it carries a
// copy of the weekly usage rules. The copy must equal claude/hooks/lib/usage-window.mts byte
// for byte, or the band and the hooks would judge the same state differently. The mod's
// install wiring is pinned here too: every file of the mod is in files.txt, and the user
// settings template names the mod folder in CLAUDE_CODE_PLUGIN_DIRS.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repo = path.resolve(import.meta.dirname, "..");
const SOURCE = "claude/hooks/lib/usage-window.mts";
const COPY = "claude/mods/usage-band/hooks/lib/usage-window.mts";
const MOD = path.join(repo, "claude", "mods", "usage-band");

function files(dir: string, rel = ""): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === "types" && rel === ".claude-plugin/" ? [] : files(path.join(dir, entry.name), `${rel}${entry.name}/`);
    return [`${rel}${entry.name}`];
  });
}

test("the mod's usage-window.mts is a byte-equal copy of the hooks' one", () => {
  assert.ok(fs.readFileSync(path.join(repo, COPY)).equals(fs.readFileSync(path.join(repo, SOURCE))),
    `${COPY} differs from ${SOURCE}; copy it again: cp ${SOURCE} ${COPY}`);
});

test("every file of the mod is installed by files.txt", () => {
  const manifest = new Set(fs.readFileSync(path.join(repo, "bootstrap", "manifest", "files.txt"), "utf8")
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = files(MOD).map((rel) => `mods/usage-band/${rel}`).filter((rel) => !manifest.has(rel));
  assert.deepEqual(missing, []);
});

test("the user settings template loads the mod folder from the Claude home", () => {
  const template = JSON.parse(fs.readFileSync(path.join(repo, "claude", "settings.user.json"), "utf8")) as { env?: Record<string, string> };
  assert.equal(template.env?.CLAUDE_CODE_PLUGIN_DIRS, "__KHEREP_CLAUDE_HOME__/mods/usage-band");
});
