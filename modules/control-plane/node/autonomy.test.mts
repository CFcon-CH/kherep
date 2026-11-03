import { syntheticHookFacts } from "./target-delivery-test-support.mts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { BUDGET_LOCK_STALE_MS, listenerDir, parentWatch, takeTurn, TURN_SPACING_MS, TURNS_PER_DAY, TURNS_PER_HOUR, wakeAudit } from "./autonomy.mts";
import { deliverForHook } from "./deliver-hook.mts";
import { getMessage } from "./inbox.mts";
import { arrive, auditLines, id, listen, SECRET, SELF, setup, T0 } from "./wake-fixture.mts";
import { WAKE_POLL_MS } from "./wake-hook.mts";

// The autonomy budget and permission gate (issue #31, operator decisions of
// 2026-09-25): wakes and Stop continuations share one budget per session.

const HOUR = 60 * 60_000;
const REPLY = 'node "/opt/kherep/modules/control-plane/node/cli.mts"';

// One Stop of session SELF at `at`; the additionalContext or "".
function stop(paths: Parameters<typeof takeTurn>[0], at: number, mode = "default"): string {
  const output = deliverForHook({ session_id: SELF, hook_event_name: "Stop", permission_mode: mode },
    { paths,...syntheticHookFacts(paths,SELF,"claude-code",at), nonce: () => "t0k3n", replyCommand: REPLY, now: () => at });
  return output ? JSON.parse(output).hookSpecificOutput.additionalContext as string : "";
}

test(`takeTurn allows ${TURNS_PER_HOUR} per rolling hour, ${TURNS_PER_DAY} per rolling day and one per ${TURN_SPACING_MS / 1000} s`, (t) => {
  const { paths } = setup(t);
  assert.equal(takeTurn(paths, SELF, T0), "ok");
  assert.equal(takeTurn(paths, SELF, T0 + TURN_SPACING_MS - 1), "spacing");
  for (let n = 1; n < TURNS_PER_HOUR; n++) assert.equal(takeTurn(paths, SELF, T0 + n * TURN_SPACING_MS), "ok", `turn ${n + 1}`);
  assert.equal(takeTurn(paths, SELF, T0 + HOUR - 1), "exhausted");
  // Rolling: the first turn leaves the hour window exactly one hour later.
  assert.equal(takeTurn(paths, SELF, T0 + HOUR), "ok");

  // 11 minutes apart the hour never fills; the day does after TURNS_PER_DAY turns.
  const daily = setup(t).paths;
  for (let n = 0; n < TURNS_PER_DAY; n++) assert.equal(takeTurn(daily, SELF, T0 + n * 11 * 60_000), "ok", `turn ${n + 1}`);
  assert.equal(takeTurn(daily, SELF, T0 + 24 * HOUR - 1), "exhausted");
  assert.equal(takeTurn(daily, SELF, T0 + 24 * HOUR), "ok");
});

test("Stop continuations consume the budget; when it is exhausted Stop offers nothing and says so in the audit", (t) => {
  const { paths } = setup(t);
  for (let n = 1; n < TURNS_PER_HOUR; n++) assert.equal(takeTurn(paths, SELF, T0 - HOUR/2 + n*TURN_SPACING_MS),"ok");
  arrive(paths, 1, T0);
  assert.match(stop(paths,T0), new RegExp(`=== Kherep peer message ${id(1)} `));
  // A different message cannot consume while this emitted owner is unresolved.
  const over = TURNS_PER_HOUR + 1;
  arrive(paths, over, T0);
  assert.equal(stop(paths, T0 + over * TURN_SPACING_MS), "");
  assert.equal(getMessage(paths.inbox, id(over))?.state, "accepted", "it waits for the next user prompt");
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["continue", "awaiting-user-turn"]);
  assert.deepEqual(auditLines(paths).at(-1)?.messageIds, [id(over)]);
  assert.ok(!fs.readFileSync(wakeAudit(paths), "utf8").includes(SECRET), "the audit never carries message text");
  // A prompt of the user is not autonomous: it delivers regardless of the budget.
  assert.match(deliverForHook({ session_id: SELF, hook_event_name: "UserPromptSubmit" }, { paths, now: () => T0 + HOUR / 2 }), /Kherep/);
});

