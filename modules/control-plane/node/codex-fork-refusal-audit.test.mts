import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { audit, listenerDir, wakeAudit } from "./autonomy.mts";
import { FORK_AUDIT, FORK_PROGRESS, type ForkRefusal, type PreClaimRefusal } from "./codex-fork-admission.mts";
import { forkAttempts } from "./codex-fork-attempts.mts";
import { FORK_OWNER, forkNode } from "./codex-fork-fixture.mts";
import { forkTestTimeouts, resetForkFeatureCache } from "./codex-fork-reply.mts";
import { FAST } from "./codex-fork-run-fixture.mts";
import { resetMcpCache } from "./codex-mcp.mts";
import { legacyForkPoll } from "./codex-fork-legacy-poll.mts";
import { codexQueueIdle } from "./codex-queue.mts";
import { markStopEnded, recordCodexSession } from "./codex-sessions.mts";
import { markOffered } from "./inbox.mts";
import { readdress } from "./_deprecated/session-handover.mts";
import { T0 } from "./task-fixture.mts";

const SECOND = "01a0db74-0000-7000-8000-0000000000f4";

// Issue #444: every refusal of the fork producer before the claim is one
// wake.jsonl line per owner, message and code, with ids and the code only.

test.beforeEach(() => { resetMcpCache(); resetForkFeatureCache(); forkTestTimeouts.value = FAST; });
test.after(() => { forkTestTimeouts.value = undefined; });

type Node = ReturnType<typeof forkNode>;
const poll = async (f: Node, extra: Parameters<Node["deps"]>[0] = {}): Promise<void> => {
  legacyForkPoll(f.deps(extra));
  await codexQueueIdle();
};
const forkAudit = (f: Node): { action: string; messageIds: string[]; sessionId: string }[] => (fs.existsSync(wakeAudit(f.paths))
  ? fs.readFileSync(wakeAudit(f.paths), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [])
  .filter((line) => String(line.action).startsWith("fork"));
const rawAudit = (f: Node): string => fs.readFileSync(wakeAudit(f.paths), "utf8");
const turns = (f: Node, owner = FORK_OWNER): number[] => {
  const file = path.join(listenerDir(f.paths), `${owner}.turns.json`);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { turns: number[] }).turns : [];
};
// The fixture's root is the parent of the workspace root: resolveCwd refuses it.
const outsideIdle = (f: Node, owner = FORK_OWNER): string => {
  const outside = fs.realpathSync.native(f.root);
  recordCodexSession(f.paths, owner, outside, T0 - 10 * 60_000, "default", "Stop");
  markStopEnded(f.paths, owner);
  return outside;
};
const busy = (f: Node): void => { recordCodexSession(f.paths, FORK_OWNER, f.cwd, T0 - 60_000, "default", "UserPromptSubmit"); };
const actionsOf = (f: Node): string[] => forkAudit(f).map((line) => line.action);
const actionIds = (f: Node): [string, string[]][] => forkAudit(f).map((line) => [line.action, line.messageIds]);
const claimed = (f: Node): boolean => fs.existsSync(path.join(f.paths.dir, "codex-fork-attempts"));

test("an owner whose cwd is outside the workspace roots gets fork-cwd-refused once, with no path in the record", async (t) => {
  const f = forkNode(t);
  const id = f.add();
  const outside = outsideIdle(f);
  await poll(f);
  await poll(f);
  assert.deepEqual(actionIds(f), [["fork-cwd-refused", [id]]]);
  assert.deepEqual(Object.keys(forkAudit(f)[0]!), ["ts", "sessionId", "messageIds", "action"], "metadata only");
  assert.deepEqual([f.app.runs.length, turns(f)], [0, []], "no helper, no spent turn");
  assert.equal(claimed(f), false, "no claim");
  for (const text of [outside, f.cwd, "workspace roots", "Is the build green"]) {
    assert.equal(rawAudit(f).includes(text), false, `the audit carries no ${text}`);
  }
  assert.ok(f.calls.length > 0, "guards 10 to 12 ran; the refusal is admission's");
});

test("guards 10 to 13 refuse with their own audit code, once per message", async (t) => {
  const cases: [string, string, (f: Node) => Parameters<Node["deps"]>[0], { capability?: boolean }?][] = [
    ["features list fails", "fork-features-unknown", (f) => { f.features("", 1); return {}; }],
    ["features list unparsable", "fork-features-unknown", (f) => { f.features("Name Stage Enabled\n"); return {}; }],
    ["mcp list fails", "fork-mcp-unknown", () => ({ mcpList: async () => ({ code: 1, stdout: "", stderr: "boom" }) })],
    ["no codex", "fork-producer", () => ({ findCodex: () => null })],
    ["not a native executable", "fork-producer", (f) => { fs.writeFileSync(f.binary, "#!/bin/sh\n"); return {}; }],
    ["remote route", "fork-producer", (f) => { fs.writeFileSync(path.join(f.home, "environments.toml"), ""); return {}; }],
    ["Worker without the proxy capability", "fork-relay-unsupported", () => ({}), { capability: false }],
  ];
  for (const [name, expected, setup, options] of cases) {
    resetMcpCache();
    resetForkFeatureCache();
    const f = forkNode(t, {}, options ?? {});
    const id = f.add();
    const extra = setup(f);
    await poll(f, extra);
    await poll(f, extra);
    assert.deepEqual(actionIds(f), [[expected, [id]]], name);
    assert.deepEqual([f.app.runs.length, forkAttempts(f.paths, FORK_OWNER).length, turns(f)], [0, 0, []], name);
  }
});

