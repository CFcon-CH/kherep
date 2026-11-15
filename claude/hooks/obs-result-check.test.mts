#!/usr/bin/env node
// Contract test for obs-result-check.mts. Drives the hook the way Claude Code
// does at SubagentStop: JSON on stdin, an optional subagent transcript on disk,
// JSON-or-nothing on stdout, always exit 0. stderr is never asserted: Node 24.1
// prints an ExperimentalWarning there for .mts files. The hook and its libs are
// copied into a temporary <root>/hooks/ (issue #555), so the handback state
// under <root>/.cache/ never lands in the checkout. Case (h), the wait for a
// late recorder, calls decide() in this process instead (issue #611): only
// there can the test plant the record after the hook's first read for certain.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { decide, OBS_RESULT_REASON } from "./obs-result-check.mts";
import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "obs-result-check-test-")));
const SECRET = "Example Corp host.example.com";

function fixture(name: string): { root: string; hook: string } {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, "obs-result-check.mts"), path.join(root, "hooks", "obs-result-check.mts"));
  declareCopy(path.join(import.meta.dirname, "obs-result-check.mts"), path.join(root, "hooks", "obs-result-check.mts"));
  fs.cpSync(path.join(import.meta.dirname, "lib"), path.join(root, "hooks", "lib"), { recursive: true });
  return { root, hook: path.join(root, "hooks", "obs-result-check.mts") };
}
const { root: ROOT, hook: HOOK } = fixture("home");
const STATE = path.join(ROOT, ".cache", "obs-result-check");

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

interface Run { stdout: string; status: number | null; output: { decision?: unknown; reason?: unknown; systemMessage?: unknown } | null }

const toRun = (stdout: string, status: number | null): Run => ({ stdout, status, output: stdout ? JSON.parse(stdout) : null });
function runRaw(stdin: string, hook = HOOK): Run {
  const { stdout, status } = spawnSync(process.execPath, [hook], { input: stdin, encoding: "utf8", env: childEnv() });
  return toRun(stdout, status);
}
function childEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT,
    ...(process.env.NODE_V8_COVERAGE === undefined ? {} : { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }) };
}

const fields = (extra: Record<string, unknown>) => ({ session_id: "00000000-0000-4000-8000-000000000000",
  hook_event_name: "SubagentStop", agent_id: "agent-1", agent_type: "claude-obs", stop_hook_active: false, ...extra });
const payload = (extra: Record<string, unknown>) => JSON.stringify(fields(extra));

const run = (extra: Record<string, unknown>, hook = HOOK): Run => runRaw(payload(extra), hook);
// Asynchronous, so the cases that wait for the recorder run side by side.
function runAsync(extra: Record<string, unknown>): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { stdio: ["pipe", "pipe", "ignore"], env: childEnv() });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (status) => resolve(toRun(stdout, status)));
    child.stdin.end(payload(extra));
  });
}

let seq = 0;
function writeTranscript(entries: unknown[]): string {
  const file = path.join(TMP, `agent-${++seq}.jsonl`);
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  return file;
}
function transcript(finalText: string): string {
  return writeTranscript([
    { type: "user", isSidechain: true, message: { role: "user", content: "brief" } },
    { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: finalText }] } },
    { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } },
  ]);
}
// A subagent transcript whose last call is SubagentHandback; result: true, false (is_error) or absent.
function handbackTranscript(id: string, message: string, ok?: boolean): string {
  const entries: unknown[] = [
    { type: "user", isSidechain: true, message: { role: "user", content: "brief" } },
    { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "tool_use", id, name: "SubagentHandback", input: { message } }] } },
  ];
  const result = { type: "tool_result", tool_use_id: id, content: "delivered", is_error: !ok };
  if (ok !== undefined) entries.push({ type: "user", isSidechain: true, message: { role: "user", content: [result] } });
  return writeTranscript(entries);
}

const stateFile = (id: string, kind: "delivered" | "stop") => path.join(STATE, `${id}.${kind}`);
function plantDelivered(id: string, line: string): void {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(stateFile(id, "delivered"), line);
}
const trace = (id: string) => fs.readFileSync(stateFile(id, "stop"), "utf8");

const silent = (result: Run) => assert.deepEqual([result.status, result.stdout], [0, ""]);

function message(result: Run): string {
  assert.equal(result.status, 0);
  assert.equal(result.output?.decision, undefined, "no block");
  assert.equal(typeof result.output?.systemMessage, "string");
  assert.doesNotMatch(result.output!.systemMessage as string, /\n/, "one line");
  return result.output!.systemMessage as string;
}

