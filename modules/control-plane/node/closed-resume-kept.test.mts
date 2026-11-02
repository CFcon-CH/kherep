import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { SessionInfo } from "../protocol.mts";
import { audits, SESSION } from "./closed-fixture.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { resumeClaude } from "./closed-resume.mts";
import {
  COPY, copyOutput, resumeNode, resumingExec, runs, secondBurst, SESSION2, type Fault,
} from "./closed-resume-fault-fixture.mts";
import { deliverForHook } from "./deliver-hook.mts";
import { recordingSessions, writeLocalSessions } from "./exchange.mts";
import { getMessage, UNDELIVERABLE_AFTER_MS } from "./inbox.mts";
import { readTask } from "./task-records.mts";
import { watchTasks } from "./task-watch.mts";

// Issue #638: once a resumed run is kept for adoption, a later bookkeeping
// error propagates instead of becoming a reason that authorizes a second
// session; a malformed listed full id is not adopted. Synthetic only.
const BAD = ["x".repeat(129), "bad\nid"];

for (const note of [true, false]) {
  test(`a resumed run listed under a malformed id ${note ? "with" : "without"} a copy note is kept; no second session`, async (t) => {
    const { node, task, id } = await resumeNode(t);
    const { deps } = resumingExec(t, node, { output: copyOutput(note), listed: BAD[note ? 0 : 1] });
    const lines: string[] = [];
    await deliverToClosed({ ...deps, log: (l) => lines.push(l) }, (l) => lines.push(l));
    assert.deepEqual(runs(node), ["--bg", "--resume"], "exactly one resume, no fallback start");
    const kept = readTask(node.paths, task.taskId)!;
    assert.deepEqual([kept.sessionId, kept.shortId, kept.state], [task.sessionId, "c0ffee01", "started"]);
    assert.ok(kept.mappingPendingSince && kept.awaitingProgressSince);
    assert.deepEqual(kept.retire, [{ shortId: task.shortId, sessionId: task.sessionId }]);
    assert.equal(getMessage(node.paths.inbox, id)?.toSession, task.sessionId, "messages stay at the old full id");
    assert.ok(lines.some((l) => l.includes(task.taskId) && l.includes("listed session id is not valid")));
    assert.ok(!lines.some((l) => l.includes(BAD[note ? 0 : 1])));
    assert.deepEqual(audits(node).at(-1)?.reason, "intercom session resumed");
    // A later valid listing maps the printed short id; the real hooks deliver once.
    node.rows.find((r) => r.id === "c0ffee01")!.sessionId = COPY;
    await watchTasks(deps);
    assert.deepEqual([readTask(node.paths, task.taskId)?.sessionId, getMessage(node.paths.inbox, id)?.toSession], [COPY, COPY]);
    writeLocalSessions(node.paths, [{ sessionId: COPY, name: task.name, runtime: "claude-code", state: "busy", cwd: task.cwd }],
      deps.now!());
    const hook = (event: "UserPromptSubmit" | "Stop") => {
      const output = deliverForHook({ hook_event_name: event, session_id: COPY, permission_mode: "auto", stop_hook_active: false },
        { paths: node.paths, now: deps.now!, nonce: () => "synthetic-nonce", replyCommand: "synthetic-node msg send" });
      const context = output ? String(JSON.parse(output).hookSpecificOutput?.additionalContext ?? "") : "";
      return [...context.matchAll(/^=== Kherep peer message ([\w-]+) \[/gm)].map((m) => m[1]!);
    };
    assert.deepEqual(hook("UserPromptSubmit"), [id]);
    hook("Stop");
    assert.equal(getMessage(node.paths.inbox, id)?.state, "delivered");
    assert.deepEqual([...hook("UserPromptSubmit"), ...hook("Stop")], []);
    assert.deepEqual(runs(node), ["--bg", "--resume"]);
  });
}

const cases: { fault: Fault; listed: string; label: string }[] = [
  { fault: "task-write", listed: COPY, label: "the adopted task write" },
  { fault: "inbox-write", listed: COPY, label: "the handover of a valid copy" },
  { fault: "release", listed: COPY, label: "the admission release after a valid adoption" },
  { fault: "release", listed: BAD[0], label: "the admission release after a malformed listing" },
];
for (const { fault, listed, label } of cases) {
  test(`an I/O error in ${label} starts no second session; a burst for another closed target still runs`, async (t) => {
    const { node, task } = await resumeNode(t);
    const other = secondBurst(node);
    const { deps, events } = resumingExec(t, node, { output: copyOutput(true), listed, fault });
    const lines: string[] = [];
    await deliverToClosed({ ...deps, log: (l) => lines.push(l) }, (l) => lines.push(l));
    assert.deepEqual(events.slice(0, 2), ["resume", `${fault}-fault`], "the fault hit after the native resume returned");
    assert.deepEqual(runs(node), ["--bg", "--resume"], "no fallback start for the burst");
    assert.equal(lines.filter((l) => l.startsWith(`kherep-node: could not deliver to closed session ${SESSION}: synthetic ${fault}`)).length, 1);
    const later = audits(node).at(-1)!;
    assert.deepEqual([later.sessionId, later.outcome, later.messageIds], [SESSION2, "reused", [other]]);
    assert.equal(readTask(node.paths, task.taskId)?.state, "started");
  });
}

test("a direct resume rejects with the original release error once the run is kept", async (t) => {
  const { node, task } = await resumeNode(t);
  const { deps } = resumingExec(t, node, { output: copyOutput(false), listed: task.sessionId!, fault: "release" });
  const now = deps.now!();
  await assert.rejects(resumeClaude(deps, task, task.cwd, 1, now), (error: Error & { code?: string }) =>
    error.message === "synthetic release failure" && error.code === "EIO");
});

test("a malformed listed id is never written to tasks, inbox, directory or reports", async (t) => {
  const { node } = await resumeNode(t);
  const { deps } = resumingExec(t, node, { output: copyOutput(true), listed: BAD[1] });
  await deliverToClosed(deps);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file); else files.push(fs.readFileSync(file, "utf8"));
    }
  };
  walk(node.paths.dir);
  assert.ok(!files.some((f) => f.includes("bad\\nid") || f.includes("bad\nid")));
});

