import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nodePaths } from "./config.mts";
import { DEFAULT_TURN_BUDGET } from "./policy.mts";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const HOUR = 3600000, DAY = 24 * HOUR;
const api = "./autonomy-budget.mts";
for (const [label, turns, limits, blockedBy, release] of [
  ["hourly", [NOW - 1000], { perHour: 1, perDay: 100, spacingMs: 0 }, ["hour"], NOW - 1000 + HOUR],
  ["daily", [NOW - 2 * HOUR], { perHour: 20, perDay: 1, spacingMs: 0 }, ["day"], NOW - 2 * HOUR + DAY],
  ["spacing", [NOW - 1000], DEFAULT_TURN_BUDGET, ["spacing"], NOW + 29000],
  ["simultaneous", [NOW - 1000], { perHour: 1, perDay: 1, spacingMs: 30000 }, ["hour", "day", "spacing"], NOW - 1000 + DAY],
  ["unsorted excess after reduction", [NOW - 1000, NOW - 3000, NOW - 2000], { perHour: 2, perDay: 100, spacingMs: 0 }, ["hour"], NOW - 2000 + HOUR],
  ["boundary equality", [NOW - HOUR, NOW - DAY], { perHour: 1, perDay: 2, spacingMs: 0 }, [], NOW],
  ["spacing equality", [NOW - 30000], DEFAULT_TURN_BUDGET, [], NOW],
  ["daily excess after reduction", [NOW - 2 * HOUR, NOW - 4 * HOUR, NOW - 3 * HOUR], { perHour: 20, perDay: 2, spacingMs: 0 }, ["day"], NOW - 3 * HOUR + DAY],
] as const) test(`autonomy evaluator: ${label}`, async () => {
  const { evaluateTurnBudget } = await import(api);
  const result = evaluateTurnBudget([...turns], limits, NOW);
  assert.deepEqual(result.blockedBy, blockedBy);
  assert.equal(result.nextAvailableAt, new Date(release).toISOString());
});

test("autonomy evaluator rejects malformed, nonfinite and future stamps explicitly", async () => {
  const { evaluateTurnBudget } = await import(api);
  for (const [input, status] of [[{}, "malformed"], [["bad"], "malformed"], [[-1], "malformed"], [[NaN], "nonfinite"], [[Infinity], "nonfinite"], [[-Infinity], "nonfinite"],
    [[NOW + 1], "future"]] as const) {
    assert.equal(evaluateTurnBudget(input, DEFAULT_TURN_BUDGET, NOW).ledgerStatus, status);
  }
});

test("the clock is sampled after the ledger is read, so a stamp just read is not future-dated", async t => {
  const { inspectTurnBudget } = await import(api);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turn budget synthetic "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  const dir = path.join(paths.dir, "listeners");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "o.turns.json"), JSON.stringify({ turns: [NOW + 400] }));
  let clock = NOW;
  const readSync = fs.readSync as (...args: unknown[]) => number;
  t.mock.method(fs, "readSync", (...args: unknown[]) => { clock = NOW + 500; return Reflect.apply(readSync, fs, args); });
  const result = inspectTurnBudget(paths, "o", () => clock);
  assert.equal(result.ledgerStatus, "ok");
  assert.equal(result.usedHour, 1);
});

test("read-only inspection never debits, locks or creates evidence", async t => {
  const { inspectTurnBudget } = await import(api);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turn budget synthetic "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  assert.equal(inspectTurnBudget(paths, "owner", NOW).ledgerStatus, "missing");
  assert.deepEqual(fs.readdirSync(root), []);
  const dir = path.join(paths.dir, "listeners");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "owner.turns.json");
  for (const [text, status] of [["not json", "malformed"], ['{"turns":{}}', "malformed"],
    ['{"turns":[1e999]}', "nonfinite"], [JSON.stringify({ turns: [NOW + 1] }), "future"],
    [JSON.stringify({ turns: [NOW - 1000] }), "ok"], [" ".repeat(262145), "too-large"]]) {
    fs.writeFileSync(file, text);
    assert.equal(inspectTurnBudget(paths, "owner", NOW).ledgerStatus, status);
    assert.equal(fs.readFileSync(file, "utf8"), text);
    assert.deepEqual(fs.readdirSync(dir), ["owner.turns.json"]);
  }
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal(inspectTurnBudget(paths, "owner", NOW).ledgerStatus, "unreadable");
  assert.equal(inspectTurnBudget(paths, "unsafe.id", NOW).ledgerStatus, "unsupported-identity");
});
