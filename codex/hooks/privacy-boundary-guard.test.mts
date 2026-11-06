import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { normalizePayloads, type HookPayload } from "./hook-adapter.mts";
import { evaluate } from "./privacy-boundary-guard.mts";

const env = { USERPROFILE: "C:\\Users\\ExampleUser" };
const privateFile = "D:\\Work-credentials\\secret.txt";

test("wrapped punctuation cannot bypass a temporary protected root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-wrapper-edge-"));
  try {
    const configured = { ...env, KHEREP_CREDENTIALS_ROOT: root };
    const wrapped = `(((${path.join(root, "plain.txt")}))),`;
    assert.match(evaluate({ tool_name: "Bash", tool_input: { command: `cat ${wrapped}` } }, configured) ?? "", /Private material/);
    assert.equal(evaluate({ tool_name: "Bash", tool_input: { command: `cat (((${root}-copy/plain.txt))),` } }, configured), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function command(payload: HookPayload): unknown {
  return (payload.tool_input as { command?: unknown }).command;
}

test("allows only the Codex-owned runner for private local inference", () => {
  assert.equal(evaluate({ tool_name: "Bash", tool_input: {
    command: `node ~/.codex/kherep/local-inference/runner.mts --private --input-file ${privateFile}`,
  } }, env), null);
  assert.match(evaluate({ tool_name: "Bash", tool_input: {
    command: `node ~/.claude/kherep/local-inference/runner.mts --private --input-file ${privateFile}`,
  } }, env) ?? "", /Claude-owned/);
  assert.match(evaluate({ tool_name: "Bash", tool_input: {
    command: "node ~/.claude/kherep/local-inference/runner.mts --backend mac",
  } }, env) ?? "", /Claude-owned/);
});

test("blocks direct inference HTTP", () => {
  assert.match(evaluate({ tool_name: "Bash", tool_input: { command: "curl http://127.0.0.1:8000/v1/models" } }, env) ?? "", /HTTP/);
});

test("allows a single nested functions.exec call to the Codex runner", () => {
  const [payload] = normalizePayloads({
    tool_name: "functions.exec",
    tool_input: `tools.shell_command({command:"node ~/.codex/kherep/local-inference/runner.mts --private --input-file ${privateFile.replace(/\\/g, "\\\\")}"})`,
  }, "pre-privacy");
  assert.equal(evaluate(payload, env), null);
});

test("keeps mixed functions.exec source visible to privacy classification", () => {
  const source = "tools.shell_command({command:'git status'}); tools.web__run({q:'D:\\\\Work-credentials\\\\secret'})";
  const [payload] = normalizePayloads({ tool_name: "functions.exec", tool_input: source }, "pre-privacy");
  assert.equal(command(payload), source);
  assert.match(evaluate(payload, env) ?? "", /Private material/);
});

test("protects the configured credentials root", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "cat $KHEREP_CREDENTIALS_ROOT/secret.txt" } };
  assert.match(evaluate(payload, {
    ...env,
    KHEREP_CREDENTIALS_ROOT: "C:\\old-vault",
  }) ?? "", /Private material/);
  assert.match(evaluate(payload, {
    ...env,
    KHEREP_CREDENTIALS_ROOT: "C:\\old-vault",
  }) ?? "", /Private material/);
});

test("protects the neutral credentials default", () => {
  assert.match(evaluate({
    tool_name: "Read",
    tool_input: { file_path: "C:\\Users\\ExampleUser\\.kherep\\credentials\\secret.txt" },
  }, env) ?? "", /Private material/);
});

test("protects private artifacts in the neutral default and configured workspace", () => {
  assert.match(evaluate({
    tool_name: "Read",
    tool_input: { file_path: "/Users/example/Kherep/analysis/local-inference/private.json" },
  }, { HOME: "/Users/example", USERPROFILE: "" }) ?? "", /Private material/);
  assert.match(evaluate({
    tool_name: "Read",
    tool_input: { file_path: "/srv/operator-workspace/analysis/local-inference/private.json" },
  }, { HOME: "/Users/example", USERPROFILE: "", KHEREP_WORKSPACE: "/srv/operator-workspace" }) ?? "", /Private material/);
});

test("protects the Codex runtime configured external artifact root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-private-path-"));
  const codexHome = path.join(root, ".codex");
  const outputRoot = path.join(root, "private-output");
  try {
    fs.mkdirSync(path.join(codexHome, "kherep", "local-inference"), { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, "kherep", "local-inference", "config.json"),
      JSON.stringify({ outputRoot }),
    );
    assert.match(evaluate({
      tool_name: "Read",
      tool_input: { file_path: path.join(outputRoot, "result.json") },
    }, { HOME: root, USERPROFILE: "", CODEX_HOME: codexHome }) ?? "", /Private material/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
