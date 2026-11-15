import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { relativeSpecifiers } from "../claude/hooks/lib/hook-inventory.mts";

const SOURCE = path.resolve(import.meta.dirname, "..");
const CANONICAL = "claude/hooks/lib/stdin-reader.mts";
const PRIVATE_PAYLOAD = "SYNTHETIC_PRIVATE_PAYLOAD";
const TYPE_WARNING = /^\(node:\d+\) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n/gm;

function copyClosure(target: string, relative: string, seen = new Set<string>()): void {
  if (seen.has(relative)) return;
  seen.add(relative);
  const source = path.resolve(SOURCE, relative);
  assert.ok(source.startsWith(`${SOURCE}${path.sep}`), "fixture imports stay inside the public source tree");
  const file = path.join(target, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(source, file);
  for (const specifier of relativeSpecifiers(fs.readFileSync(source, "utf8"))) {
    if (specifier.startsWith(".") && specifier.endsWith(".mts")) {
      copyClosure(target, path.relative(SOURCE, path.resolve(path.dirname(source), specifier)), seen);
    }
  }
}

const ROUTES = [
  { name: "deliver", entry: "modules/control-plane/node/deliver-hook.mts", helper: "modules/control-plane/node/stdin-reader.mts",
    prefix: "kherep deliver-hook: cannot read stdin: ", args: [] },
  { name: "attribution", entry: "modules/control-plane/node/attribution-hook.mts", helper: "modules/control-plane/node/stdin-reader.mts",
    prefix: "kherep attribution-hook: ", args: [] },
  { name: "pre-push recorder", entry: "claude/kherep/githooks/attribution-record.mts", helper: CANONICAL,
    prefix: "kherep pre-push: attribution not recorded: ", args: ["push", "https://example.invalid/repo.git", "/synthetic/repo"] },
] as const;

function run(t: TestContext, route: typeof ROUTES[number], fault: "missing" | "corrupt") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "SYNTHETIC_PRIVATE_ROOT-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  copyClosure(root, route.entry);
  const helper = path.join(root, route.helper);
  // Installed siblings contain canonical bytes, rather than a source reexport shim.
  fs.copyFileSync(path.join(SOURCE, CANONICAL), helper);
  if (fault === "missing") fs.rmSync(helper);
  else fs.writeFileSync(helper, 'export * from "./SYNTHETIC_PRIVATE_MODULE_MARKER.mts";\n');
  const child = spawnSync(process.execPath, [path.join(root, route.entry), ...route.args], {
    cwd: root, input: PRIVATE_PAYLOAD, encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT,
      CLAUDE_HOME: path.join(root, "claude-home"), CODEX_HOME: path.join(root, "codex-home"),
      KHEREP_CONFIG_DIR: path.join(root, "config"), KHEREP_WORKSPACE: path.join(root, "workspace"),
      KHEREP_PROFILE: process.platform === "win32" ? "win" : "mac" },
  });
  return { child, stderr: child.stderr.replace(TYPE_WARNING, "") };
}

for (const route of ROUTES) for (const fault of ["missing", "corrupt"] as const) {
  test(`${route.name}: ${fault} stdin helper retains path-free stderr and exit behavior`, t => {
    const { child, stderr } = run(t, route, fault);
    assert.deepEqual([child.status, child.stdout], [0, ""]);
    assert.doesNotMatch(stderr, /SYNTHETIC_PRIVATE|stdin-reader\.mts|file:\/\//);
    assert.equal(stderr, `${route.prefix}stdin reader unavailable\n`);
  });
}
