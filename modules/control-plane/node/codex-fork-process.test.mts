import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import { ANSWER, FORK_ID, FORK_OWNER, FORK_TURN, LAST_TURN, type ForkScenario } from "./codex-fork-fixture.mts";
import { FORK_FEATURE_KEYS } from "./codex-fork-process.mts";
import { RECORD, runFork } from "./codex-fork-run-fixture.mts";
import { serviceAdmissionsIdle } from "./service-drain.mts";
import { testServiceOwner } from "./task-fixture.mts";

// The helper reports the product version from the root package.json; pin the test to the same source.
const VERSION = (JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version;

// Issue #408, PR 3: one fork attempt end to end against the fake app-server
// (design sections 2 to 4). Nothing here starts a process or reaches a real Codex.

const SEQUENCE = ["initialize", "initialized", "thread/read", "thread/turns/list", "thread/goal/get", "thread/fork", "thread/goal/get",
  "turn/start"];

// Issue #477: a JSON-RPC refusal is one local log line of content-free metadata.
const sha = (text: string): string => crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);

test("the happy path: exact sequence, exact fork request, persisted running, then the validated answer", async (t) => {
  const r = await runFork(t);
  assert.deepEqual(r.outcome, { state: "completed", from: "running", answer: JSON.parse(ANSWER).text });
  assert.deepEqual(r.methods(), SEQUENCE);
  assert.deepEqual(r.running, [[LAST_TURN, FORK_ID, "ephemeral-gate"]], "T16: the ephemeral proof goes with running");
  assert.deepEqual([r.run.args, r.run.cwd, r.run.detached, r.run.env.KHEREP_CODEX_FORK, r.run.env.CODEX_HOME],
    [["app-server", "--listen", "stdio://"], r.cwd, true, "1", r.home]);
  const request = (method: string) => r.run.requests.find((m) => m.method === method)!.params;
  assert.deepEqual(request("initialize"), { clientInfo: { name: "kherep_fork_reply", version: VERSION }, capabilities: { experimentalApi: true } });
  assert.deepEqual(request("thread/read"), { threadId: FORK_OWNER, includeTurns: false });
  assert.deepEqual(request("thread/turns/list"), { threadId: FORK_OWNER, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
  const goals = r.run.requests.filter((m) => m.method === "thread/goal/get").map((m) => m.params);
  assert.deepEqual(goals, [{ threadId: FORK_OWNER }, { threadId: FORK_ID }]);
  const config = Object.fromEntries(FORK_FEATURE_KEYS.map((key) => [`features.${key}`, false]));
  assert.deepEqual(request("thread/fork"), { threadId: FORK_OWNER, lastTurnId: LAST_TURN, ephemeral: true, excludeTurns: true, cwd: r.cwd,
    runtimeWorkspaceRoots: [r.cwd], sandbox: "read-only", approvalPolicy: "on-request",
    config: { ...config, web_search: "disabled", "tools.experimental_request_user_input.enabled": false,
      "mcp_servers.synthetic_probe.enabled": false } });
  assert.equal(Object.hasOwn(request("thread/fork")!, "deferGoalContinuation"), false, "measured: rejected with ephemeral");
  const start = request("turn/start")!;
  assert.equal(start.threadId, FORK_ID);
  assert.equal(start.input[0].type, "text");
  assert.deepEqual(start.outputSchema.required, ["kind", "text", "code"]);
  assert.match(start.input[0].text, /Is the build green\?/);
  assert.doesNotMatch(start.input[0].text, /To reply:|In reply to:|msg send/);
  assert.deepEqual(r.run.signals, [], "a clean close needs no signal");
  assert.ok(r.run.ended);
});

test("turn notifications are kept and counted once whether they arrive before or after the turn/start response", async (t) => {
  for (const early of [false, true]) {
    const r = await runFork(t, { early });
    assert.equal(r.outcome.state, "completed", `early: ${early}`);
  }
});

test("owner preflight: a different cwd, id or an ephemeral thread is cwd-mismatch, and no fork is requested", async (t) => {
  for (const ownerThread of [{ cwd: "/elsewhere" }, { id: FORK_ID }, { ephemeral: true }]) {
    const r = await runFork(t, { ownerThread });
    assert.deepEqual(r.outcome, { state: "failed", from: "launching", reason: "cwd-mismatch" }, JSON.stringify(ownerThread));
    assert.ok(!r.methods().includes("thread/fork"));
  }
});

test("the newest owner turn must be completed: inProgress, interrupted, failed or no row refuses", async (t) => {
  for (const rows of [[{ id: LAST_TURN, status: "inProgress" }], [{ id: LAST_TURN, status: "interrupted" }],
    [{ id: LAST_TURN, status: "failed" }], []]) {
    const r = await runFork(t, { turnRows: rows });
    assert.deepEqual(r.outcome, { state: "failed", from: "launching", reason: "last-turn-not-completed" }, JSON.stringify(rows));
  }
});

// Goal revision of 2026-10-16. Strings MEASURED by the macOS session on Codex
// 0.160.1, 0.162.0-alpha.17.2 and 0.163.0 (hypothesis H1).
const DISABLED = { error: { code: -32600, message: "goals feature is disabled" } };

test("T18, T19: owner goal: none or complete pass; any other goal, goals disabled or anything else refuses", async (t) => {
  const cases: [Record<string, unknown>, string | null][] = [
    [{ ownerGoalReply: { result: { goal: null } } }, null], [{ ownerGoalReply: { result: { goal: { status: "complete" } } } }, null],
    [{ ownerGoalReply: { result: { goal: { status: "active" } } } }, "owner-goal"],
    [{ ownerGoalReply: { result: { goal: { status: "paused" } } } }, "owner-goal"],
    [{ ownerGoalReply: DISABLED }, "goals-disabled"],
    [{ ownerGoalReply: { error: { code: -32603, message: "failed to locate thread id" } } }, "goal-unknown"],
    [{ ownerGoalReply: { error: { code: -32600, message: `thread not found: ${FORK_OWNER}` } } }, "goal-unknown"],
    [{ ownerGoalReply: { result: { goal: 7 } } }, "goal-unknown"],
  ];
  for (const [scenario, reason] of cases) {
    const r = await runFork(t, scenario);
    if (!reason) { assert.equal(r.outcome.state, "completed", JSON.stringify(scenario)); continue; }
    assert.deepEqual(r.outcome, { state: "failed", from: "launching", reason }, JSON.stringify(scenario));
    assert.ok(!r.methods().includes("thread/fork"), "no fork after a refused owner read");
  }
});

test("fork response shape: same id, wrong source, persisted, writable or other approvals fail; an RPC error is fork-rejected", async (t) => {
  for (const shape of [{ forkThread: { id: FORK_OWNER } }, { forkThread: { forkedFromId: FORK_ID } }, { forkThread: { ephemeral: false } },
    { forkThread: { id: "not-a-uuid" } }, { forkTop: { sandbox: { type: "workspaceWrite" } } }, { forkTop: { approvalPolicy: "never" } },
    { forkTop: { cwd: "/elsewhere" } }]) {
    const r = await runFork(t, shape);
    assert.deepEqual(r.outcome, { state: "failed", from: "launching", reason: "fork-shape" }, JSON.stringify(shape));
    assert.deepEqual(r.running, [], "never running");
  }
  const rejected = await runFork(t, { errors: { "thread/fork": { code: -32600, message: "cannot fork" } } });
  assert.deepEqual(rejected.outcome, { state: "failed", from: "launching", reason: "fork-rejected" });
  assert.equal(Object.hasOwn(rejected.outcome, "rpc"), false, "#477: no new outcome field");
  assert.ok(rejected.logs.includes(`kherep-node: Codex fork helper refused thread/fork (code -32600, text, sha256 ${sha("cannot fork")}, mentions none)`));
});

test("T17: anything but the ephemeral proof on the fork fails before the turn, with its detail code", async (t) => {
  const cases: [Record<string, unknown>, string][] = [
    [{ forkGoalReply: { result: { goal: { threadId: FORK_ID, status: "active" } } } }, "fork-has-goal"],
    [{ forkGoalReply: { result: { goal: null } } }, "fork-goal-null-unexpected"],
    [{ forkGoalReply: DISABLED }, "fork-goal-inconsistent"],
    [{ forkGoalReply: { error: { code: -32600, message: "ephemeral thread does not support goals: 01a0db74-0000-7000-8000-000000000999" } } },
      "fork-goal-id-mismatch"],
  ];
  for (const [scenario, detail] of cases) {
    const r = await runFork(t, scenario);
    assert.deepEqual(r.outcome, { state: "failed", from: "launching", reason: "fork-goal", detail }, detail);
    assert.deepEqual([r.methods().includes("turn/start"), r.running, r.run.ended], [false, [], true], `${detail}: no turn, closed`);
  }
});

test("T14: no answer to the fork's goal read within its timeout fails fork-goal-timeout and closes the helper", async (t) => {
  const r = await runFork(t, { forkGoalReply: "hang" });
  assert.deepEqual(r.outcome, { state: "failed", from: "launching", reason: "fork-goal", detail: "fork-goal-timeout" });
  assert.ok(r.run.ended);
  assert.ok(!r.methods().includes("turn/start"));
});

test("T15: a goal notification for the fork before the goal read's answer fails from the watch rule", async (t) => {
  const r = await runFork(t, { beforeForkGoal: (fork) => [{ method: "thread/goal/updated", params: { threadId: fork, goal: { status: "active" } } }] });
  assert.deepEqual(r.outcome, { state: "failed", from: "launching", reason: "fork-goal" }, "the ephemeral proof that follows is ignored");
  assert.deepEqual(r.running, []);
  assert.deepEqual(r.run.signals, ["SIGKILL"], "a preflight violation ends the group too");
});

test("watch rules during the turn fail the attempt and interrupt the fork turn", async (t) => {
  const cases: [string, (fork: string, turn: string) => Record<string, unknown>[]][] = [
    ["fork-goal", (fork) => [{ method: "thread/goal/updated", params: { threadId: fork, goal: { status: "active" } } }]],
    ["tool-item", (fork, turn) => [{ method: "item/started", params: { threadId: fork, turnId: turn, item: { type: "commandExecution" } } }]],
    ["unsolicited-turn", () => [{ method: "turn/started", params: { threadId: FORK_OWNER, turn: { id: "x" } } }]],
    ["unsolicited-turn", (fork) => [{ method: "turn/started", params: { threadId: fork, turn: { id: "another" } } }]],
    ["hook-ran", (fork) => [{ method: "hook/started", params: { threadId: fork } }]],
    ["mcp-started", (fork) => [{ method: "mcpServer/startupStatus/updated", params: { threadId: fork, name: "s" } }]],
    ["server-request", (fork) => [{ id: 900, method: "item/commandExecution/requestApproval", params: { threadId: fork } }]],
  ];
  for (const [reason, during] of cases) {
    const r = await runFork(t, { during, hang: true });
    assert.deepEqual(r.outcome, { state: "failed", from: "running", reason }, reason);
    assert.ok(r.methods().includes("turn/interrupt"), `${reason}: interrupted`);
  }
  const refused = (await runFork(t, { during: (fork) => [{ id: 900, method: "item/tool/requestUserInput", params: { threadId: fork } }],
    hang: true })).run.requests.find((m) => m.id === 900);
  assert.deepEqual(refused, { id: 900, error: { code: -32601, message: "kherep fork reply has no approval authority" } });
});

test("a server request with the id of a pending preflight request fails the attempt before any fork", async (t) => {
  const r = await runFork(t, { serverRequestAt: "thread/read" });
  assert.deepEqual(r.outcome, { state: "failed", from: "launching", reason: "server-request" });
  assert.ok(!r.methods().includes("thread/fork"));
  const read = r.run.requests.find((m) => m.method === "thread/read")!;
  assert.ok(r.run.requests.some((m) => m.id === read.id && m.error !== undefined), "refused with the colliding id");
  assert.deepEqual(r.run.signals, ["SIGKILL"], "a preflight violation ends the group too");
});

test("decline, interrupted and failed turns, and an invalid answer never complete", async (t) => {
  const decline = await runFork(t, { answer: JSON.stringify({ kind: "decline", text: "", code: "needs-owner" }) });
  assert.deepEqual(decline.outcome, { state: "declined", from: "running", reason: "needs-owner" });
  for (const [turnStatus, reason] of [["interrupted", "turn-interrupted"], ["failed", "turn-failed"]]) {
    assert.deepEqual((await runFork(t, { turnStatus })).outcome, { state: "failed", from: "running", reason });
  }
  assert.deepEqual((await runFork(t, { answer: "not json" })).outcome, { state: "failed", from: "running", reason: "answer-invalid" });
});

test("a turn past its deadline is interrupted and uncertain; a helper exit is helper-exit", async (t) => {
  const late = await runFork(t, { hang: true });
  assert.deepEqual(late.outcome, { state: "uncertain", from: "running", reason: "turn-timeout" });
  assert.deepEqual(late.run.requests.find((m) => m.method === "turn/interrupt")?.params, { threadId: FORK_ID, turnId: FORK_TURN });
  assert.deepEqual((await runFork(t, { exitAt: "turn/start" })).outcome, { state: "uncertain", from: "running", reason: "helper-exit" });
  const early = await runFork(t, { exitAt: "thread/fork" });
  assert.deepEqual(early.outcome, { state: "failed", from: "launching", reason: "helper-exit" });
  assert.match(early.logs.join("\n"), /Codex fork helper ended \(0\)/);
});

test("initialize, superseded and a failed running write end before any turn", async (t) => {
  assert.deepEqual((await runFork(t, { errors: { initialize: { code: -1, message: "no" } } })).outcome,
    { state: "failed", from: "launching", reason: "initialize" });
  const superseded = await runFork(t, {}, { stillAccepted: () => false });
  assert.deepEqual(superseded.outcome, { state: "superseded", from: "launching" });
  assert.ok(!superseded.methods().includes("thread/fork"), "the owner read it: no fork");
  const stuck = await runFork(t, {}, { running: () => { throw new Error("disk full"); } });
  assert.deepEqual(stuck.outcome, { state: "uncertain", from: "launching", reason: "helper-exit" });
  assert.ok(!stuck.methods().includes("turn/start"));
});

test("an unconfirmed close after a valid answer is uncertain and keeps the service admission", async (t) => {
  const r = await runFork(t, { ignoreEnd: true, neverExit: true });
  assert.deepEqual(r.outcome, { state: "uncertain", from: "running", reason: "close-unconfirmed" });
  assert.deepEqual(r.run.signals, ["SIGKILL"]);
  assert.equal(r.unconfirmed(), 1);
  assert.equal(serviceAdmissionsIdle(r.paths, testServiceOwner), false, "the lease stays");
});

test("a failure kills the process group even after the direct child ended on SIGTERM (issue #432)", async (t) => {
  const r = await runFork(t, { malformedAt: "thread/turns/list", exitOnTerm: true });
  assert.deepEqual(r.outcome, { state: "failed", from: "launching", reason: "last-turn-not-completed" });
  assert.deepEqual(r.run.signals, ["SIGTERM", "SIGKILL"]);
});

test("an unexpected failure after running is uncertain from running, never a launching record", async (t) => {
  let running=false;
  const record={...RECORD,depth:0,senderOrigin:{nodeId:RECORD.from.nodeId,sentAt:RECORD.createdAt},get text():string{if(running)throw Error("synthetic");return RECORD.text;}};
  const r=await runFork(t,{}, {record,running:()=>{running=true;}});
  assert.deepEqual(r.outcome, { state: "uncertain", from: "running", reason: "helper-exit" });
  assert.equal(r.running.length, 1);
});

// Cross-review of #439, P2-1 and the late-violation follow-up: a watch rule that fires in the same stdout chunk as
// turn/completed, after it, or while the helper closes discards the answer and still ends the process group.
test("a violation after turn/completed or during the close discards the answer and ends the group", async (t) => {
  const request = (id: number, method: string) => (fork: string) => [{ id, method, params: { threadId: fork } }];
  const DECLINE = JSON.stringify({ kind: "decline", text: "", code: "needs-owner" });
  const cases: [string, Partial<ForkScenario>][] = [
    ["server-request", { afterCompleted: request(950, "item/commandExecution/requestApproval") }],
    ["tool-item", { afterCompleted: (fork, turn) => [{ method: "item/started", params: { threadId: fork, turnId: turn, item: { type: "commandExecution" } } }] }],
    ["unsolicited-turn", { afterCompleted: () => [{ method: "turn/started", params: { threadId: FORK_OWNER, turn: { id: "x" } } }] }],
    ["server-request", { onClose: request(951, "item/tool/requestUserInput") }],
    ["tool-item", { onClose: (fork) => [{ method: "item/completed", params: { threadId: fork, item: { type: "mcpToolCall" } } }] }],
    ["server-request", { answer: DECLINE, onClose: request(952, "item/permissions/requestApproval") }],
  ];
  for (const [reason, scenario] of cases) {
    const r = await runFork(t, scenario);
    assert.deepEqual(r.outcome, { state: "failed", from: "running", reason }, JSON.stringify(scenario));
    assert.deepEqual([r.run.ended, r.run.signals, r.unconfirmed()], [true, ["SIGKILL"], 0], `${reason}: group ended, close confirmed`);
    assert.equal(serviceAdmissionsIdle(r.paths, testServiceOwner), true, `${reason}: released after the confirmed forced close`);
  }
});

// Cross-review of #439, P2-2: a turn timeout ends with the group SIGKILL even
// when turn/interrupt succeeds and the direct child ends on stdin end.
test("a timed-out turn ends with the group SIGKILL after a successful interrupt, never settled early", async (t) => {
  const r = await runFork(t, { hang: true });
  assert.deepEqual(r.outcome, { state: "uncertain", from: "running", reason: "turn-timeout" });
  // The fake answers turn/interrupt with a result: the interrupt succeeded.
  assert.ok(r.methods().includes("turn/interrupt"));
  assert.ok(r.run.ended, "the direct child ended on stdin end");
  assert.deepEqual(r.run.signals, ["SIGKILL"], "the group still gets SIGKILL before the attempt settles");
  const violated = await runFork(t, { hang: true, during: (fork) => [{ method: "thread/goal/updated", params: { threadId: fork } }] });
  assert.deepEqual(violated.outcome, { state: "failed", from: "running", reason: "fork-goal" });
  assert.deepEqual(violated.run.signals, ["SIGKILL"], "a violating turn is ended the same way");
});