// The documented limit: messages of a kept invalid-id resume stay at the old
// id; they are refused only by a successful listing without their target,
// once they are older than the threshold, never by a failed listing.
test("messages left at the old id by a malformed listing are refused only under the existing conditions", async (t) => {
  const { node, task, id } = await resumeNode(t);
  const { deps } = resumingExec(t, node, { output: copyOutput(true), listed: BAD[0] });
  await deliverToClosed(deps);
  const kept = getMessage(node.paths.inbox, id)!;
  assert.deepEqual([kept.toSession, kept.closedTo, kept.state], [task.sessionId, SESSION, "accepted"]);
  const since = Date.parse(kept.closedAttempt!);
  const old = { sessionId: task.sessionId!, runtime: "claude-code", state: "idle" } as const;
  const listing = (sessions: SessionInfo[] | null, at: number) => recordingSessions(node.paths,
    async () => { if (!sessions) throw new Error("synthetic listing failure"); return sessions; }, () => {}, () => at)();
  await listing([], since + UNDELIVERABLE_AFTER_MS);
  await assert.rejects(listing(null, since + UNDELIVERABLE_AFTER_MS + 1));
  await listing([old], since + UNDELIVERABLE_AFTER_MS + 1);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted", "young, failed or live: not refused");
  await listing([], since + UNDELIVERABLE_AFTER_MS + 1);
  assert.equal(getMessage(node.paths.inbox, id)?.state, "accepted", "empty or malformed evidence remains UNKNOWN");
  const { fixtureEvidence, syntheticListing } = await import("./session-authority-fixture.mts");
  const at = since + UNDELIVERABLE_AFTER_MS + 1;
  await recordingSessions(node.paths, async () => syntheticListing(node.livenessAuthority, [],
    [fixtureEvidence({ runtime: old.runtime, sessionId: old.sessionId }, "closed", at)], at), () => {}, () => at,
    undefined, undefined, node.livenessAuthority)();
  assert.deepEqual([getMessage(node.paths.inbox, id)?.state, getMessage(node.paths.inbox, id)?.reason],
    ["refused", "target session not running"]);
  assert.deepEqual(runs(node), ["--bg", "--resume"]);
});
