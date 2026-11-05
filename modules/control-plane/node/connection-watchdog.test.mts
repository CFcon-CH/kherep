import assert from "node:assert/strict";
import test from "node:test";
import { createConnectionWatchdog } from "./connection-watchdog.mts";
import { FakeClock } from "./connection-test-fixture.mts";

function fixture() {
  const clock = new FakeClock(), pings: number[] = [], expired: unknown[] = [];
  let fail = false;
  const watchdog = createConnectionWatchdog({ clock, sendPing: () => { pings.push(clock.now()); if (fail) throw new Error("synthetic"); },
    expire: event => expired.push(event) });
  return { clock, pings, expired, watchdog, fail: () => { fail = true; } };
}
test("OPEN has exactly a 30 second deadline and one expiry", () => {
  const f = fixture(); f.clock.advance(29_999); assert.deepEqual(f.expired, []);
  f.clock.advance(1); assert.equal(f.expired.length, 1);
  assert.equal((f.expired[0] as { code: string }).code, "OPEN_TIMEOUT");
  f.watchdog.open(); f.watchdog.pong(); f.clock.advance(100_000);
  assert.equal(f.expired.length, 1); assert.equal(f.clock.timers.size, 0);
});
test("OPEN pings immediately; absent pong has 45 second deadline plus fresh 5 second confirmation grace", () => {
  const f = fixture(); f.watchdog.open(); assert.deepEqual(f.pings, [0]);
  f.clock.advance(44_999); assert.deepEqual(f.expired, []);
  f.clock.advance(1); assert.deepEqual(f.pings, [0, 45_000]);
  f.clock.advance(4_999); assert.deepEqual(f.expired, []);
  f.clock.advance(1); assert.equal(f.expired.length, 1);
  assert.equal((f.expired[0] as { code: string }).code, "PONG_TIMEOUT");
  f.watchdog.pong(); f.clock.advance(100_000); assert.equal(f.expired.length, 1);
});
test("healthy pong arms the next ping at 30 seconds, no duplicate cycles", () => {
  const f = fixture(); f.watchdog.open(); f.watchdog.open(); f.clock.advance(10); f.watchdog.pong();
  f.clock.advance(29_999); assert.deepEqual(f.pings, [0]);
  f.clock.advance(1); assert.deepEqual(f.pings, [0, 30_010]);
  f.watchdog.pong(); f.clock.advance(30_000); f.watchdog.pong();
  assert.equal(f.clock.timers.size, 1); assert.deepEqual(f.expired, []); f.watchdog.stop();
});
test("late pong within grace cancels expiry and schedules the normal next probe", () => {
  const f = fixture(); f.watchdog.open(); f.clock.advance(49_999); f.watchdog.pong();
  f.clock.advance(1); assert.deepEqual(f.expired, []);
  f.clock.advance(29_999); assert.deepEqual(f.pings, [0, 45_000, 79_999]); f.watchdog.stop();
});
for (const phase of ["waiting", "probe", "grace", "idle"] as const) {
  test(`stop in ${phase} cancels all timers and ignores all later events`, () => {
    const f = fixture();
    if (phase !== "waiting") f.watchdog.open();
    if (phase === "grace") f.clock.advance(45_000);
    if (phase === "idle") f.watchdog.pong();
    const count = f.pings.length; f.watchdog.stop(); f.watchdog.stop(); f.watchdog.open(); f.watchdog.pong();
    f.clock.advance(1_000_000); assert.equal(f.clock.timers.size, 0);
    assert.equal(f.pings.length, count); assert.deepEqual(f.expired, []);
  });
}
for (const phase of ["probe", "idle"] as const) {
  test(`sleep/block while ${phase}: first firing sends confirmation and allows queued pongs`, () => {
    const f = fixture(); f.watchdog.open();
    if (phase === "idle") f.watchdog.pong();
    f.clock.time = 900_000; assert.equal(f.clock.fire(), true);
    assert.deepEqual(f.pings, [0, 900_000]); assert.deepEqual(f.expired, []);
    f.clock.advance(4_999); f.watchdog.pong(); f.clock.advance(1);
    assert.deepEqual(f.expired, []); f.watchdog.stop();
  });
}
test("sleep/block with missing pong expires only after confirmation and fresh grace", () => {
  const f = fixture(); f.watchdog.open(); f.clock.time = 900_000; f.clock.fire();
  f.clock.advance(4_999); assert.deepEqual(f.expired, []);
  f.clock.advance(1); assert.equal(f.expired.length, 1);
});
test("send failure does not extend deadlines, open delay yields at most 80 seconds", () => {
  const f = fixture(); f.fail(); f.clock.advance(29_999); f.watchdog.open();
  f.clock.advance(50_000); assert.equal(f.clock.now(), 79_999); assert.equal(f.expired.length, 1);
  assert.deepEqual(f.pings, [29_999, 74_999]);
});

test("worst case after last pong is 30 + 45 + 5 seconds", () => {
  const f = fixture(); f.watchdog.open(); f.watchdog.pong();
  f.clock.advance(79_999); assert.equal(f.expired.length, 0);
  f.clock.advance(1); assert.equal(f.expired.length, 1); assert.deepEqual(f.pings, [0, 30_000, 75_000]);
});

test("a block during grace yields a timer turn for a queued pong, with no second confirmation", () => {
  const f = fixture(); f.watchdog.open(); f.clock.advance(45_000);
  f.clock.time = 900_000; assert.equal(f.clock.fire(), true);
  assert.equal(f.expired.length, 0); assert.deepEqual(f.pings, [0, 45_000]);
  f.watchdog.pong(); f.clock.advance(5_000); assert.equal(f.expired.length, 0); f.watchdog.stop();
});

test("stop during the final yield cancels the one-shot expiry", () => {
  const f = fixture(); f.watchdog.open(); f.clock.advance(45_000); f.clock.time = 50_000; f.clock.fire();
  assert.equal(f.expired.length, 0); f.watchdog.stop(); f.clock.advance(100_000); assert.equal(f.expired.length, 0);
});

test("a synchronous pong response cannot be overwritten by the sending timer", () => {
  const clock = new FakeClock(), pings: number[] = [];
  const watchdog = createConnectionWatchdog({ clock, expire: () => assert.fail("healthy"), sendPing: () => {
    pings.push(clock.now()); watchdog.pong();
  } });
  watchdog.open(); clock.advance(60_000); assert.deepEqual(pings, [0, 30_000, 60_000]); watchdog.stop();
});

test("an early scheduler callback re-arms the remaining deadline", () => {
  const f = fixture(), [id, timer] = [...f.clock.timers][0];
  f.clock.timers.delete(id); f.clock.time = 1; timer.run();
  f.clock.advance(29_998); assert.equal(f.expired.length, 0);
  f.clock.advance(1); assert.equal(f.expired.length, 1);
});
