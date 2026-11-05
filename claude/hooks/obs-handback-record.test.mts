#!/usr/bin/env node
// Contract test for obs-handback-record.mts (issue #555). Drives the hook the
// way Claude Code does at PostToolUse on SubagentHandback: JSON on stdin,
// JSON-or-nothing on stdout, always exit 0. The hook and its libs are copied
// into a temporary <root>/hooks/, so the state lands under <root>, never in
// the checkout. stderr is never asserted (Node's ExperimentalWarning).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "obs-handback-record-test-")));
fs.mkdirSync(path.join(ROOT, "hooks"));
fs.copyFileSync(path.join(import.meta.dirname, "obs-handback-record.mts"), path.join(ROOT, "hooks", "obs-handback-record.mts"));
fs.cpSync(path.join(import.meta.dirname, "lib"), path.join(ROOT, "hooks", "lib"), { recursive: true });
const HOOK = path.join(ROOT, "hooks", "obs-handback-record.mts");
declareCopy(path.join(import.meta.dirname, "obs-handback-record.mts"), HOOK);
const STATE = path.join(ROOT, ".cache", "obs-result-check");
const SECRET = "Example Corp host.example.com";

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

interface Run { stdout: string; status: number | null; output: Record<string, unknown> | null }

function runRaw(stdin: string): Run {
  const result = spawnSync(process.execPath, [HOOK], { input: stdin, encoding: "utf8" });
  return { stdout: result.stdout, status: result.status, output: result.stdout ? JSON.parse(result.stdout) : null };
}

let seq = 0;
function run(message: unknown, extra: Record<string, unknown> = {}): Run & { id: string } {
  const id = `rec-${++seq}`;
  return {
    id,
    ...runRaw(JSON.stringify({
      session_id: "00000000-0000-4000-8000-000000000000",
      hook_event_name: "PostToolUse",
      agent_id: id,
      agent_type: "claude-obs",
      tool_name: "SubagentHandback",
      tool_input: { message },
      tool_use_id: "toolu_01ABC",
      tool_response: { delivered: SECRET },
      ...extra,
    })),
  };
}

const delivered = (id: string) => path.join(STATE, `${id}.delivered`);
const stateOf = (id: string) => fs.existsSync(delivered(id)) ? fs.readFileSync(delivered(id), "utf8") : null;

function notice(result: Run): string {
  assert.equal(result.status, 0);
  assert.deepEqual(Object.keys(result.output ?? {}), ["systemMessage"], "a notice only, never a decision");
  assert.doesNotMatch(result.output!.systemMessage as string, /\n/, "one line");
  return result.output!.systemMessage as string;
}

test("other tools and other agents are silent and record nothing", () => {
  for (const extra of [{ tool_name: "Bash" }, { agent_type: "general-purpose" }, { agent_type: undefined }]) {
    const result = run("OBS-RESULT: empty none", extra);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(stateOf(result.id), null);
  }
});

test("a valid wrote or empty report is recorded with its tool_use_id and stays silent", () => {
  const wrote = run("OBS-RESULT: wrote 2 11,22\n11 A\n22 B");
  assert.equal(wrote.stdout, "");
  assert.equal(stateOf(wrote.id), "wrote\ttoolu_01ABC\n");
  const empty = run("OBS-RESULT: empty nothing new", { tool_use_id: 42 });
  assert.equal(empty.stdout, "");
  assert.equal(stateOf(empty.id), "empty\t-\n");
});

test("a valid failed report is recorded and warns the operator", () => {
  const result = run(`OBS-RESULT: failed missing broker ${SECRET}`);
  assert.match(notice(result), /OBS-RESULT: failed\. The Maestro reports it as a failure/);
  assert.equal(stateOf(result.id), "failed\ttoolu_01ABC\n");
});

test("a malformed report is recorded and reported, never refused", () => {
  const result = run(`OBS-RESULT: failed wrote 4 pages: 1,2,3,4 ${SECRET}`);
  assert.match(notice(result), /claude-obs result is still malformed \(failed reason starts with a status word\); the Maestro treats it as a failure\./);
  assert.equal(stateOf(result.id), "malformed failed reason starts with a status word\ttoolu_01ABC\n");
});

test("a handback without a visible message is a notice and records nothing", () => {
  for (const message of [undefined, 42, "", "   "]) {
    const result = run(message);
    assert.match(notice(result), /handback carried no visible message/);
    assert.equal(stateOf(result.id), null);
  }
});

test("without a valid agent_id the notice stays and nothing is written", () => {
  for (const agent_id of [undefined, 42, "../escape", "a b", "x".repeat(65)]) {
    const result = run("OBS-RESULT: failed missing broker", { agent_id });
    assert.match(notice(result), /OBS-RESULT: failed/);
  }
  // Every file under <root>/.cache is a record of a valid rec-<n> id, wherever an invalid id would have landed.
  const cache = path.join(ROOT, ".cache");
  const written = fs.existsSync(cache) ? fs.readdirSync(cache, { recursive: true }).map((name) => String(name).replace(/\\/g, "/")) : [];
  for (const name of written) assert.match(name, /^obs-result-check(\/rec-\d+\.delivered)?$/, name);
});

test("any hook error is one systemMessage and exit 0", () => {
  for (const stdin of ["{not json", "", "[]", "null"]) {
    assert.match(notice(runRaw(stdin)), /obs-handback-record/, stdin);
  }
});

test("nothing from the message, the response or the payload reaches stdout", () => {
  const results = [
    run(`OBS-RESULT: failed ${SECRET}`),
    run(`${SECRET}\nOBS-RESULT: wrote 1 5`),
    run(`OBS-RESULT: wrote 9 ${SECRET}`),
    run(42),
  ];
  for (const result of results) {
    assert.ok(result.stdout, "each case emits something");
    for (const fragment of ["Example Corp", "host.example.com", "00000000-0000", result.id, "toolu_01ABC", " 9 ", ROOT]) {
      assert.ok(!result.stdout.includes(fragment), `${fragment} leaked: ${result.stdout}`);
    }
  }
});
