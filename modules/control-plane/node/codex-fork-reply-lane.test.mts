import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { wakeAudit } from "./autonomy.mts";
import { readBusyAdmission } from "./codex-busy-admission.mts";
import { consumeBusyHint } from "./codex-busy-consume.mts";
import { forkAttempts } from "./codex-fork-attempts.mts";
import { FORK_OWNER, forkNode } from "./codex-fork-fixture.mts";
import { forkTestTimeouts, resetForkFeatureCache } from "./codex-fork-reply.mts";
import { FAST } from "./codex-fork-run-fixture.mts";
import { resetMcpCache } from "./codex-mcp.mts";
import { legacyForkPoll } from "./codex-fork-legacy-poll.mts";
import { codexQueueIdle } from "./codex-queue.mts";
import { deliverForCodex } from "./deliver-codex.mts";
import { runCodexHook } from "./deliver-hook.mts";
import { getMessageProgress, markOffered } from "./inbox.mts";
import { beginServiceDrain } from "./service-drain.mts";
import { T0, testServiceOwner } from "./task-fixture.mts";

// Issue #408, PR 3: ordering, fences and the hook short-circuit of the fork
// reply producer (design sections 4.7, 6.3), against the fake app-server only.

test.beforeEach(() => { resetMcpCache(); resetForkFeatureCache(); forkTestTimeouts.value = FAST; });
test.after(() => { forkTestTimeouts.value = undefined; });

const OTHER = "01a0db74-0000-7000-8000-0000000000f3";
const actions = (paths: { dir: string }): string[] => (fs.existsSync(wakeAudit(paths as never))
  ? fs.readFileSync(wakeAudit(paths as never), "utf8").trim().split("\n").map((line) => JSON.parse(line).action as string) : []);

test("the owner reads the message between claim and fork: superseded, and no thread/fork request", async (t) => {
  let f: ReturnType<typeof forkNode>;
  let id = "";
  f = forkNode(t, { onRequest: (method) => { if (method === "thread/goal/get") markOffered(f.paths.inbox, id); } });
  id = f.add();
  legacyForkPoll(f.deps());
  await codexQueueIdle();
  assert.deepEqual(forkAttempts(f.paths, FORK_OWNER).map((a) => a.state), ["superseded"]);
  assert.ok(!f.app.runs[0]!.requests.some((m) => m.method === "thread/fork"));
  assert.ok(actions(f.paths).includes("fork-superseded"));
});

test("a policy edited between schedule and admission refuses: no helper and no claim", async (t) => {
  const f = forkNode(t);
  f.add();
  legacyForkPoll(f.deps());
  const policy = JSON.parse(fs.readFileSync(f.paths.policy, "utf8"));
  policy.wake.codexFork.idleAfterSeconds = 120;
  fs.writeFileSync(f.paths.policy, JSON.stringify(policy));
  await codexQueueIdle();
  assert.deepEqual([f.app.runs.length, forkAttempts(f.paths, FORK_OWNER).length], [0, 0]);
  assert.deepEqual(actions(f.paths).filter((action) => action.startsWith("fork")), ["fork-policy-changed"], "issue #444");
});

test("a service drain holds the helper until it ends", async (t) => {
  const f = forkNode(t);
  f.add();
  const end = beginServiceDrain(f.paths, testServiceOwner);
  legacyForkPoll(f.deps());
  const idle = codexQueueIdle();
  await new Promise((resolve) => { setTimeout(resolve, 150); });
  assert.equal(f.app.runs.length, 0, "no helper while the drain runs");
  end();
  await idle;
  assert.equal(f.app.runs.length, 1);
  assert.equal(forkAttempts(f.paths, FORK_OWNER)[0]?.state, "completed");
});

