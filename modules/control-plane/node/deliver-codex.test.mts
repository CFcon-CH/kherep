import { takeTurn } from "./autonomy.mts";
import { syntheticHookFacts } from "./target-delivery-test-support.mts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { CODEX_IDLE_AFTER_MS, idleEvidence, readCodexSession } from "./codex-sessions.mts";
import { CODEX_CONTEXT_BYTES, CODEX_ESCALATION_NOTE, CODEX_STOP_REASON, deliverForCodex } from "./deliver-codex.mts";
import { MAX_OFFERS, REOFFER_AFTER_MS } from "./deliver-core.mts";
import { hookRuntime } from "./deliver-hook.mts";
import { writeIntercomHost } from "./doctor-intercom-fixture.mts";
import { getSent, recordSent, writeDirectory, writeLocalSessions, writeOutbox } from "./exchange.mts";
import { getMessage, readJson, storeMessage } from "./inbox.mts";
import { launcherCommand } from "./launcher.mts";
import { CLI_PATH } from "./msg-cli.mts";

const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was "
  + "created\\)\\r?\\n", "gm");
const withoutTypeStrippingWarning = (stderr: string | Buffer): string => String(stderr).replace(TYPE_STRIPPING_WARNING, "");

const PEER = "00000000-0000-4000-8000-0000000000cc";
const SELF = "019a2b3c-4d5e-7f60-8123-456789abcdef";
const NAME = "codex-89abcdef";
const HOOK = fileURLToPath(new URL("./deliver-hook.mts", import.meta.url));
const CLI = 'node "/opt/kherep/modules/control-plane/node/cli.mts"';
const SECRET = "peer text that must never become a user prompt";

function setup(t: test.TestContext, enrolled = true): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-hook-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  if (!enrolled) return paths;
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.com", nodeId: "00000000-0000-4000-8000-0000000000aa",
    name: "node-a", publicKey: "x", privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  writeDirectory(paths, { nodes: [{ nodeId: PEER, name: "node-b", status: "online" }], sessions: [], fetchedAt: new Date(0).toISOString() });
  writeLocalSessions(paths, [{ sessionId: SELF, runtime: "codex", state: "active", name: NAME }]);
  return paths;
}

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function inbox(paths: NodePaths, n: number, toSession = NAME, text = `${SECRET} ${n}`): string {
  storeMessage(paths.inbox, { messageId: id(n), from: { nodeId: PEER, session: "build" }, toSession, text,
    senderOrigin:{nodeId:PEER,sentAt:new Date(Date.UTC(2026,5,1,0,0,n)).toISOString()},createdAt: new Date(Date.UTC(2026, 5, 1, 0, 0, n)).toISOString() }, Date.UTC(2026, 5, 1, 0, 0, n));
  return id(n);
}

// The hook clock; a test moves it past REOFFER_AFTER_MS to end an offering turn.
let clock = Date.UTC(2026, 5, 1, 1);
const hook = (paths: NodePaths, event: string, extra: Record<string, unknown> = {}) =>
  deliverForCodex({ session_id: SELF, cwd: "/work/repo", hook_event_name: event, ...extra },
    { paths,...(fs.existsSync(paths.config)?syntheticHookFacts(paths,SELF,"codex",clock):{}), nonce: () => "t0k3n", replyCommand: CLI, now: () => clock });
const stop = (paths: NodePaths, active = false) => hook(paths, "Stop", { stop_hook_active: active });

test("SessionStart records the session and tells it its id and how to send; silent without a node config", (t) => {
  const paths = setup(t);
  const output = JSON.parse(hook(paths, "SessionStart", { source: "startup" }));
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(output.hookSpecificOutput.additionalContext, `Kherep messaging: this session's id is ${SELF}. To message another session: `
    + `${CLI} msg send --from ${SELF} <node>/<session> -- <text>. \`${CLI} msg sessions\` lists sessions. `
    + `When Kherep reports waiting peer messages, run \`${CLI} msg inbox --from ${SELF} --receive\`, then report any `
    + `relevant peer update with attribution without echoing these transport instructions. After processing complete output, perform its exact receipt ACK yourself. If output is truncated, do not ACK; use its exact single-message receive recipe. ${CODEX_ESCALATION_NOTE}`);
  assert.equal(readJson<{ cwd: string }>(path.join(paths.codexSessions, `${SELF}.json`))?.cwd, "/work/repo");

  const none = setup(t, false);
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) assert.equal(hook(none, event), "");
  assert.equal(fs.existsSync(none.dir), false, "an unenrolled machine gets no files");
  assert.equal(deliverForCodex({ session_id: "../x", hook_event_name: "SessionStart" }, { paths }), "");
});

