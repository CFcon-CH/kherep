import assert from "node:assert/strict";
import test from "node:test";
import { makeEnvelope, PING_FRAME, PONG_FRAME } from "../protocol.mts";
import { FakeClock } from "./connection-test-fixture.mts";
import { PONG_DEADLINE_MS } from "./connection-watchdog.mts";
import { createIntakeDiagnostics, diagnosticNumbers, FRAME_CLASSES } from "./intake-diagnostics.mts";

const frame = (type: Parameters<typeof makeEnvelope>[0], body = {}): string => JSON.stringify(makeEnvelope(type, body, 0, 0));
function fixture() {
  const clock = new FakeClock(), lines: string[] = [], snapshots: unknown[] = [];
  let pending = false;
  const diagnostics = createIntakeDiagnostics({ clock, wall: () => 100_000 + clock.now(), log: line => lines.push(line),
    pending: () => pending, publish: snapshot => snapshots.push(snapshot) });
  return { clock, lines, snapshots, diagnostics, pending: (value: boolean) => { pending = value; } };
}

test("callback captures fixed classes and numbers, without logging or publishing", () => {
  const f = fixture(), d = f.diagnostics;
  const data = frame("event", { name: "auth.ok", text: "PRIVATE /path host.example.invalid" });
  assert.equal(d.receive(data).kind, FRAME_CLASSES.indexOf("auth"));
  d.receive(PONG_FRAME); d.sent(PING_FRAME); d.sent(frame("message.send")); d.receive("PRIVATE");
  assert.deepEqual(f.lines, []); assert.deepEqual(f.snapshots, []);
  const value = d.snapshot();
  assert.equal(value.rx.reduce((a, b) => a + b, 0), 3);
  assert.equal(value.tx.reduce((a, b) => a + b, 0), 2);
  assert.equal(value.pongWallMs, 100_000);
  assert.equal(JSON.stringify(value).includes("PRIVATE"), false);
  assert.deepEqual(diagnosticNumbers({ ...value, secret: "PRIVATE" }), value);
  assert.equal(diagnosticNumbers({ ...value, lagMs: "PRIVATE" }), undefined);
  assert.equal(diagnosticNumbers(null), undefined);
  d.stop(); assert.equal(f.clock.timers.size, 0);
});

test("original arrival survives deferral: age boundary, lane entry/exit and rate limit", async () => {
  const f = fixture(), d = f.diagnostics;
  const first = d.receive(frame("message.deliver"));
  f.clock.advance(30_000);
  await d.process(first, async () => {});
  assert.deepEqual(f.lines, []);
  f.clock.advance(1);
  await d.process(first, async () => { f.clock.advance(4); });
  assert.equal(f.lines.length, 1);
  assert.match(f.lines[0], /^INTAKE_DIAG code=1 class=\d+ mono_ms=30001 wall_ms=130001 age_ms=30001 lag_ms=0/);
  const snapshot = d.snapshot();
  assert.equal(snapshot.enterMs[first.kind], 30_001); assert.equal(snapshot.exitMs[first.kind], 30_005);
  await d.process(first, async () => {}); assert.equal(f.lines.length, 1);
  f.clock.advance(60_000); await d.process(first, async () => {});
  assert.equal(f.lines.length, 2); d.stop();
});

test("blocked loop is measured independently; no warning at exactly five seconds", () => {
  const f = fixture();
  f.clock.time = 6_000; f.clock.fire(); assert.deepEqual(f.lines, []);
  f.clock.time = 12_001; f.clock.fire();
  assert.equal(f.lines.length, 1); assert.match(f.lines[0], /code=2 .*lag_ms=5001/);
  f.clock.time += 20_000; f.clock.fire(); assert.equal(f.lines.length, 1);
  f.diagnostics.stop();
});

