import assert from "node:assert/strict";
import test from "node:test";

import { ROUND_LOG_SPACING_MS, ROUND_SLOW_MS, roundTiming, untimed } from "./round-timing.mts";

// Issue #1012: the round line, with an injected monotonic clock, process CPU and host times.
const ROUND_LINE = /^kherep-node: round slow total_ms=\d+ sync_ms=\d+ cpu_ms=\d+ host_busy_pct=(\d+|unknown) skipped=\d+ steps=([a-z-]+:\d+(\+\d+)?\/\d+)(,[a-z-]+:\d+(\+\d+)?\/\d+)*$/;

function clocked(t: test.TestContext) {
  const state = { now: 0, cpu: 0, host: { idle: 0, total: 0 } };
  const lines: string[] = [];
  const timing = roundTiming((line) => lines.push(line), { now: () => state.now, cpu: () => state.cpu, host: () => ({ ...state.host }) });
  t.after(() => { for (const line of lines) assert.match(line, ROUND_LINE); });
  const work = (ms: number, cpu = 0) => (): void => { state.now += ms; state.cpu += cpu; };
  return { state, lines, timing, work };
}

test("1012: a round under the slow threshold logs nothing", (t) => {
  const c = clocked(t);
  const round = c.timing.begin();
  round.step("storage", c.work(ROUND_SLOW_MS - 1, 50));
  round.finish();
  assert.deepEqual(c.lines, []);
});

test("1012: a round of 5000 ms logs exactly one line with its steps in fixed order", (t) => {
  const c = clocked(t);
  const round = c.timing.begin();
  round.step("inbox", c.work(25, 16));
  round.step("storage", c.work(300, 100));
  c.state.now = 5_000; c.state.cpu += 4; c.state.host = { idle: 300, total: 1_000 };
  round.finish();
  assert.deepEqual(c.lines, ["kherep-node: round slow total_ms=5000 sync_ms=325 cpu_ms=120 host_busy_pct=70 skipped=0 steps=storage:300/100,inbox:25/16"]);
});

test("1012: slow rounds under 5 s log at most once per spacing and the next line counts the skipped ones", (t) => {
  const c = clocked(t);
  const round = (ms: number): void => { const r = c.timing.begin(); r.step("tasks", c.work(ms)); c.state.host.total += 10; r.finish(); };
  round(3_000);
  round(3_000);
  assert.equal(c.lines.length, 1);
  assert.match(c.lines[0], / skipped=0 /);
  c.state.now += ROUND_LOG_SPACING_MS;
  round(3_000);
  assert.equal(c.lines.length, 2);
  assert.match(c.lines[1], / skipped=1 /);
});

test("1012: an async step is written as sync+rest/cpu, a synchronous one as sync/cpu", async (t) => {
  const c = clocked(t);
  const round = c.timing.begin();
  round.step("tasks", c.work(1));
  await round.step("codex-inbound", async () => { c.state.now += 50; c.state.cpu += 5; await Promise.resolve(); c.state.now += 12; });
  c.state.now = 5_000;
  round.finish();
  assert.match(c.lines[0], / steps=tasks:1\/0,codex-inbound:50\+12\/5$/);
});

test("1012: a step name used twice adds up", (t) => {
  const c = clocked(t);
  const round = c.timing.begin();
  round.step("policy", c.work(2, 1));
  round.step("policy", c.work(3));
  c.state.now = 5_000;
  round.finish();
  assert.match(c.lines[0], / sync_ms=5 .* steps=policy:5\/1$/);
});

test("1012: a throwing step is recorded and its error rethrown", (t) => {
  const c = clocked(t);
  const round = c.timing.begin();
  assert.throws(() => round.step("exchange", () => { c.state.now += 40; throw new Error("synthetic step failure"); }), /synthetic step failure/);
  c.state.now = 5_000;
  round.finish();
  assert.match(c.lines[0], / steps=exchange:40\/0$/);
});

test("1012: host_busy_pct is unknown when the host sample does not move, and finish twice logs once", (t) => {
  const c = clocked(t);
  const round = c.timing.begin();
  round.step("storage", c.work(5_000));
  round.finish();
  round.finish();
  assert.equal(c.lines.length, 1);
  assert.match(c.lines[0], / host_busy_pct=unknown /);
});

test("1012: untimed runs the step and logs nothing", () => {
  assert.equal(untimed.step("storage", () => 42), 42);
  assert.throws(() => untimed.step("storage", () => { throw new Error("synthetic"); }), /synthetic/);
  untimed.finish();
});
