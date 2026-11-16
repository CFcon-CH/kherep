#!/usr/bin/env node
// Issue #731 PR-B. The promotion trigger through the Claude hooks that carry
// it: the dispatch guard records the brief, the recorder and the stop hook
// join it with the result, and the parent Stop hook delivers the hits once.
// The hooks run from the checkout: decide() and promotion() in this process
// with a temporary home, and the two CLIs spawned in place, whose home is
// then the checkout's claude/ directory; every file a case puts there is
// removed again (cleanCheckout), and their session ids are unique to this file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decide as record } from "./obs-handback-record.mts";
import { decide as stop } from "./obs-result-check.mts";
import { promotion, withPromotion } from "./observation-stop.mts";
import { FAILED_MESSAGE, stateDir } from "./lib/obs-handback-state.mts";
import { promotionReason } from "./lib/obs-promotion-policy.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "obs-promotion-hooks-test-")));
const CHECKOUT_HOME = path.resolve(import.meta.dirname, "..");
const CHECKOUT_STATE = stateDir(CHECKOUT_HOME);
const planted: string[] = [];
function cleanCheckout(): void {
  for (const file of planted) fs.rmSync(file, { force: true });
  for (const dir of [CHECKOUT_STATE, path.dirname(CHECKOUT_STATE)]) {
    try { fs.rmdirSync(dir); } catch { /* absent, or still used by another test file */ }
  }
}
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); cleanCheckout(); });

let seq = 0;
function home(): string {
  const dir = path.join(TMP, `home-${++seq}`);
  fs.mkdirSync(dir);
  return dir;
}
const SID = "0f3c2a9e-1b7d-4c55-9e21-5a0d6b8c4f17";
const brief = (h: string, line: string, sid = SID) => {
  fs.mkdirSync(stateDir(h), { recursive: true });
  fs.writeFileSync(path.join(stateDir(h), `${sid}.brief`), line);
};
// The pending promotion files of the session, their lines joined in name order; null for none.
const pending = (h: string, sid = SID) => {
  let names: string[];
  try { names = fs.readdirSync(stateDir(h)); } catch { return null; }
  const files = names.filter((name) => name.startsWith(`${sid}.promote`) && !/\.(claim|tmp)$/.test(name)).sort((a, b) => a.localeCompare(b));
  return files.length ? files.map((name) => fs.readFileSync(path.join(stateDir(h), name), "utf8")).join("") : null;
};
const HIT = "OBS-RESULT: wrote 2 11,12\n11 finding=1 evidence=assumed Build passes\n12 finding=2 evidence=confirmed Endpoint answers";
const UNLABELLED = "OBS-RESULT: wrote 1 13\n13 (id, title) old page line";
const handback = (message: string, extra: Record<string, unknown> = {}) => ({ session_id: SID, agent_id: "rec-1", agent_type: "claude-obs",
  tool_name: "SubagentHandback", tool_input: { message }, tool_use_id: "toolu_01", ...extra });

test("the recorder writes a hit of a wrote report and stays silent", () => {
  const h = home();
  brief(h, "measured=1,2 findings=2\n");
  assert.equal(record(handback(HIT), h), null);
  assert.equal(pending(h), "11\n");
});

test("every measured finding filed confirmed: no promotion, and the parent Stop stays silent", () => {
  const h = home();
  brief(h, "measured=1,2 findings=2\n");
  const confirmed = "OBS-RESULT: wrote 2 11,12\n11 finding=1 evidence=confirmed Build passes\n12 finding=2 evidence=confirmed Endpoint answers";
  assert.equal(record(handback(confirmed), h), null);
  assert.equal(pending(h), null);
  assert.equal(promotion({ session_id: SID, stop_hook_active: false }, h), null);
});

test("the recorder warns about labels it cannot read against a measured brief, never more", () => {
  const h = home();
  brief(h, "measured=1 findings=1\n");
  const output = record(handback(UNLABELLED), h);
  assert.deepEqual(Object.keys(output ?? {}), ["systemMessage"], "a notice, never a decision");
  assert.match(String(output?.systemMessage), /^Kherep obs-promotion: the evidence labels of page\(s\) 13 could not be read/);
  assert.equal(pending(h), null);
});

test("the recorder joins neither a failed nor an empty report", () => {
  const h = home();
  brief(h, "measured=1 findings=1\n");
  assert.deepEqual(record(handback("OBS-RESULT: failed broker down created=11\n11 finding=1 evidence=assumed T"), h), { systemMessage: FAILED_MESSAGE });
  assert.equal(record(handback("OBS-RESULT: empty nothing new"), h), null);
  assert.equal(pending(h), null);
});

test("without a session id the recorder degrades to the warning and never throws", () => {
  const h = home();
  assert.match(String(record(handback(HIT, { session_id: undefined }), h)?.systemMessage), /could not be joined to the dispatch brief \(no session id\)/);
  assert.equal(record(handback("OBS-RESULT: wrote 1 12\n12 finding=2 evidence=confirmed T", { session_id: undefined, tool_use_id: "toolu_02" }), h), null);
  assert.deepEqual(fs.readdirSync(stateDir(h)), ["rec-1.delivered"], "only the delivery record: no hit was written, so no join marker");
});

