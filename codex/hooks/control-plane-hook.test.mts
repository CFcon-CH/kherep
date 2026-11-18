import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { withoutTypeStrippingWarning } from "../lib/node-warning-fixture.mts";
import { ENTRY_NODE_FLAG } from "../lib/parity-config.mts";
import { copySource } from "./hook-adapter.fixture.mts";

// Issue #503. The stable entry point runs the hook of the source its pointer
// names, as that hook's own main module, and fails closed without the pointer.

const STUB = (marker: string, record: string) => `import fs from "node:fs";
import { pathToFileURL } from "node:url";
fs.writeFileSync(${JSON.stringify(record)}, ${JSON.stringify(marker)});
const stdin = fs.readFileSync(0, "utf8");
const main = import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
process.stdout.write(JSON.stringify({ marker: ${JSON.stringify(marker)}, argv: process.argv.slice(1), main, stdin,
  cwd: fs.realpathSync(process.cwd()), config: process.env.KHEREP_CONFIG_DIR }));
process.stderr.write("stub stderr line\\n");
process.exitCode = 7;
`;

function fixture(t: import("node:test").TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-cp-entry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "codex");
  const hookDir = path.join(home, "hooks", "kherep-maestro");
  fs.mkdirSync(hookDir, { recursive: true });
  const entry = path.join(hookDir, "codex-control-plane-hook.mts");
  copySource("control-plane-hook.mts", entry);
  const record = path.join(root, "record.txt");
  const source = (name: string, marker = name, hook = "deliver-hook.mts"): string => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, "modules", "control-plane", "node"), { recursive: true });
    fs.writeFileSync(path.join(dir, "modules", "control-plane", "node", hook), STUB(marker, record));
    return dir;
  };
  const pointerPath = path.join(home, "orchestra", "control-plane-source.json");
  const pointer = (value: unknown): void => {
    fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
    fs.writeFileSync(pointerPath, typeof value === "string" ? value : JSON.stringify(value));
  };
  const cwd = path.join(root, "cwd");
  fs.mkdirSync(cwd);
  const configDir = path.join(root, "kherep-config");
  // PATH holds only a decoy `node`: the entry point must start process.execPath.
  const decoyBin = path.join(root, "bin");
  fs.mkdirSync(decoyBin);
  fs.writeFileSync(path.join(decoyBin, "node"), `#!/bin/sh\necho decoy > ${JSON.stringify(record)}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(decoyBin, "node.cmd"), `@echo decoy> "${record}"\r\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^path$/i.test(key)));
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [ENTRY_NODE_FLAG, entry, ...args], {
    input: '{"hook_event_name":"Stop"}', encoding: "utf8", cwd, timeout: 20_000,
    env: { ...env, PATH: decoyBin, KHEREP_CONFIG_DIR: configDir, CODEX_HOME: path.join(root, "elsewhere"), ...extra },
  });
  const ran = (): string | undefined => fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim() : undefined;
  return { root, home, hookDir, entry, source, pointer, run, ran, cwd, configDir, record };
}

test("the entry point runs the pointer's hook with the caller's stdio, argv, cwd, env and exit code", (t) => {
  const f = fixture(t);
  const r1 = f.source("R1");
  const r2 = f.source("R2");
  f.pointer({ version: 1, root: r1, kind: "checkout", verified: true });

  const first = f.run(["deliver", "--runtime", "codex"]);

  assert.equal(first.status, 7, first.stderr);
  // A Node that warns about type stripping warns once, for the hook, as for a direct hook call.
  assert.equal(withoutTypeStrippingWarning(first.stderr, 1), "stub stderr line\n");
  const out = JSON.parse(first.stdout) as { marker: string; argv: string[]; main: boolean; stdin: string; cwd: string; config: string };
  assert.equal(out.marker, "R1");
  assert.equal(out.argv[0], path.join(r1, "modules", "control-plane", "node", "deliver-hook.mts"));
  assert.equal(out.main, true, "the hook runs as its own main module");
  assert.deepEqual(out.argv.slice(1), ["--runtime", "codex"]);
  assert.equal(out.stdin, '{"hook_event_name":"Stop"}');
  assert.equal(out.cwd, fs.realpathSync(f.cwd));
  assert.equal(out.config, f.configDir);

  f.pointer({ version: 1, root: r2, kind: "checkout", verified: true });
  const second = f.run(["deliver", "--runtime", "codex"]);
  assert.equal(second.status, 7, second.stderr);
  assert.equal((JSON.parse(second.stdout) as { marker: string }).marker, "R2");
});

