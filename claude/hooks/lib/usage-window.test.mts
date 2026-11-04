#!/usr/bin/env node
// Issue #748. Unit tests of the weekly usage rules: threshold, pace guard, parsing of
// missing or odd fields, window identity across rollover, and the toast and notice texts.
import assert from "node:assert/strict";
import test from "node:test";

import {
  CONDITIONS, PACE_MARGIN_POINTS, PACE_MIN_ELAPSED_PERCENT, THRESHOLD_PERCENT, WEEK_SECONDS,
  evaluate, formatLocal, parseState, parseWindow, toastText, windowKey, type UsageState,
} from "./usage-window.mts";

const RESETS = 1738857600; // Thu 06 Feb 2025 16:00 UTC, the documented example
const START = RESETS - WEEK_SECONDS;
// Epoch ms at a given elapsed percentage of the window.
const at = (elapsedPercent: number) => (START + WEEK_SECONDS * elapsedPercent / 100) * 1000;

test("constants match the approved design", () => {
  assert.equal(THRESHOLD_PERCENT, 50);
  assert.equal(PACE_MIN_ELAPSED_PERCENT, 10);
  assert.equal(PACE_MARGIN_POINTS, 5);
  assert.deepEqual(CONDITIONS, ["threshold", "pace"]);
});

test("A1 threshold: 49.9 no, 50 and above yes, above 100 still yes", () => {
  for (const [used, expected] of [[49.9, false], [50, true], [50.1, true], [104, true]] as const) {
    assert.equal(evaluate({ used, resetsAt: RESETS }, at(90)).threshold, expected, String(used));
  }
});

test("A2 pace: minimum elapsed, the 5-point margin and the issue example", () => {
  assert.equal(evaluate({ used: 39.9, resetsAt: RESETS }, at(9.9)).pace, false, "before 10 % elapsed");
  assert.equal(evaluate({ used: 15, resetsAt: RESETS }, at(10)).pace, true, "lead of exactly 5 at 10 %");
  assert.equal(evaluate({ used: 14.9, resetsAt: RESETS }, at(10)).pace, false, "lead 4.9");
  const example = evaluate({ used: 35, resetsAt: RESETS }, at(17));
  assert.equal(example.pace, true);
  assert.equal(example.threshold, false);
  assert.ok(Math.abs(example.elapsed - 17) < 1e-9);
  assert.equal(evaluate({ used: 35, resetsAt: RESETS }, (START - 3600) * 1000).elapsed, 0);
  assert.equal(evaluate({ used: 35, resetsAt: RESETS }, (RESETS + 3600) * 1000).elapsed, 100);
});

test("A3 parse: missing or odd fields are no window, never a zero", () => {
  assert.equal(parseWindow(undefined, RESETS), null);
  assert.equal(parseWindow(41.2, undefined), null);
  assert.equal(parseWindow("abc", RESETS), null);
  assert.equal(parseWindow(41.2, "abc"), null);
  assert.equal(parseWindow(Number.NaN, RESETS), null);
  assert.equal(parseWindow(Number.POSITIVE_INFINITY, RESETS), null);
  assert.equal(parseWindow(null, RESETS), null);
  assert.equal(parseWindow(41.2, null), null);
  assert.equal(parseWindow("", RESETS), null);
  assert.deepEqual(parseWindow("41.2", String(RESETS)), { used: 41.2, resetsAt: RESETS });
  assert.deepEqual(parseWindow(41.2, RESETS * 1000), { used: 41.2, resetsAt: RESETS }, "milliseconds guard");
  assert.deepEqual(parseWindow(41.2, "2025-02-06T16:00:00Z"), { used: 41.2, resetsAt: RESETS }, "ISO string");
});

test("A3 window identity: sub-minute jitter keeps the key, a new window changes it", () => {
  assert.equal(windowKey(RESETS), windowKey(RESETS + 20));
  assert.notEqual(windowKey(RESETS), windowKey(RESETS + 120));
  assert.notEqual(windowKey(RESETS), windowKey(RESETS + WEEK_SECONDS));
});

function state(over: Partial<UsageState> = {}): UsageState {
  return {
    v: 1, window_key: windowKey(RESETS), resets_at: RESETS, used_percentage: 55, elapsed_percentage: 20,
    observed_at: new Date(at(20)).toISOString(), conditions: { threshold: true, pace: true }, notified: {}, ...over,
  };
}

test("A4 local date format", () => {
  assert.equal(formatLocal(RESETS, "UTC"), "Thu 06 Feb 16:00");
  assert.equal(formatLocal(RESETS, "Europe/Berlin"), "Thu 06 Feb 17:00");
});

test("A4 toast texts carry used, elapsed and reset time", () => {
  const v = evaluate({ used: 55, resetsAt: RESETS }, at(20));
  assert.deepEqual(toastText(v, "threshold", "UTC"), {
    title: "Claude weekly budget: half used",
    body: "55% of the 7-day plan budget used after 20% of the window. Resets Thu 06 Feb 16:00.",
  });
  const p = evaluate({ used: 35, resetsAt: RESETS }, at(17));
  assert.deepEqual(toastText(p, "pace", "UTC"), {
    title: "Claude weekly usage ahead of pace",
    body: "35% used after 17% of the 7-day window. Resets Thu 06 Feb 16:00.",
  });
});

test("the toast text holds nothing that breaks toast XML", () => {
  const body = toastText(evaluate({ used: 55, resetsAt: RESETS }, at(20)), "pace").body;
  assert.doesNotMatch(body, /[\<]/);
});

test("parseState accepts only the recorder's v1 shape", () => {
  assert.deepEqual(parseState(JSON.stringify(state())), state());
  assert.equal(parseState(null), null);
  assert.equal(parseState("{not json"), null);
  assert.equal(parseState(JSON.stringify({ ...state(), v: 2 })), null);
  assert.equal(parseState(JSON.stringify({ ...state(), resets_at: "soon" })), null);
  assert.equal(parseState(JSON.stringify({ ...state(), conditions: { threshold: true } })), null);
  assert.equal(parseState(JSON.stringify([state()])), null);
});
