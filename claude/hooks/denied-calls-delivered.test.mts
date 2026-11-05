// Issue #504. The delivery recorder (PostToolUse on SubagentHandback) run the way the settings
// template wires it, through kherep/hook-runtime/entry.mts reader in a temporary home: a delivered
// line for a delegated handback, nothing otherwise, never output, always exit 0, within its cap.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";

import { denialFaultEnv, faultSpan, MARKER_SLOW_MS, readFaultReceipt, stallFor, type FaultReceipt } from "./denial-fault.fixture.mts";
import { cleanup, entry, runtimeHome, type Home, type Run } from "./hook-runtime-fixture.mts";
import { journalPaths } from "./lib/denial-journal.mts";
import { readJournal, renderReport } from "./lib/denial-report.mts";

after(cleanup);
const RECORDER = "denied-calls-delivered.mts";

function home(unchanged = true): Home {
  const h = runtimeHome("denied-calls-delivered-");
  fs.copyFileSync(path.join(import.meta.dirname, RECORDER), path.join(h.hooks, RECORDER));
  declareCopy(path.join(import.meta.dirname, RECORDER), path.join(h.hooks, RECORDER));
  for (const lib of ["denial-journal.mts", "workspace-scope.mts"]) fs.copyFileSync(path.join(import.meta.dirname, "lib", lib), path.join(h.hooks, "lib", lib));
  if (unchanged) declareCopy(path.join(import.meta.dirname, "lib", "denial-journal.mts"), path.join(h.hooks, "lib", "denial-journal.mts"));
  return h;
}
const payload = (extra: Record<string, unknown> = {}): string => JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "SubagentHandback",
  tool_input: { message: "the worker's report" }, tool_response: "ok", agent_id: "agent-d1", tool_use_id: "toolu_h", cwd: "/w", ...extra });
const record = (h: Home, input: string, env: NodeJS.ProcessEnv = process.env) => entry("reader", path.join(h.hooks, RECORDER), [], input, 20_000, env);

test("a delegated handback leaves one delivered line and nothing of the report; no output, exit 0", () => {
  const h = home();
  fs.mkdirSync(journalPaths(h.root, "agent-d1").dir, { recursive: true });
  fs.writeFileSync(journalPaths(h.root, "agent-d1").journal, `${JSON.stringify({ v: 1, kind: "call", at: "2026-10-21T00:00:00.000Z", id: "t", tool: "Read", agent_type: null, decision: "none", denials: [] })}\n`);
  const run = record(h, payload());
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, "", ""]);
  const text = fs.readFileSync(journalPaths(h.root, "agent-d1").journal, "utf8");
  const last = JSON.parse(text.trim().split("\n").at(-1)!);
  assert.deepEqual([last.v, last.kind, last.id], [1, "delivered", "toolu_h"]);
  assert.ok(!text.includes("report"), "nothing of tool_input.message");
  assert.match(renderReport(readJournal(h.root, "agent-d1")).text, /^DENIED-CALLS: none\nstatus: delivered \d{4}-/);
});

test("nothing without a valid agent_id, for another tool, or for input that is no JSON object", () => {
  const h = home();
  for (const input of [payload({ agent_id: undefined }), payload({ agent_id: "x/y" }), payload({ tool_name: "Read" }), "[]", "nope", ""]) {
    const run = record(h, input);
    assert.deepEqual([run.status, run.stdout], [0, ""]);
  }
  assert.equal(fs.existsSync(journalPaths(h.root, "x").dir), false);
});

test("a write that fails leaves the marker, exit 0", () => {
  const failed = home();
  assert.equal(record(failed, payload(), denialFaultEnv("journal-enospc", RECORDER)).status, 0);
  assert.equal(fs.readFileSync(journalPaths(failed.root, "agent-d1").marker, "utf8"), "append\n");
});

// DEADLINE_MS restates denied-calls-delivered.mts HOOK_TIMEOUT_MS - SAFETY_MARGIN_MS (issue #653).
const DEADLINE_MS = 5_500, LATE_MS = 500, NO_RECEIPT = "no fault receipt: the child was killed or the fault did not engage";
// Issue #664. Why a marker-slow run left no marker: the first violated condition, undefined when the recorder's own
// deadline limited the wait. 4a a clean exit; 4b the calls up to the marker append, then at most one rename; 4c
// exactly one timer armed between the .jsonl and the .failed interception (where the marker's settle arms it), due at
// the deadline or a zero delay armed at it; 4d that timer fired, then the exit; 4e the append had under 500 ms slack.
// TOLERANCE_MS is a classification allowance, not a measured bound.
const TOLERANCE_MS = 10, SLACK_MS = 500, MARKER_PATH = ["mkdir:dir", "appendFile:.jsonl", "appendFile:.failed"];
type RunLike = Pick<Run, "status" | "signal" | "stdout">;
const opsOf = (doc: FaultReceipt): string[] => doc.calls.map((c) => `${c.op}${c.tail ? `:${c.tail}` : ""}`);
const complete = (doc?: FaultReceipt): doc is FaultReceipt => doc !== undefined && typeof doc.originAt === "number"
  && typeof doc.exitAt === "number" && Array.isArray(doc.calls) && Array.isArray(doc.timers);
