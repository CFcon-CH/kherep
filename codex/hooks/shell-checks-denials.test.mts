// Issue #504. The Codex shell dispatcher journals every denying guard of a delegated call, not only
// the first, after its guards and before the re-check; a journal lib that fails or a writer that
// stalls leaves the decision as it was, within the deadline, and an adapter that does not load
// leaves the capture-failed marker. Inert until a Codex child payload carries agent_id (#537).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { denialFaultEnv, readFaultReceipt } from "../../claude/hooks/denial-fault.fixture.mts";
import { journalPaths } from "../../claude/hooks/lib/denial-journal.mts";
import { readJournal, renderReport } from "../../claude/hooks/lib/denial-report.mts";
import { assertSameAnswer, cleanupHomes, codexHome, exit2, run, shellPayload, type CodexHome } from "./denials-fixture.mts";

after(cleanupHomes);
const GUARDS = { "commit-guard.mts": exit2("commit-guard"), "deploy-guard.mts": "process.exit(0);\n", "main-checkout-guard.mts": exit2("main-checkout") };
const shell = (home: CodexHome, input: string, env?: NodeJS.ProcessEnv) => run([path.join(home.hookDir, "codex-shell-checks.mts")], input, env);
const first = (home: CodexHome): string => renderReport(readJournal(home.root, "agent-c1")).text.split("\n")[0]!;
// Issue #652. The capture interval as the dispatcher saw it: first intercepted write to process exit,
// both stamped in the child by the fault fixture, so process start-up and guard-child load stay out.
// The shared window is 2 s absolute; 500 ms covers one timer's lateness and the flush before exit.
// The child's total wall time is deliberately bounded only by the run() watchdog: start-up and
// guard children are not what the window controls. The exact mkdir, mkdir sequence mirrors the
// journal lib's internals; a change there is an expected test update, not a regression.
const WINDOW_MS = 2_000, LATE_MS = 500, NO_RECEIPT = "no fault receipt: the child was killed or the fault did not engage";
function captured(receipt: string) {
  const doc = readFaultReceipt(receipt);
  return { calls: doc?.calls ?? [], captureMs: doc?.calls[0] ? doc.exitAt - doc.calls[0].at : undefined };
}

