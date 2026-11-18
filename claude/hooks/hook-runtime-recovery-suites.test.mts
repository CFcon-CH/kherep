// Issue #965. kherep/hook-runtime/recovery/ ships restore-write.mts and workspace-scope.mts byte for byte
// equal to claude/hooks/lib/ (bootstrap/hook-runtime-delivery.test.mts pins that), so the runtime's copies
// are the same behaviour. Their lib suites run here once more, each in its own Node process whose module
// resolution maps the two lib files to the runtime's files: the same assertions then judge the code the
// runtime loads, and its coverage credits the runtime files. Nothing is copied or altered.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const LIB = path.join(import.meta.dirname, "lib");
const RECOVERY = path.resolve(import.meta.dirname, "..", "kherep", "hook-runtime", "recovery");
const MODULES = ["restore-write.mts", "workspace-scope.mts"];
const SUITES = ["restore-write.test.mts", "restore-write-publish.test.mts", "restore-write-acl.test.mts", "workspace-scope.test.mts"];
const MARK = "recovery-suites redirected";

// lib URL -> recovery URL (drive letters compared case-insensitively on Windows); the number of distinct
// lib files redirected is reported at exit on stderr, so a suite that loaded none fails below.
const key = (url: string): string => (process.platform === "win32" ? url.toLowerCase() : url);
const map = Object.fromEntries(MODULES.map((name) => [key(pathToFileURL(path.join(LIB, name)).href), pathToFileURL(path.join(RECOVERY, name)).href]));
const program = `import { registerHooks } from "node:module"; const map = ${JSON.stringify(map)}; const seen = new Set();
const key = (url) => (process.platform === "win32" ? url.toLowerCase() : url);
registerHooks({ resolve(specifier, context, next) { const r = next(specifier, context); const to = map[key(r.url)];
  if (!to) return r; seen.add(r.url); return { ...r, url: to }; } });
process.on("exit", () => process.stderr.write(${JSON.stringify(MARK)} + " " + seen.size + "\\n"));`;
const REDIRECT = `--import=data:text/javascript,${encodeURIComponent(program)}`;

test("the runtime's recovery files equal the lib files the suites test", () => {
  for (const name of MODULES) assert.deepEqual(fs.readFileSync(path.join(RECOVERY, name)), fs.readFileSync(path.join(LIB, name)), name);
});

for (const suite of SUITES) {
  test(`lib/${suite} passes against the runtime's recovery files`, () => {
    const run = spawnSync(process.execPath, [REDIRECT, path.join(LIB, suite)], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^(?:ℹ|#) fail 0$/m, run.stdout);
    const redirected = Number(new RegExp(`^${MARK} (\\d+)$`, "m").exec(run.stderr)?.[1] ?? 0);
    assert.ok(redirected >= 1, `no lib module was redirected:\n${run.stderr}`);
  });
}