const markerWaits = (doc: FaultReceipt): FaultReceipt["timers"] => doc.timers.filter((timer) => timer.afterCall === 2);
export function armedForDeadline(doc: FaultReceipt): boolean {
  const waits = markerWaits(doc), end = doc.originAt + DEADLINE_MS;
  return waits.length === 1 && (Math.abs(waits[0]!.due - end) <= TOLERANCE_MS || (waits[0]!.delay === 0 && waits[0]!.armedAt >= end - TOLERANCE_MS));
}
export function deadlineLimited(run: RunLike, doc: FaultReceipt): string | undefined {
  if (run.signal !== null || run.status !== 0 || run.stdout !== "") return "4a";
  const ops = opsOf(doc);
  if (!MARKER_PATH.every((op, i) => ops[i] === op) || ops.length > 4 || (ops.length === 4 && ops[3] !== "rename:.failed")) return "4b";
  if (!armedForDeadline(doc)) return "4c";
  const wait = markerWaits(doc)[0]!;
  if (wait.firedAt === undefined || wait.firedAt < wait.due - TOLERANCE_MS || doc.exitAt < wait.firedAt) return "4d";
  return doc.originAt + DEADLINE_MS - (doc.calls[2]!.at + MARKER_SLOW_MS) < SLACK_MS ? undefined : "4e";
}

// Issue #614. The recorder exits through process.exit(0), which abandons a pending fs.promises write, so the
// marker write is awaited until the recorder's deadline (5.5 s after its start, under the entry's timeout 10)
// instead of a fixed 400 ms slice. Red against the previous recorder: with the append settling after 700 ms
// the read saw ENOENT.
// Issue #664: the recorder's own start-up counts inside its deadline, so under heavy load the marker can be lost.
// Without a marker the run is skipped only when its receipt shows that deadline ended the wait (4a-4e below);
// the marker file read stays the only pass.
test("a marker append that settles late: the marker is on disk when the recorder has exited", (t) => {
  const slow = home();
  const receipt = path.join(slow.root, "fault-receipt.json");
  const run = record(slow, payload(), denialFaultEnv("marker-slow", RECORDER, process.env, receipt));
  const marker = journalPaths(slow.root, "agent-d1").marker;
  if (fs.existsSync(marker)) {
    assert.deepEqual([run.status, run.stdout], [0, ""]);
    assert.match(fs.readFileSync(marker, "utf8"), /^append(-timeout)?\n$/);
    assert.ok(run.ms >= MARKER_SLOW_MS, `${run.ms} ms: the recorder waited for the append`);
    return;
  }
  const doc = readFaultReceipt(receipt);
  assert.ok(complete(doc), `${NO_RECEIPT} (childMs ${run.ms}, signal ${run.signal})`);
  const evidence = JSON.stringify({ childMs: run.ms, ops: opsOf(doc), originAt: doc.originAt, exitAt: doc.exitAt, waits: markerWaits(doc) });
  assert.notDeepEqual(opsOf(doc), [], `no write at all: the stdin read reached its 1.5 s cap (path B) ${evidence}`);
  const violated = deadlineLimited(run, doc);
  assert.equal(violated, undefined, `no marker and not limited by the deadline: ${violated} ${evidence}`);
  t.diagnostic(evidence);
  t.skip("no marker: the recorder's own deadline ended the wait before the 700 ms append");
});

