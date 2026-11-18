// Issue #965. control-plane-hook.mts in-process, as the shell dispatcher imports it: which hook
// a pointer names, why there is none, and which Codex home a checkout copy reads.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { pointerFile, readPointer, resolveControlPlaneHook, resolveHook } from "./control-plane-hook.mts";

const ENTRY = path.join(import.meta.dirname, "control-plane-hook.mts");

function home(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-cp-resolve-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), node = path.join(root, "source", "modules", "control-plane", "node");
  fs.mkdirSync(node, { recursive: true });
  fs.writeFileSync(path.join(node, "attribution-hook.mts"), "export {};\n");
  const file = pointerFile(path.join(root, "codex"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const point = (value: unknown): string => { fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; };
  return { root, source, node, file, point };
}

// Runs fn with the given environment entries, restoring the previous values afterwards.
function withEnv<T>(entries: Record<string, string>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(entries).map((key) => [key, process.env[key]]));
  Object.assign(process.env, entries);
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

test("an unreadable or malformed pointer is invalid; an absent one is missing", (t) => {
  const h = home(t);
  assert.deepEqual(readPointer(path.join(h.root, "none.json")), { reason: "missing" });
  assert.deepEqual(readPointer(h.point("{not json")), { reason: "invalid" });
  assert.deepEqual(readPointer(h.point("null")), { reason: "invalid" });
  fs.rmSync(h.file);
  fs.mkdirSync(h.file);
  assert.deepEqual(readPointer(h.file), { reason: "invalid" }, "a directory is no pointer");
});

test("resolveHook: the named hook of a checkout or a pin with its manifest, else the reason", (t) => {
  const h = home(t);
  const file = h.point({ version: 1, root: h.source, kind: "checkout", verified: true });
  assert.deepEqual(resolveHook("attribution", file), { hook: path.join(h.node, "attribution-hook.mts"), pointer: JSON.parse(fs.readFileSync(file, "utf8")) });
  assert.deepEqual(resolveHook("deliver", file), { reason: "missing-hook" });
  for (const name of [undefined, "", "toString", "../x"]) assert.deepEqual(resolveHook(name, file), { reason: "name" }, String(name));
  h.point({ version: 1, root: h.source, kind: "pin", verified: false });
  assert.deepEqual(resolveHook("attribution", file), { reason: "missing-manifest" });
  fs.writeFileSync(path.join(h.source, ".kherep-source.json"), "{}");
  assert.equal("hook" in resolveHook("attribution", file), true);
  const plain = path.join(h.root, "plain-file");
  fs.writeFileSync(plain, "");
  h.point({ version: 1, root: plain, kind: "pin", verified: true });
  assert.deepEqual(resolveHook("attribution", file), { reason: "missing-manifest" }, "a root that is a file has no manifest");
});

test("resolveControlPlaneHook outside an install reads CODEX_HOME, else the OS home, and throws the reason", (t) => {
  const h = home(t);
  h.point({ version: 1, root: h.source, kind: "checkout", verified: true });
  withEnv({ CODEX_HOME: path.join(h.root, "codex") }, () => {
    assert.equal(resolveControlPlaneHook("attribution"), path.join(h.node, "attribution-hook.mts"));
    assert.throws(() => resolveControlPlaneHook("deliver"), { message: "the pointer's source has no such hook" });
  });
  const profile = path.join(h.root, "profile");
  withEnv({ CODEX_HOME: "relative", HOME: profile, USERPROFILE: profile }, () => {
    assert.throws(() => resolveControlPlaneHook("attribution"), { message: "no control-plane source pointer" }, "a relative CODEX_HOME is ignored");
  });
  assert.equal(resolveControlPlaneHook("attribution", h.file), path.join(h.node, "attribution-hook.mts"));
});

test("run from the checkout, the entry reads CODEX_HOME; a hook killed by a signal exits 1; an import runs nothing", (t) => {
  const h = home(t);
  h.point({ version: 1, root: h.source, kind: "checkout", verified: true });
  const run = (args: string[], codexHome: string) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY, ...args],
    { input: "{}", encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome }, windowsHide: true, timeout: 30_000 });
  const missing = run(["deliver"], path.join(h.root, "codex"));
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr, `kherep control-plane-hook: the pointer's source has no such hook; pointer ${h.file}; run codex/install.mts\n`);
  if (process.platform !== "win32") {
    fs.writeFileSync(path.join(h.node, "deliver-hook.mts"), "process.kill(process.pid, \"SIGKILL\");\n");
    assert.equal(run(["deliver"], path.join(h.root, "codex")).status, 1, "no exit code: 1");
  }
  fs.writeFileSync(path.join(h.node, "deliver-hook.mts"), "process.exitCode = 5;\n");
  assert.equal(run(["deliver"], path.join(h.root, "codex")).status, 5);
  const imported = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(ENTRY).href)});`, "no-such-entry.mts"],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.deepEqual([imported.status, imported.stdout, imported.stderr], [0, "", ""]);
});