test("two denying guards: two denials journalled, the decision as without agent_id", async () => {
  const home = codexHome(GUARDS);
  const plain = await shell(home, shellPayload({ agent_id: undefined }));
  const delegated = await shell(home, shellPayload());
  assert.equal(delegated.status, 0, delegated.stderr);
  assert.equal(delegated.stdout, plain.stdout);
  const [line] = fs.readFileSync(journalPaths(home.root, "agent-c1").journal, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(line.denials.map((d: { guard: string; target: string }) => [d.guard, d.target]), [["commit-guard", "git"], ["main-checkout", "git"]]);
  assert.equal(first(home), "DENIED-CALLS: 2");
});

test("two guards that cannot run stay two denials, each with its guard's tag", async () => {
  for (const [source, tag] of [["", "commit-guard"], ["process.exit(1);\n", "hook-adapter"]] as const) {
    const home = codexHome({ ...GUARDS, "commit-guard.mts": source, "main-checkout-guard.mts": source });
    await shell(home, shellPayload());
    const rendered = renderReport(readJournal(home.root, "agent-c1")).text.split("\n");
    assert.equal(rendered[0], "DENIED-CALLS: 2", rendered.join("\n"));
    assert.ok(rendered.every((line) => !line.includes("[is]")), rendered.join("\n"));
    assert.ok(rendered[1]!.includes(`[${tag}]`), rendered[1]);
  }
});

test("a journal lib that throws: the same decision and a marker", async () => {
  const referenceHome = codexHome(GUARDS);
  const reference = await shell(referenceHome, shellPayload());
  const home = codexHome(GUARDS, "throwing");
  const result = await shell(home, shellPayload());
  assertSameAnswer(result, home, reference, referenceHome);
  assert.equal(first(home), "DENIED-CALLS: unknown (capture-failed)");
});

test("a writer that never settles: the decision within the journal cap", async (t) => {
  const referenceHome = codexHome(GUARDS), home = codexHome(GUARDS), receipt = path.join(home.root, "fault-receipt.json");
  const reference = await shell(referenceHome, shellPayload());
  const result = await shell(home, shellPayload(), denialFaultEnv("all-hang", "codex-shell-checks.mts", process.env, receipt));
  const { calls, captureMs } = captured(receipt);
  t.diagnostic(JSON.stringify({ referenceMs: reference.ms, childMs: result.ms, captureMs }));
  assert.equal(result.timedOut, false, `killed by the watchdog after ${result.ms} ms`);
  assert.equal(result.status, 0, result.stderr);
  assertSameAnswer(result, home, reference, referenceHome);
  assert.ok(captureMs !== undefined, NO_RECEIPT);
  // The lib's mkdir, then the marker's: the chain lib -> marker ran and every write hung.
  assert.deepEqual(calls.map((call) => call.op), ["mkdir", "mkdir"]);
  assert.ok(captureMs < WINDOW_MS + LATE_MS, `capture held ${captureMs} ms`);
  assert.ok(captureMs >= 1_000, `capture window abandoned early: ${captureMs} ms`);
});

// Issues #612 and #621. A 700 ms marker after the lib's 600 ms timeout must
// still persist inside the dispatcher's shared 2 s journal/marker window.
test("a marker append that settles late: the dispatcher exits after it, the marker is on disk", async () => {
  const referenceHome = codexHome(GUARDS);
  const reference = await shell(referenceHome, shellPayload());
  const home = codexHome(GUARDS, "hanging");
  const result = await shell(home, shellPayload(), denialFaultEnv("marker-slow", "codex-shell-checks.mts"));
  assertSameAnswer(result, home, reference, referenceHome);
  assert.equal(fs.readFileSync(journalPaths(home.root, "agent-c1").marker, "utf8"), "lib-timeout\n");
});

test("an adapter that does not load: the deny stands and the call leaves the marker", async () => {
  const home = codexHome(GUARDS, "present", false);
  fs.writeFileSync(path.join(home.hookDir, "hook-adapter.mts"), "");
  const result = await shell(home, shellPayload());
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /adapter could not load/);
  assert.equal(fs.readFileSync(journalPaths(home.root, "agent-c1").marker, "utf8"), "lib-load\n");
});

// Issue #621. The deny can be complete on stdout while a referenced filesystem handle still
// keeps the CLI alive. The watchdog owns only this child and waits for its close after killing it.
for (const brokenAdapter of [false, true]) {
  test(`a stuck marker cannot retain the CLI after its deny (${brokenAdapter ? "broken adapter" : "journal timeout"})`, async (t) => {
    const referenceHome = codexHome(GUARDS, "hanging"), home = codexHome(GUARDS, "hanging"), receipt = path.join(home.root, "fault-receipt.json");
    if (brokenAdapter) for (const h of [referenceHome, home]) fs.writeFileSync(path.join(h.hookDir, "hook-adapter.mts"), "");
    const reference = await shell(referenceHome, shellPayload());
    const result = await run([path.join(home.hookDir, "codex-shell-checks.mts")], shellPayload(),
      denialFaultEnv("marker-stuck", "codex-shell-checks.mts", process.env, receipt), 8_000);
    const { calls, captureMs } = captured(receipt);
    t.diagnostic(JSON.stringify({ brokenAdapter, childMs: result.ms, captureMs, status: result.status, signal: result.signal, timedOut: result.timedOut }));
    assert.equal(result.timedOut, false, `deny was written but child survived to watchdog (${result.ms} ms, ${result.signal})`);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny", "complete deny before child closes");
    assertSameAnswer(result, home, reference, referenceHome);
    assert.equal(fs.existsSync(journalPaths(home.root, "agent-c1").marker), false, "the stuck write did not persist");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.ok(captureMs !== undefined, NO_RECEIPT);
    assert.ok(calls.some((call) => call.op === "appendFile" && call.tail === ".failed"), JSON.stringify(calls));
    assert.ok(captureMs < WINDOW_MS + LATE_MS, `capture held ${captureMs} ms`);
    // The hanging lib spends its 600 ms, then the stuck marker is awaited to the end of the 2 s window.
    if (!brokenAdapter) assert.ok(result.ms >= 1_800, `capture window abandoned early: ${result.ms} ms`);
  });
}

