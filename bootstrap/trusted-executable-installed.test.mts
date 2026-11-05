import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { declareCopy } from "./coverage-copy-fixture.mts";
import { relativeSpecifiers } from "../claude/hooks/lib/hook-inventory.mts";

const source = path.resolve(import.meta.dirname, "../claude/hooks");
const manifest = fs.readFileSync(path.join(import.meta.dirname, "manifest/files.txt"), "utf8").split("\n");

// Copy the same relative import closure that integrity/guard-recheck inventories.
function copyHook(name: string, into: string, seen = new Set<string>()): Set<string> {
  if (seen.has(name)) return seen;
  seen.add(name);
  assert.ok(manifest.includes(`hooks/${name}`), `Claude installation lacks ${name}`);
  const original = path.join(source, name), copy = path.join(into, name);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(original, copy);
  declareCopy(original, copy);
  for (const specifier of relativeSpecifiers(fs.readFileSync(original, "utf8"))) {
    if (!specifier.startsWith(".")) continue;
    copyHook(path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier)), into, seen);
  }
  return seen;
}

for (const layout of ["hooks", "hooks/kherep-maestro"]) {
  test(`copied hooks load the shared resolver in ${layout} and preserve missing-tool behavior`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "trusted-install-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const hookDir = path.join(root, ...layout.split("/"));
    const names = ["main-checkout-guard.mts", "manifest-watch.mts",
      ...(layout === "hooks" ? ["runtime-capability-snapshot.mts"] : [])];
    for (const name of names) {
      const closure = copyHook(name, hookDir);
      assert.ok(closure.has("lib/trusted-executable.mts"));
      const run = spawnSync(process.execPath, [path.join(hookDir, name)], {
        input: JSON.stringify({ cwd: root, tool_name: name === "manifest-watch.mts" ? "Edit" : "Bash",
          tool_input: { command: "git switch feature", file_path: path.join(root, "manifest.yml") } }),
        encoding: "utf8", cwd: root, timeout: 10_000,
        env: { ...process.env, PATH: ".", HOME: root, USERPROFILE: root, CLAUDE_HOME: root, KHEREP_WORKSPACE: root },
      });
      assert.equal(run.status, 0, run.stderr);
      assert.doesNotMatch(run.stderr, /ERR_MODULE_NOT_FOUND/);
      if (name === "runtime-capability-snapshot.mts") {
        assert.match(JSON.parse(run.stdout).hookSpecificOutput.additionalContext, /branch=UNKNOWN; HEAD=UNKNOWN/);
      } else assert.equal(run.stdout, "");
    }
  });
}