test("a valid wrote or empty result is silent", () => {
  silent(run({ last_assistant_message: "OBS-RESULT: wrote 2 11,22\n11 A\n22 B" }));
  silent(run({ last_assistant_message: "OBS-RESULT: empty nothing new" }));
});

test("other agents are never judged", () => {
  for (const agent_type of ["general-purpose", "kherep-builder", "codex-obs", "", undefined]) {
    silent(run({ agent_type, last_assistant_message: "not a status line" }));
  }
});

test("a malformed result is sent back once with the fixed reason", () => {
  const result = run({ last_assistant_message: `OBS-RESULT: failed wrote 4 pages: 1,2,3,4 ${SECRET}` });
  assert.equal(result.status, 0);
  assert.deepEqual(result.output, { decision: "block", reason: OBS_RESULT_REASON });
  assert.match(OBS_RESULT_REASON, /exactly one OBS-RESULT line/);
  assert.match(OBS_RESULT_REASON, /no further pages/);
});

test("a malformed result on the continuation only warns the operator", () => {
  for (const stop_hook_active of [true, undefined, "false"]) {
    const text = message(run({ stop_hook_active, last_assistant_message: `Done. ${SECRET}` }));
    assert.match(text, /claude-obs/);
    assert.match(text, /no OBS-RESULT status line/);
  }
});

test("a valid failed result warns the operator without blocking", () => {
  const text = message(run({ last_assistant_message: `OBS-RESULT: failed missing broker ${SECRET}` }));
  assert.match(text, /OBS-RESULT: failed/);
  assert.match(text, /failure/);
});

test("the transcript is the fallback when the payload carries no message", () => {
  silent(run({ agent_transcript_path: transcript("OBS-RESULT: wrote 1 5\n5 Title") }));
  silent(run({ last_assistant_message: "  ", agent_transcript_path: transcript("OBS-RESULT: empty none") }));
  const blocked = run({ agent_transcript_path: transcript("OBS-RESULT: wrote 2 5") });
  assert.deepEqual(blocked.output, { decision: "block", reason: OBS_RESULT_REASON });
});