test("application silence requires known pending work and continuing fresh pongs", () => {
  const f = fixture(), d = f.diagnostics;
  for (let n = 0; n < 40; n++) { f.clock.advance(1_000); d.receive(PONG_FRAME); }
  assert.deepEqual(f.lines, []); f.pending(true);
  for (let n = 0; n < 31; n++) { d.receive(PONG_FRAME); f.clock.advance(1_000); }
  assert.deepEqual(f.lines, []);
  f.clock.advance(1_000);
  assert.equal(f.lines.length, 1); assert.match(f.lines[0], /code=3 .*app_gap_ms=72000 .*pending=1/);
  f.clock.advance(30_000); assert.equal(f.lines.length, 1, "one warning per silence episode");
  const arrival = d.receive(frame("message.status"));
  assert.equal(d.snapshot().rx[arrival.kind], 1);
  f.pending(false); f.clock.advance(1_000); f.pending(true);
  f.clock.advance(100_000); assert.equal(f.lines.length, 1, "stale pongs are not continuing pongs");
  d.stop();
});

test("all envelope classes are fixed, no incoming type or event name reaches output", () => {
  const f = fixture(), d = f.diagnostics;
  for (const [type, body] of [["challenge", {}], ["auth", {}], ["message.status", {}], ["event", { name: "message.receipt" }],
    ["message.resolve.request", {}], ["command", {}], ["mcp.intent.receipt", {}]] as const) d.receive(frame(type, body));
  assert.equal(d.snapshot().rx.reduce((a, b) => a + b, 0), 7);
  const value = d.snapshot(); value.rx[0] = -1;
  assert.equal(diagnosticNumbers(value), undefined); d.stop();
});

test("a suppressed second silence episode stays eligible after the rate limit expires", () => {
  const f = fixture(), d = f.diagnostics;
  f.pending(true);
  const pongs = (seconds: number): void => {
    for (let n = 0; n < seconds; n++) { d.receive(PONG_FRAME); f.clock.advance(1_000); }
  };
  pongs(32); assert.equal(f.lines.length, 1);
  d.receive(frame("message.status")); pongs(32);
  assert.equal(f.lines.length, 1, "second silence is still rate limited");
  pongs(28); assert.equal(f.lines.length, 2, "continuing second silence eventually reports");
  d.stop();
});

// Issue #961: a gap of at least PONG_DEADLINE_MS (host sleep or a stalled loop) wakes the watchdog.
test("a tick gap of at least the pong deadline signals wake, a shorter one does not", () => {
  const clock = new FakeClock(), wakes: number[] = [];
  const diagnostics = createIntakeDiagnostics({ clock, log: () => {}, pending: () => false, wake: () => wakes.push(clock.now()) });
  clock.time = 1_000 + PONG_DEADLINE_MS - 1; clock.fire(); assert.deepEqual(wakes, [], "below the deadline");
  const due = clock.time + 1_000;
  clock.time = due + PONG_DEADLINE_MS; clock.fire(); assert.deepEqual(wakes, [due + PONG_DEADLINE_MS]);
  clock.advance(10_000); assert.equal(wakes.length, 1, "regular ticks do not wake");
  diagnostics.stop();
});

// Issue #1012: the arrival carries the tick's overdue amount and the last tick's lag and age, separately.
test("1012: an arrival records the overdue tick, the last tick's lag and its age, in memory only", () => {
  const f = fixture(), d = f.diagnostics;
  const idle = d.receive(PONG_FRAME);
  assert.equal(idle.overdueMs, 0, "an idle clock is not overdue");
  assert.equal(idle.tickLagMs, undefined, "no tick ran yet");
  f.clock.time = 1_700; // past the tick's due time; the tick has not run
  const overdue = d.receive(frame("message.resolve.request"));
  assert.equal(overdue.overdueMs, 700);
  assert.equal(overdue.tickAgeMs, undefined);
  f.clock.time = 3_500; f.clock.fire(); // a tick 2500 ms late
  const late = d.receive(frame("message.resolve.request"));
  assert.deepEqual([late.overdueMs, late.tickLagMs, late.tickAgeMs], [0, 2_500, 0]);
  f.clock.time += 400;
  const after = d.receive(frame("message.resolve.request"));
  assert.deepEqual([after.overdueMs, after.tickLagMs, after.tickAgeMs], [0, 2_500, 400]);
  assert.deepEqual(f.lines, []); assert.deepEqual(f.snapshots, []);
  d.stop();
});
