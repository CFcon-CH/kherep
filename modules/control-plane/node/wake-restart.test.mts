import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { rememberedMode, rememberMode, TURNS_PER_HOUR } from "./autonomy.mts";
import { getMessage, markOffered, MAX_REPLY_DEPTH } from "./inbox.mts";
import { transcriptMode } from "./transcript-mode.mts";
import { killSwitch, REARM_TEXT, WAKE_BACKLOG_AFTER_MS, WAKE_POLL_MS, WAKE_SETTLE_MS, wakeText } from "./wake-hook.mts";
import { arrive, auditLines, id, listen, lockFile, SELF, setup, T0, type ListenOptions } from "./wake-fixture.mts";

// Issue #101: an idle session wakes after a restart with no user input. The
// SessionStart listener takes the permission mode from the session transcript
// when none is stored, and wakes once for messages that arrived while no
// listener ran. Synthetic transcripts only; the launch check is injected.

const BACKLOG_WAKE = T0 + WAKE_BACKLOG_AFTER_MS + WAKE_SETTLE_MS;
const atStart = (options: ListenOptions = {}): ListenOptions => ({ event: "SessionStart", source: "resume", mode: null, ...options });
const noPoll = (options: ListenOptions = {}): ListenOptions => ({ ...options, tick: () => assert.fail("no poll") });
const seen = (t: test.TestContext, wake?: unknown) => {
  const { paths } = wake === undefined ? setup(t) : setup(t, { wake });
  rememberMode(paths, SELF, "default");
  return paths;
};
const actions = (paths: Parameters<typeof auditLines>[0]) => auditLines(paths).map((l) => l.action);

// A Claude config dir with one synthetic transcript whose user entries carry the given modes.
function transcriptHome(t: test.TestContext, modes: string[]) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-restart-"));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const file = path.join(configDir, "projects", "p", `${SELF}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, modes.map((m) => `${JSON.stringify({ type: "user", permissionMode: m, message: { content: "synthetic" } })}\n`
    + `${JSON.stringify({ type: "assistant", message: { content: "synthetic" } })}\n`).join(""));
  return { configDir, file, readTranscript: (p: unknown) => transcriptMode(p, { configDir }) };
}

test("without a stored mode the last user entry of the transcript decides, and is stored", async (t) => {
  const { paths } = setup(t);
  const { file, readTranscript } = transcriptHome(t, ["bypassPermissions", "auto"]);
  let checked = false;
  const launch = async () => { checked = true; return "ok" as const; };
  const result = await listen(paths, atStart({ transcript: file, readTranscript, launch, tick: (clock) => {
    if (clock === T0 + 2 * WAKE_POLL_MS) arrive(paths, 1, clock);
  } }));
  assert.deepEqual(result, { code: 2, text: wakeText(1) });
  assert.equal(checked, true, "settings and launch flags are still checked");
  assert.equal(rememberedMode(paths, SELF), "auto");

  // A stored mode comes first; the transcript is then not read.
  const stored = seen(t);
  assert.deepEqual((await listen(stored, atStart({ transcript: file, maxWaitMs: 10_000,
    readTranscript: () => assert.fail("not read") }))).code, 2);
});

test("a bypass mode, or a missing, foreign or unparseable transcript refuses", async (t) => {
  const refused = async (action: string, options: ListenOptions) => {
    const { paths } = setup(t);
    assert.deepEqual(await listen(paths, noPoll(atStart({ ...options, launch: async () => assert.fail("not checked") }))), { code: 0 });
    assert.deepEqual(actions(paths), [action]);
    assert.equal(fs.existsSync(lockFile(paths)), false);
    return paths;
  };
  const bypass = transcriptHome(t, ["default", "bypassPermissions"]);
  const stored = await refused("permission-mode", { transcript: bypass.file, readTranscript: bypass.readTranscript });
  assert.equal(rememberedMode(stored, SELF), "bypassPermissions");
  const home = transcriptHome(t, ["default"]);
  const { readTranscript } = home;
  await refused("permission-mode-unknown", { transcript: path.join(path.dirname(home.file), "missing.jsonl"), readTranscript });
  const foreign = path.join(home.configDir, "elsewhere.jsonl");
  fs.copyFileSync(home.file, foreign);
  await refused("permission-mode-unknown", { transcript: foreign, readTranscript });
  fs.writeFileSync(home.file, "{not json\n");
  await refused("permission-mode-unknown", { transcript: home.file, readTranscript });
  await refused("permission-mode-unknown", { readTranscript });
});

