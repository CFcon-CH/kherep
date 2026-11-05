// Issue #504. The dispatcher journals each guarded call of a delegated run (a payload with a valid
// agent_id) after its guards, and capture never changes the decision: a journal lib that is missing,
// empty, throws or hangs, and a filesystem that fails or stalls, leave the decision JSON byte for
// byte as without capture, within the journal cap plus the marker grace. The renderer then reads
// unknown, never none, wherever a line was lost; a lost line with no marker is the named residual.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";

import { denialFaultEnv, faultSpan, MARKER_SLOW_MS, type DenialFault } from "./denial-fault.fixture.mts";
import { dispatcherFixture, type DispatcherFixture } from "./guard-dispatch-fixture.mts";
import { journalPaths } from "./lib/denial-journal.mts";
import { readJournal, renderReport } from "./lib/denial-report.mts";

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
const LIBS = ["denial-journal.mts", "workspace-scope.mts"];
const decision = (permissionDecision: string, reason: string): string => JSON.stringify({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason } });
const GUARDS: Record<string, string> = {
  "exit2.mts": "process.stderr.write(\"[exit2-guard] exit2 says no\\nsecond line\\n\");\nprocess.exit(2);\n",
  "json-deny.mts": `process.stdout.write(${JSON.stringify(decision("deny", "[json-guard] json says no"))});\n`,
  "allow.mts": "process.exit(0);\n",
  "empty.mts": "",
  // Issue #700: the header-then-violations shape of commit-, deploy- and main-checkout-guard.
  "header.mts": "process.stderr.write(\"header-guard blocked this command:\\n  - cannot write /h/repo/out.txt\\n  - second\\n\\nadvice\\n\");\nprocess.exit(2);\n",
};

// A dispatcher copy with synthetic guards; lib is the journal lib's state in it.
function fixture(lib: "present" | "missing" | "empty" | "throwing" | "hanging" = "present", capture = true): DispatcherFixture {
  const fx = dispatcherFixture("guard-dispatch-denials-");
  roots.push(fx.root);
  for (const [name, source] of Object.entries(GUARDS)) fs.writeFileSync(path.join(fx.hooks, name), source);
  if (lib !== "missing") for (const name of LIBS) fs.copyFileSync(path.join(import.meta.dirname, "lib", name), path.join(fx.hooks, "lib", name));
  const target = path.join(fx.hooks, "lib", "denial-journal.mts");
  if (lib === "present" && capture) declareCopy(path.join(import.meta.dirname, "lib", "denial-journal.mts"), target);
  if (lib === "empty") fs.writeFileSync(target, "");
  if (lib === "throwing") fs.writeFileSync(target, "export function journalVerdict() { throw new Error(\"boom\"); }\n");
  if (lib === "hanging") fs.writeFileSync(target, "export function journalVerdict() { return new Promise(() => {}); }\n");
  return fx;
}

const payload = (extra: Record<string, unknown> = {}): string => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash",
  tool_input: { command: "git push origin" }, cwd: "/w", agent_id: "agent-t1", agent_type: "general-purpose", tool_use_id: "toolu_1", ...extra });

interface Run { status: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: string; ms: number }
// timeoutMs is a hang guard only, above the 30 s hook timeout so a loaded start-up never turns into a kill; never the measure.
function dispatch(fx: DispatcherFixture, guards: string[], input: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 40_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", fx.dispatch, ...guards.map((g) => path.join(fx.hooks, g))],
      { windowsHide: true, env });
    let stdout = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (status, signal) => { clearTimeout(timer); resolve({ status, signal, timedOut, stdout, ms: Date.now() - start }); });
    child.stdin.end(input);
  });
}
const lines = (fx: DispatcherFixture): Record<string, unknown>[] => {
  const file = journalPaths(fx.root, "agent-t1").journal;
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
};
const firstLine = (fx: DispatcherFixture): string => renderReport(readJournal(fx.root, "agent-t1")).text.split("\n")[0]!;

