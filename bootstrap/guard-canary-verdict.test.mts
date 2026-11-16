// Issue #808, stage 2b: the canary verdict is decided from observations only. ALLOWED needs the bad commit
// in git log, DENIED needs the control commit, no bad commit and the guard's fixed deny text; everything
// else is INCONCLUSIVE, so an absent signal never passes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { BAD_PREFIX, CONTROL_PREFIX, DENY_TEXT, EM_DASH, liveVerdict, overallExit, syntheticVerdict, type LiveObservation }
  from "./guard-canary-verdict.mts";

const NONCE = "a1b2c3d4e5f6";
const CONTROL = `${CONTROL_PREFIX} ${NONCE}`;
const BAD = `${BAD_PREFIX} ${NONCE} ${EM_DASH} dash`;
const live = (over: Partial<LiveObservation>): LiveObservation =>
  ({ nonce: NONCE, timedOut: false, subjects: [CONTROL, "kherep-canary-base"], output: `x ${DENY_TEXT} y`, ...over });

test("the deny text is the fixed text commit-guard prints, so a reworded guard fails here first", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "..", "claude", "hooks", "commit-guard.mts"), "utf8");
  assert.ok(source.includes(DENY_TEXT));
  assert.equal(EM_DASH.codePointAt(0), 0x2014);
});

test("live matrix", () => {
  const rows: [string, Partial<LiveObservation>, string, number, string][] = [
    ["control, deny text, no bad commit", {}, "DENIED", 0, "deny-evidence"],
    ["bad commit exists", { subjects: [BAD, CONTROL] }, "ALLOWED", 1, "bad-commit-exists"],
    ["bad commit wins over a timeout and missing evidence", { subjects: [BAD], timedOut: true, output: "" }, "ALLOWED", 1, "bad-commit-exists"],
    ["a bad commit of another run does not count", { subjects: [`${BAD_PREFIX} ffffffffffff ${EM_DASH}`, CONTROL] }, "DENIED", 0, "deny-evidence"],
    ["git log unreadable", { subjects: null }, "INCONCLUSIVE", 2, "git-log-unreadable"],
    ["cli missing", { failure: "cli-missing", subjects: [] }, "INCONCLUSIVE", 2, "cli-missing"],
    ["timeout", { timedOut: true }, "INCONCLUSIVE", 2, "timeout"],
    ["no control commit (auth, refusal)", { subjects: ["kherep-canary-base"] }, "INCONCLUSIVE", 2, "no-control-commit"],
    ["control from another nonce", { subjects: [`${CONTROL_PREFIX} ffffffffffff`] }, "INCONCLUSIVE", 2, "no-control-commit"],
    ["bad commit rewritten without the dash", { subjects: [CONTROL, `${BAD_PREFIX} ${NONCE} - dash`] }, "INCONCLUSIVE", 2, "bad-commit-altered"],
    ["no deny text", { output: "commit-guard blocked this commit" }, "INCONCLUSIVE", 2, "no-deny-evidence"],
  ];
  for (const [name, over, verdict, exitCode, reason] of rows) {
    assert.deepEqual(liveVerdict(live(over)), { verdict, exitCode, reason }, name);
  }
});

const deny = (reason: string, decision = "deny"): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } });

test("synthetic matrix", () => {
  const base = { timedOut: false, exitCode: 0, stdout: "", stderr: "" };
  const rows: [string, object, string, number, string][] = [
    ["printed deny with the text", { stdout: deny(`commit-guard blocked this commit:\n  - ${DENY_TEXT}`) }, "DENIED", 0, "deny-evidence"],
    ["exit 2 with the text on stderr", { exitCode: 2, stderr: DENY_TEXT }, "DENIED", 0, "deny-evidence"],
    ["empty output is an allow", {}, "ALLOWED", 1, "dispatcher-allowed"],
    ["a notice only is an allow", { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "n" } }) },
      "ALLOWED", 1, "dispatcher-allowed"],
    ["text on stderr but no printed deny", { stderr: DENY_TEXT }, "ALLOWED", 1, "dispatcher-allowed"],
    ["deny for another reason", { stdout: deny("[guard-dispatch] commit-guard.mts cannot run (missing)") }, "INCONCLUSIVE", 2, "deny-without-evidence"],
    ["ask", { stdout: deny(DENY_TEXT, "ask") }, "INCONCLUSIVE", 2, "deny-without-evidence"],
    ["unreadable stdout", { stdout: "not json" }, "INCONCLUSIVE", 2, "dispatcher-output-unreadable"],
    ["exit 2 without the text", { exitCode: 2, stderr: "other" }, "INCONCLUSIVE", 2, "deny-without-evidence"],
    ["other exit code", { exitCode: 1 }, "INCONCLUSIVE", 2, "deny-without-evidence"],
    ["timeout", { timedOut: true, exitCode: null }, "INCONCLUSIVE", 2, "timeout"],
    ["not started", { failure: "installed-command-missing", exitCode: null }, "INCONCLUSIVE", 2, "installed-command-missing"],
  ];
  for (const [name, over, verdict, exitCode, reason] of rows) {
    assert.deepEqual(syntheticVerdict({ ...base, ...over }), { verdict, exitCode, reason }, name);
  }
});

test("overall exit: any ALLOWED is 1, else any INCONCLUSIVE or nothing is 2, all DENIED is 0", () => {
  const d = (exitCode: 0 | 1 | 2) => ({ exitCode });
  assert.equal(overallExit([d(0), d(0)]), 0);
  assert.equal(overallExit([d(0), d(2)]), 2);
  assert.equal(overallExit([d(2), d(1), d(0)]), 1);
  assert.equal(overallExit([]), 2);
});

test("the canary uses a fixed system Git and reports an internal error as INCONCLUSIVE", async () => {
  const { gitBinary, main } = await import("./guard-canary.mts");
  assert.equal(gitBinary("linux", (file) => file === "/usr/local/bin/git"), "/usr/local/bin/git");
  assert.equal(gitBinary("win32", (file) => file.endsWith("\\cmd\\git.exe")), "C:\\Program Files\\Git\\cmd\\git.exe");
  assert.equal(gitBinary("darwin", () => false), null);
  const lines: string[] = [];
  const code = await main(["--runtime", "claude", "--home", "/nonexistent-home"], {
    tmpRoot: "/nonexistent-guard-canary-root", resolve: () => ({ file: process.execPath, args: [] }), git: "/usr/bin/git",
    out: (line) => lines.push(line) });
  assert.equal(code, 2);
  assert.ok(lines.includes("guard-canary: internal error"));
});

test("the CLI entry point runs main and returns its exit code", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./guard-canary.mts", import.meta.url)), "--runtime", "gpt"], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /^usage: /m);
});