// Issue #621. The 2 s capture window is clipped by the dispatcher deadline: with 1 s left at the
// call, a hanging lib and writes that never settle, shellChecks returns well before 2 s.
test("the capture window is clipped by the remaining deadline", async () => {
  // Beside the dispatcher: the adapter resolves the installed home from the main module's directory.
  const home = codexHome(GUARDS, "hanging"), driver = path.join(home.hookDir, "clip-driver.mts");
  fs.writeFileSync(driver, `import { shellChecks } from ${JSON.stringify(pathToFileURL(path.join(home.hookDir, "codex-shell-checks.mts")).href)};
    const start = Date.now(), output = await shellChecks(${shellPayload()}, undefined, { deadline: start + 1_000 });
    process.stdout.write(JSON.stringify({ ms: Date.now() - start, output }), () => process.exit(0));`);
  const result = await run([driver], "", denialFaultEnv("all-hang", "clip-driver.mts"), 8_000);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.timedOut, false);
  const { ms, output } = JSON.parse(result.stdout) as { ms: number; output: string };
  assert.equal(JSON.parse(output).hookSpecificOutput.permissionDecision, "deny");
  assert.ok(ms < 1_500, `shellChecks took ${ms} ms with a 1 s deadline`);
});

test("importing and calling shellChecks leaves the caller alive", async () => {
  const home = codexHome(GUARDS, "present", false);
  const code = `const { shellChecks } = await import(${JSON.stringify(pathToFileURL(path.join(home.hookDir, "codex-shell-checks.mts")).href)});
    const output = await shellChecks(${shellPayload({ agent_id: undefined })});
    process.stdout.write(JSON.stringify({ alive: true, output }));`;
  const result = await run(["--input-type=module", "-e", code], "");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.timedOut, false);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.alive, true);
  assert.equal(JSON.parse(doc.output).hookSpecificOutput.permissionDecision, "deny");
});