test("a delegated call is journalled with one denial per denying guard; the decision is the one without capture", async () => {
  const fx = fixture();
  const plain = await dispatch(fx, ["exit2.mts", "json-deny.mts", "allow.mts", "empty.mts"], payload({ agent_id: undefined }));
  assert.equal(fs.existsSync(journalPaths(fx.root, "x").dir), false, "no agent_id, no journal");
  const run = await dispatch(fx, ["exit2.mts", "json-deny.mts", "allow.mts", "empty.mts"], payload());
  assert.equal(run.status, 0);
  assert.equal(run.stdout, plain.stdout);
  const [line] = lines(fx);
  assert.equal(line!.kind, "call");
  assert.equal(line!.id, "toolu_1");
  assert.equal(line!.agent_type, "general-purpose");
  assert.equal(line!.decision, "deny");
  assert.deepEqual(line!.denials, [
    { guard: "exit2-guard", target: "git", reason: "[exit2-guard] exit2 says no", broken: false },
    { guard: "json-guard", target: "git", reason: "[json-guard] json says no", broken: false },
    { guard: "guard-dispatch", target: "git", reason: "[guard-dispatch] empty.mts cannot run (empty, 0 bytes); the tool call is blocked until hook integrity restores it", broken: true },
  ]);
  assert.equal(firstLine(fx), "DENIED-CALLS: 3");
});

// Issue #700. A guard's header is skipped for its first violation, path-reduced (I1); the real commit-guard
// with an em dash renders its violation, the decision as without agent_id (I2).
test("a header guard is journalled with its first violation, not its header", async () => {
  const fx = fixture();
  await dispatch(fx, ["header.mts"], payload());
  assert.deepEqual(lines(fx)[0]!.denials, [{ guard: "header-guard", target: "git", reason: "cannot write out.txt", broken: false }]);
  assert.equal(renderReport(readJournal(fx.root, "agent-t1")).text.split("\n")[1], "- Bash git [header-guard] cannot write out.txt");
});

test("the real commit-guard: an em dash renders as its violation", async () => {
  const fx = fixture();
  fs.copyFileSync(path.join(import.meta.dirname, "commit-guard.mts"), path.join(fx.hooks, "commit-guard.mts"));
  fs.copyFileSync(path.join(import.meta.dirname, "lib", "git-commit-match.mts"), path.join(fx.hooks, "lib", "git-commit-match.mts"));
  const env = { ...process.env };
  delete env.KHEREP_WORK_ITEM_REQUIRED;
  const commit = { tool_input: { command: "git commit -m \"x \u2014 y\"" } };
  const plain = await dispatch(fx, ["commit-guard.mts"], payload({ ...commit, agent_id: undefined }), env);
  const run = await dispatch(fx, ["commit-guard.mts"], payload(commit), env);
  assert.equal(run.stdout, plain.stdout);
  assert.match(run.stdout, /"permissionDecision":"deny"/);
  assert.deepEqual(lines(fx)[0]!.denials, [{ guard: "commit-guard", target: "git", reason: "commit message contains an em dash (U+2014)", broken: false }]);
  assert.equal(renderReport(readJournal(fx.root, "agent-t1")).text.split("\n")[1], "- Bash git [commit-guard] commit message contains an em dash (U+2014)");
});

test("an allow is a call line without denials, the handback is not journalled, a non-string tool_use_id is null", async () => {
  const fx = fixture();
  await dispatch(fx, ["allow.mts"], payload());
  await dispatch(fx, ["exit2.mts"], payload({ tool_name: "SubagentHandback", tool_input: { message: "report" } }));
  await dispatch(fx, ["allow.mts"], payload({ tool_use_id: 42, agent_id: "agent-t1" }));
  assert.deepEqual(lines(fx).map((line) => [line.decision, line.id, (line.denials as unknown[]).length]), [["none", "toolu_1", 0], ["none", null, 0]]);
  assert.equal(firstLine(fx), "DENIED-CALLS: none");
  await dispatch(fx, ["exit2.mts"], payload({ agent_id: "../../escape" }));
  assert.deepEqual(fs.readdirSync(journalPaths(fx.root, "x").dir), ["agent-t1.jsonl"]);
});

