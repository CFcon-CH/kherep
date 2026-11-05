// Issue #504. The Codex adapter's main() journals a delegated call's verdict once, through the
// installed journal lib beside it, and capture never changes the decision: a lib that is missing,
// empty, throws or hangs leaves the deny JSON as without capture, exit 0, within the deadline.
// preToolUse() and runAdaptedHook(), which the shell dispatcher calls in-process, never journal.
// Capture stays inert until a Codex child payload carries agent_id (#537); these payloads carry one.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

import { denialFaultEnv, faultSpan, MARKER_SLOW_MS } from "../../claude/hooks/denial-fault.fixture.mts";
import { journalPaths } from "../../claude/hooks/lib/denial-journal.mts";
import { readJournal, renderReport } from "../../claude/hooks/lib/denial-report.mts";
import { assertSameAnswer, cleanupHomes, codexHome, exit2, run, scrub, shellPayload, type CodexHome, type Run } from "./denials-fixture.mts";

after(cleanupHomes);
const GUARDS = { "codex-guard.mts": exit2("codex-guard"), "allow.mts": "process.exit(0);\n" };
const adapt = (home: CodexHome, guard: string, input: string) =>
  run([path.join(home.hookDir, "codex-hook-adapter.mts"), path.join(home.hookDir, guard), "pre"], input);
const slowExit2 = (tag: string, ms: number): string => `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});\n${exit2(tag)}`;
// Issue #664. Both runs deny in PreToolUse; with the control reason in both the strict comparison holds ("same"),
// else every other reason is one of the adapter's wall-clock reasons for a guard or for itself ("time-bound").
const CONTROL = "[codex-guard] codex-guard says no";
const TIME_BOUND = new RegExp("^\\[hook-adapter\\] kherep-maestro/codex-(guard|hook-adapter)\\.mts cannot run \\((timed out after \\d+\\.\\d s"
  + "|budget exhausted before item \\d+ of \\d+ \\(\\d+ ms used\\)|stdin not closed within \\d+ ms|spawn failed \\([A-Za-z0-9_]+\\))\\); "
  + "the tool call is blocked until hook integrity restores it$");
