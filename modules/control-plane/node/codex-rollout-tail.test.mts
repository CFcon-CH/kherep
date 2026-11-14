// Issue #911: the backward tail read of a held Codex rollout, and the turn the
// liveness source derives from it. Synthetic fixtures only: record types and
// timestamps, written to temp files by the test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Holder } from "./codex-holder-probe.mts";
import { IDLE_WRITE_SLACK_MS as S, turnFor } from "./codex-liveness-source.mts";
import { lateWrites, ROLLOUT_TAIL_BYTES, type LateWrites } from "./codex-rollout-tail.mts";
import type { CodexSessionRecord } from "./codex-sessions.mts";

const B = Date.UTC(2026, 10, 14, 20, 12, 26, 763); // the ended Stop
const T = B + 86_400_000;
const ID = "01a0db01-0000-7000-8000-0000000000b1";
const iso = (ms: number) => new Date(ms).toISOString();
const row = (ms: number, type: string, payload: Record<string, unknown> = {}) => `${JSON.stringify({ timestamp: iso(ms), type, payload })}\n`;
const event = (ms: number, type: string, itemType?: string, item: Record<string, unknown> = {}) =>
  row(ms, "event_msg", itemType ? { type, item: { type: itemType, ...item } } : { type });

// Every fixture starts with session_meta and one turn before B; task_complete follows B by 150 ms.
const ENDED = row(B - 600_000, "session_meta") + event(B - 300_000, "task_started")
  + row(B - 200_000, "response_item", { type: "message" }) + event(B + 150, "task_complete");
const SUBAGENT = event(B + 721_000, "item_completed", "SubAgentActivity");
const UNHOOKED = event(B + 60_000, "thread_settings_applied") + event(B + 60_001, "task_started") + row(B + 60_002, "world_state")
  + row(B + 60_003, "turn_context") + event(B + 60_004, "item_completed", "UserMessage");
const DEVELOPER = row(B + 60_000, "response_item", { type: "message", role: "developer" });
const PADDED = (ms: number, bytes: number) => event(ms, "item_completed", "SubAgentActivity", { pad: "x".repeat(bytes) });

