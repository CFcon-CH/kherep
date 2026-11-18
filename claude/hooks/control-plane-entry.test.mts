import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { readPointer as readCodexPointer } from "../../codex/hooks/control-plane-hook.mts";
import { withoutTypeStrippingWarning } from "../../codex/lib/node-warning-fixture.mts";
import { readPointer } from "../kherep/control-plane/claude-control-plane-hook.mts";
import { copyDeclared } from "./copy-declare-fixture.mts";

// Issue #592. The stable Claude entry point runs the hook of the source its
// pointer names inside its own process, as that hook's main module, and fails
// closed without the pointer. It runs on every CI platform, Windows included:
// the Windows evidence the design asks for is this file in the unit-windows
// hooks shard, so nothing here skips on win32.

const ENTRY = path.resolve(import.meta.dirname, "..", "kherep", "control-plane", "claude-control-plane-hook.mts");
const STUB = (marker: string, record: string) => `import fs from "node:fs";
import { pathToFileURL } from "node:url";
fs.writeFileSync(${JSON.stringify(record)}, ${JSON.stringify(marker)});
const stdin = fs.readFileSync(0, "utf8");
const main = import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
process.stdout.write(JSON.stringify({ marker: ${JSON.stringify(marker)}, argv: process.argv.slice(1), main, stdin, ppid: process.ppid,
  execArgv: process.execArgv, cwd: fs.realpathSync(process.cwd()), config: process.env.KHEREP_CONFIG_DIR }));
process.stderr.write("stub stderr line\\n");
process.exitCode = Number(process.env.STUB_EXIT ?? 7);
`;
const FAIL_LINE = /^kherep control-plane-hook: [^\n]+; pointer [^\n]+; run bootstrap\/install\.sh\n$/;

function fixture(t: TestContext) {
  // A space in the home: the quoting Claude Code's shell form has to survive.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep cp-entry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "claude home");
  const entryDir = path.join(home, "kherep", "control-plane");
  fs.mkdirSync(entryDir, { recursive: true });
  const entry = path.join(entryDir, "claude-control-plane-hook.mts");
  copyDeclared(ENTRY, entry);
  const record = path.join(root, "record.txt");
  const source = (name: string, marker = name, hook = "deliver-hook.mts", body = STUB(marker, record)): string => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, "modules", "control-plane", "node"), { recursive: true });
    fs.writeFileSync(path.join(dir, "modules", "control-plane", "node", hook), body);
    return dir;
  };
  const pointerPath = path.join(entryDir, "source.json");
  const pointer = (value: unknown): void => fs.writeFileSync(pointerPath, typeof value === "string" ? value : JSON.stringify(value));
  const cwd = path.join(root, "cwd");
  fs.mkdirSync(cwd);
  const configDir = path.join(root, "kherep-config");
  // PATH holds only a decoy `node`: nothing the entry does may start another node.
  const decoyBin = path.join(root, "bin");
  fs.mkdirSync(decoyBin);
  fs.writeFileSync(path.join(decoyBin, "node"), `#!/bin/sh\necho decoy > ${JSON.stringify(record)}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(decoyBin, "node.cmd"), `@echo decoy> "${record}"\r\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^path$/i.test(key) && !key.startsWith("KHEREP_")));
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}, input = '{"hook_event_name":"Stop"}') => spawnSync(process.execPath, [entry, ...args], {
    input, encoding: "utf8", cwd, timeout: 20_000, env: { ...env, PATH: decoyBin, KHEREP_CONFIG_DIR: configDir, ...extra },
  });
  const ran = (): string | undefined => fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim() : undefined;
  return { root, home, entryDir, entry, pointerPath, source, pointer, run, ran, cwd, configDir, record, env };
}

type Out = { marker: string; argv: string[]; main: boolean; stdin: string; ppid: number; execArgv: string[]; cwd: string; config: string };

test("the entry point runs the pointer's hook in its own process: main module, argv, stdin, cwd, env, exit code, parent", (t) => {
  const f = fixture(t);
  const r1 = f.source("R1");
  const r2 = f.source("R2");
  f.pointer({ version: 1, root: r1, kind: "checkout", verified: true });

  const first = f.run(["deliver", "--runtime", "codex"]);

  assert.equal(first.status, 7, first.stderr);
  // A Node that warns about type stripping warns once per process, as a direct hook call does.
  assert.equal(withoutTypeStrippingWarning(first.stderr, 1), "stub stderr line\n");
  const out = JSON.parse(first.stdout) as Out;
  assert.equal(out.marker, "R1");
  assert.equal(out.argv[0], path.join(r1, "modules", "control-plane", "node", "deliver-hook.mts"));
  assert.equal(out.main, true, "the hook runs as its own main module");
  assert.deepEqual(out.argv.slice(1), ["--runtime", "codex"]);
  assert.deepEqual(out.execArgv, []);
  assert.equal(out.stdin, '{"hook_event_name":"Stop"}');
  assert.equal(out.cwd, fs.realpathSync(f.cwd));
  assert.equal(out.config, f.configDir);
  // No process between the caller and the hook: the hook's parent is this test process,
  // so its parent watch, ancestry walk and lock release are those of the path form.
  assert.equal(out.ppid, process.pid);

  f.pointer({ version: 1, root: r2, kind: "checkout", verified: true });
  const second = f.run(["deliver"]);
  assert.equal(second.status, 7, second.stderr);
  assert.equal((JSON.parse(second.stdout) as Out).marker, "R2");
});

