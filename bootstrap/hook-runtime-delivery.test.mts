// Issue #507, part 2 (D3, R8, R9). The hook runtime is delivered with every
// file it needs, its recovery writer is a byte-identical copy of the one
// restore-write implementation, its entry has no static project import, and
// the settings template runs every managed hook through it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repo = path.resolve(import.meta.dirname, "..");
const runtime = path.join(repo, "claude", "kherep", "hook-runtime");
const manifest = new Set(fs.readFileSync(path.join(repo, "bootstrap", "manifest", "files.txt"), "utf8").split(/\r?\n/).filter(Boolean));
const capabilities = JSON.parse(fs.readFileSync(path.join(repo, "bootstrap", "manifest", "capabilities.json"), "utf8")) as { runtimeFiles: string[] };

function files(dir: string, rel = ""): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(path.join(dir, entry.name), `${rel}${entry.name}/`) : [`${rel}${entry.name}`]);
}

test("every runtime file is installed and required live", () => {
  const all = files(runtime).map((rel) => `kherep/hook-runtime/${rel}`);
  assert.ok(all.length >= 6, JSON.stringify(all));
  for (const rel of all) {
    assert.ok(manifest.has(rel), `files.txt lists ${rel}`);
    assert.ok(capabilities.runtimeFiles.includes(rel), `capabilities.json runtimeFiles lists ${rel}`);
  }
});

test("the recovery writer is the one restore-write implementation, byte for byte", () => {
  for (const name of ["restore-write.mts", "workspace-scope.mts"]) {
    assert.deepEqual(fs.readFileSync(path.join(runtime, "recovery", name)), fs.readFileSync(path.join(repo, "claude", "hooks", "lib", name)),
      `claude/kherep/hook-runtime/recovery/${name} equals claude/hooks/lib/${name}`);
  }
});

test("the entry imports node:* only, the coordinator never reaches into hooks/", () => {
  const imports = (file: string) => [...fs.readFileSync(path.join(runtime, file), "utf8").matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  for (const specifier of imports("entry.mts")) assert.match(specifier!, /^node:/, `entry.mts imports ${specifier}`);
  for (const file of ["coordinator.mts", "coordinator-db.mts", "coordinator-intent.mts", "replay-pending.mts"]) {
    for (const specifier of imports(file)) assert.match(specifier!, /^(node:|\.\/[\w-]+\.mts$)/, `${file} imports ${specifier}`);
  }
});

test("the template runs every managed hook through the entry, with its mode, timeouts unchanged", () => {
  const settings = JSON.parse(fs.readFileSync(path.join(repo, "claude", "settings.user.json"), "utf8"));
  const entry = 'node "__KHEREP_CLAUDE_HOME__/kherep/hook-runtime/entry.mts" ';
  let managed = 0;
  for (const [event, groups] of Object.entries(settings.hooks as Record<string, { hooks: { command: string; timeout?: number }[] }[]>)) {
    for (const hook of groups.flatMap((group) => group.hooks)) {
      if (!hook.command.includes("__KHEREP_CLAUDE_HOME__/hooks/")) continue;
      managed++;
      assert.ok(hook.command.startsWith(entry), hook.command);
      const [mode, main] = hook.command.slice(entry.length).split(" ");
      const expected = main!.endsWith('/guard-dispatch.mts"') ? "pretool" : main!.endsWith('/live-hook-integrity.mts"') ? "writer" : "reader";
      assert.equal(mode, expected, hook.command);
      if (mode === "pretool") assert.equal(event, "PreToolUse");
      if (event === "PreToolUse") assert.equal(hook.timeout, 30);
    }
  }
  assert.equal(managed, 27);
});