function assertSameDeny(result: Run, home: CodexHome, reference: Run, referenceHome: CodexHome): "same" | "time-bound" {
  const both = `${scrub(result.stdout, home)} / reference ${scrub(reference.stdout, referenceHome)}`;
  const outputs = [result, reference].map((r) => (JSON.parse(r.stdout) as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput);
  for (const output of outputs) assert.deepEqual([output?.hookEventName, output?.permissionDecision], ["PreToolUse", "deny"], both);
  const reasons = outputs.map((output) => output?.permissionDecisionReason);
  if (reasons.every((reason) => reason === CONTROL)) { assertSameAnswer(result, home, reference, referenceHome); return "same"; }
  for (const reason of reasons) if (reason !== CONTROL) assert.match(String(reason), TIME_BOUND, both);
  return "time-bound";
}
const lines = (home: CodexHome): Record<string, unknown>[] => {
  const file = journalPaths(home.root, "agent-c1").journal;
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
};

test("a delegated deny is journalled once with its target; without agent_id nothing is written", async () => {
  const home = codexHome(GUARDS);
  const plain = await adapt(home, "codex-guard.mts", shellPayload({ agent_id: undefined }));
  assert.equal(fs.existsSync(journalPaths(home.root, "x").dir), false);
  const delegated = await adapt(home, "codex-guard.mts", shellPayload());
  assert.equal(delegated.status, 0, delegated.stderr);
  assert.equal(delegated.stdout, plain.stdout);
  assert.equal(JSON.parse(delegated.stdout).hookSpecificOutput.permissionDecision, "deny");
  const [line, extra] = lines(home);
  assert.equal(extra, undefined);
  assert.deepEqual([line!.tool, line!.id, line!.decision], ["shell_command", "call_1", "deny"]);
  assert.deepEqual(line!.denials, [{ guard: "codex-guard", target: "git", reason: "[codex-guard] codex-guard says no", broken: false }]);
  await adapt(home, "allow.mts", shellPayload({ tool_use_id: "call_2" }));
  assert.equal(lines(home).length, 2);
  assert.equal(renderReport(readJournal(home.root, "agent-c1")).text.split("\n")[0], "DENIED-CALLS: 1");
});

for (const lib of ["missing", "empty", "throwing", "hanging"] as const) {
  test(`an installed journal lib that is ${lib}: the same deny, exit 0, a marker`, async (t) => {
    const referenceHome = codexHome(GUARDS);
    const reference = await adapt(referenceHome, "codex-guard.mts", shellPayload());
    const home = codexHome(GUARDS, lib);
    const result = await adapt(home, "codex-guard.mts", shellPayload());
    assert.equal(result.status, 0);
    t.diagnostic(JSON.stringify({ deny: assertSameDeny(result, home, reference, referenceHome), referenceMs: reference.ms, childMs: result.ms }));
    assert.equal(fs.readFileSync(journalPaths(home.root, "agent-c1").marker, "utf8"), lib === "hanging" ? "lib-timeout\n" : "lib-load\n");
    assert.ok(result.ms < 8_500, `${result.ms} ms`);
  });
}

// Issue #664. A guard slower than its 5 s cap: the same deny family with a wall-clock reason instead of the
// control reason. 6 s is always past the cap; a cap shortened by a slow start yields the same family.
test("a guard slower than its cap: a time-bound deny, exit 0, a marker", async (t) => {
  const referenceHome = codexHome(GUARDS);
  const reference = await adapt(referenceHome, "codex-guard.mts", shellPayload());
  const home = codexHome({ ...GUARDS, "codex-guard.mts": slowExit2("codex-guard", 6_000) }, "empty");
  const result = await adapt(home, "codex-guard.mts", shellPayload());
  assert.equal(result.status, 0);
  assert.equal(assertSameDeny(result, home, reference, referenceHome), "time-bound");
  assert.match(fs.readFileSync(journalPaths(home.root, "agent-c1").marker, "utf8"), /^lib-(load|timeout)\n$/);
  t.diagnostic(JSON.stringify({ referenceMs: reference.ms, childMs: result.ms }));
});

// Issue #612. The marker is on disk when the process has exited, however slow the filesystem: the
// adapter exits through process.exit(0), which abandons a pending fs.promises write, so the marker
// write is awaited (up to the hook deadline) before emit(). Red against an adapter that gives the
// marker a fixed slice and exits: with the append settling after 700 ms the read saw ENOENT.
test("a marker append that settles late: the marker is on disk when the adapter has exited", async (t) => {
  const referenceHome = codexHome(GUARDS);
  const reference = await adapt(referenceHome, "codex-guard.mts", shellPayload());
  const home = codexHome(GUARDS, "hanging");
  const result = await run([path.join(home.hookDir, "codex-hook-adapter.mts"), path.join(home.hookDir, "codex-guard.mts"), "pre"],
    shellPayload(), denialFaultEnv("marker-slow", "codex-hook-adapter.mts"));
  assert.equal(result.status, 0);
  t.diagnostic(JSON.stringify({ deny: assertSameDeny(result, home, reference, referenceHome), referenceMs: reference.ms, childMs: result.ms }));
  assert.equal(fs.readFileSync(journalPaths(home.root, "agent-c1").marker, "utf8"), "lib-timeout\n");
  assert.ok(result.ms >= MARKER_SLOW_MS, `${result.ms} ms: the adapter waited for the append`);
  assert.ok(result.ms < 8_500, `${result.ms} ms`);
});

// The lib's write ends within 1 s; a marker write that never settles is given up at the hook
// deadline less 250 ms (issue #612), so this deny arrives late but before the deadline. Issue #653:
// measured inside the adapter from its time origin, the anchor of its START, by the fault receipt;
// END_MS restates hook-adapter.mts HOOK_TIMEOUT_MS - SAFETY_MARGIN_MS - 250, never read from it.
const END_MS = 8_250, LATE_MS = 500, NO_RECEIPT = "no fault receipt: the child was killed or the fault did not engage";
test("a journal write that never settles: the same deny before the hook deadline, the marker given up there", async (t) => {
  const referenceHome = codexHome(GUARDS), home = codexHome(GUARDS);
  const reference = await adapt(referenceHome, "codex-guard.mts", shellPayload());
  const receipt = path.join(home.root, "fault-receipt.json");
  const result = await run([path.join(home.hookDir, "codex-hook-adapter.mts"), path.join(home.hookDir, "codex-guard.mts"), "pre"],
    shellPayload(), denialFaultEnv("all-hang", "codex-hook-adapter.mts", process.env, receipt));
  assert.equal(result.timedOut, false, `killed by the watchdog after ${result.ms} ms`);
  assert.equal(result.status, 0, result.stderr);
  t.diagnostic(JSON.stringify({ deny: assertSameDeny(result, home, reference, referenceHome), referenceMs: reference.ms, childMs: result.ms }));
  assert.equal(fs.existsSync(journalPaths(home.root, "agent-c1").marker), false, "nothing settled, so no marker: the named residual");
  const { ops, ms } = faultSpan(receipt, "origin");
  t.diagnostic(JSON.stringify({ referenceMs: reference.ms, childMs: result.ms, spanMs: ms, ops }));
  assert.ok(ms !== undefined, `${NO_RECEIPT} (childMs ${result.ms}, signal ${result.signal})`);
  // The lib's mkdir hangs to its cap, then the marker's mkdir to the end: no append, no rename.
  assert.deepEqual(ops, ["mkdir:dir", "mkdir:dir"]);
  assert.ok(ms < END_MS + LATE_MS, `the adapter held ${ms} ms`);
  assert.ok(ms >= END_MS - 250, `the deadline was abandoned early: ${ms} ms`);
});

test("runAdaptedHook, the in-process path, writes nothing", async () => {
  const home = codexHome(GUARDS, "present", false);
  const adapter = await import(pathToFileURL(path.join(home.hookDir, "hook-adapter.mts")).href) as typeof import("./hook-adapter.mts");
  const result = adapter.runAdaptedHook(path.join(home.hookDir, "codex-guard.mts"), "pre", JSON.parse(shellPayload()), 5_000);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(journalPaths(home.root, "x").dir), false);
});
