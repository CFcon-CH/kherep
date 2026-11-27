// Tests for the semantic dispatcher (issue #1020): the default per runtime,
// the KHEREP_SEMANTIC_BACKEND override, the runtime bound by the entry file,
// and that no backend ever reaches the other.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli as runCodexCli } from "./atl-confluence.mts";
import { runCli as runClaudeCli } from "./atl-confluence-ccoder.mts";
import type { ExecLike } from "./confluence-semantic.mts";
import { DEFAULT_BACKEND, semanticFor, semanticSearch, type SemanticDeps } from "./confluence-semantic.mts";
import { claudeEnvelope, fakeChild, fakeGate, PAGES, recordingSession } from "./semantic-model.fixture.mts";

const BIN = path.join(tmpdir(), "fake-cli.exe");

function twgExec() {
  const calls: string[][] = [];
  const exec: ExecLike = async (file, args) => { calls.push([file, ...args]); return { stdout: "", stderr: "" }; };
  return { exec, calls, read: async () => JSON.stringify({ results: [{ id: "3", title: "Credential file expired in the nightly job" }] }) };
}

function deps(over: Partial<SemanticDeps> = {}) {
  const twg = twgExec();
  const child = fakeChild({ stdout: claudeEnvelope('{"ranked":[1]}') });
  const d: SemanticDeps = {
    exec: twg.exec, read: twg.read, remove: async () => {}, outFile: "out.json", cli: "twg",
    env: { KHEREP_CLAUDE_BIN: BIN, KHEREP_CODEX_BIN: BIN }, exists: () => true, platform: "win32",
    gateExec: fakeGate().exec, spawn: child.spawn, tmp: mkdtempSync(path.join(tmpdir(), "kherep-dispatch-")),
    workspace: path.join(tmpdir(), "no-workspace"), trace: () => {}, pool: { session: recordingSession().session, spaceKey: "KB", pages: PAGES },
    ...over,
  };
  return { d, twg, child };
}

test("the committed defaults are twg for both runtimes until a runtime passes the comparison", () => {
  assert.deepEqual(DEFAULT_BACKEND, { "claude-code": "twg", codex: "twg" });
});

test("the default follows the map of the bound runtime, both values injected", async () => {
  for (const runtime of ["claude-code", "codex"] as const) {
    const twgRun = deps({ runtime, defaults: { "claude-code": "twg", codex: "twg" } });
    assert.equal((await semanticSearch("credential", 3, twgRun.d)).backend, "twg");
    assert.equal(twgRun.twg.calls.length, 1);
    assert.equal(twgRun.child.runs.length, 0, "twg never starts a model child");
  }
  const modelRun = deps({ runtime: "claude-code", defaults: { "claude-code": "model", codex: "twg" } });
  const result = await semanticSearch("credential", 3, modelRun.d);
  assert.equal(result.backend, "model:claude-code");
  assert.deepEqual(result.items?.map((i) => i.id), ["2"]);
  assert.equal(modelRun.twg.calls.length, 0, "the model backend never runs twg");
});

test("KHEREP_SEMANTIC_BACKEND overrides both ways; any other value is an error; explicit env beats process.env", async () => {
  const toModel = deps({ runtime: "codex", env: { KHEREP_SEMANTIC_BACKEND: "model", KHEREP_CODEX_BIN: BIN }, selection: () => ({ error: "receipt gone" }) });
  const failed = await semanticSearch("credential", 3, toModel.d);
  assert.equal(failed.backend, "model:codex");
  assert.equal(failed.error, "semantic search did not run: receipt gone");
  assert.equal(toModel.twg.calls.length, 0, "a model failure never falls back to twg");
  const toTwg = deps({ runtime: "claude-code", defaults: { "claude-code": "model", codex: "model" }, env: { KHEREP_SEMANTIC_BACKEND: "twg" } });
  assert.equal((await semanticSearch("credential", 3, toTwg.d)).backend, "twg");
  assert.equal(toTwg.child.runs.length, 0);
  const bad = deps({ runtime: "claude-code", env: { KHEREP_SEMANTIC_BACKEND: "rovo" } });
  assert.deepEqual(await semanticSearch("credential", 3, bad.d),
    { titles: [], items: [], error: 'semantic search did not run: KHEREP_SEMANTIC_BACKEND "rovo" is not one of model, twg' });
  assert.equal(bad.twg.calls.length + bad.child.runs.length, 0);
  const saved = process.env.KHEREP_SEMANTIC_BACKEND;
  process.env.KHEREP_SEMANTIC_BACKEND = "model";
  try {
    const explicit = deps({ runtime: "claude-code", env: {} });
    assert.equal((await semanticSearch("credential", 3, explicit.d)).backend, "twg", "the injected env decides, not process.env");
  } finally {
    if (saved === undefined) delete process.env.KHEREP_SEMANTIC_BACKEND; else process.env.KHEREP_SEMANTIC_BACKEND = saved;
  }
});

test("a twg failure never starts a model child", async () => {
  const run = deps({ runtime: "claude-code", exec: async () => { throw new Error("twg missing"); } });
  const result = await semanticSearch("credential", 3, run.d);
  assert.match(result.error ?? "", /^semantic search did not run: twg missing/);
  assert.equal(run.child.runs.length, 0);
});

test("semanticFor binds the runtime from the entry's credential variable", async () => {
  const claude = deps({ env: { KHEREP_SEMANTIC_BACKEND: "model", KHEREP_CLAUDE_BIN: BIN, KHEREP_CODEX_BIN: BIN } });
  await semanticFor("KHEREP_ATL_CRED_FILE_CLAUDE")("credential", 3, claude.d);
  assert.equal(claude.child.runs[0].args[0], "-p");
  const codex = deps({ env: { KHEREP_SEMANTIC_BACKEND: "model", KHEREP_CLAUDE_BIN: BIN, KHEREP_CODEX_BIN: BIN }, selection: () => ({ model: "gpt-6-luna", effort: "medium" }) });
  await semanticFor("KHEREP_ATL_CRED_FILE_CODEX")("credential", 3, codex.d);
  assert.equal(codex.child.runs[0].args[0], "exec");
  assert.throws(() => semanticFor("SOMETHING_ELSE"), /Cannot tell the runtime/);
  const unbound = await semanticSearch("credential", 3, { ...deps().d, env: { KHEREP_SEMANTIC_BACKEND: "model" } });
  assert.equal(unbound.error, "semantic search did not run: the model backend needs the runtime of the broker entry, and none was bound");
});

test("each entry file binds its own runtime: the Claude entry spawns claude, the Codex entry codex", async () => {
  const sources = await Promise.all(["atl-confluence.mts", "atl-confluence-ccoder.mts", "observation-broker.mts"]
    .map((name) => import("node:fs/promises").then((fs) => fs.readFile(path.join(import.meta.dirname, name), "utf8"))));
  assert.match(sources[0], /semanticFor\(CRED_ENV, /);
  assert.match(sources[1], /semanticFor\(CRED_ENV, /);
  assert.match(sources[2], /semanticFor\(CREDENTIAL, ctx\.env\)/);
  assert.match(sources[0], /const CRED_ENV = "KHEREP_ATL_CRED_FILE_CODEX";/);
  assert.match(sources[1], /const CRED_ENV = "KHEREP_ATL_CRED_FILE_CLAUDE";/);
  assert.equal(typeof runCodexCli, "function");
  assert.equal(typeof runClaudeCli, "function");
});
