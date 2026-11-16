// Issue #731 PR-B. The Codex side of the promotion trigger: the optional
// OBS-EVIDENCE worker line, the join in codex-obs-result-check, the brief record
// of the dispatch guard and the consuming Stop hook. Every case runs the
// checkout's modules in this process with a temporary state home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { advise, type DispatchPolicy, statePolicy } from "./dispatch-contract-guard.mts";
import { decide, HOME, hookLib, OBS_RESULT_REASON, stateLib } from "./obs-result-check.mts";
import { checkObsHandback } from "./obs-result-policy.mts";
import { decision, promotion } from "./observation-stop.mts";
import { stateDir } from "../../claude/hooks/lib/obs-handback-state.mts";
import { promotionReason } from "../../claude/hooks/lib/obs-promotion-policy.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-obs-promotion-test-")));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let seq = 0;
function home(): string {
  const dir = path.join(TMP, `home-${++seq}`);
  fs.mkdirSync(dir);
  return dir;
}
const SID = "0f3c2a9e-1b7d-4c55-9e21-5a0d6b8c4f17";
const brief = (h: string, line: string) => {
  fs.mkdirSync(stateDir(h), { recursive: true });
  fs.writeFileSync(path.join(stateDir(h), `${SID}.brief`), line);
};
const pending = (h: string) => {
  try { return fs.readFileSync(path.join(stateDir(h), `${SID}.promote`), "utf8"); } catch { return null; }
};
const RECEIPT = "OBS-RESULT: wrote 2 11,12";

test("checkObsHandback accepts one OBS-EVIDENCE line after a receipt", () => {
  assert.deepEqual(checkObsHandback(`${RECEIPT}\nOBS-EVIDENCE: 11:1:assumed, 12:-:confirmed`), { status: "wrote", ids: ["11", "12"],
    evidence: [{ id: "11", finding: 1, evidence: "assumed" }, { id: "12", finding: null, evidence: "confirmed" }] });
  assert.deepEqual(checkObsHandback("OBS-RESULT: failed readback-unverified created=11\r\n\r\nOBS-EVIDENCE: 11:2:refuted"),
    { status: "failed", ids: ["11"], evidence: [{ id: "11", finding: 2, evidence: "refuted" }] });
});

test("a malformed OBS-EVIDENCE line keeps the receipt, with no entries", () => {
  for (const line of ["OBS-EVIDENCE: 11:1:guessed", "OBS-EVIDENCE: 11:0:assumed", "OBS-EVIDENCE: 11:1:assumed,11:2:confirmed", "OBS-EVIDENCE:",
    `OBS-EVIDENCE: ${Array.from({ length: 21 }, (_, i) => `${i + 1}:-:assumed`).join(",")}`, `OBS-EVIDENCE: 1:-:assumed,${" ".repeat(1200)}2:-:assumed`]) {
    assert.deepEqual(checkObsHandback(`${RECEIPT}\n${line}`), { status: "wrote", ids: ["11", "12"], evidence: null }, line.slice(0, 60));
  }
});

test("the receipt parser itself stays strict, and other second lines stay malformed", () => {
  const bad = { problem: "the result is not one strict publication receipt or worker attempt" };
  assert.deepEqual(checkObsHandback(`${RECEIPT}\nprose`), bad);
  assert.deepEqual(checkObsHandback("OBS-RESULT: wrote 9 11\nOBS-EVIDENCE: 11:1:assumed"), bad);
  assert.deepEqual(checkObsHandback(`${RECEIPT}\nOBS-EVIDENCE: 11:1:assumed\nOBS-EVIDENCE: 12:1:assumed`), bad);
});

const stop = (text: string, extra: Record<string, unknown> = {}) => ({ session_id: SID, hook_event_name: "SubagentStop", agent_type: "codex-obs",
  stop_hook_active: false, last_assistant_message: text, ...extra });

test("codex-obs-result-check writes a hit and stays silent", () => {
  const h = home();
  brief(h, "measured=1 findings=2\n");
  assert.equal(decide(stop(`${RECEIPT}\nOBS-EVIDENCE: 11:1:assumed,12:2:assumed`), h), null);
  assert.equal(pending(h), "11\n");
});