test("an agent_id that is no string: the decision as without one, no journal, never the internal-error deny", async () => {
  const fx = fixture("present", false);
  for (const guards of [["allow.mts"], ["exit2.mts"]]) {
    const plain = await dispatch(fx, guards, payload({ agent_id: undefined }));
    const odd = await dispatch(fx, guards, payload({ agent_id: { toString: 1 } }));
    assert.deepEqual([odd.status, odd.stdout], [plain.status, plain.stdout]);
    assert.doesNotMatch(odd.stdout, /internal error/);
  }
  assert.equal(fs.existsSync(journalPaths(fx.root, "x").dir), false);
});

for (const lib of ["missing", "empty", "throwing", "hanging"] as const) {
  test(`a journal lib that is ${lib}: identical decision, exit 0, a marker, never the internal-error deny`, async () => {
    const reference = await dispatch(fixture(), ["exit2.mts"], payload());
    const fx = fixture(lib);
    const run = await dispatch(fx, ["exit2.mts"], payload());
    assert.equal(run.status, 0);
    assert.equal(run.stdout, reference.stdout);
    assert.doesNotMatch(run.stdout, /internal error|cannot run/);
    assert.equal(fs.readFileSync(journalPaths(fx.root, "agent-t1").marker, "utf8"), lib === "hanging" ? "lib-timeout\n" : "lib-load\n");
    assert.equal(firstLine(fx), "DENIED-CALLS: unknown (capture-failed)");
    assert.ok(run.ms < 8_000, `${run.ms} ms`);
  });
}

async function faulted(fault: DenialFault): Promise<{ fx: DispatcherFixture; run: Run; reference: Run; receipt: string }> {
  const fx = fixture();
  await dispatch(fx, ["allow.mts"], payload({ tool_use_id: "toolu_0" })); // an earlier, journalled call
  const reference = await dispatch(fixture(), ["exit2.mts"], payload());
  const receipt = path.join(fx.root, "fault-receipt.json");
  const run = await dispatch(fx, ["exit2.mts"], payload(), denialFaultEnv(fault, "guard-dispatch.mts", process.env, receipt));
  assert.equal(run.timedOut, false, `killed by the hang guard after ${run.ms} ms`);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, reference.stdout, "the decision is unchanged");
  return { fx, run, reference, receipt };
}

// Issue #653: a cap is measured inside the dispatcher, from the fault receipt, not as its wall clock against a
// reference run (node start, guard spawns and teardown are noise the cap does not bound). The caps restate
// guard-dispatch.mts: JOURNAL_CAP_MS, and HOOK_TIMEOUT_MS less SAFETY_MARGIN_MS for DEADLINE; never read from it.
const JOURNAL_CAP_MS = 1_500, DEADLINE_MS = 25_000, LATE_MS = 500, DEADLINE_LATE_MS = 1_000;
const NO_RECEIPT = "no fault receipt: the child was killed or the fault did not engage";
function span(t: TestContext, receipt: string, from: "first-call" | "start", run: Run, reference: Run): { ops: string[]; ms: number } {
  const { ops, ms } = faultSpan(receipt, from);
  t.diagnostic(JSON.stringify({ referenceMs: reference.ms, childMs: run.ms, spanMs: ms, ops }));
  assert.ok(ms !== undefined, `${NO_RECEIPT} (childMs ${run.ms}, signal ${run.signal})`);
  return { ops, ms };
}

test("ENOSPC on the denying call: a marker, the renderer reads unknown (capture-failed)", async () => {
  const { fx } = await faulted("journal-enospc");
  assert.equal(fs.readFileSync(journalPaths(fx.root, "agent-t1").marker, "utf8"), "append\n");
  assert.equal(firstLine(fx), "DENIED-CALLS: unknown (capture-failed)");
});