test("a refusal code is audited once per owner, message and code; a code seen before is not written again", async (t) => {
  const f = forkNode(t);
  f.add();
  busy(f);
  await poll(f);
  assert.deepEqual(actionsOf(f), ["fork-not-idle"]);
  outsideIdle(f);
  await poll(f);
  assert.deepEqual(actionsOf(f), ["fork-not-idle", "fork-cwd-refused"]);
  busy(f);
  await poll(f);
  await poll(f);
  assert.deepEqual(actionsOf(f), ["fork-not-idle", "fork-cwd-refused"], "set semantics: a recurring code is not written again");
  f.idle(FORK_OWNER);
  await poll(f);
  assert.deepEqual(actionsOf(f), ["fork-not-idle", "fork-cwd-refused", "fork"]);
  assert.equal(f.app.runs.length, 1);
});

test("the forgotten message is not audited again for the owner's next message", async (t) => {
  const f = forkNode(t);
  const first = f.add();
  const second = f.add();
  outsideIdle(f);
  await poll(f);
  assert.deepEqual(actionIds(f), [["fork-cwd-refused", [first]]]);
  markOffered(f.paths.inbox, first, T0);
  await poll(f);
  await poll(f);
  assert.deepEqual(actionIds(f), [["fork-cwd-refused", [first]], ["fork-cwd-refused", [second]]]);
});

test("a failed audit append is not deduplicated: the next poll audits the same code again", async (t) => {
  const f = forkNode(t);
  const id = f.add();
  outsideIdle(f);
  // A directory in place of wake.jsonl: the append of this poll fails.
  fs.mkdirSync(wakeAudit(f.paths));
  await poll(f);
  fs.rmdirSync(wakeAudit(f.paths));
  await poll(f);
  assert.deepEqual(actionIds(f), [["fork-cwd-refused", [id]]], "the next poll writes");
  await poll(f);
  await poll(f);
  assert.deepEqual(actionIds(f), [["fork-cwd-refused", [id]]], "further polls dedup");
  assert.deepEqual([f.app.runs.length, turns(f)], [0, []], "no helper, no spent turn");
  assert.equal(claimed(f), false, "no claim");
});

test("the dedup key is owner and message: a readdressed message id is audited for each owner, cleanup is per owner", async (t) => {
  const f = forkNode(t);
  const policy = JSON.parse(fs.readFileSync(f.paths.policy, "utf8"));
  policy.wake.sessions.push(SECOND);
  policy.wake.codexFork.sessions.push(SECOND);
  fs.writeFileSync(f.paths.policy, JSON.stringify(policy));
  outsideIdle(f);
  outsideIdle(f, SECOND);
  const id = f.add();
  const lines = (): [string, string, string[]][] => forkAudit(f).map((line) => [line.sessionId, line.action, line.messageIds]);
  await poll(f);
  assert.deepEqual(lines(), [[FORK_OWNER, "fork-cwd-refused", [id]]]);
  // The legacy readdress (node/_deprecated) moves the waiting message to another session under the same id.
  assert.deepEqual(readdress(f.paths.inbox, FORK_OWNER, SECOND), [id]);
  await poll(f);
  assert.deepEqual(lines(), [[FORK_OWNER, "fork-cwd-refused", [id]], [SECOND, "fork-cwd-refused", [id]]], "each owner once");
  // The first owner gets a new message: its cleanup forgets (FORK_OWNER, id), never (SECOND, id).
  const next = f.add();
  await poll(f);
  await poll(f);
  assert.deepEqual(lines(), [[FORK_OWNER, "fork-cwd-refused", [id]], [SECOND, "fork-cwd-refused", [id]],
    [FORK_OWNER, "fork-cwd-refused", [next]]], "interleaved polls of both owners dedup per owner");
  assert.deepEqual([f.app.runs.length, turns(f), turns(f, SECOND)], [0, [], []]);
});

test("with wake.codexFork absent nothing is written: the pre-claim audit changes nothing", async (t) => {
  const f = forkNode(t, {}, { fork: false });
  f.add();
  outsideIdle(f);
  await poll(f);
  await poll(f);
  assert.deepEqual(forkAudit(f), []);
  assert.equal(claimed(f), false);
  assert.deepEqual(f.calls, []);
});

test("every pre-claim refusal maps to a fork- audit action and no pre-claim code is left out", (t) => {
  const reasons = (Object.keys(FORK_PROGRESS) as ForkRefusal[])
    .filter((reason): reason is PreClaimRefusal => reason !== "fork-relay-stale");
  assert.deepEqual(Object.keys(FORK_AUDIT).sort(), [...reasons].sort());
  const f = forkNode(t);
  const id = f.add();
  for (const reason of reasons) {
    const action = FORK_AUDIT[reason];
    assert.ok(action.startsWith("fork-"), reason);
    assert.equal(action, reason.startsWith("fork-") ? reason : `fork-${reason}`, reason);
    audit(f.paths, T0, FORK_OWNER, [id], action);
  }
  const lines = forkAudit(f);
  assert.deepEqual(lines.map((line) => line.action), reasons.map((reason) => FORK_AUDIT[reason]));
  for (const line of lines) assert.deepEqual(Object.keys(line), ["ts", "sessionId", "messageIds", "action"], line.action);
});