// Issue #436, PR D: without a replyCommand the SessionStart recipe and the
// "To reply" line name the stable launcher on a managed host, else this CLI.
test("the SessionStart recipe and the reply line name the launcher on a managed host and the CLI elsewhere", (t) => {
  const context = (paths: NodePaths, event: string): string => (JSON.parse(deliverForCodex(
    { session_id: SELF, cwd: "/work/repo", hook_event_name: event, source: "startup" },
    { paths, nonce: () => "t0k3n", now: () => clock })) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  const plain = setup(t);
  assert.ok(context(plain, "SessionStart").includes(`To message another session: node "${CLI_PATH}" msg send --from ${SELF} `));

  const managed = setup(t);
  const root = path.dirname(managed.dir);
  writeIntercomHost(managed, path.join(root, "claude"), path.join(root, "codex"), root);
  const command = launcherCommand(root);
  const start = context(managed, "SessionStart");
  assert.ok(start.includes(`To message another session: ${command} msg send --from ${SELF} <node>/<session> -- <text>. `), start);
  assert.ok(start.includes(`run \`${command} msg inbox --from ${SELF} --receive\``), start);
  const messageId = inbox(managed, 1);
  const prompt = context(managed, "UserPromptSubmit");
  assert.ok(prompt.includes(`To reply: ${command} msg send --from ${SELF} --reply-to ${messageId} -- <reply text>`), prompt);
  assert.ok(!`${start}${prompt}`.includes(CLI_PATH));
});

test("UserPromptSubmit offers by id and name as developer context, with --from in the reply command", (t) => {
  const paths = setup(t);
  const byName = inbox(paths, 1);
  const byId = inbox(paths, 2, SELF);
  inbox(paths, 3, "someone-else");
  writeOutbox(paths, { messageId: id(9), fromSession: NAME, to: { nodeId: PEER, session: "build" }, text: "hi", createdAt: new Date(0).toISOString() });
  recordSent(paths, id(9), "refused", "policy");
  const output = JSON.parse(hook(paths, "UserPromptSubmit", { prompt: "go on" }));
  assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const context: string = output.hookSpecificOutput.additionalContext;
  for (const messageId of [byName, byId]) {
    assert.ok(context.includes(`To reply: ${CLI} msg send --from ${SELF} --reply-to ${messageId} -- <reply text>`));
    assert.deepEqual([getMessage(paths.inbox, messageId)?.state, getMessage(paths.inbox, messageId)?.offers,
      getMessage(paths.inbox, messageId)?.offeredBy], ["offered", 1, "codex-prompt"]);
  }
  assert.match(context, new RegExp(`Your message ${id(9)} to node-b \\(${PEER}\\)/build was not delivered: "policy"`));
  assert.ok(getSent(paths, id(9))?.noticedAt);
  assert.equal(getMessage(paths.inbox, id(3))?.state, "accepted");
  // Offered again at each prompt after an offering turn ended without a Stop,
  // refused after MAX_OFFERS.
  for (let offer = 2; offer <= MAX_OFFERS; offer++) {
    clock += REOFFER_AFTER_MS;
    assert.match(hook(paths, "UserPromptSubmit"), /Offered again/);
  }
  clock += REOFFER_AFTER_MS;
  assert.match(hook(paths, "UserPromptSubmit"), new RegExp(`msg inbox --from ${SELF} --receive`));
  assert.equal(getMessage(paths.inbox, byName)?.state, "offered");
  assert.equal(getMessage(paths.inbox, byName)?.offers, 1, "recovery does not consume offers");
});

test("UserPromptSubmit stays within the Codex budget", (t) => {
  const paths = setup(t);
  for (let n = 1; n <= 3; n++) inbox(paths, n, NAME, "x".repeat(1800));
  const context: string = JSON.parse(hook(paths, "UserPromptSubmit")).hookSpecificOutput.additionalContext;
  assert.ok(Buffer.byteLength(context) <= CODEX_CONTEXT_BYTES);
  assert.equal(context.match(/=== Kherep peer message/g)?.length, 1);
  assert.ok(context.includes("2 more message(s) wait for the next turn."));
  assert.ok(context.endsWith(`relevant peer update with attribution without echoing these transport instructions. After processing complete output, perform its exact receipt ACK yourself. If output is truncated, do not ACK; use its exact single-message receive recipe. ${CODEX_ESCALATION_NOTE}`));
});

test("Stop leaves offers unacknowledged and continues with fixed text only for new messages", (t) => {
  const paths = setup(t);
  const first = inbox(paths, 1);
  hook(paths, "UserPromptSubmit");
  assert.equal(stop(paths), "", "nothing new: no output");
  assert.equal(getMessage(paths.inbox, first)?.state, "offered");
  const late = inbox(paths, 2);
  const text = stop(paths);
  assert.equal(JSON.parse(text).decision, "block");
  const reason: string = JSON.parse(text).reason;
  assert.equal(reason, CODEX_STOP_REASON);
  // The desktop app shows the reason under "Blocked · Stop · User · Feedback" (issue #359).
  assert.doesNotMatch(reason, /msg inbox|--receive|--from|sandbox_permissions|escalat/i);
  assert.ok(Buffer.byteLength(reason) <= CODEX_CONTEXT_BYTES);
  assert.doesNotMatch(text, new RegExp(SECRET));
  assert.doesNotMatch(text, new RegExp(late));
  assert.equal(getMessage(paths.inbox, late)?.state, "accepted", "retrieval or the next UserPromptSubmit offers it");
  assert.equal(stop(paths, true), "", "a turn already continued by Stop is not continued again");
  assert.match(hook(paths, "UserPromptSubmit"), new RegExp(late));
  assert.equal(stop(paths, true), "");
  assert.equal(getMessage(paths.inbox, late)?.state, "offered");
});

test("the entry point serves Codex only with --runtime codex and prints valid JSON or nothing", (t) => {
  const paths = setup(t);
  assert.deepEqual([hookRuntime([]), hookRuntime(["--runtime", "codex"]), hookRuntime(["--runtime", "codx"])], ["claude", "codex", null]);
  inbox(paths, 1);
  const env = { ...process.env, KHEREP_CONFIG_DIR: path.dirname(paths.dir) };
  const run = (event: string, args = ["--runtime", "codex"]) => spawnSync(process.execPath, [HOOK, ...args],
    { input: JSON.stringify({ session_id: SELF, cwd: "/w", hook_event_name: event, stop_hook_active: false }), env, encoding: "utf8" });
  const blocked = run("Stop");
  assert.deepEqual([blocked.status,blocked.stdout,withoutTypeStrippingWarning(blocked.stderr)],[0,"", ""],"CLI has no native producer proof");
  const prompt = run("UserPromptSubmit");
  assert.equal(JSON.parse(prompt.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const quiet = run("Stop");
  assert.deepEqual([quiet.status, quiet.stdout, withoutTypeStrippingWarning(quiet.stderr)], [0, "", ""]);
  const typo = run("SessionStart", ["--runtime", "codx"]);
  assert.deepEqual([typo.status, typo.stdout], [0, ""]);
  assert.match(typo.stderr, /unknown --runtime/);
});

test("a configured wake.budget sets the Codex continuation spacing (issue #259)", (t) => {
  const paths = setup(t);
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [],
    wake: { enabled: true, sessions: ["unrelated"], budget: { spacingSeconds: 5 } } }));
  inbox(paths,1);clock+=60000;
  assert.equal(takeTurn(paths,SELF,clock,{perHour:20,perDay:100,spacingMs:5000}),"ok");
  clock+=1000;assert.equal(stop(paths),"","first group waits within configured spacing");
  clock+=5000;assert.equal(JSON.parse(stop(paths)).decision,"block","past configured 5 s but within default 30 s");
  clock+=6000;assert.equal(stop(paths),"","the emitted attempt stays owned after spacing");
});