test("wake and attribution are the other fixed names; a source pin needs its manifest", (t) => {
  const f = fixture(t);
  const pin = f.source("pin", "PIN", "wake-hook.mts");
  fs.writeFileSync(path.join(pin, "modules", "control-plane", "node", "attribution-hook.mts"), STUB("PIN-ATTRIBUTION", f.record));
  f.pointer({ version: 1, root: pin, commit: "0123456789abcdef0123456789abcdef01234567", kind: "pin", verified: true });
  const refused = f.run(["wake", "--timeout", "86400"]);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  assert.match(withoutTypeStrippingWarning(refused.stderr, 1), /^kherep control-plane-hook: the pointer's source pin has no manifest; pointer .+; run bootstrap\/install\.sh\n$/);
  assert.equal(f.ran(), undefined);

  fs.writeFileSync(path.join(pin, ".kherep-source.json"), "{}");
  const wake = f.run(["wake", "--timeout", "86400"]);
  assert.equal(wake.status, 7, wake.stderr);
  const out = JSON.parse(wake.stdout) as Out;
  assert.equal(out.marker, "PIN");
  assert.deepEqual(out.argv.slice(1), ["--timeout", "86400"]);
  const attribution = f.run(["attribution"]);
  assert.equal((JSON.parse(attribution.stdout) as Out).marker, "PIN-ATTRIBUTION");
});

// asyncRewake wakes the session on exit 2 and shows stderr, or stdout when stderr is empty.
test("exit 2 and the hook's stderr or stdout pass through unchanged, with a large stdin", (t) => {
  const f = fixture(t);
  f.pointer({ version: 1, root: f.source("R", "R", "wake-hook.mts"), kind: "checkout", verified: true });
  const big = JSON.stringify({ hook_event_name: "Stop", pad: "x".repeat(1_000_000) });
  const woke = f.run(["wake", "--timeout", "86400"], { STUB_EXIT: "2" }, big);
  assert.equal(woke.status, 2);
  assert.equal(withoutTypeStrippingWarning(woke.stderr, 1), "stub stderr line\n");
  assert.equal((JSON.parse(woke.stdout) as Out).stdin, big);

  const quiet = f.source("Q", "Q", "wake-hook.mts", 'process.stdout.write("wake text on stdout\\n"); process.exitCode = 2;\n');
  f.pointer({ version: 1, root: quiet, kind: "checkout", verified: true });
  const stdoutOnly = f.run(["wake"]);
  assert.deepEqual([stdoutOnly.status, stdoutOnly.stdout, withoutTypeStrippingWarning(stdoutOnly.stderr, 1)], [2, "wake text on stdout\n", ""]);
});

test("the entry point fails closed and never falls back to another source", (t) => {
  const f = fixture(t);
  const valid = f.source("valid");
  // Decoys: beside the entry point, under the home, in cwd and in a workspace checkout.
  const decoy = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "deliver-hook.mts"), STUB("DECOY", f.record));
  };
  decoy(f.entryDir);
  decoy(path.join(f.home, "modules", "control-plane", "node"));
  decoy(f.cwd);
  const workspace = f.source("workspace", "DECOY");
  const cases: [string, unknown, string[]][] = [
    ["missing", undefined, ["deliver"]],
    ["invalid JSON", "{broken", ["deliver"]],
    ["version 2", { version: 2, root: valid, kind: "checkout", verified: true }, ["deliver"]],
    ["relative root", { version: 1, root: "valid", kind: "checkout", verified: true }, ["deliver"]],
    ["hook file missing", { version: 1, root: path.join(f.root, "absent"), kind: "checkout", verified: true }, ["deliver"]],
    ["pin without manifest", { version: 1, root: valid, kind: "pin", verified: true }, ["deliver"]],
    ["unknown name", { version: 1, root: valid, kind: "checkout", verified: true }, ["other"]],
    ["name as a path", { version: 1, root: valid, kind: "checkout", verified: true }, ["../deliver-hook.mts"]],
    ["name as a file name", { version: 1, root: valid, kind: "checkout", verified: true }, ["deliver-hook.mts"]],
    ["empty name", { version: 1, root: valid, kind: "checkout", verified: true }, [""]],
    ["no name", { version: 1, root: valid, kind: "checkout", verified: true }, []],
  ];
  for (const [label, pointer, args] of cases) {
    fs.rmSync(f.pointerPath, { force: true });
    if (pointer !== undefined) f.pointer(pointer);
    const result = f.run(args, { KHEREP_WORKSPACE: workspace });
    assert.equal(result.status, 1, label);
    assert.equal(result.stdout, "", label);
    assert.match(withoutTypeStrippingWarning(result.stderr, 1), FAIL_LINE, label);
    assert.equal(f.ran(), undefined, `${label}: no hook ran`);
  }
});

