#!/usr/bin/env node
// Contract test for obs-handback-gate.mts (issue #571). Drives the gate the way
// the dispatcher does at PreToolUse on SubagentHandback: JSON on stdin,
// a deny or nothing on stdout, always exit 0. The gate and its libs are copied
// into a temporary <root>/hooks/, so the .refused markers land under <root>,
// never in the checkout. stderr is never asserted (Node's ExperimentalWarning).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decide } from "./obs-handback-gate.mts";
import { refusedReason } from "./lib/obs-handback-state.mts";
import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "obs-handback-gate-test-")));
const SECRET = "Example Corp host.example.com";
const BAD = "OBS-RESULT: failed wrote 4 pages: 1,2,3,4";
const BAD_PROBLEM = "failed reason starts with a status word";
const GOOD = "OBS-RESULT: wrote 2 11,22\n11 A\n22 B";

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function fixture(name: string, ...hooks: string[]): { root: string; state: string; hook: (file?: string) => string } {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  for (const file of ["obs-handback-gate.mts", ...hooks]) {
    fs.copyFileSync(path.join(import.meta.dirname, file), path.join(root, "hooks", file));
    declareCopy(path.join(import.meta.dirname, file), path.join(root, "hooks", file));
  }
  fs.cpSync(path.join(import.meta.dirname, "lib"), path.join(root, "hooks", "lib"), { recursive: true });
  return {
    root,
    state: path.join(root, ".cache", "obs-result-check"),
    hook: (file = "obs-handback-gate.mts") => path.join(root, "hooks", file),
  };
}
const MAIN = fixture("home");

interface Run { stdout: string; status: number | null; output: Record<string, unknown> | null }

function runRaw(stdin: string, hook = MAIN.hook()): Run {
  const result = spawnSync(process.execPath, [hook], { input: stdin, encoding: "utf8", env: {
    PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT,
    ...(process.env.NODE_V8_COVERAGE === undefined ? {} : { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }),
  } });
  return { stdout: result.stdout, status: result.status, output: result.stdout ? JSON.parse(result.stdout) : null };
}

const fields = (id: string, message: unknown, extra: Record<string, unknown> = {}) => ({
  session_id: "00000000-0000-4000-8000-000000000000",
  hook_event_name: "PreToolUse",
  cwd: `/srv/${SECRET}`,
  agent_id: id,
  agent_type: "claude-obs",
  tool_name: "SubagentHandback",
  tool_input: { message },
  tool_use_id: "toolu_01ABC",
  ...extra,
});
const run = (id: string, message: unknown, extra: Record<string, unknown> = {}, hook = MAIN.hook()): Run =>
  runRaw(JSON.stringify(fields(id, message, extra)), hook);

let seq = 0;
const nextId = () => `rec-${++seq}`;
const marker = (id: string, state = MAIN.state) => path.join(state, `${id}.refused`);
const markerOf = (id: string, state = MAIN.state) => fs.existsSync(marker(id, state)) ? fs.readFileSync(marker(id, state), "utf8") : null;
const deny = (problem: string) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: refusedReason(problem) },
});

const silent = (result: Run, label = "") => assert.deepEqual([result.status, result.stdout], [0, ""], label);

test("T1 other tools and other agents are silent and create no state", () => {
  const scope = fixture("scope");
  for (const extra of [{ tool_name: "Bash" }, { agent_type: "general-purpose" }, { agent_type: undefined }]) {
    silent(run(nextId(), BAD, extra, scope.hook()), JSON.stringify(extra));
  }
  assert.equal(fs.existsSync(path.join(scope.root, ".cache")), false);
});

test("T2 a valid status line passes without a marker", () => {
  for (const message of [GOOD, "OBS-RESULT: empty nothing new", "OBS-RESULT: failed missing broker"]) {
    const id = nextId();
    silent(run(id, message), message);
    assert.equal(markerOf(id), null);
  }
});

test("T3 malformed is refused once, corrected passes, malformed again passes", () => {
  const id = nextId();
  const first = run(id, BAD, { tool_use_id: "toolu_1" });
  assert.equal(first.status, 0);
  assert.deepEqual(first.output, deny(BAD_PROBLEM));
  assert.equal(markerOf(id), "refused\ttoolu_1\n");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(marker(id)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(MAIN.state).mode & 0o777, 0o700);
  }
  silent(run(id, GOOD, { tool_use_id: "toolu_2" }), "corrected");
  silent(run(id, BAD, { tool_use_id: "toolu_3" }), "second malformed");
  assert.equal(markerOf(id), "refused\ttoolu_1\n");
});

test("T4 a second id is refused once, independently", () => {
  const a = nextId();
  const b = nextId();
  assert.deepEqual(run(a, BAD).output, deny(BAD_PROBLEM));
  assert.deepEqual(run(b, "OBS-RESULT: empty x\nOBS-RESULT: empty y").output, deny("more than one OBS-RESULT line"));
  silent(run(a, BAD));
  silent(run(b, BAD));
});

test("T5 a handback without a visible message passes without a marker", () => {
  for (const message of [undefined, 42, "", "   "]) {
    const id = nextId();
    silent(run(id, message), String(message));
    assert.equal(markerOf(id), null);
  }
});