test("CLI completion awaits stdout and stderr callbacks, including a silent allow", async () => {
  for (const denied of [false, true]) {
    const home = codexHome(Object.fromEntries(Object.keys(GUARDS).map((name) => [name, denied ? GUARDS[name as keyof typeof GUARDS] : "process.exit(0);\n"])), "present", false);
    // A flat layout omits the installed peer notice, so allow has genuinely empty stdout.
    const main = path.join(home.root, "shell-checks.mts");
    for (const name of fs.readdirSync(home.hookDir)) if (fs.statSync(path.join(home.hookDir, name)).isFile()) {
      fs.copyFileSync(path.join(home.hookDir, name), path.join(home.root, name === "codex-shell-checks.mts" ? "shell-checks.mts" : name));
    }
    const receipt = path.join(home.root, "flush.jsonl"), preload = path.join(home.root, "flush-preload.mts");
    fs.writeFileSync(preload, `import fs from "node:fs";
      for (const name of ["stdout", "stderr"]) {
        const stream = process[name], write = stream.write.bind(stream);
        stream.write = (text, callback) => write(text, typeof callback === "function" ? () => setTimeout(() => {
          fs.appendFileSync(${JSON.stringify(receipt)}, name + "\\n"); callback();
        }, 50) : callback);
      }`);
    const result = await run(["--import", pathToFileURL(preload).href, main], shellPayload({ agent_id: undefined }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.timedOut, false);
    if (denied) assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
    else assert.equal(result.stdout, "");
    const flushed = fs.readFileSync(receipt, "utf8").trim().split("\n");
    assert.ok(flushed.includes("stdout"), "stdout callback before process exit");
    assert.ok(flushed.includes("stderr"), "stderr callback before process exit");
  }
});

test("a stuck capture marker preserves an allow", async (t) => {
  const guards = Object.fromEntries(Object.keys(GUARDS).map((name) => [name, "process.exit(0);\n"]));
  const referenceHome = codexHome(guards, "hanging"), home = codexHome(guards, "hanging");
  const reference = await shell(referenceHome, shellPayload());
  assert.equal(fs.readFileSync(journalPaths(referenceHome.root, "agent-c1").marker, "utf8"), "lib-timeout\n");
  const result = await run([path.join(home.hookDir, "codex-shell-checks.mts")], shellPayload(),
    denialFaultEnv("marker-stuck", "codex-shell-checks.mts"), 8_000);
  t.diagnostic(JSON.stringify({ allow: true, childMs: result.ms, status: result.status, timedOut: result.timedOut }));
  assertSameAnswer(result, home, reference, referenceHome);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.timedOut, false);
  assert.equal(fs.existsSync(journalPaths(home.root, "agent-c1").marker), false);
});

test("a large deny drains a paused stdout pipe and queued stderr before close", async (t) => {
  const reason = "synthetic deny " + "x".repeat(256 * 1024);
  const diagnostic = "queued synthetic diagnostic\n";
  const source = `process.stderr.write(${JSON.stringify(diagnostic)});
    process.stdout.write(${JSON.stringify(JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
    } }))});`;
  const guards = { ...GUARDS, "commit-guard.mts": source, "main-checkout-guard.mts": "process.exit(0);\n" };
  const referenceHome = codexHome(guards), home = codexHome(guards);
  const reference = await shell(referenceHome, shellPayload());
  const result = await run([path.join(home.hookDir, "codex-shell-checks.mts")], shellPayload(), process.env, 8_000, 300);
  t.diagnostic(JSON.stringify({ stdoutBytes: Buffer.byteLength(result.stdout), childMs: result.ms, status: result.status, timedOut: result.timedOut }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.timedOut, false);
  assertSameAnswer(result, home, reference, referenceHome);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, reason);
  assert.ok(result.stderr.includes(diagnostic), "queued diagnostic arrived before child close");
});

test("default child environments discard stale fault selectors and explicit environments retain them", async () => {
  const selectors = ["stale-fixture", "stale-main.mts"];
  const probe = `import { run } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "denials-fixture.mts")).href)};
    const args = ["-e", "process.stdout.write(JSON.stringify([process.env.KHEREP_DENIAL_FAULT ?? null, process.env.KHEREP_DENIAL_FAULT_MAIN ?? null]))"];
    const clean = await run(args, ""), explicit = await run(args, "", process.env);
    process.stdout.write(JSON.stringify({ clean: JSON.parse(clean.stdout), explicit: JSON.parse(explicit.stdout),
      parent: [process.env.KHEREP_DENIAL_FAULT, process.env.KHEREP_DENIAL_FAULT_MAIN] }));`;
  const result = await run(["--input-type=module", "-e", probe], "", {
    ...process.env, KHEREP_DENIAL_FAULT: selectors[0], KHEREP_DENIAL_FAULT_MAIN: selectors[1],
  });
  assert.equal(result.status, 0, result.stderr);
  const doc = JSON.parse(result.stdout);
  assert.deepEqual(doc.clean, [null, null]);
  assert.deepEqual(doc.explicit, selectors);
  assert.deepEqual(doc.parent, selectors);
});