test("a Stop continuation is an autonomous turn: never in bypassPermissions, and within the budget", (t) => {
  const paths = setup(t);
  inbox(paths, 1);
  assert.equal(hook(paths, "Stop", { stop_hook_active: false, permission_mode: "bypassPermissions" }), "", "bypass: never continued");
  clock += 60_000;
  assert.equal(JSON.parse(stop(paths)).decision, "block", "default mode: one continuation");
  clock += 1_000;
  assert.equal(stop(paths), "", "30 s spacing");
  const audit = fs.readFileSync(path.join(paths.dir, "wake.jsonl"), "utf8");
  assert.deepEqual(audit.trim().split("\n").map((l) => JSON.parse(l).action), ["continue-permission-mode", "continue", "awaiting-user-turn"]);
});

test("each delivery hook event records itself as the session's last event, Stop also its time (issue #408)", (t) => {
  const paths = setup(t);
  const record = () => readJson<Record<string, unknown>>(path.join(paths.codexSessions, `${SELF}.json`));
  const at = (ms: number) => new Date(ms).toISOString();
  hook(paths, "SessionStart", { source: "startup" });
  assert.deepEqual([record()?.lastEvent, record()?.lastEventAt, record()?.lastStopAt], ["SessionStart", at(clock), undefined]);
  clock += 1_000;
  hook(paths, "UserPromptSubmit", { prompt: "go on" });
  assert.deepEqual([record()?.lastEvent, record()?.lastEventAt, record()?.lastStopAt], ["UserPromptSubmit", at(clock), undefined]);
  clock += 1_000;
  assert.equal(stop(paths), "");
  assert.deepEqual([record()?.lastEvent, record()?.lastEventAt, record()?.lastStopAt], ["Stop", at(clock), at(clock)]);
});