test("T6 without a valid agent_id nothing is refused and nothing is written", () => {
  for (const agent_id of [undefined, 42, "../escape", "a b", "x".repeat(65)]) {
    silent(run("unused", BAD, { agent_id }), String(agent_id));
  }
  // Every file under <root>/.cache is a marker of a valid rec-<n> id, wherever an invalid id would have landed.
  const cache = path.join(MAIN.root, ".cache");
  const written = fs.existsSync(cache) ? fs.readdirSync(cache, { recursive: true }).map((name) => String(name).replace(/\\/g, "/")) : [];
  for (const name of written) assert.match(name, /^obs-result-check(\/rec-\d+\.refused)?$/, name);
});

test("T7 a directory in the marker's place passes", () => {
  const id = nextId();
  fs.mkdirSync(marker(id), { recursive: true });
  silent(run(id, BAD));
  assert.ok(fs.statSync(marker(id)).isDirectory());
});

const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
test("T7 a marker that cannot be created passes", { skip: process.platform === "win32" || asRoot }, () => {
  const locked = fixture("locked");
  fs.mkdirSync(locked.state, { recursive: true });
  fs.chmodSync(locked.state, 0o500);
  try {
    silent(run("lock-1", BAD, {}, locked.hook()));
    assert.deepEqual(fs.readdirSync(locked.state), []);
  } finally {
    fs.chmodSync(locked.state, 0o700);
  }
});

test("T8 nothing from the message or the payload reaches stdout", () => {
  const id = nextId();
  const result = run(id, `${BAD} ${SECRET}`);
  assert.deepEqual(result.output, deny(BAD_PROBLEM));
  for (const fragment of ["Example Corp", "host.example.com", "00000000-0000", "/srv/", id, "toolu_01ABC", MAIN.root]) {
    assert.ok(!result.stdout.includes(fragment), `${fragment} leaked: ${result.stdout}`);
  }
});

test("T9 an unreadable payload passes", () => {
  for (const stdin of ["{not json", "", "[]", "null"]) {
    const result = runRaw(stdin);
    assert.deepEqual([result.status, result.stdout], [0, ""], stdin);
  }
});

test("T10 decide() returns null for an allow and the deny object otherwise", () => {
  const home = fs.mkdtempSync(path.join(TMP, "decide-"));
  assert.equal(decide(fields("in-1", GOOD), home), null);
  assert.equal(decide(fields("in-1", BAD, { tool_name: "Bash" }), home), null);
  const output = decide(fields("in-1", BAD), home);
  assert.deepEqual(output, deny(BAD_PROBLEM));
  assert.doesNotMatch(output!.hookSpecificOutput.permissionDecisionReason, /\n/);
  assert.equal(decide(fields("in-1", BAD), home), null);
});

// D1: the marker outlives the stop hook's clear, prune and trace, so a resumed
// agent with the same id is never refused twice, however old the marker is.
test("T11 an aged marker survives the real stop path, and the same id is not refused again", () => {
  const aged = fixture("aged", "obs-result-check.mts");
  const first = run("age-1", BAD, { tool_use_id: "toolu_age1" }, aged.hook());
  assert.deepEqual(first.output, deny(BAD_PROBLEM));
  const then = new Date(Date.now() - 25 * 3_600_000);
  const file = (name: string) => path.join(aged.state, name);
  fs.writeFileSync(file("age-1.delivered"), "wrote\ttoolu_age1b\n");
  fs.writeFileSync(file("age-0.delivered"), "empty\ttoolu_age0\n");
  fs.writeFileSync(file("age-0.stop"), "mode=auto state=absent waited=0 after=- transcript=none branch=auto\n");
  fs.writeFileSync(file("age-0.refused"), "refused\ttoolu_age0\n");
  for (const name of ["age-1.refused", "age-1.delivered", "age-0.delivered", "age-0.stop", "age-0.refused"]) {
    fs.utimesSync(file(name), then, then);
  }
  const stop = runRaw(JSON.stringify({
    session_id: "00000000-0000-4000-8000-000000000000", hook_event_name: "SubagentStop", agent_id: "age-1",
    agent_type: "claude-obs", permission_mode: "auto", stop_hook_active: false, last_assistant_message: "Report delivered.",
  }), aged.hook("obs-result-check.mts"));
  silent(stop, "stop hook");
  silent(run("age-1", BAD, { tool_use_id: "toolu_age1c" }, aged.hook()), "resumed malformed handback");
  assert.equal(fs.readFileSync(file("age-1.refused"), "utf8"), "refused\ttoolu_age1\n");
  assert.equal(fs.existsSync(file("age-1.delivered")), false, "cleared by clearDelivered");
  assert.match(fs.readFileSync(file("age-1.stop"), "utf8"), /^mode=auto state=present waited=0 after=- transcript=none branch=state\n$/);
  assert.equal(fs.existsSync(file("age-0.delivered")), false, "pruned");
  assert.equal(fs.existsSync(file("age-0.stop")), false, "pruned");
  assert.equal(fs.readFileSync(file("age-0.refused"), "utf8"), "refused\ttoolu_age0\n");
});