// The journal write ends within its 1.5 s cap; a marker write that never settles is given up at the
// recorder's deadline, 5.5 s after its start (issue #614), before the entry's hook timeout of 10 s.
// Issue #653: measured inside the recorder from its time origin, the anchor of its DEADLINE, by the
// fault receipt.
test("a write that never settles: exit 0 before the recorder deadline, the marker given up there", (t) => {
  const stalled = home();
  const receipt = path.join(stalled.root, "fault-receipt.json");
  const run = record(stalled, payload(), denialFaultEnv("all-hang", RECORDER, process.env, receipt));
  assert.equal(run.signal, null, `killed after ${run.ms} ms`);
  assert.deepEqual([run.status, run.stdout], [0, ""]);
  assert.equal(fs.existsSync(journalPaths(stalled.root, "agent-d1").marker), false, "nothing settled, so no marker: the named residual");
  const { ops, ms } = faultSpan(receipt, "origin");
  t.diagnostic(JSON.stringify({ childMs: run.ms, spanMs: ms, ops }));
  assert.ok(ms !== undefined, `${NO_RECEIPT} (childMs ${run.ms}, signal ${run.signal})`);
  // The journal's mkdir hangs to the cap, then the marker append directly, to the deadline.
  assert.deepEqual(ops, ["mkdir:dir", "appendFile:.failed"]);
  assert.ok(ms < DEADLINE_MS + LATE_MS, `the recorder held ${ms} ms`);
  assert.ok(ms >= DEADLINE_MS - 500, `the deadline was abandoned early: ${ms} ms`);
});

// Issue #664. Contract tests of the classifier on hand-built receipts, times relative to an origin of 0: no process
// is spawned and no clock is read, so no row depends on scheduling. They are not persistence checks.
type Call = FaultReceipt["calls"][number];
const call = (at: number, op: Call["op"], tail: Call["tail"]): Call => ({ at, op, tail });
const CALLS = [call(4_300, "mkdir", "dir"), call(4_350, "appendFile", ".jsonl"), call(4_400, "appendFile", ".failed")];
const STDIN = { afterCall: 0, armedAt: 100, delay: 1_500, due: 1_600 };
const WAIT = { afterCall: 2, armedAt: 4_400, delay: 1_100, due: 5_500, firedAt: 5_501 };
const SLICE = { afterCall: 2, armedAt: 4_400, delay: 400, due: 4_800, firedAt: 5_450 };
const CLEAN: RunLike = { status: 0, signal: null, stdout: "" };
const ROWS: [string, Partial<FaultReceipt>, Partial<RunLike>, string | undefined][] = [
  ["the wait armed for the deadline, fired, then the exit", {}, {}, undefined],
  ["a 400 ms slice firing late at 5 450 (the B3 model)", { timers: [STDIN, SLICE], exitAt: 5_450 }, {}, "4c"],
  ["a sampling gap, due 5 520", { timers: [STDIN, { ...WAIT, due: 5_520 }] }, {}, "4c"],
  ["no timer after the .jsonl interception", { timers: [STDIN] }, {}, "4c"],
  ["two timers after the .jsonl interception", { timers: [STDIN, WAIT, SLICE] }, {}, "4c"],
  ["the wait never fired", { timers: [STDIN, { ...WAIT, firedAt: undefined }] }, {}, "4d"],
  ["the exit before the fire", { exitAt: 5_499 }, {}, "4d"],
  ["a zero delay armed at 5 495", { timers: [STDIN, { afterCall: 2, armedAt: 5_495, delay: 0, due: 5_495, firedAt: 5_496 }], exitAt: 5_497 }, {}, undefined],
  ["one rename after the marker append", { calls: [...CALLS, call(5_500, "rename", ".failed")] }, {}, undefined],
  ["the marker append not reached", { calls: CALLS.slice(0, 2) }, {}, "4b"],
  ["a rename before the marker append", { calls: [CALLS[0]!, CALLS[1]!, call(4_380, "rename", ".failed"), CALLS[2]!] }, {}, "4b"],
  ["exit status 1", {}, { status: 1 }, "4a"],
  ["killed", {}, { signal: "SIGKILL" }, "4a"],
  ["output", {}, { stdout: "x" }, "4a"],
  ["a slack of 600 ms, the marker append at 4 200",
    { calls: [call(4_100, "mkdir", "dir"), call(4_150, "appendFile", ".jsonl"), call(4_200, "appendFile", ".failed")] }, {}, "4e"],
];
for (const [name, doc, run, expected] of ROWS) {
  test(`classifier: ${name}: ${expected ?? "deadline-limited"}`, () => {
    assert.equal(deadlineLimited({ ...CLEAN, ...run }, { calls: CALLS, timers: [STDIN, WAIT], exitAt: 5_503, startAt: 50, originAt: 0, ...doc }), expected);
  });
}