test("two owners: one helper at a time on the node, both complete", async (t) => {
  const f = forkNode(t);
  const policy = JSON.parse(fs.readFileSync(f.paths.policy, "utf8"));
  policy.wake.sessions.push(OTHER);
  policy.wake.codexFork.sessions.push(OTHER);
  fs.writeFileSync(f.paths.policy, JSON.stringify(policy));
  f.idle(OTHER);
  f.add();
  f.add(OTHER);
  legacyForkPoll(f.deps());
  await codexQueueIdle();
  assert.equal(f.app.runs.length, 2);
  const [first, second] = f.app.runs;
  assert.ok(first!.endedAt! <= second!.startedAt, "the second helper starts after the first ended");
  assert.deepEqual([...forkAttempts(f.paths, FORK_OWNER), ...forkAttempts(f.paths, OTHER)].map((a) => a.state), ["completed", "completed"]);
});

test("the CP hint path is unchanged while a fork runs", async (t) => {
  const results: unknown[] = [];
  for (const fork of [false, true]) {
    resetMcpCache();
    resetForkFeatureCache();
    const f = forkNode(t, {}, { fork });
    const id = f.add();
    legacyForkPoll(f.deps());
    await codexQueueIdle();
    const admission = readBusyAdmission(f.paths, FORK_OWNER);
    results.push([admission?.messageIds.length, admission?.publishedAt !== undefined, getMessageProgress(f.paths.inbox, id)?.code,
      actions(f.paths).filter((action) => !action.startsWith("fork"))]);
  }
  assert.deepEqual(results[1], results[0]);
});

test("KHEREP_CODEX_FORK=1: the Codex hooks write nothing, record nothing and reconcile nothing", async (t) => {
  const f = forkNode(t);
  f.add();
  const sessions = path.join(f.paths.codexSessions, `${OTHER}.json`);
  const deps = { paths: f.paths, now: () => T0, replyCommand: "kherep-node" };
  const input = (event: string) => ({ hook_event_name: event, session_id: OTHER, cwd: f.cwd, permission_mode: "default",
    tool_name: "exec_command" });
  const reconciled: string[] = [];
  // The recorded owner's own PostToolUse: outside a fork it refreshes the owner's last event.
  const ownerFile = path.join(f.paths.codexSessions, `${FORK_OWNER}.json`);
  const ownerTool = { hook_event_name: "PostToolUse", session_id: FORK_OWNER, tool_name: "exec_command",
    transcript_path: `/synthetic/sessions/rollout-2026-10-10T10-00-00-${FORK_OWNER}.jsonl` };
  const ownerRecord = fs.readFileSync(ownerFile, "utf8");
  const run = async (): Promise<string[]> => {
    const out: string[] = [];
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) out.push(deliverForCodex(input(event), deps));
    out.push(consumeBusyHint(ownerTool, deps));
    await runCodexHook(JSON.stringify(input("Stop")), deps, (text) => { out.push(text); }, () => {},
      async (owner) => { reconciled.push(owner); });
    return out.filter(Boolean);
  };
  process.env.KHEREP_CODEX_FORK = "1";
  try {
    assert.deepEqual(await run(), []);
    assert.equal(fs.existsSync(sessions), false, "no session record");
    assert.equal(fs.readFileSync(ownerFile, "utf8"), ownerRecord, "the owner's record is untouched");
    assert.deepEqual(reconciled, []);
  } finally {
    delete process.env.KHEREP_CODEX_FORK;
  }
  assert.ok((await run()).length > 0, "without the variable SessionStart answers as before");
  assert.ok(fs.existsSync(sessions));
  assert.equal(JSON.parse(fs.readFileSync(ownerFile, "utf8")).lastEvent, "PostToolUse");
  assert.deepEqual(reconciled, [OTHER]);
});

test("the owner reads the message between admission and claim: superseded without a helper", async (t) => {
  const f = forkNode(t);
  const id = f.add();
  // resolveCwd runs inside admission, after the message was read.
  legacyForkPoll({ ...f.deps(), realpath: (file: string) => { markOffered(f.paths.inbox, id); return fs.realpathSync.native(file); } });
  await codexQueueIdle();
  assert.deepEqual(forkAttempts(f.paths, FORK_OWNER).map((a) => a.state), ["superseded"]);
  assert.equal(f.app.runs.length, 0);
  assert.ok(actions(f.paths).includes("fork-superseded"));
});
