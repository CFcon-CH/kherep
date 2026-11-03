#!/usr/bin/env node
// Functional test for usage-record.mts (issue #748): a synthetic weekly window produces the
// state file and exactly one toast per condition per reset window, also with two recorders
// at once. No real toast is shown: KHEREP_USAGE_TOAST_LOG records it instead.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WEEK_SECONDS, windowKey } from "./lib/usage-window.mts";
import { TOAST_APP_ID, deliverToast, notifierArgs, toastArgs } from "./usage-record.mts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "usage-record.mts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "usage-record-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const RESETS = 1738857600;
const at = (resets: number, elapsedPercent: number) => String(Math.round((resets - WEEK_SECONDS + WEEK_SECONDS * elapsedPercent / 100) * 1000));

function setup() {
  const home = fs.mkdtempSync(path.join(TMP, "home-"));
  const dir = path.join(home, ".cache", "usage-watch");
  const log = path.join(home, "toasts.log");
  const env: Record<string, string | undefined> = { ...process.env, KHEREP_USAGE_TOAST_LOG: log };
  delete env.KHEREP_USAGE_TOAST;
  delete env.CLAUDE_HOME;
  const argv = (args: string[]) => [SCRIPT, "--home", home, ...args];
  const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(process.execPath, argv(args), { encoding: "utf8", env: { ...env, ...extra } });
  const start = (args: string[]) => new Promise<number | null>((resolve) => {
    spawn(process.execPath, argv(args), { env, stdio: "ignore" }).on("close", resolve);
  });
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  const markers = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith("toast-")).sort() : []);
  return { home, dir, run, start, lines, state, markers };
}

test("B1-B3 one toast per condition per window, rollover re-arms", () => {
  const t = setup();
  for (let i = 0; i < 3; i++) {
    const r = t.run(["--used", "55", "--resets-at", String(RESETS), "--now", at(RESETS, 20)]);
    assert.equal(r.status, 0, r.stderr);
  }
  const key = windowKey(RESETS);
  let s = t.state();
  assert.deepEqual(s.conditions, { threshold: true, pace: true });
  assert.deepEqual(Object.keys(s.notified).sort(), ["pace", "threshold"]);
  assert.equal(t.lines().length, 2);
  assert.match(t.lines()[0], /^Claude weekly budget: half used\t55% of the 7-day plan budget used after 20% of the window\. Resets /);
  assert.match(t.lines()[1], /^Claude weekly usage ahead of pace\t55% used after 20% of the 7-day window\. Resets /);
  assert.deepEqual(t.markers(), [`toast-${key}-pace`, `toast-${key}-threshold`]);

  // B2: same window, more usage: no new toast, fresh state and throttle.
  t.run(["--used", "70", "--resets-at", String(RESETS), "--now", at(RESETS, 30)]);
  assert.equal(t.lines().length, 2);
  assert.equal(t.state().used_percentage, 70);
  assert.equal(fs.readFileSync(path.join(t.dir, "last-input"), "utf8"), `70|${RESETS}\n`);

  // B3: next week's window toasts again and drops the old markers.
  const next = RESETS + WEEK_SECONDS;
  t.run(["--used", "55", "--resets-at", String(next), "--now", at(next, 20)]);
  assert.equal(t.lines().length, 4);
  const nextKey = windowKey(next);
  assert.deepEqual(t.markers(), [`toast-${nextKey}-pace`, `toast-${nextKey}-threshold`]);
  s = t.state();
  assert.equal(s.window_key, nextKey);
  assert.deepEqual(Object.keys(s.notified).sort(), ["pace", "threshold"]);
  const r = t.run(["--used", "56", "--resets-at", String(next), "--now", at(next, 21)]);
  assert.match(r.stdout, /^usage-record: used 56% elapsed 21% threshold=yes pace=yes toast=none\n$/);
});

test("B4 no window in the input: nothing written, exit 0", () => {
  for (const args of [["--used", "55"], ["--used", "abc", "--resets-at", String(RESETS)], ["--resets-at", String(RESETS)]]) {
    const t = setup();
    const r = t.run(args);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /usage-record: no weekly window in input/);
    assert.equal(fs.existsSync(path.join(t.dir, "state.json")), false);
    assert.equal(fs.existsSync(path.join(t.dir, "last-input")), false);
    assert.deepEqual(t.lines(), []);
  }
});

test("B5 two recorders at once still toast at most once per condition", async () => {
  for (let round = 0; round < 3; round++) {
    const t = setup();
    const args = ["--used", "55", "--resets-at", String(RESETS), "--now", at(RESETS, 20)];
    await Promise.all([t.start(args), t.start(args)]);
    const lines = t.lines();
    assert.equal(lines.filter((l) => l.startsWith("Claude weekly budget")).length, 1, lines.join("\n"));
    assert.equal(lines.filter((l) => l.startsWith("Claude weekly usage ahead")).length, 1, lines.join("\n"));
    assert.deepEqual(Object.keys(t.state().notified).sort(), ["pace", "threshold"]);
  }
});