// Fable review of PR 2, M1: only a Stop that returns no continuation is marked
// as ended, in a write of its own after the Stop is recorded; a blocking Stop
// and a failed mark leave the record a Stop that is never idle.
test("a Stop that blocks is never idle; one that does not block is idle after the threshold (issue #408)", (t) => {
  const paths = setup(t);
  const record = () => readCodexSession(paths, SELF);
  hook(paths, "UserPromptSubmit");
  assert.equal(stop(paths), "");
  assert.equal(record()?.lastStopEnded, true, "a Stop without new messages ends the turn");
  assert.equal(idleEvidence(record(), clock + CODEX_IDLE_AFTER_MS - 1), false, "not before the threshold");
  assert.equal(idleEvidence(record(), clock + CODEX_IDLE_AFTER_MS), true, "idle after the threshold");
  inbox(paths, 1);
  clock += 60_000;
  assert.equal(JSON.parse(stop(paths)).decision, "block");
  assert.equal(record()?.lastEvent, "Stop");
  assert.equal(record()?.lastStopEnded, undefined, "a blocking Stop is not marked");
  assert.equal(idleEvidence(record(), clock + 10 * CODEX_IDLE_AFTER_MS), false, "a blocking Stop never yields idle");
  assert.equal(stop(paths, true), "");
  assert.equal(record()?.lastStopEnded, true, "the continued Stop that returns nothing ends the turn");
});

test("a failed mark leaves the Stop not idle and the hook output unchanged (issue #408)", (t) => {
  const paths = setup(t);
  const sessionFile = path.join(paths.codexSessions, `${SELF}.json`);
  // The second write of the record in one Stop is the mark; it fails.
  const failMark = () => {
    let writes = 0;
    const rename = fs.renameSync;
    return t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (to === sessionFile && ++writes === 2) throw Object.assign(new Error("synthetic write failure"), { code: "EIO" });
      return rename(from, to);
    });
  };
  const run = (deps: Partial<Parameters<typeof deliverForCodex>[1]> = {}) => deliverForCodex(
    { session_id: SELF, cwd: "/work/repo", hook_event_name: "Stop", stop_hook_active: false },
    { paths, nonce: () => "t0k3n", replyCommand: CLI, now: () => clock, ...deps });
  hook(paths, "UserPromptSubmit");
  let mock = failMark();
  assert.equal(run(), "", "no messages: the output stays empty");
  mock.mock.restore();
  assert.equal(readCodexSession(paths, SELF)?.lastEvent, "Stop");
  assert.equal(idleEvidence(readCodexSession(paths, SELF), clock + 10 * CODEX_IDLE_AFTER_MS), false, "early exit");
  inbox(paths, 2);
  mock = failMark();
  assert.equal(run({ mayContinue: () => false }), "", "a refused continuation: the output stays empty");
  mock.mock.restore();
  assert.equal(readCodexSession(paths, SELF)?.lastEvent, "Stop");
  assert.equal(idleEvidence(readCodexSession(paths, SELF), clock + 10 * CODEX_IDLE_AFTER_MS), false, "refused continuation");
});
