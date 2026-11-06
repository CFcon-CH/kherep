// The readers and environment helpers of the Windows test route (issue #832).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { parseTap } from "../codex/scripts/codex-run-tap.mts";
import {
  cpuBusyPct, failingNames, gitBashDir, insideRoot, npmCliPath, passingNames, sandboxMarkers, scrubEnv, selectedFiles,
  suitesFromPackage, tscNames, withPathFirst,
} from "./test-route-compare.mts";

const FIXTURE = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "test-route", "windows-locations.tap"), "utf8");
const script = (body: string) => JSON.stringify({ scripts: { "test:x": body } });
const same = (body: string) => suitesFromPackage(script(body), script(body), ["x"]);

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kt-fx-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("suitesFromPackage reads the real control-plane script", () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8");
  assert.deepEqual(suitesFromPackage(text, text, ["control-plane"]), [{
    name: "control-plane", flags: [], patterns: ["modules/control-plane/*.test.mts", "modules/control-plane/node/*.test.mts"],
  }]);
});

test("C1 suitesFromPackage refuses a script that differs from the base's, naming both", () => {
  const base = 'node --test "a/*.test.mts" "b/*.test.mts"', candidate = 'node --test "a/*.test.mts"';
  assert.throws(() => suitesFromPackage(script(base), script(candidate), ["x"]), (error: Error) => {
    assert.match(error.message, /suite x: definition differs/);
    assert.ok(error.message.includes(base) && error.message.includes(candidate), error.message);
    return true;
  });
  assert.throws(() => suitesFromPackage("{}", script(candidate), ["x"]), /definition differs/);
});

test("C2 suitesFromPackage takes only flags that select nothing", () => {
  for (const flag of ["--test-name-pattern=x", "--test-skip-pattern=x", "--test-only", "--test-shard=1/2", "--watch", "--test-concurrency=x"]) {
    assert.throws(() => same(`node --test ${flag} "a/*.test.mts"`), /not understood/, flag);
  }
  assert.deepEqual(same('node --test --test-concurrency=1 --test-timeout=5 --test-force-exit "a/*.test.mts"'), [
    { name: "x", flags: ["--test-concurrency=1", "--test-timeout=5", "--test-force-exit"], patterns: ["a/*.test.mts"] },
  ]);
});

test("suitesFromPackage refuses anything but node --test", () => {
  assert.throws(() => same("vitest run"), /not understood/);
  assert.throws(() => same('node --test "../a/*.test.mts"'), /not understood/);
  assert.throws(() => same("node --test"), /not understood/);
  assert.throws(() => suitesFromPackage(script("x"), script("x"), ["nope"]), /test:nope/);
});

test("C3 selectedFiles counts test files of the pattern's own directory", (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "a", "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir, "a", "x.test.mts"), "");
  fs.writeFileSync(path.join(dir, "a", "y.mts"), "");
  fs.writeFileSync(path.join(dir, "a", "sub", "z.test.mts"), "");
  assert.deepEqual(selectedFiles(dir, "a/*.test.mts"), ["x.test.mts"]);
  assert.deepEqual(selectedFiles(dir, "b/*.test.mts"), []);
});

test("C4 tscNames reads file errors and configuration errors", () => {
  const text = "a.mts(1,2): error TS2322: x\r\n  more\r\nb.mts(3,4): error TS1005: y\nerror TS5083: Cannot read file 'tsconfig.json'.\n";
  assert.deepEqual(tscNames(text), ["a.mts TS2322 x", "b.mts TS1005 y", "TS5083 Cannot read file 'tsconfig.json'."]);
  assert.deepEqual(tscNames(""), []);
});

test("C5 scrubEnv drops what would steer a child, in any spelling, on a copy", () => {
  const env = { GIT_DIR: "x", git_work_tree: "x", npm_config_prefix: "y", NPM_EXECPATH: "n", npm_execpath: "n", NODE_TEST_CONTEXT: "z", PATH: "p" };
  assert.deepEqual(scrubEnv(env), { PATH: "p" });
  assert.equal(env.GIT_DIR, "x");
});

test("C5b scrubEnv drops NODE_OPTIONS, in any spelling", () => {
  assert.deepEqual(scrubEnv({ NODE_OPTIONS: "--test-name-pattern=keep", node_options: "--test-only", NODE_PATH: "p" }), { NODE_PATH: "p" });
});