test("messages waiting at SessionStart wake the session once, after the grace period", async (t) => {
  const paths = seen(t, {enabled:true,sessions:[SELF]});
  arrive(paths, 1, T0 - 60_000);
  arrive(paths, 2, T0 + 1_000);
  // Addressed to another session: not this session's backlog.
  arrive(paths, 3, T0 - 60_000, "someone-else");
  assert.deepEqual(await listen(paths, atStart()), { code: 2, text: wakeText(2) });
  assert.deepEqual(auditLines(paths).map((l) => [l.action, l.messageIds, Date.parse(l.ts)]), [["backlog", [id(1), id(2)], BACKLOG_WAKE]]);
  assert.equal(fs.existsSync(lockFile(paths)), false);

  // The woken turn never ran, so the records still wait: a later start does not wake for them again.
  assert.deepEqual(await listen(paths, atStart({ start: T0 + 10 * 60_000, maxWaitMs: 20_000 })), { code: 2, text: REARM_TEXT });
  assert.deepEqual(actions(paths), ["backlog", "rearm"]);
  assert.equal(getMessage(paths.inbox, id(1))?.state, "accepted", "left for the next prompt");

  // A listener armed at UserPromptSubmit or Stop leaves them to its delivery hook.
  for (const event of ["UserPromptSubmit", "Stop"]) {
    const other = seen(t);
    arrive(other, 1, T0 - 60_000);
    assert.deepEqual(await listen(other, { event, maxWaitMs: 20_000 }), { code: 2, text: REARM_TEXT }, event);
  }
});

test("a prompt within the grace period supersedes it, and a delivery hook's offer wakes nobody", async (t) => {
  const paths = seen(t);
  arrive(paths, 1, T0 - 60_000);
  const result = await listen(paths, atStart({ tick: (clock) => {
    if (clock !== T0 + 3 * WAKE_POLL_MS) return;
    fs.writeFileSync(lockFile(paths), JSON.stringify({ token: "prompt", pid: 7, startedAt: clock, event: "UserPromptSubmit" }));
    markOffered(paths.inbox, id(1), clock);
  } }));
  assert.deepEqual(result, { code: 0 });
  assert.deepEqual(actions(paths), ["superseded"]);

  // Offered between the poll that found it and the re-read: no wake for it.
  const raced = seen(t);
  arrive(raced, 1, T0 - 60_000);
  const settled = await listen(raced, atStart({ maxWaitMs: 20_000, tick: (clock) => {
    if (clock === T0 + WAKE_BACKLOG_AFTER_MS + WAKE_SETTLE_MS) markOffered(raced.inbox, id(1), clock);
  } }));
  assert.deepEqual(settled, { code: 2, text: REARM_TEXT });
  assert.deepEqual(actions(raced), ["rearm"]);
});

test("the guards hold for waiting messages: kill switch, allowlist, reply depth and budget", async (t) => {
  const off = seen(t);
  arrive(off, 1, T0 - 60_000);
  fs.writeFileSync(killSwitch(off), "");
  assert.deepEqual(await listen(off, noPoll(atStart())), { code: 0 });
  assert.deepEqual(actions(off), ["disabled"]);

  const other = seen(t, { enabled: true, sessions: ["someone-else"] });
  arrive(other, 1, T0 - 60_000);
  assert.deepEqual(await listen(other, noPoll(atStart())), { code: 0 });
  assert.deepEqual(actions(other), ["not-allowlisted"]);

  const deep = seen(t);
  arrive(deep, 1, T0 - 60_000, "review", MAX_REPLY_DEPTH);
  assert.deepEqual(await listen(deep, atStart({ maxWaitMs: 20_000 })), { code: 2, text: REARM_TEXT });
  assert.deepEqual(actions(deep), ["depth-limit", "rearm"]);

  const paths = seen(t, {enabled:true,sessions:[SELF]});
  for (let n = 1; n <= TURNS_PER_HOUR; n++) {
    arrive(paths, n, T0 + n * 60_000 - 1_000);
    assert.deepEqual(await listen(paths, atStart({ start: T0 + n * 60_000 })), { code: 2, text: wakeText(1) }, `wake ${n}`);
  }
  const over = TURNS_PER_HOUR + 1;
  arrive(paths, over, T0 + over * 60_000 - 1_000);
  assert.deepEqual(await listen(paths, atStart({ start: T0 + over * 60_000 })), { code: 0 });
  assert.deepEqual(auditLines(paths).findLast(line => line.action === "budget")?.messageIds, [id(over)]);
  assert.equal(auditLines(paths).at(-1)?.action, "listener-timeout");
});
