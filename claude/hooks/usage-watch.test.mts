#!/usr/bin/env node
// Contract test for usage-watch.mts (issues #748, #757): the notice appears for the model
// (additionalContext) and the person (systemMessage) when the cached state says a condition
// holds in an open window, and nothing appears otherwise; exit 0 always.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WEEK_SECONDS, noticeText, userNotice, windowKey, type UsageState } from "./lib/usage-window.mts";
import { promptNotice, promptOutput } from "./usage-watch.mts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "usage-watch-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const RESETS = 1738857600;
const at = (elapsedPercent: number) => (RESETS - WEEK_SECONDS + WEEK_SECONDS * elapsedPercent / 100) * 1000;

function state(over: Partial<UsageState> = {}): UsageState {
  return {
    v: 1, window_key: windowKey(RESETS), resets_at: RESETS, used_percentage: 55, elapsed_percentage: 20,
    observed_at: new Date(at(20)).toISOString(), conditions: { threshold: true, pace: true }, notified: {}, ...over,
  };
}

test("C1 both conditions in an open window: the two-line notice", () => {
  const text = promptNotice(JSON.stringify(state()), at(20), "UTC");
  const lines = text.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[usage-watch\] Weekly Claude plan budget: 55% used, 20% of the 7-day window elapsed/);
  assert.match(lines[0], /resets Thu 06 Feb 16:00\)/);
  assert.match(lines[0], /Half of the budget is gone; usage runs ahead of the week\.$/);
});

test("C2 clean, over, malformed, other version or missing state: silent", () => {
  assert.equal(promptNotice(JSON.stringify(state({ conditions: { threshold: false, pace: false } })), at(20), "UTC"), "");
  assert.equal(promptNotice(JSON.stringify(state()), (RESETS + 60) * 1000, "UTC"), "");
  assert.equal(promptNotice("{broken", at(20), "UTC"), "");
  assert.equal(promptNotice(JSON.stringify({ ...state(), v: 2 }), at(20), "UTC"), "");
  assert.equal(promptNotice(null, at(20), "UTC"), "");
});

// A home whose state.json warns now: the window is centred on the current time.
function homeWith(content: string | null): string {
  const home = fs.mkdtempSync(path.join(TMP, "home-"));
  if (content !== null) {
    fs.mkdirSync(path.join(home, ".cache", "usage-watch"), { recursive: true });
    fs.writeFileSync(path.join(home, ".cache", "usage-watch", "state.json"), content, "utf8");
  }
  return home;
}

const live = (over: Partial<UsageState> = {}) => {
  const resets = Math.round(Date.now() / 1000 + WEEK_SECONDS * 0.8); // 20 % elapsed
  return JSON.stringify(state({ resets_at: resets, window_key: windowKey(resets), observed_at: new Date().toISOString(), ...over }));
};

function spawnHook(stdin: string, home: string) {
  return spawnSync(process.execPath, [path.join(HERE, "usage-watch.mts")], {
    input: stdin, encoding: "utf8", env: { ...process.env, CLAUDE_HOME: home },
  });
}

type Output = { systemMessage: string; hookSpecificOutput: { hookEventName: string; additionalContext: string } };

test("C4 promptOutput: the person's line and the model's context together, or nothing", () => {
  const text = promptOutput(JSON.stringify(state()), at(20), "UTC");
  const out = JSON.parse(text) as Output;
  assert.deepEqual(Object.keys(out).sort(), ["hookSpecificOutput", "systemMessage"]);
  assert.equal(out.systemMessage, userNotice(state(), at(20), "UTC"));
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(out.hookSpecificOutput.additionalContext, noticeText(state(), at(20), "UTC"));
  assert.match(out.systemMessage, /^Weekly Claude budget: 55% used/);
  assert.equal(promptOutput(JSON.stringify(state({ conditions: { threshold: false, pace: false } })), at(20), "UTC"), "");
  assert.equal(promptOutput(JSON.stringify(state()), (RESETS + 60) * 1000, "UTC"), "");
  assert.equal(promptOutput("{broken", at(20), "UTC"), "");
  assert.equal(promptOutput(null, at(20), "UTC"), "");
});

test("C3 as a hook: JSON systemMessage and additionalContext when the state warns", () => {
  const run = spawnHook(JSON.stringify({ cwd: "/somewhere", prompt: "Example Corp secret" }), homeWith(live()));
  assert.equal(run.status, 0);
  const out = JSON.parse(run.stdout) as Output;
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /^\[usage-watch\] Weekly Claude plan budget: 55% used, 20% of the 7-day window/);
  assert.match(out.systemMessage, /^Weekly Claude budget: 55% used, 20% of the 7-day window elapsed \(reading from \d\d:\d\d, resets /);
  assert.doesNotMatch(run.stdout, /Example Corp|somewhere/, "the payload is never echoed");
});

test("C3 as a hook: silence and exit 0 for clean, absent or malformed state and non-JSON stdin", () => {
  const cases: Array<[string, string]> = [
    ["clean", homeWith(live({ conditions: { threshold: false, pace: false } }))],
    ["absent", homeWith(null)],
    ["malformed", homeWith("{\"v\":1,")],
  ];
  for (const [label, home] of cases) {
    const run = spawnHook("{}", home);
    assert.equal(run.status, 0, label);
    assert.equal(run.stdout, "", label);
  }
  const notJson = spawnHook("not json", homeWith(live()));
  assert.equal(notJson.status, 0);
  assert.equal(notJson.stdout, "");
});