test("wakes and Stop continuations draw on the same budget", async (t) => {
  const { paths } = setup(t);
  for (let n = 1; n < TURNS_PER_HOUR; n++) assert.equal(takeTurn(paths, SELF, T0 - HOUR / 2 + n * TURN_SPACING_MS), "ok");
  arrive(paths, 1, T0);
  assert.notEqual(stop(paths, T0), "", "the last turn of the hour");
  assert.deepEqual(await listen(paths, { start: T0 + TURN_SPACING_MS, tick: (clock) => {
    if (clock === T0 + TURN_SPACING_MS + 2 * WAKE_POLL_MS) arrive(paths, 2, clock);
  } }), { code: 0 });
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["continue", "awaiting-user-turn"]);
});

test("bypassPermissions: no Stop continuation, while the user's own prompt still delivers", (t) => {
  const { paths } = setup(t);
  const messageId = arrive(paths, 1, T0);
  assert.equal(stop(paths, T0, "bypassPermissions"), "");
  assert.equal(getMessage(paths.inbox, messageId)?.state, "accepted");
  assert.deepEqual(auditLines(paths).map((l) => [l.action, l.messageIds]), [["continue-permission-mode", [messageId]]]);
  const prompt = deliverForHook({ session_id: SELF, hook_event_name: "UserPromptSubmit", permission_mode: "bypassPermissions" }, { paths });
  assert.match(prompt, new RegExp(messageId));
  for (const mode of ["default", "acceptEdits", "plan", "auto", "dontAsk"]) {
    const other = setup(t).paths;
    arrive(other, 1, T0);
    assert.notEqual(stop(other, T0, mode), "", mode);
  }
});

test("parentWatch: the starting process alive, a finished one gone", () => {
  assert.equal(parentWatch()(), true);
  assert.equal(parentWatch(1)(), true, "pid 1 cannot be watched");
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  assert.equal(parentWatch(Number(child.stdout))(), false);
});

test("the budget lock: live owners stay fenced despite age; positively absent owners can be recovered", (t) => {
  const { paths } = setup(t);
  const turns = path.join(listenerDir(paths), `${SELF}.turns.json`);
  const lock = `${turns}.lock`;
  fs.mkdirSync(listenerDir(paths), { recursive: true });
  fs.writeFileSync(lock, String(process.pid));
  assert.equal(takeTurn(paths, SELF, T0), "locked", "denied, not counted blind");
  assert.equal(fs.existsSync(turns), false);
  const old = (Date.now() - BUDGET_LOCK_STALE_MS - 1_000) / 1000;
  fs.utimesSync(lock, old, old);
  assert.equal(takeTurn(paths, SELF, T0), "locked", "age cannot establish absence");
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0); fs.writeFileSync(lock, child.stdout);
  assert.equal(takeTurn(paths, SELF, T0), "ok");
  assert.equal(fs.existsSync(lock), false, "released after the spend");
});

test("concurrent spends from separate processes never both take the last slot", async (t) => {
  const { paths } = setup(t);
  for (let n = 0; n < TURNS_PER_HOUR - 1; n++) assert.equal(takeTurn(paths, SELF, T0 + n * TURN_SPACING_MS), "ok");
  const module = new URL("./autonomy.mts", import.meta.url).href;
  const at = T0 + HOUR / 2;
  const startAt = Date.now() + 1_500;
  // Each child waits for the common start, then spends once at the same instant.
  const script = `import { takeTurn } from ${JSON.stringify(module)};
    while (Date.now() < ${startAt});
    process.stdout.write(takeTurn(${JSON.stringify(paths)}, ${JSON.stringify(SELF)}, ${at}));`;
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => resolve(out));
  })));
  assert.equal(results.filter((r) => r === "ok").length, 1, results.join(","));
  assert.ok(results.every((r) => ["ok", "exhausted", "locked"].includes(r)), results.join(","));
  assert.equal(takeTurn(paths, SELF, at + TURN_SPACING_MS), "exhausted", "six turns recorded, not more");
});