test("C6 insideRoot compares real paths, also of a path that does not exist yet", () => {
  const link = path.resolve("j"), real = path.resolve("real", "cand"), other = path.resolve("other");
  const realpath = (file: string) => {
    if (file === path.join(link, "x")) throw Object.assign(new Error("absent"), { code: "ENOENT" });
    return file === link ? real : file;
  };
  assert.equal(insideRoot(path.join(link, "x"), real, realpath), true);
  assert.equal(insideRoot(link, real, realpath), true);
  assert.equal(insideRoot(real, link, realpath), true);
  assert.equal(insideRoot(other, real, realpath), false);
  assert.equal(insideRoot(`${real}-other`, real, realpath), false);
  const denied = () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); };
  assert.throws(() => insideRoot(other, real, denied), /denied/);
});

test("C7 npmCliPath prefers the npm that started the route, then the layouts beside node", () => {
  const exec = path.join(path.sep, "n", "bin", "node");
  const windows = path.join(path.sep, "n", "bin", "node_modules/npm/bin/npm-cli.js");
  const posix = path.join(path.sep, "n", "lib/node_modules/npm/bin/npm-cli.js");
  const started = path.join(path.sep, "v", "npm-cli.js");
  assert.equal(npmCliPath(exec, started, () => true), started);
  assert.equal(npmCliPath(exec, started, (file) => file === windows), windows);
  assert.equal(npmCliPath(exec, path.join(path.sep, "v", "pnpm.cjs"), (file) => file === posix), posix);
  assert.equal(npmCliPath(exec, undefined, (file) => file === posix), posix);
  assert.equal(npmCliPath(exec, undefined, () => false), null);
});

test("failingNames takes failed tests and suites that failed on their own, with relative files", () => {
  const parsed = parseTap(FIXTURE);
  assert.deepEqual(failingNames(parsed, "C:\\w"), [
    { name: "dup name", file: "t/a.test.mts" },
    { name: "fails # with hash", file: "t/a.test.mts" },
    { name: "dup name", file: "t/b.test.mts" },
    { name: "t\\c.test.mts", file: "t/c.test.mts" },
    { name: "broken suite", file: "t/d.test.mts" },
    { name: "inner fails", file: "t/d.test.mts" },
  ]);
  assert.deepEqual(passingNames(parsed), ["passes", "inner passes"]);
});

test("failingNames keeps a name whose YAML block has no location", () => {
  const tap = `not ok 1 - bare\n  ---\n  type: 'test'\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n`;
  assert.deepEqual(failingNames(parseTap(tap), "C:\\w"), [{ name: "bare", file: null }]);
});

test("gitBashDir walks the fixed list, withPathFirst keeps the PATH key", () => {
  const only = (file: string) => (candidate: string) => candidate === file;
  assert.equal(gitBashDir("C:\\L", only("C:/Program Files (x86)/Git/bin/bash.exe")), "C:/Program Files (x86)/Git/bin");
  assert.equal(gitBashDir("C:\\L", only("C:/L/Programs/Git/bin/bash.exe")), "C:/L/Programs/Git/bin");
  assert.equal(gitBashDir(undefined, () => false), null);
  assert.deepEqual(withPathFirst({ Path: "C:\\a" }, "C:/Program Files/Git/bin", "win32"), { Path: "C:/Program Files/Git/bin;C:\\a" });
  assert.deepEqual(withPathFirst({ PATH: "/a" }, "/g", "linux"), { PATH: "/g:/a" });
});

test("every Codex marker counts", () => {
  assert.deepEqual(sandboxMarkers({}), []);
  for (const marker of ["CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_THREAD_ID"]) {
    assert.deepEqual(sandboxMarkers({ [marker]: "1" }), [marker]);
  }
});

test("cpuBusyPct measures the interval", () => {
  const cpu = (busy: number, idle: number) => [{ times: { user: busy, nice: 0, sys: 0, irq: 0, idle } }];
  assert.equal(cpuBusyPct(cpu(0, 0), cpu(25, 75)), 25);
  assert.equal(cpuBusyPct(cpu(5, 5), cpu(5, 5)), 0);
});