test("codex-obs-result-check warns, never blocks, when labels cannot be read against a measured brief", () => {
  const h = home();
  brief(h, "measured=1 findings=2\n");
  for (const text of [RECEIPT, `${RECEIPT}\nOBS-EVIDENCE: 11:1:guessed`]) {
    const output = decide(stop(text), h);
    assert.deepEqual(Object.keys(output ?? {}), ["systemMessage"], text);
    assert.match(String((output as { systemMessage: string }).systemMessage), /page\(s\) 11, 12 could not be read/);
  }
  assert.equal(pending(h), null);
});

test("codex-obs-result-check warns without a recorded brief, is silent without a measured finding, and keeps failed and empty unchanged", () => {
  const h = home();
  assert.match(String((decide(stop(`${RECEIPT}\nOBS-EVIDENCE: 11:1:assumed,12:-:assumed`), h) as { systemMessage: string }).systemMessage),
    /page\(s\) 11 were filed evidence-assumed but could not be joined to the dispatch brief \(no dispatch brief recorded for this session\)/);
  brief(h, "measured=- findings=2\n");
  assert.equal(decide(stop(RECEIPT), h), null);
  assert.match(String((decide(stop("OBS-RESULT: failed authority-denied\nOBS-EVIDENCE: 1:1:assumed"), h) as { systemMessage: string }).systemMessage),
    /OBS-RESULT: failed; report this failure/);
  assert.equal(decide(stop("OBS-RESULT: empty no-admissible-findings"), h), null);
  assert.deepEqual(decide(stop("prose"), h), { decision: "block", reason: OBS_RESULT_REASON });
  assert.equal(pending(h), null);
});

test("codex-obs-result-check prunes old state at each stop", () => {
  const h = home();
  brief(h, "measured=1 findings=1\n");
  const old = new Date(Date.now() - 2 * 86_400_000);
  fs.utimesSync(path.join(stateDir(h), `${SID}.brief`), old, old);
  assert.equal(decide(stop("OBS-RESULT: empty no-admissible-findings"), h), null);
  assert.deepEqual(fs.readdirSync(stateDir(h)), []);
});

test("without a session id the join degrades to the warning, and the state home is the hook's parent", () => {
  const h = home();
  assert.match(String((decide(stop(`${RECEIPT}\nOBS-EVIDENCE: 11:1:assumed`, { session_id: undefined }), h) as { systemMessage: string }).systemMessage),
    /page\(s\) 11 were filed evidence-assumed but could not be joined/);
  assert.equal(fs.existsSync(path.join(h, ".cache")), false);
  assert.equal(HOME, path.resolve(import.meta.dirname, ".."));
});

test("hookLib prefers the installed lib beside the hook and gives null when none loads", () => {
  const dir = path.join(TMP, "installed", "hooks");
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lib", "stub.mts"), "export const installed = true;\n");
  assert.deepEqual({ ...hookLib<{ installed: boolean }>("stub.mts", dir) }, { installed: true });
  assert.equal(hookLib("absent.mts", dir), null);
});

// The observation-only upgrade refreshes the hooks but not hooks/kherep-maestro/lib,
// so an installed 840b9548 obs-handback-state.mts (no recordPromotion) can sit beside them.
function staleLibDir(name: string, source: string): string {
  const dir = path.join(TMP, name, "hooks");
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lib", "obs-handback-state.mts"), source);
  return dir;
}

test("codex-obs-result-check skips the join, never fails, beside an older state lib", () => {
  const h = home();
  brief(h, "measured=1 findings=2\n");
  const dir = staleLibDir("stale-result", "export function prune() {}\n");
  assert.equal(stateLib(dir), null);
  assert.equal(decide(stop(`${RECEIPT}\nOBS-EVIDENCE: 11:1:assumed`), h, dir), null);
  assert.equal(pending(h), null);
  assert.equal(stateLib(staleLibDir("no-prune", "export function recordPromotion() {}\n")), null);
  assert.notEqual(stateLib(), null, "the checkout lib has both");
});