test("the payload message wins over the transcript", () => {
  silent(run({ last_assistant_message: "OBS-RESULT: empty none", agent_transcript_path: transcript("garbage") }));
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

test("nothing from the message, the transcript or the payload reaches stdout", () => {
  const leaks = [
    run({ last_assistant_message: `OBS-RESULT: failed ${SECRET}` }),
    run({ last_assistant_message: `${SECRET}\nOBS-RESULT: wrote 1 5` }),
    run({ stop_hook_active: true, last_assistant_message: `OBS-RESULT: wrote 9 ${SECRET}` }),
    run({ agent_transcript_path: transcript(`OBS-RESULT: empty empty ${SECRET}`) }),
    run({ agent_transcript_path: path.join(TMP, `${SECRET}.jsonl`) }),
  ];
  for (const result of leaks) {
    assert.ok(result.stdout, "each case emits something");
    for (const fragment of ["Example Corp", "host.example.com", "00000000-0000", "agent-1", "obs-result-check-test-", " 9 "]) {
      assert.ok(!result.stdout.includes(fragment), `${fragment} leaked: ${result.stdout}`);
    }
  }
});

// Issue #555: in auto mode the report arrives through SubagentHandback, and
// last_assistant_message is only the closing text ("Report delivered.").
describe("handback evidence never blocks", { concurrency: true }, () => {
  const closing = { last_assistant_message: "Report delivered." };

  test("(a) a recorded delivery is silent and cleared", async () => {
    plantDelivered("hb-a", "wrote\ttoolu_a\n");
    silent(await runAsync({ ...closing, agent_id: "hb-a" }));
    assert.equal(fs.existsSync(stateFile("hb-a", "delivered")), false);
    assert.match(trace("hb-a"), /^mode=- state=present waited=0 after=- transcript=none branch=state\n$/);
  });

  test("(b) auto mode without any evidence is a notice, never a block", async () => {
    assert.match(message(await runAsync({ ...closing, agent_id: "hb-b", permission_mode: "auto" })), /not visible/);
    assert.match(trace("hb-b"), /^mode=auto state=absent waited=\d+ after=absent transcript=none branch=auto\n$/);
  });

  test("(c) a delivered valid handback in the transcript is silent", async () => {
    silent(await runAsync({ agent_id: "hb-c", agent_transcript_path: handbackTranscript("t1", "OBS-RESULT: empty none", true) }));
  });

  test("(d) a delivered malformed handback is reported, not blocked", async () => {
    const file = handbackTranscript("t1", `OBS-RESULT: wrote 2 5\n5 ${SECRET}`, true);
    const text = message(await runAsync({ ...closing, agent_id: "hb-d", agent_transcript_path: file }));
    assert.match(text, /still malformed \(wrote count differs from the number of ids\)/);
    assert.doesNotMatch(text, /Example Corp|not confirmed/);
  });

  test("(e) a refused handback is a notice, not a block", async () => {
    const text = message(await runAsync({ ...closing, agent_id: "hb-e", agent_transcript_path: handbackTranscript("t1", "OBS-RESULT: empty none", false) }));
    assert.match(text, /handback did not execute/);
    assert.match(trace("hb-e"), /transcript=refused branch=transcript-error\n$/);
  });

  test("(f) a handback without a visible result is checked and marked unconfirmed", async () => {
    assert.match(message(await runAsync({ ...closing, agent_id: "hb-f", agent_transcript_path: handbackTranscript("t1", "OBS-RESULT: empty none") })),
      /delivery was not confirmed/);
    assert.match(message(await runAsync({ ...closing, agent_id: "hb-f2", agent_transcript_path: handbackTranscript("t1", "OBS-RESULT: empty") })),
      /still malformed \(empty needs a reason\).* \(delivery not confirmed\)$/);
  });

  test("(g) a stale delivery of an earlier handback is cleared, then the transcript decides", async () => {
    plantDelivered("hb-g", "wrote\tt1\n");
    const result = await runAsync({ ...closing, agent_id: "hb-g", agent_transcript_path: handbackTranscript("t2", "OBS-RESULT: empty none") });
    assert.match(message(result), /delivery was not confirmed/);
    assert.equal(fs.existsSync(stateFile("hb-g", "delivered")), false);
    assert.match(trace("hb-g"), /state=stale .*transcript=unknown branch=transcript-unknown\n$/);
  });

  // Issue #611. In this process, not spawned: decide() runs synchronously up to
  // its first await, the first poll of its wait loop, so the record planted
  // right after the call lands after the hook read the state as absent and
  // before it polls again. A record planted beside a spawn races Node's start:
  // on a slow runner it lands first and the trace reads state=present waited=0.
  test("(h) the hook waits for a recorder that lands after the stop", async () => {
    const pending = decide(fields({ ...closing, agent_id: "hb-h", permission_mode: "auto" }), { home: ROOT });
    plantDelivered("hb-h", "wrote\ttoolu_h\n");
    assert.equal(await pending, null, "silent");
    assert.equal(fs.existsSync(stateFile("hb-h", "delivered")), false);
    const match = /^mode=auto state=absent waited=(\d+) after=present transcript=none branch=state\n$/.exec(trace("hb-h"));
    assert.ok(match, trace("hb-h"));
    assert.ok(Number(match[1]) < 2000, `waited ${match[1]} ms`);
  });

  test("(k) an unreadable record is no delivery: the hook waits, then decides without it", async () => {
    plantDelivered("hb-k", "no tab in this line\n");
    assert.match(message(await runAsync({ ...closing, agent_id: "hb-k", permission_mode: "auto" })), /not visible/);
    assert.match(trace("hb-k"), /^mode=auto state=unreadable waited=\d+ after=absent transcript=none branch=auto\n$/);
  });
});

test("(j) the trace holds the fixed keys only, and nothing reaches stdout", () => {
  const result = run({ agent_id: "hb-j", permission_mode: SECRET, last_assistant_message: `OBS-RESULT: failed ${SECRET}` });
  assert.match(message(result), /OBS-RESULT: failed/);
  assert.equal(trace("hb-j"), "mode=other state=absent waited=0 after=- transcript=none branch=final-message\n");
});

// Issue #571: the gate's .refused marker outlives the stop; only .delivered is cleared.
test("(l) the stop clears the delivery and keeps the gate's .refused marker", () => {
  plantDelivered("hb-l", "wrote\ttoolu_l2\n");
  fs.writeFileSync(path.join(STATE, "hb-l.refused"), "refused\ttoolu_l1\n");
  silent(run({ agent_id: "hb-l", last_assistant_message: "Report delivered." }));
  assert.equal(fs.existsSync(stateFile("hb-l", "delivered")), false);
  assert.equal(fs.readFileSync(path.join(STATE, "hb-l.refused"), "utf8"), "refused\ttoolu_l1\n");
  assert.match(trace("hb-l"), /^mode=\S+ state=\S+ waited=\d+ after=\S+ transcript=\S+ branch=\S+\n$/);
});

test("without a valid agent_id there is no state, no wait and no .cache under the home", () => {
  const bare = fixture("bare");
  for (const agent_id of [undefined, "../x"]) {
    const result = run({ agent_id, permission_mode: "auto", last_assistant_message: "Report delivered." }, bare.hook);
    assert.match(message(result), /not visible/);
  }
  assert.equal(fs.existsSync(path.join(bare.root, ".cache")), false);
});