test("B6 opt-out and platforms without a notifier: no toast, no marker, state still written", () => {
  const t = setup();
  const r = t.run(["--used", "55", "--resets-at", String(RESETS), "--now", at(RESETS, 20)], { KHEREP_USAGE_TOAST: "0" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(t.lines(), []);
  assert.deepEqual(t.markers(), []);
  assert.deepEqual(t.state().notified, {});
  assert.deepEqual(t.state().conditions, { threshold: true, pace: true });
  const text = { title: "t", body: "b" };
  assert.equal(deliverToast(text, {}, "linux"), "skipped:platform");
  assert.equal(deliverToast(text, { KHEREP_USAGE_TOAST: "0" }, "win32"), "skipped:disabled");
  assert.equal(deliverToast(text, { KHEREP_USAGE_TOAST: "0" }, "darwin"), "skipped:disabled");
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "usage-record-mac-")), "toasts.log");
  assert.equal(deliverToast(text, { KHEREP_USAGE_TOAST_LOG: log }, "darwin"), "sent");
  assert.equal(fs.readFileSync(log, "utf8"), "t\tb\n");
  fs.rmSync(path.dirname(log), { recursive: true, force: true });
});

test("B7b the macOS notifier is osascript display notification with escaped text, argv only", () => {
  const n = notifierArgs("darwin", 'Budget "half" \\ used', "55% used. Resets Thu 06 Nov 09:00.");
  assert.equal(n.command, "osascript");
  assert.deepEqual(n.args, ["-e", 'display notification "55% used. Resets Thu 06 Nov 09:00." with title "Budget \\"half\\" \\\\ used"']);
  const w = notifierArgs("win32", "t", "b", { SystemRoot: "Z:\\NoWindows" });
  assert.equal(w.command, "powershell.exe");
  assert.deepEqual(w.args, toastArgs("t", "b"));
});

test("B7 the toast command is Windows PowerShell WinRT with escaped text", () => {
  const args = toastArgs("Budget <half> & 'more'", "55% used. Resets Thu 06 Nov 09:00.");
  assert.deepEqual(args.slice(0, 5), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
  const script = Buffer.from(args[5], "base64").toString("utf16le");
  assert.ok(script.includes(`CreateToastNotifier('${TOAST_APP_ID}')`));
  assert.ok(script.includes("<text>Budget &#60;half&#62; &#38; &#39;more&#39;</text>"), script);
  assert.ok(script.includes("<text>55% used. Resets Thu 06 Nov 09:00.</text>"));
  assert.ok(script.includes("ContentType = WindowsRuntime"));
  const loadXml = script.split("\n").find((l) => l.startsWith("$xml.LoadXml("));
  assert.ok(loadXml && loadXml.slice("$xml.LoadXml('".length, -2).indexOf("'") === -1, "no quote ends the PowerShell string early");
});

// B8. The status line hands the window to the recorder, detached, only when the pair changed.
function gitBash(): string | null {
  if (process.platform !== "win32") return spawnSync("bash", ["--version"]).status === 0 ? "bash" : null;
  const local = process.env.LOCALAPPDATA ? [`${process.env.LOCALAPPDATA}/Programs/Git/bin/bash.exe`] : [];
  return ["C:/Program Files/Git/bin/bash.exe", ...local].find((p) => fs.existsSync(p)) ?? null;
}

const BASH = gitBash();
const PYTHON = BASH ? spawnSync(BASH, ["-c", "command -v python3 || command -v python"], { encoding: "utf8" }).status === 0 : false;
const skip = !BASH ? "Git Bash not found" : !PYTHON ? "python not on the bash PATH" : false;

test("B8 status line starts the recorder only for a changed window, output unchanged", { skip }, async () => {
  const home = fs.mkdtempSync(path.join(TMP, "statusline-")).replace(/\\/g, "/");
  const calls = path.join(home, "calls.log");
  fs.mkdirSync(path.join(home, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(home, "hooks", "usage-record.mts"),
    `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`, "utf8");
  const statusline = path.join(HERE, "..", "statusline-command.sh");
  const env = { ...process.env, CLAUDE_HOME: home, HOME: home, KHEREP_WORKSPACE: `${home}/no-workspace` };
  const base = { workspace: { current_dir: "/work/demo/app" }, model: { display_name: "Opus" }, context_window: { used_percentage: 12.4 }, session_id: "s1" };
  const withWeek = { ...base, rate_limits: { five_hour: { used_percentage: 20 }, seven_day: { used_percentage: 55, resets_at: RESETS } } };
  const render = (status: object) => spawnSync(BASH as string, [statusline], { input: JSON.stringify(status), encoding: "utf8", env });
  const callLines = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : []);
  const settle = async (count: number, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end && callLines().length < count;) await new Promise((r) => setTimeout(r, 100));
  };

  const first = render(withWeek);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, "demo/app | Opus | ctx:12% | 5h:20% 7d:55%");
  await settle(1, 15000);
  assert.deepEqual(callLines().map((l) => JSON.parse(l)), [["--used", "55", "--resets-at", String(RESETS)]]);

  fs.mkdirSync(path.join(home, ".cache", "usage-watch"), { recursive: true });
  fs.writeFileSync(path.join(home, ".cache", "usage-watch", "last-input"), `55|${RESETS}\n`, "utf8");
  const second = render(withWeek);
  assert.equal(second.stdout, first.stdout);
  const third = render(base);
  assert.equal(third.stdout, "demo/app | Opus | ctx:12%");
  await settle(2, 2000);
  assert.equal(callLines().length, 1, "unchanged pair and missing window start nothing");
});
