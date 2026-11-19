// Contract test for obs-result-check.mts. Drives the hook the way Codex does at
// SubagentStop: JSON on stdin, an optional subagent rollout on disk, a JSON
// document or nothing on stdout, never plain text, always exit 0. stderr is
// never asserted: Node 24.1 prints an ExperimentalWarning there for .mts files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { OBS_RESULT_REASON } from "./obs-result-check.mts";

const HOOK = path.join(import.meta.dirname, "obs-result-check.mts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codex-obs-result-check-test-"));
const SECRET = "Example Corp host.example.com";
const EMPTY = 'OBS-RESULT: empty no-admissible-findings';
const VALID = 'OBS-RESULT: wrote 1 123';

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

interface Run {
  stdout: string;
  status: number | null;
  output: { decision?: unknown; reason?: unknown; systemMessage?: unknown } | null;
}

function runRaw(stdin: string): Run {
  const result = spawnSync(process.execPath, [HOOK], { input: stdin, encoding: "utf8" });
  // JSON.parse throws on plain text, so every non-empty stdout is proven JSON.
  return { stdout: result.stdout, status: result.status, output: result.stdout ? JSON.parse(result.stdout) : null };
}

function run(extra: Record<string, unknown>): Run {
  return runRaw(JSON.stringify({
    session_id: "00000000-0000-4000-8000-000000000000",
    hook_event_name: "SubagentStop",
    agent_id: "agent-1",
    agent_type: "codex-obs",
    agent_transcript_path: null,
    stop_hook_active: false,
    last_assistant_message: null,
    ...extra,
  }));
}

let seq = 0;
function rollout(finalText: string): string {
  const file = path.join(TMP, `rollout-${++seq}.jsonl`);
  const message = (role: string, text: string) =>
    ({ type: "response_item", payload: { type: "message", role, content: [{ type: "output_text", text }] } });
  const entries = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    message("user", "brief"),
    message("assistant", "working"),
    { type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } },
    message("assistant", finalText),
  ];
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return file;
}

function silent(result: Run): void {
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
}

function message(result: Run): string {
  assert.equal(result.status, 0);
  assert.equal(result.output?.decision, undefined, "no block");
  assert.equal(typeof result.output?.systemMessage, "string");
  assert.doesNotMatch(result.output!.systemMessage as string, /\n/, "one line");
  return result.output!.systemMessage as string;
}

test("a valid receipt, empty or not, is silent", () => {
  silent(run({ last_assistant_message: EMPTY }));
  silent(run({ last_assistant_message: VALID }));
});

test("other agents are never judged", () => {
  for (const agent_type of ["worker", "explorer", "claude-obs", "", undefined]) {
    silent(run({ agent_type, last_assistant_message: "not a candidate" }));
  }
});

test("a malformed receipt is sent back once with the fixed reason", () => {
  for (const text of [`Done. ${SECRET}`, `\`\`\`json\n${EMPTY}\n\`\`\``, '{"observations":[{"title":"x"}]}']) {
    const result = run({ last_assistant_message: text });
    assert.equal(result.status, 0);
    assert.deepEqual(result.output, { decision: "block", reason: OBS_RESULT_REASON });
  }
  assert.match(OBS_RESULT_REASON, /one strict OBS-RESULT line/);
  assert.match(OBS_RESULT_REASON, /no Markdown fence/);
  assert.match(OBS_RESULT_REASON, /no configuration or broker I\/O/);
});

test("a malformed receipt on the continuation only warns the operator", () => {
  for (const stop_hook_active of [true, undefined, "false"]) {
    const text = message(run({ stop_hook_active, last_assistant_message: `Done. ${SECRET}` }));
    assert.match(text, /codex-obs/);
    assert.match(text, /strict publication receipt/);
    assert.match(text, /must not publish or repair silently/);
  }
});

test("the rollout is the fallback when the payload carries no message", () => {
  silent(run({ agent_transcript_path: rollout(EMPTY) }));
  silent(run({ last_assistant_message: "  ", agent_transcript_path: rollout(VALID) }));
  const blocked = run({ agent_transcript_path: rollout(`Here it is:\n${EMPTY}`) });
  assert.deepEqual(blocked.output, { decision: "block", reason: OBS_RESULT_REASON });
});

test("the payload message wins over the rollout", () => {
  silent(run({ last_assistant_message: EMPTY, agent_transcript_path: rollout("garbage") }));
});

test("a result the hook cannot see warns the operator", () => {
  for (const extra of [{}, { agent_transcript_path: path.join(TMP, "missing.jsonl") }, { last_assistant_message: 42 }]) {
    assert.match(message(run(extra)), /not visible/);
  }
});

test("any hook error is one systemMessage and exit 0", () => {
  for (const stdin of ["{not json", "", "[]", "null"]) {
    const result = runRaw(stdin);
    assert.equal(result.status, 0, stdin);
    assert.match(String(result.output?.systemMessage), /obs-result-check/, stdin);
    assert.equal(result.output?.decision, undefined, stdin);
  }
});

test("nothing from the message, the rollout or the payload reaches stdout", () => {
  const leaks = [
    run({ last_assistant_message: `${SECRET}\n${EMPTY}` }),
    run({ stop_hook_active: true, last_assistant_message: JSON.stringify({ observations: [{ title: SECRET }] }) }),
    run({ agent_transcript_path: rollout(`${SECRET} ${EMPTY}`) }),
    run({ agent_transcript_path: path.join(TMP, `${SECRET}.jsonl`) }),
  ];
  for (const result of leaks) {
    assert.ok(result.stdout, "each case emits something");
    for (const fragment of ["Example Corp", "host.example.com", "00000000-0000", "agent-1", "codex-obs-result-check-test-"]) {
      assert.ok(!result.stdout.includes(fragment), `${fragment} leaked: ${result.stdout}`);
    }
  }
});

test("a valid failed receipt warns in the same turn without a correction or data echo", () => {
  assert.match(message(run({last_assistant_message:'OBS-RESULT: failed readback-unverified created=123'})), /same turn/);
  assert.match(OBS_RESULT_REASON, /NO further publication/);
});

for (const code of ['space-lookup-unavailable', 'space-unresolved', 'space-lookup-bindings-missing',
    'space-lookup-network-unavailable', 'space-lookup-timeout']) test(`lookup failure ${code} warns without requesting a retry`, () => {
    assert.match(message(run({ last_assistant_message: `OBS-RESULT: failed ${code}` })), /same turn/);
});

// Issue #989: a refusal naming its findings is a valid failed receipt, never a correction.
for (const stop_hook_active of [false, true]) test(`a failed receipt with why= warns without a block (stop_hook_active ${stop_hook_active})`, () => {
    for (const text of ['OBS-RESULT: failed links-refused why=1:another-title,2:not-candidate', 'OBS-RESULT: failed invalid-request why=1:reason-invalid'])
        assert.match(message(run({ stop_hook_active, last_assistant_message: text })), /same turn/);
});