test("a source pin needs its manifest; attribution is the other fixed entry", (t) => {
  const f = fixture(t);
  const pin = f.source("pin", "PIN", "attribution-hook.mts");
  f.pointer({ version: 1, root: pin, commit: "0123456789abcdef0123456789abcdef01234567", kind: "pin", verified: true });
  const refused = f.run(["attribution", "--runtime", "codex"]);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /^kherep control-plane-hook: the pointer's source pin has no manifest; pointer .+; run codex\/install\.mts\n$/);
  assert.equal(f.ran(), undefined);

  fs.writeFileSync(path.join(pin, ".kherep-source.json"), "{}");
  const accepted = f.run(["attribution", "--runtime", "codex"]);
  assert.equal(accepted.status, 7, accepted.stderr);
  assert.equal((JSON.parse(accepted.stdout) as { marker: string }).marker, "PIN");
});

test("the entry point fails closed and never falls back to another source", (t) => {
  const f = fixture(t);
  const valid = f.source("valid");
  // Decoys: beside the entry point, two levels above it, in cwd and in a workspace checkout.
  const decoy = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "deliver-hook.mts"), STUB("DECOY", f.record));
  };
  decoy(f.hookDir);
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
    ["name wake", { version: 1, root: valid, kind: "checkout", verified: true }, ["wake"]],
    ["name as a path", { version: 1, root: valid, kind: "checkout", verified: true }, ["../deliver-hook.mts"]],
    ["name as a file name", { version: 1, root: valid, kind: "checkout", verified: true }, ["deliver-hook.mts"]],
    ["no name", { version: 1, root: valid, kind: "checkout", verified: true }, []],
  ];
  for (const [label, pointer, args] of cases) {
    fs.rmSync(path.join(f.home, "orchestra"), { recursive: true, force: true });
    if (pointer !== undefined) f.pointer(pointer);
    const result = f.run([...args, "--runtime", "codex"], { KHEREP_WORKSPACE: workspace });
    assert.equal(result.status, 1, label);
    assert.equal(result.stdout, "", label);
    assert.match(result.stderr, /^kherep control-plane-hook: [^\n]+; pointer [^\n]+; run codex\/install\.mts\n$/, label);
    assert.equal(f.ran(), undefined, `${label}: no hook ran`);
  }
});

// Issue #503. The entry point adds no Node option to the hook, so every warning
// the hook emits reaches the caller as from a direct call, of any category.
test("the entry point keeps every warning of the hook, as a direct call shows it", (t) => {
  const f = fixture(t);
  const r = f.source("R");
  const hook = path.join(r, "modules", "control-plane", "node", "deliver-hook.mts");
  fs.writeFileSync(hook, `process.emitWarning("SYNTHETIC_UNRELATED_WARNING", "ExperimentalWarning");
process.stderr.write("stub stderr line\\n");
`);
  f.pointer({ version: 1, root: r, kind: "checkout", verified: true });
  const env = { ...process.env, KHEREP_CONFIG_DIR: f.configDir };
  const options = { input: "{}", encoding: "utf8" as const, cwd: f.cwd, env, timeout: 20_000 };
  const direct = spawnSync(process.execPath, [hook, "--runtime", "codex"], options);
  const stable = f.run(["deliver", "--runtime", "codex"]);
  const pids = (text: string) => text.replace(/\(node:\d+\)/g, "(node:PID)");

  assert.equal(stable.status, direct.status);
  assert.match(stable.stderr, /ExperimentalWarning: SYNTHETIC_UNRELATED_WARNING/);
  assert.equal(pids(stable.stderr), pids(direct.stderr));
});