const stopFields = (extra: Record<string, unknown>) => ({ session_id: SID, hook_event_name: "SubagentStop", agent_id: "stop-1",
  agent_type: "claude-obs", stop_hook_active: false, ...extra });
function handbackTranscript(message: string, ok?: boolean, id = "toolu_h"): string {
  const file = path.join(TMP, `agent-${++seq}.jsonl`);
  const entries: unknown[] = [
    { type: "user", isSidechain: true, message: { role: "user", content: "brief" } },
    { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "tool_use", id, name: "SubagentHandback", input: { message } }] } },
  ];
  if (ok !== undefined) entries.push({ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: !ok }] } });
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return file;
}

test("the stop hook joins a wrote final message itself", async () => {
  const h = home();
  brief(h, "measured=1 findings=2\n");
  assert.equal(await stop(stopFields({ last_assistant_message: HIT }), { home: h, waitMs: 0 }), null);
  assert.equal(pending(h), "11\n");
  assert.match(String((await stop(stopFields({ last_assistant_message: UNLABELLED }), { home: h, waitMs: 0 }) as { systemMessage?: string })?.systemMessage),
    /page\(s\) 13 could not be read/);
});

test("a repeated wrote final message of the same agent is joined once", async () => {
  const h = home();
  brief(h, "measured=1 findings=2\n");
  assert.equal(await stop(stopFields({ last_assistant_message: HIT }), { home: h, waitMs: 0 }), null);
  assert.equal(promotion({ session_id: SID }, h), promotionReason(["11"]));
  assert.equal(await stop(stopFields({ last_assistant_message: `\n${HIT}` }), { home: h, waitMs: 0 }), null, "the resumed agent's same status line");
  assert.equal(pending(h), null, "the consumed promotion is not written again");
  assert.equal(await stop(stopFields({ agent_id: undefined, last_assistant_message: HIT }), { home: h, waitMs: 0 }), null);
  assert.equal(pending(h), "11\n", "only without an agent id does the join run unguarded");
});

test("a handback without a tool_use_id is joined once by its status line", () => {
  const h = home();
  brief(h, "measured=1 findings=2\n");
  assert.equal(record(handback(HIT, { tool_use_id: undefined }), h), null);
  assert.equal(promotion({ session_id: SID }, h), promotionReason(["11"]));
  assert.equal(record(handback(HIT, { tool_use_id: undefined }), h), null);
  assert.equal(pending(h), null);
});

test("the stop hook keeps a failed or empty final message as before and joins neither", async () => {
  const h = home();
  brief(h, "measured=1 findings=2\n");
  assert.deepEqual(await stop(stopFields({ last_assistant_message: "OBS-RESULT: failed broker down" }), { home: h, waitMs: 0 }), { systemMessage: FAILED_MESSAGE });
  assert.equal(await stop(stopFields({ last_assistant_message: "OBS-RESULT: empty nothing new" }), { home: h, waitMs: 0 }), null);
  assert.equal(pending(h), null);
});

test("the stop hook joins a handback seen in the transcript, after its own notice", async () => {
  const h = home();
  brief(h, "measured=1 findings=2\n");
  assert.equal(await stop(stopFields({ agent_transcript_path: handbackTranscript(HIT, true) }), { home: h, waitMs: 0 }), null);
  assert.equal(pending(h), "11\n");
  const unconfirmed = await stop(stopFields({ agent_transcript_path: handbackTranscript(UNLABELLED, undefined, "toolu_u") }), { home: h, waitMs: 0 });
  assert.match(String((unconfirmed as { systemMessage?: string }).systemMessage), /delivery was not confirmed; check the result by hand\. Kherep obs-promotion: .* 13 /);
  const empty = await stop(stopFields({ agent_transcript_path: handbackTranscript("OBS-RESULT: empty nothing new", true, "toolu_e") }), { home: h, waitMs: 0 });
  assert.equal(empty, null);
});

test("the stop hook leaves a recorded delivery to the recorder's join", async () => {
  const h = home();
  brief(h, "measured=1 findings=2\n");
  fs.writeFileSync(path.join(stateDir(h), "stop-1.delivered"), "wrote\ttoolu_h\n");
  assert.equal(await stop(stopFields({ agent_transcript_path: handbackTranscript(HIT, true) }), { home: h, waitMs: 0 }), null);
  assert.equal(pending(h), null);
});

test("a handback joined once is never joined again after the Stop consumed it", async () => {
  const h = home();
  brief(h, "measured=1 findings=2\n");
  assert.equal(record(handback(HIT, { agent_id: "stop-1", tool_use_id: "toolu_h" }), h), null);
  assert.equal(promotion({ session_id: SID }, h), promotionReason(["11"]));
  assert.equal(record(handback(HIT, { agent_id: "stop-1", tool_use_id: "toolu_h" }), h), null, "the recorder again");
  assert.equal(await stop(stopFields({ agent_transcript_path: handbackTranscript(HIT, true) }), { home: h, waitMs: 0 }), null, "the stop hook, same handback");
  assert.equal(pending(h), null, "nothing to deliver twice");
  assert.equal(promotion({ session_id: SID }, h), null);
});