function dir(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-rollout-tail-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function file(t: test.TestContext, content: string): string {
  const rollout = path.join(dir(t), `rollout-2026-11-14T20-00-00-${ID}.jsonl`);
  fs.writeFileSync(rollout, content);
  return rollout;
}

// lateWrites, and turnFor for an ended Stop at B whose rollout was written later than the slack.
const holder: Holder = { pid: 4242, startMs: B - 3_600_000, identity: `4242:${(B - 3_600_000) / 1000}`, file: "" };
const stopped: CodexSessionRecord = { sessionId: ID, runtime: "codex", lastSeen: iso(B), lastEvent: "Stop", lastEventAt: iso(B),
  lastStopAt: iso(B), lastStopEnded: true };
const TURN: Record<LateWrites, string> = { "non-turn": "idle", turn: "unknown:conflict", unreadable: "unknown:failed" };
function check(rollout: string, expected: LateWrites, name: string) {
  assert.equal(lateWrites(rollout, B, S), expected, name);
  const o = turnFor(stopped, holder, B + S + 1_000, T, boundary => lateWrites(rollout, boundary, S));
  assert.equal(o.status === "value" ? o.value : `unknown:${o.reasonCode}`, TURN[expected], name);
}

const CASES: [string, string, LateWrites][] = [
  ["T1 a sub-agent completion 721 s after Stop", ENDED + SUBAGENT, "non-turn"],
  ["T2 a settings record without a turn", ENDED + event(B + 20_000_000, "thread_settings_applied"), "non-turn"],
  ["T3 a late command completion", ENDED + event(B + 150_000, "item_completed", "CommandExecution"), "non-turn"],
  ["T4 an unhooked turn", ENDED + UNHOOKED, "turn"],
  ["T5 an unhooked turn read right after its start", ENDED + event(B + 60_000, "thread_settings_applied") + event(B + 60_001, "task_started"), "turn"],
  ["T6 a turn start inside the slack", ENDED + event(B + 10_000, "task_started") + event(B + 45_000, "item_completed", "SubAgentActivity"), "turn"],
  ["T7 a turn record without its start", ENDED + row(B + 60_000, "world_state"), "turn"],
  ["T8 an unknown record type", ENDED + row(B + 60_000, "future_record"), "turn"],
  ["T9 an unlisted item", ENDED + event(B + 60_000, "item_completed", "AgentMessage"), "turn"],
  ["T10 a truncated final line", ENDED + SUBAGENT + SUBAGENT.slice(0, 40), "unreadable"],
  ["T10 a complete final record without its newline", ENDED + SUBAGENT + SUBAGENT.slice(0, -1), "unreadable"],
  ["T11 a line that is not JSON", `${ENDED}{"timestamp":\n${SUBAGENT}`, "unreadable"],
  ["T12 a record without a timestamp", `${ENDED}${JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied" } })}\n${SUBAGENT}`, "unreadable"],
  ["T12 a timestamp without milliseconds", ENDED + SUBAGENT.replace(/\.\d{3}Z/, "Z"), "unreadable"],
  ["T12 a timestamp in the format but no date", ENDED + SUBAGENT.replace(/"timestamp":"[^"]+"/, '"timestamp":"2026-13-45T25:61:61.000Z"'), "unreadable"],
  ["T16 a listed record of 200 KiB across several chunks", ENDED + PADDED(B + 60_000, 200 * 1024), "non-turn"],
  ["T17 nothing later than the slack", ENDED + event(B + 25_000, "item_completed", "AgentMessage"), "non-turn"],
  ["T18 the start of the file reached", row(B + 40_000, "session_meta") + event(B + 50_000, "thread_settings_applied") + SUBAGENT, "turn"],
  ["T19 CRLF line ends", (ENDED + SUBAGENT).replaceAll("\n", "\r\n"), "non-turn"],
  ["T20 a developer message followed by its task_started", ENDED + DEVELOPER + event(B + 60_000, "task_started"), "turn"],
  ["T21 a developer message read before its task_started", ENDED + DEVELOPER, "turn"],
  ["T22 a voice transcript segment", ENDED + row(B + 60_000, "realtime_item", { type: "transcript_segment" }), "turn"],
];
for (const [name, content, expected] of CASES) test(name, t => check(file(t, content), expected, name));

test("T13 a missing file, a directory, an unreadable file and a symlink are unreadable", async (t) => {
  const root = dir(t), valid = file(t, ENDED + SUBAGENT);
  check(path.join(root, "missing.jsonl"), "unreadable", "missing");
  check(root, "unreadable", "directory");
  await t.test("mode 000", st => {
    if (process.platform === "win32") return st.skip("no POSIX file modes on Windows");
    if (process.getuid?.() === 0) return st.skip("root reads a mode 000 file");
    const locked = file(st, ENDED + SUBAGENT);
    fs.chmodSync(locked, 0o000);
    check(locked, "unreadable", "mode 000");
  });
  await t.test("symlink to a valid rollout", st => {
    if (process.platform === "win32") return st.skip("symlinks need a privilege on Windows");
    const link = path.join(root, "link.jsonl");
    fs.symlinkSync(valid, link);
    check(valid, "non-turn", "the target itself");
    check(link, "unreadable", "symlink");
  });
});

test("T14 an empty file is unreadable", t => check(file(t, ""), "unreadable", "empty"));

test("T15 listed records beyond the byte budget are unreadable", t => {
  const pad = 60_000, count = Math.ceil(ROLLOUT_TAIL_BYTES / pad) + 1;
  const content = ENDED + SUBAGENT + Array.from({ length: count }, (_, i) => PADDED(B + 800_000 + i, pad)).join("");
  assert.ok(Buffer.byteLength(content) - Buffer.byteLength(ENDED) > ROLLOUT_TAIL_BYTES);
  check(file(t, content), "unreadable", "budget");
});
