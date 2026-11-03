#!/usr/bin/env node
// Issue #748. Unit tests of the weekly usage rules: threshold, pace guard, parsing of
// missing or odd fields, window identity across rollover, and the toast and notice texts.
import assert from "node:assert/strict";
import test from "node:test";

import {
  CONDITIONS, PACE_MARGIN_POINTS, PACE_MIN_ELAPSED_PERCENT, THRESHOLD_PERCENT, WEEK_SECONDS,
  evaluate, formatLocal, noticeText, parseState, parseWindow, toastText, windowKey, type UsageState,
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

test("A4 notice names each condition that holds and says nothing otherwise", () => {
  const both = noticeText(state(), at(20), "UTC");
  const lines = both.split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "[usage-watch] Weekly Claude plan budget: 55% used, 20% of the 7-day window elapsed (reading from 01:36, resets Thu 06 Feb 16:00). Half of the budget is gone; usage runs ahead of the week.");
  assert.match(lines[1], /^Spend sparingly until the reset/);
  const thresholdOnly = noticeText(state({ used_percentage: 60, conditions: { threshold: true, pace: false } }), at(60), "UTC");
  assert.match(thresholdOnly, /60% used, 60% of the 7-day window elapsed .*\. Half of the budget is gone\.\n/);
  const paceOnly = noticeText(state({ used_percentage: 35, conditions: { threshold: false, pace: true } }), at(17), "UTC");
  assert.match(paceOnly, /35% used, 17% of the 7-day window elapsed .*\. Usage runs ahead of the week\.\n/);
  assert.equal(noticeText(state({ conditions: { threshold: false, pace: false } }), at(20), "UTC"), "", "no condition");
  assert.equal(noticeText(state(), (RESETS + 1) * 1000, "UTC"), "", "window over");
  assert.equal(noticeText(state(), RESETS * 1000, "UTC"), "", "at the reset itself");
  // A recorded pace lead that time has used up is not repeated.
  assert.equal(noticeText(state({ used_percentage: 35, conditions: { threshold: false, pace: true } }), at(40), "UTC"), "");
  for (const text of [both, thresholdOnly, paceOnly, toastText(evaluate({ used: 55, resetsAt: RESETS }, at(20)), "pace").body]) {
    assert.doesNotMatch(text, /[\\<]/, "nothing that breaks toast XML or hook JSON");
  }
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