test("a resumed agent's earlier handback in the transcript is not joined again", async () => {
  const h = home();
  brief(h, "measured=1 findings=2\n");
  assert.equal(await stop(stopFields({ agent_transcript_path: handbackTranscript(HIT, true) }), { home: h, waitMs: 0 }), null);
  assert.equal(promotion({ session_id: SID }, h), promotionReason(["11"]));
  const resumed = await stop(stopFields({ agent_transcript_path: handbackTranscript(HIT, true) }), { home: h, waitMs: 0 });
  assert.equal(resumed, null, "the old handback, still the last one in the transcript");
  assert.equal(pending(h), null);
});

test("promotion consumes a pending promotion once, whatever the payload's stop marker", () => {
  const h = home();
  brief(h, "measured=1 findings=2\n");
  record(handback(HIT), h);
  assert.equal(promotion({ session_id: SID, stop_hook_active: true }, h), promotionReason(["11"]));
  assert.equal(promotion({ session_id: SID, stop_hook_active: true }, h), null);
  for (const value of [null, "text", [SID], { session_id: 7 }]) assert.equal(promotion(value, h), null);
});

test("withPromotion merges the promotion into one block", () => {
  const block = { decision: "block" as const, reason: "Session observation." };
  assert.equal(withPromotion(null, null), null);
  assert.equal(withPromotion(block, null), block);
  assert.deepEqual(withPromotion(null, "P"), { decision: "block", reason: "P" });
  assert.deepEqual(withPromotion(block, "P"), { decision: "block", reason: "Session observation.\n\nP" });
});

function spawnHook(name: string, payload: unknown, env: Record<string, string> = {}): string {
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(import.meta.dirname, name)],
    { input: JSON.stringify(payload), encoding: "utf8", env: { PATH: process.env.PATH, ...env, ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}) } });
  assert.equal(result.status, 0);
  return result.stdout;
}

test("observation-stop: a pending promotion blocks once, also on a continuation", () => {
  const sid = randomUUID();
  const file = path.join(CHECKOUT_STATE, `${sid}.promote`);
  planted.push(file);
  fs.mkdirSync(CHECKOUT_STATE, { recursive: true });
  fs.writeFileSync(file, "123,456\n");
  const payload = { session_id: sid, stop_hook_active: true, cwd: TMP, hook_event_name: "Stop" };
  assert.deepEqual(JSON.parse(spawnHook("observation-stop.mts", payload)), { decision: "block", reason: promotionReason(["123", "456"]) });
  assert.equal(fs.existsSync(file), false, "consumed before it was emitted");
  assert.equal(spawnHook("observation-stop.mts", payload), "", "the second Stop is silent");
});

test("observation-stop: the observation block and a pending promotion merge into one block", () => {
  const sid = randomUUID();
  const file = path.join(CHECKOUT_STATE, `${sid}.promote`);
  planted.push(file);
  fs.mkdirSync(CHECKOUT_STATE, { recursive: true });
  fs.writeFileSync(file, "789\n");
  const transcript = path.join(TMP, `turn-${++seq}.jsonl`);
  fs.writeFileSync(transcript, [
    { type: "user", message: { role: "user", content: [{ type: "text", text: "change the file" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/tmp/x" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const workspace = path.join(TMP, "workspace");
  const stdout = spawnHook("observation-stop.mts", { session_id: sid, stop_hook_active: false, cwd: path.join(workspace, "app"), transcript_path: transcript },
    { KHEREP_WORKSPACE: workspace });
  const output = JSON.parse(stdout) as { decision: string; reason: string };
  assert.equal(output.decision, "block");
  assert.match(output.reason, /^Session observation \(ROUTING\.md, Session observations\): this turn was substantial/);
  assert.ok(output.reason.endsWith(`\n\n${promotionReason(["789"])}`), "one block: the observation reason, then the promotion");
  assert.equal(fs.existsSync(file), false);
});

test("dispatch-contract-guard records the brief of an allowed claude-obs dispatch, and only then", () => {
  const sid = randomUUID();
  const file = path.join(CHECKOUT_STATE, `${sid}.brief`);
  planted.push(file);
  const dispatch = (prompt: string) => ({ session_id: sid, tool_name: "Agent", tool_input: { subagent_type: "claude-obs", model: "haiku", description: "Record", prompt } });
  const denied = spawnHook("dispatch-contract-guard.mts", dispatch("no markers"));
  assert.match(denied, /OBS_BRIEF_FORMAT/);
  assert.equal(fs.existsSync(file), false, "a denied dispatch records nothing");
  spawnHook("dispatch-contract-guard.mts", dispatch(`Session id: ${sid}\n- relayed: the operator\n- measured: \`node x.test.mts\` -> 12 pass`));
  assert.equal(fs.readFileSync(file, "utf8"), "measured=2 findings=2\n");
});
