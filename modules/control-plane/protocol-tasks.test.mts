import assert from "node:assert/strict";
import test from "node:test";

import { isCommandBody, isSessionInfo } from "./protocol.mts";
import {
  intercomLabel, isCommandArgs, isTaskLabel, isTaskReportBody, isTaskRequestBody, isTaskRequirements, taskSessionName,
} from "./protocol-tasks.mts";

const TASK = "3f2a1b0c-0000-4000-8000-000000000001";
const START = { taskId: TASK, runtime: "claude", name: taskSessionName(TASK), prompt: "fix it", permissionMode: "auto" };

test("Phase 1 commands take no arguments", () => {
  assert.equal(isCommandArgs("session.list", undefined), true);
  assert.equal(isCommandArgs("session.list", {}), true);
  assert.equal(isCommandArgs("node.status", { verbose: true }), false);
  assert.equal(isCommandArgs("shell.exec", { cmd: "id" }), false);
  assert.equal(isCommandBody({ commandId: "c", command: "session.start", args: [] }), false);
});

test("session.start args are validated field by field and nothing else is accepted", () => {
  assert.equal(isCommandArgs("session.start", START), true);
  assert.equal(isCommandArgs("session.start", { ...START, cwd: "/work/repo" }), true);
  assert.equal(isCommandArgs("session.start", { ...START, runtime: "codex" }), true, "codex reaches the node, whose policy decides");
  for (const bad of [
    { ...START, permissionMode: "bypassPermissions" }, { ...START, permissionMode: "plan" }, { ...START, runtime: "gemini" },
    { ...START, name: "task-other" }, { ...START, prompt: "" }, { ...START, prompt: "x".repeat(16_385) }, { ...START, taskId: "t1" },
    { ...START, cwd: "/a\nb" }, { ...START, shell: "bash" }, { ...START, requestedBy: "n/s" }, { ...START, directive: "do it" },
    undefined,
  ]) assert.equal(isCommandArgs("session.start", bad), false, JSON.stringify(bad));
  assert.equal(isCommandArgs("session.start", { ...START, requestedBy: "n/s", directive: "do it" }), true);
  assert.equal(isCommandArgs("session.start", { ...START, requestedBy: "n/s", directive: "do it", sourceRequestId: TASK }), true);
  assert.equal(isCommandArgs("session.start", { ...START, sourceRequestId: TASK }), false);
});

test("session.stop and session.continue take exactly their fields", () => {
  assert.equal(isCommandArgs("session.stop", { taskId: TASK }), true);
  assert.equal(isCommandArgs("session.stop", { taskId: TASK, force: true }), false);
  assert.equal(isCommandArgs("session.stop", {}), false);
  assert.equal(isCommandArgs("session.continue", { taskId: TASK, prompt: "go on" }), true);
  assert.equal(isCommandArgs("session.continue", { taskId: TASK }), false);
  assert.equal(isCommandArgs("session.continue", { taskId: TASK, prompt: "go on", permissionMode: "auto" }), false);
});

test("task reports, requests and requirements", () => {
  assert.equal(isTaskReportBody({ taskId: TASK, state: "done", summary: "fixed" }), true);
  assert.equal(isTaskReportBody({ taskId: TASK, state: "queued" }), false);
  assert.equal(isTaskReportBody({ taskId: TASK, state: "done", text: "x" }), false);
  assert.equal(isTaskRequirements({ runtime: "claude", os: "win32", capabilities: ["gpu"], cwd: "D:/ws" }), true);
  assert.equal(isTaskRequirements({ runtime: "claude", shell: "cmd" }), false);
  const request = { requestId: TASK, title: "t", text: "x", requirements: {}, directive: "", requestedBy: "maestro" };
  assert.equal(isTaskRequestBody(request), true, "an empty directive parses, so the Worker can refuse it with a reason");
  assert.equal(isTaskRequestBody({ ...request, requestedBy: "a\nb" }), false);
});

test("a label is letters, digits, space and : @ - _ . with at most 64 characters (issue #74)", () => {
  assert.equal(intercomLabel("claude", "sekhmet"), "intercom: claude@sekhmet");
  for (const good of ["intercom: claude@sekhmet", "intercom: agent-name@example.test", "a", "A_b-9.x", "x".repeat(64)]) {
    assert.equal(isTaskLabel(good), true, good);
  }
  for (const bad of ["", " lead", "trail ", "x".repeat(65), "a\nb", "a/b", "café", "a\tb", 'quote"', "semi;colon", 42]) {
    assert.equal(isTaskLabel(bad), false, JSON.stringify(bad));
  }
});

test("session.start, requests, requirements and session info carry an optional label and target node (issue #74)", () => {
  const NODE = "00000000-0000-4000-8000-0000000000cc";
  assert.equal(isCommandArgs("session.start", { ...START, label: "intercom: claude@sekhmet" }), true);
  assert.equal(isCommandArgs("session.start", { ...START, label: "bad/label" }), false);
  assert.equal(isCommandArgs("session.start", { ...START, name: "intercom: claude@sekhmet" }), false, "the name stays task-<8>");
  assert.equal(isTaskRequirements({ runtime: "codex", node: NODE }), true);
  assert.equal(isTaskRequirements({ node: "sekhmet" }), false, "the target is a node id; the CLI resolves names");
  const request = { requestId: TASK, title: "t", text: "x", requirements: { node: NODE }, directive: "d", requestedBy: "maestro" };
  assert.equal(isTaskRequestBody({ ...request, label: "intercom: codex@isis" }), true);
  assert.equal(isTaskRequestBody({ ...request, label: "" }), false);
  const session = { sessionId: "s1", runtime: "claude-code", state: "working", name: "task-3f2a1b0c" };
  assert.equal(isSessionInfo({ ...session, label: "intercom: claude@sekhmet" }), true);
  assert.equal(isSessionInfo({ ...session, label: "x".repeat(65) }), false);
});