test("the Codex dispatch guard uses the state lib only when it can record a brief", () => {
  assert.equal(statePolicy(staleLibDir("stale-guard", "export function prune() {}\n")), null);
  assert.equal(statePolicy(path.join(TMP, "nowhere", "hooks")), null);
  assert.equal(typeof statePolicy()?.recordBrief, "function");
});

test("the Codex Stop hook consumes a pending promotion once and merges it with the observation reason", () => {
  const h = home();
  brief(h, "measured=1 findings=2\n");
  decide(stop(`${RECEIPT}\nOBS-EVIDENCE: 11:1:assumed`), h);
  const first = decision({ session_id: SID, turn_id: "turn-1", stop_hook_active: false }, {}, h);
  assert.equal(first?.decision, "block");
  assert.ok(first?.reason.endsWith(`\n\n${promotionReason(["11"])}`), "the promotion follows the observation reason");
  assert.match(String(first?.reason), /codex-obs/);
  assert.equal(decision({ session_id: SID, turn_id: "turn-1", stop_hook_active: true }, {}, h), null, "consumed");
  fs.writeFileSync(path.join(stateDir(h), `${SID}.promote`), "7\n");
  assert.deepEqual(decision({ session_id: SID, stop_hook_active: true }, {}, h), { decision: "block", reason: promotionReason(["7"]) });
});

test("the Codex Stop hook CLI, run in place, delivers a pending promotion once and fails open on bad input", (t) => {
  const sid = randomUUID(), dir = stateDir(HOME), file = path.join(dir, `${sid}.promote`);
  t.after(() => {
    fs.rmSync(file, { force: true });
    for (const empty of [dir, path.dirname(dir)]) { try { fs.rmdirSync(empty); } catch { /* absent or still used */ } }
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, "321\n");
  const run = (input: string) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(import.meta.dirname, "observation-stop.mts")],
    { input, encoding: "utf8", env: { PATH: process.env.PATH, ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}) } });
  const first = run(JSON.stringify({ session_id: sid, stop_hook_active: true }));
  assert.deepEqual([first.status, JSON.parse(first.stdout)], [0, { decision: "block", reason: promotionReason(["321"]) }]);
  assert.deepEqual([run(JSON.stringify({ session_id: sid, stop_hook_active: true })).stdout, run("{not json").stdout], ["", ""]);
});

test("the Codex Stop hook finds the installed lib beside it, and without one there is no promotion", () => {
  const dir = path.join(TMP, "stop", "hooks");
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lib", "obs-handback-state.mts"), "export const pendingPromotion = (home, id) => `pending ${id}`;\n");
  assert.equal(promotion({ session_id: SID }, TMP, dir), `pending ${SID}`);
  assert.equal(promotion({ session_id: SID }, TMP, path.join(TMP, "nowhere", "hooks")), null);
});

const policy: DispatchPolicy = { observationAgent: "codex-obs", codeBoundAgents: new Set(), supportedModels: new Map(), agentDefaults: new Map() };
const spawn = (extra: Record<string, unknown>, input: Record<string, unknown> = {}) => ({ tool_name: "spawn_agent", session_id: SID,
  tool_input: { task_name: "obs", agent_type: " codex-obs ", message: "measured: live `curl x` -> 200\nrelayed: operator", ...input }, ...extra });

test("the Codex dispatch guard records an allowed observation brief for the session, and nothing else", () => {
  const h = home();
  advise(spawn({}), policy, h);
  assert.equal(fs.readFileSync(path.join(stateDir(h), `${SID}.brief`), "utf8"), "measured=1 findings=2\n");
  const bare = home();
  for (const payload of [null, spawn({ tool_name: "Bash" }), spawn({ tool_input: "x" }), spawn({}, { agent_type: "kherep-builder" }),
    spawn({}, { message: "All green." }), spawn({ session_id: undefined })]) advise(payload, policy, bare);
  advise(spawn({}), { ...policy, observationAgent: null }, bare);
  assert.equal(fs.existsSync(path.join(bare, ".cache")), false, "a denied, foreign or session-less dispatch records nothing");
});