test("a hook that does not load exits 1 with the fail-closed line and the error's first line", (t) => {
  const f = fixture(t);
  for (const [label, body, detail] of [
    ["syntax error", "const x: number = ;\n", /the hook could not be loaded \([^\n)]+\)/],
    ["throws while loading", 'throw new Error("boom at load\\nsecond line");\n', /the hook could not be loaded \(boom at load\)/],
  ] as const) {
    f.pointer({ version: 1, root: f.source(label.replace(/\s/g, "-"), label, "deliver-hook.mts", body), kind: "checkout", verified: true });
    const result = f.run(["deliver"]);
    assert.equal(result.status, 1, label);
    assert.equal(result.stdout, "", label);
    assert.match(withoutTypeStrippingWarning(result.stderr, 1), FAIL_LINE, label);
    assert.match(result.stderr, detail, label);
  }
});

// The entry adds no process and no Node option, so the hook's stderr, warnings
// of every category included, reaches the caller exactly as from a direct call.
// The one exception is where the floor Node versions (24.1) put their single
// type-stripping notice per process: the stable form loads the .mts entry first,
// so the notice comes before the hook's output, not after it. That notice is
// dropped once from each side; a second one would still fail.
test("the stable form's stderr and exit code equal the path form's, warnings included", (t) => {
  const f = fixture(t);
  const r = f.source("R", "R", "deliver-hook.mts", `process.emitWarning("SYNTHETIC_UNRELATED_WARNING", "ExperimentalWarning");
process.stderr.write("stub stderr line\\n");
process.exitCode = 3;
`);
  const hook = path.join(r, "modules", "control-plane", "node", "deliver-hook.mts");
  f.pointer({ version: 1, root: r, kind: "checkout", verified: true });
  const options = { input: "{}", encoding: "utf8" as const, cwd: f.cwd, env: { ...f.env, KHEREP_CONFIG_DIR: f.configDir }, timeout: 20_000 };
  const direct = spawnSync(process.execPath, [hook], options);
  const stable = f.run(["deliver"], {}, "{}");
  const pids = (text: string) => withoutTypeStrippingWarning(text, 1).replace(/\(node:\d+\)/g, "(node:PID)");

  assert.equal(stable.status, direct.status);
  assert.equal(stable.status, 3);
  assert.match(stable.stderr, /ExperimentalWarning: SYNTHETIC_UNRELATED_WARNING/);
  assert.equal(pids(stable.stderr), pids(direct.stderr));
});

// The command as settings.json carries it, run the way Claude Code runs it: through
// the shell (sh on POSIX, Git Bash on Windows), the home quoted with its space.
test("the rendered command form runs through the shell with a quoted home", (t) => {
  const f = fixture(t);
  f.pointer({ version: 1, root: f.source("SHELL"), kind: "checkout", verified: true });
  // As rendered on each platform: backslashes of a Windows home stay literal inside double quotes.
  const command = `node "${f.entry}" deliver`;
  const result = spawnSync("bash", ["-c", command], { input: "{}", encoding: "utf8", cwd: f.cwd, timeout: 20_000,
    env: { ...process.env, KHEREP_CONFIG_DIR: f.configDir, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}` } });
  assert.equal(result.status, 7, `${result.stdout}\n${result.stderr}`);
  assert.equal((JSON.parse(result.stdout) as Out).marker, "SHELL");
});

test("the entry point imports Node built-ins only and reads the same pointers as the Codex entry", (t) => {
  const imports = fs.readFileSync(ENTRY, "utf8").split("\n").filter((line) => /^import\b/.test(line));
  assert.ok(imports.length >= 3);
  for (const line of imports) assert.match(line, /from "node:[a-z/]+";$/, line);
  const f = fixture(t);
  const valid = { version: 1, root: f.root, kind: "checkout", verified: false };
  for (const value of [valid, { ...valid, kind: "pin", commit: "0123456789abcdef0123456789abcdef01234567" }, { ...valid, version: 2 },
    { ...valid, root: "relative" }, { ...valid, verified: "yes" }, { ...valid, commit: "short" }, { ...valid, kind: "other" }, null, "{broken"]) {
    f.pointer(value);
    const ours = readPointer(f.pointerPath);
    const codex = readCodexPointer(f.pointerPath);
    assert.deepEqual(ours, codex, JSON.stringify(value));
  }
});