test("no space for the marker either: the journal is renamed to the marker", async () => {
  const { fx } = await faulted("enospc-all");
  assert.equal(fs.existsSync(journalPaths(fx.root, "agent-t1").journal), false);
  assert.match(fs.readFileSync(journalPaths(fx.root, "agent-t1").marker, "utf8"), /"id":"toolu_0"/);
  assert.equal(firstLine(fx), "DENIED-CALLS: unknown (capture-failed)");
});

test("append and rename both fail: the decision still stands; the lost line is the named residual", async () => {
  const { fx } = await faulted("all-fail");
  assert.equal(fs.existsSync(journalPaths(fx.root, "agent-t1").marker), false);
  assert.equal(lines(fx).length, 1, "only the earlier call; docs name this residual");
});

// Issue #614. The marker is on disk when the dispatcher has exited, however slow the filesystem: emit()
// exits through process.exit(0), which abandons a pending fs.promises write, so the marker write is
// awaited until the dispatcher's deadline. Red against a dispatcher that gave it a fixed 400 ms slice:
// with the append settling after 700 ms the read saw ENOENT.
test("a marker append that settles late: the marker is on disk when the dispatcher has exited", async () => {
  const { fx, run } = await faulted("marker-slow");
  assert.equal(fs.readFileSync(journalPaths(fx.root, "agent-t1").marker, "utf8"), "append\n");
  assert.equal(firstLine(fx), "DENIED-CALLS: unknown (capture-failed)");
  assert.ok(run.ms >= MARKER_SLOW_MS, `${run.ms} ms: the dispatcher waited for the append`);
});

// From the lib's first write to the exit event: the lib waits its cap less 50 ms for the hung journal append,
// then the marker chain writes append-timeout and the dispatcher emits.
test("a journal append that never settles (journal-hang): the decision within the cap, a marker, no broken guard, no re-check", async (t) => {
  const { fx, run, reference, receipt } = await faulted("journal-hang");
  assert.equal(fs.readFileSync(journalPaths(fx.root, "agent-t1").marker, "utf8"), "append-timeout\n");
  const { ops, ms } = span(t, receipt, "first-call", run, reference);
  assert.deepEqual(ops, ["mkdir:dir", "appendFile:.jsonl", "mkdir:dir", "appendFile:.failed"]);
  assert.ok(ms < JOURNAL_CAP_MS + LATE_MS, `capture held ${ms} ms`);
  assert.ok(ms >= 1_000, `capture window abandoned early: ${ms} ms`);
  assert.doesNotMatch(run.stdout, /additionalContext|cannot run/);
});

// The lib's write ends within its 1.5 s cap; a marker write that never settles is given up at the dispatcher's
// deadline, 25 s after its start (issue #614), so this decision arrives late but before the 30 s hook timeout.
// Measured from the preload's evaluation, which precedes the dispatcher's own start by its module load: that
// load is the extra 500 ms of DEADLINE_LATE_MS over LATE_MS.
test("a writer that never settles (all-hang): the decision before the dispatcher deadline, the marker given up there", async (t) => {
  const { fx, run, reference, receipt } = await faulted("all-hang");
  assert.equal(fs.existsSync(journalPaths(fx.root, "agent-t1").marker), false, "nothing settled, so no marker: the named residual");
  const { ops, ms } = span(t, receipt, "start", run, reference);
  assert.deepEqual(ops, ["mkdir:dir", "mkdir:dir"]);
  assert.ok(ms < DEADLINE_MS + DEADLINE_LATE_MS, `the dispatcher held ${ms} ms`);
  assert.ok(ms >= DEADLINE_MS - 500, `the deadline was abandoned early: ${ms} ms`);
  assert.doesNotMatch(run.stdout, /additionalContext|cannot run/);
});