// Issue #664, process-level cases: each states the path and the receipt it reached; none promises load independence.
test("plumbing: a start-up stalled 4.9 s leaves no marker and one recorded marker wait, fired before the exit", (t) => {
  const h = home();
  const receipt = path.join(h.root, "fault-receipt.json");
  const run = record(h, payload(), denialFaultEnv("marker-slow", RECORDER, stallFor(process.env, "startup", 4_900), receipt));
  assert.equal(fs.existsSync(journalPaths(h.root, "agent-d1").marker), false, "the wait ended before the 700 ms append");
  const doc = readFaultReceipt(receipt);
  assert.ok(complete(doc), `${NO_RECEIPT}, or no timers (childMs ${run.ms}, signal ${run.signal})`);
  const waits = markerWaits(doc);
  const evidence = JSON.stringify({ childMs: run.ms, ops: opsOf(doc), originAt: doc.originAt, exitAt: doc.exitAt, waits });
  assert.equal(waits.length, 1, evidence);
  if (doc.exitAt >= waits[0]!.due) assert.notEqual(waits[0]!.firedAt, undefined, evidence);
  if (Math.abs(waits[0]!.due - (doc.originAt + DEADLINE_MS)) <= TOLERANCE_MS) assert.equal(deadlineLimited(run, doc), undefined, evidence);
  else t.diagnostic(`reached path outside the tolerance, not classified: ${evidence}`);
});

// The historical fixed 400 ms slice (no min with the deadline), in the test home only. wrapper-receipt.json records
// which mutation was requested; it never decides the expectation, since settle reads its clock before the timer is armed.
// REAL is interpolated so the static import scan (bootstrap/hook-require-resolution.test.mts) never sees it as this file's import.
const REAL = "./denial-journal.real.mts";
const SLICED = `import fs from "node:fs";
import path from "node:path";
import * as real from "${REAL}";
export * from "${REAL}";
export function markCaptureFailed(home, id, code, until, fsp) {
  const effective = Date.now() + 400;
  fs.writeFileSync(path.join(home, "wrapper-receipt.json"), JSON.stringify({ until, effective }));
  return real.markCaptureFailed(home, id, code, effective, fsp);
}
`;
test("mutation: a marker wait cut to a fixed 400 ms slice is classified 4c when its receipt discriminates", (t) => {
  const h = home(false);
  const lib = path.join(h.hooks, "lib");
  fs.renameSync(path.join(lib, "denial-journal.mts"), path.join(lib, "denial-journal.real.mts"));
  declareCopy(path.join(import.meta.dirname, "lib", "denial-journal.mts"), path.join(lib, "denial-journal.real.mts"));
  fs.writeFileSync(path.join(lib, "denial-journal.mts"), SLICED);
  const receipt = path.join(h.root, "fault-receipt.json"), side = path.join(h.root, "wrapper-receipt.json");
  const run = record(h, payload(), denialFaultEnv("marker-slow", RECORDER, process.env, receipt));
  const doc = readFaultReceipt(receipt);
  assert.ok(doc !== undefined && Array.isArray(doc.timers), `plumbing: ${NO_RECEIPT}, or no timers (childMs ${run.ms})`);
  const violated = complete(doc) ? deadlineLimited(run, doc) : "incomplete receipt";
  const evidence = JSON.stringify({ violated, side: fs.existsSync(side) ? JSON.parse(fs.readFileSync(side, "utf8")) : null, waits: markerWaits(doc) });
  if (complete(doc) && violated !== "4a" && violated !== "4b" && !armedForDeadline(doc)) assert.equal(violated, "4c", evidence);
  else t.diagnostic(`inconclusive for mutation detection: ${evidence}`);
});

// Path B, a named residual (its own issue; this is that issue's red/green test): a stdin read stalled past its 1.5 s
// cap resolves empty although the payload sits in the pipe, so nothing is written. Today's behaviour, no other fault.
test("path B: a stdin read stalled 1.6 s leaves no delivered line and no write at all", () => {
  const h = home();
  const receipt = path.join(h.root, "fault-receipt.json");
  const env = { ...denialFaultEnv("marker-slow", RECORDER, stallFor(process.env, "stdin", 1_600), receipt), KHEREP_DENIAL_FAULT: undefined };
  const run = record(h, payload(), env);
  assert.deepEqual([run.status, run.stdout], [0, ""]);
  assert.equal(fs.existsSync(journalPaths(h.root, "agent-d1").journal), false, "no delivered line");
  const { doc, ops } = faultSpan(receipt, "origin");
  assert.ok(doc !== undefined, `${NO_RECEIPT} (childMs ${run.ms}, signal ${run.signal})`);
  assert.deepEqual(ops, []);
});
