import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { blockerDiagnostic } from "../protocol-diagnostics.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { recordSent, writeOutbox } from "./exchange.mts";
import { markDelivered, markOffered, setMessageProgress, storeMessage } from "./inbox.mts";
import { runMsg } from "./msg-cli.mts";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const ID = "00000000-0000-4000-8000-000000000001";
const NODE = "00000000-0000-4000-8000-000000000002";
const ROUTES = ["sent", "received"] as const;
function home(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "msg status synthetic "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return nodePaths(root);
}
const budgetProgress = (retry: number) => ({ phase: "waiting" as const, code: "budget-exhausted" as const,
  observedAt: new Date(NOW - 2000).toISOString(), retryAt: new Date(retry).toISOString() });
function stored(paths: NodePaths): void {
  storeMessage(paths.inbox, { messageId: ID, from: { nodeId: NODE, session: "sender" }, toSession: "target",
    text: "synthetic", createdAt: new Date(NOW - 5000).toISOString() }, NOW - 5000);
}
function received(paths: NodePaths, retry: number): void {
  stored(paths);
  setMessageProgress(paths.inbox, ID, "waiting", "budget-exhausted", NOW - 2000, retry);
}
function sent(paths: NodePaths, retry: number, diagnostic?: ReturnType<typeof blockerDiagnostic>): void {
  writeOutbox(paths, { messageId: ID, fromSession: "sender", to: { nodeId: NODE, session: "target" }, text: "synthetic",
    createdAt: new Date(NOW - 2000).toISOString() });
  recordSent(paths, ID, "accepted", undefined, NOW - 2000, budgetProgress(retry), diagnostic);
}
async function statusLines(paths: NodePaths): Promise<string[]> {
  const lines: string[] = [];
  assert.equal(await runMsg(["status", ID], { paths, env: {}, now: () => NOW, out: line => lines.push(line),
    err: line => assert.fail(line) }), 0);
  return lines;
}
const place = (route: typeof ROUTES[number], paths: NodePaths, retry: number) =>
  route === "received" ? received(paths, retry) : sent(paths, retry);

for (const route of ROUTES) for (const expired of [false, true]) {
  test(`status renders existing budget progress on ${route}, expired=${expired}`, async t => {
    const paths = home(t);
    const retry = NOW + (expired ? -1000 : 1000);
    place(route, paths, retry);
    const progress = budgetProgress(retry);
    const text = (await statusLines(paths)).join("\n");
    assert.match(text, /waiting\/budget-exhausted/);
    assert.ok(text.includes(progress.observedAt));
    assert.ok(text.includes(progress.retryAt));
    assert.match(text, /autonomous-turn budget is exhausted/);
    if (expired) assert.match(text, /current hold unknown/);
  });
}

// These two pin behaviour that was already right; they guard the qualifier that
// stayed when the rest of the wording returned to its earlier form.
for (const route of ROUTES) {
  test(`pin: a retry time still ahead says retry after and claims no elapsed hold, on ${route}`, async t => {
    const paths = home(t);
    place(route, paths, NOW + 1000);
    const text = (await statusLines(paths)).join("\n");
    assert.match(text, /retry after /);
    assert.doesNotMatch(text, /current hold unknown/);
  });
  test(`pin: a retry time equal to now counts as elapsed, on ${route}`, async t => {
    const paths = home(t);
    place(route, paths, NOW);
    assert.match((await statusLines(paths)).join("\n"), /has elapsed; current hold unknown/);
  });
}

test("a delivered message no longer shows the progress recorded while it waited", async t => {
  const paths = home(t);
  received(paths, NOW + 600_000);
  markDelivered(paths.inbox, ID);
  const lines = await statusLines(paths);
  assert.ok(lines[0].startsWith(`${ID} delivered (received `), lines[0]);
  assert.equal(lines.join("\n").includes("budget-exhausted"), false);
});

test("an offer ends the wait its older progress described; progress written after it still shows", async t => {
  const paths = home(t);
  stored(paths);
  setMessageProgress(paths.inbox, ID, "waiting", "budget-exhausted", NOW - 4000, NOW + 600_000);
  markOffered(paths.inbox, ID, NOW - 2000);
  const first = await statusLines(paths);
  assert.ok(first[0].startsWith(`${ID} offered (received `), first[0]);
  assert.equal(first.join("\n").includes("budget-exhausted"), false);
  setMessageProgress(paths.inbox, ID, "waiting", "awaiting-turn-confirmation", NOW - 1000);
  assert.match((await statusLines(paths)).join("\n"), /waiting\/awaiting-turn-confirmation/);
});

test("progress older than the offer brings no waiting hint either", async t => {
  const paths = home(t);
  stored(paths);
  setMessageProgress(paths.inbox, ID, "waiting", "retry-pending", NOW - 4000);
  markOffered(paths.inbox, ID, NOW - 2000);
  const text = (await statusLines(paths)).join("\n");
  assert.doesNotMatch(text, /retry-pending/);
  assert.doesNotMatch(text, /detailed cause unavailable/);
});

test("an offered record without an offer time still shows its progress", async t => {
  const paths = home(t);
  received(paths, NOW + 1000);
  const file = path.join(paths.inbox, `${ID}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), state: "offered" }));
  assert.match((await statusLines(paths)).join("\n"), /waiting\/budget-exhausted/);
});

test("pin: only budget progress marks an elapsed retry time as an unknown hold", async t => {
  const paths = home(t);
  stored(paths);
  setMessageProgress(paths.inbox, ID, "waiting", "retry-pending", NOW - 2000, NOW - 1000);
  const text = (await statusLines(paths)).join("\n");
  assert.match(text, /retry after /);
  assert.doesNotMatch(text, /current hold unknown/);
});

test("a stored diagnostic replaces the budget progress label on the sent route", async t => {
  const paths = home(t);
  sent(paths, NOW + 1000, blockerDiagnostic("turn-spacing", NOW - 2000));
  const first = (await statusLines(paths))[0];
  assert.match(first, /waiting\/budget-exhausted/);
  assert.doesNotMatch(first, /autonomous-turn budget/);
});
