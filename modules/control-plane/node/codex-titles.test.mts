import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isSessionInfo, isTitle, type SessionInfo } from "../protocol.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { CODEX_INDEX, INDEX_MAX_BYTES, INDEX_MAX_LINES, codexAssignmentTitle, readCodexTitles, sanitiseTitle, withCodexTitles } from "./codex-titles.mts";
import { nodePaths } from "./config.mts";
import { listSessions } from "./sessions.mts";

// Codex thread titles (issue #88): <codex home>/session_index.jsonl holds one
// line per thread with id, thread_name and updated_at. Fixture values only.

const A = "019a0000-0000-7000-8000-00000000d7d0";
const B = "019a0000-0000-7000-8000-0000000000b2";

function home(t: test.TestContext, lines?: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-titles-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (lines) fs.writeFileSync(path.join(dir, CODEX_INDEX), lines.join("\n") + "\n");
  return dir;
}
const line = (id: string, name: unknown, at: string) => JSON.stringify({ id, thread_name: name, updated_at: at });

test("reads the title of each thread, and the latest entry for an id wins", (t) => {
  const dir = home(t, [
    line(A, "First title", "2026-09-27T10:00:00Z"),
    line(B, "Other thread", "2026-09-27T09:00:00Z"),
    line(A, "Renamed title", "2026-09-27T11:00:00Z"),
    line(A, "Older entry written later", "2026-09-27T08:00:00Z"),
  ]);
  const titles = readCodexTitles(dir);
  assert.equal(titles.get(A), "Renamed title");
  assert.equal(titles.get(B), "Other thread");
});

test("a missing, empty or garbled index gives no titles and never throws", (t) => {
  assert.equal(readCodexTitles(home(t)).size, 0);
  assert.equal(readCodexTitles(home(t, [""])).size, 0);
  const garbled = home(t, ["not json", "{\"id\":", "[1,2]", "null", line(A, 42, "2026-09-27T10:00:00Z"),
    line(B, "   ", "2026-09-27T10:00:00Z"), JSON.stringify({ id: 7, thread_name: "x", updated_at: "2026-09-27T10:00:00Z" }),
    line("019a0000-0000-7000-8000-0000000000c3", "Still read", "not a date")]);
  const titles = readCodexTitles(garbled);
  assert.deepEqual([...titles], [["019a0000-0000-7000-8000-0000000000c3", "Still read"]]);
  // A directory in place of the file is unreadable, not an error.
  const dir = home(t);
  fs.mkdirSync(path.join(dir, CODEX_INDEX));
  assert.equal(readCodexTitles(dir).size, 0);
});

test("only the tail of an oversized index is read", (t) => {
  const filler = Array.from({ length: 50 }, (_, i) => line(`019a0000-0000-7000-8000-${String(i).padStart(12, "0")}`, "x".repeat(50), "2026-09-27T09:00:00Z"));
  const dir = home(t, [line(A, "Too far back", "2026-09-27T10:00:00Z"), ...filler, line(B, "Near the end", "2026-09-27T10:00:00Z")]);
  const titles = readCodexTitles(dir, { maxBytes: 2048 });
  assert.equal(titles.get(A), undefined);
  assert.equal(titles.get(B), "Near the end");
  assert.ok(titles.size < 52);
});

test("titles are sanitised: control and format characters removed, whitespace collapsed, length capped", () => {
  assert.equal(sanitiseTitle("  Kherep-Funktionen\tnachschlagen \n"), "Kherep-Funktionen nachschlagen");
  assert.equal(sanitiseTitle("a\u0000b\u001bc\u202ed\u200be"), "abcde");
  assert.equal(sanitiseTitle("line\u2028break"), "line break");
  assert.equal(sanitiseTitle(" \u0007 "), undefined);
  assert.equal(sanitiseTitle(17), undefined);
  const long = sanitiseTitle("Ä".repeat(100))!;
  assert.equal([...long].length, 60);
  assert.ok(long.endsWith("…"));
  for (const title of ["Kherep-Funktionen nachschlagen", long, "Quote \" and \\ back"]) assert.ok(isTitle(title), title);
  for (const bad of ["", " x", "x ", "a\u0000b", "a\u202eb", "a\nb", "x".repeat(61), 5]) assert.equal(isTitle(bad), false, JSON.stringify(bad));
});

test("titles attach to Codex sessions only; a Claude session keeps its name", () => {
  const sessions: SessionInfo[] = [
    { sessionId: A, runtime: "codex", state: "active", name: "codex-0000d7d0", kind: "codex" },
    { sessionId: B, runtime: "claude-code", state: "idle", name: "review" },
  ];
  const titled = withCodexTitles(sessions, new Map([[A, "Kherep-Funktionen nachschlagen"], [B, "not for claude"]]));
  assert.deepEqual(titled.map((s) => s.title), ["Kherep-Funktionen nachschlagen", undefined]);
  assert.ok(titled.every(isSessionInfo));
  assert.equal(isSessionInfo({ ...sessions[0], title: "bad\u0000" }), false);
});

test("listSessions carries the title of a recorded Codex session when given the Codex home, and reads nothing without it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-titles-node-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  const now = Date.UTC(2026, 8, 27, 12);
  recordCodexSession(paths, A, "/work/repo", now);
  const list = (codexHome?: string) => listSessions({ paths, now: () => now, findClaude: () => null, codexHome });
  const listed = await list(home(t, [line(A, "Kherep-Funktionen nachschlagen", "2026-09-27T10:00:00Z")]));
  assert.deepEqual(listed.map((s) => [s.name, s.title]), [["codex-0000d7d0", "Kherep-Funktionen nachschlagen"]]);
  assert.equal((await list())[0].title, undefined);
  assert.equal((await list(path.join(root, "absent")))[0].title, undefined);
});

// Assignment must preserve the exact native title; the display reader remains lossy.

test("assignment title uses only the exact full id and latest rename, with later ties winning", async (t) => {
  const dir = home(t, [line(A, "Original", "2026-09-27T10:00:00Z"),
    line(A, "Newest", "2026-09-27T12:00:00Z"), line(A, "Older appended", "2026-09-27T11:00:00Z"),
    line(A, "Later tie", "2026-09-27T12:00:00Z"), line(B, "Other newest chat", "2026-09-27T15:00:00Z")]);
  assert.equal(await codexAssignmentTitle(dir, A), "Later tie");
  assert.equal(await codexAssignmentTitle(dir, B), "Other newest chat");
  for (const id of [A.slice(0, 8), "codex-0000d7d0", "../x", "", "019a0000-0000-7000-8000-0000000000ff"]) {
    assert.equal(await codexAssignmentTitle(dir, id), null, id);
  }
  const aliases = home(t, [line("alias", "Alias title", "2026-09-27T10:00:00Z")]);
  assert.equal(await codexAssignmentTitle(aliases, "alias"), null);
});

test("assignment titles remain lossless across display and protocol length boundaries", async (t) => {
  for (const title of ["Exact  internal  spaces", "  native spacing  ", "Ä".repeat(60), "Ä".repeat(61), "🦉".repeat(256)]) {
    const dir = home(t, [line(A, title, "2026-09-27T10:00:00Z")]);
    assert.equal(await codexAssignmentTitle(dir, A), title);
    assert.equal(readCodexTitles(dir).get(A), sanitiseTitle(title), "listing retains its display behavior");
  }
});

test("assignment refuses the newest unsupported title instead of reviving an older name", async (t) => {
  for (const title of [null, 42, {}, "", "   ", "bad\u0000title", "bad\u202etitle", "bad\u2028title", "bad\ud800title"]) {
    const dir = home(t, [line(A, "Old valid name", "2026-09-27T10:00:00Z"),
      line(A, title, "2026-09-27T11:00:00Z"), line(B, "No fallback", "2026-09-27T12:00:00Z")]);
    assert.equal(await codexAssignmentTitle(dir, A), null, JSON.stringify(title));
  }
});

test("assignment uses the display reader timestamp fallback", async (t) => {
  const dir = home(t, [line(A, "Undated", "not a date"),
    line(A, "Later undated", ""), line(B, "Other", "2026-09-27T10:00:00Z")]);
  assert.equal(await codexAssignmentTitle(dir, A), "Later undated");
  assert.equal(await codexAssignmentTitle(home(t), A), null);
  assert.equal(await codexAssignmentTitle(home(t, ["garbled", '{"id":']), A), null);
  const directory = home(t);
  fs.mkdirSync(path.join(directory, CODEX_INDEX));
  assert.equal(await codexAssignmentTitle(directory, A), null);
});

test("assignment title byte and line reads are bounded without a most recent fallback", async (t) => {
  const byteBounded = home(t, [line(A, "Outside tail", "2026-09-27T10:00:00Z"),
    "x".repeat(INDEX_MAX_BYTES), line(B, "Inside tail", "2026-09-27T10:00:00Z")]);
  assert.equal(await codexAssignmentTitle(byteBounded, A), null);
  assert.equal(await codexAssignmentTitle(byteBounded, B), "Inside tail");
  const lineBounded = home(t, [line(A, "Outside line limit", "2026-09-27T10:00:00Z"),
    ...Array.from({ length: INDEX_MAX_LINES }, () => JSON.stringify({ id: B })), line(B, "Inside lines", "2026-09-27T10:00:00Z")]);
  assert.equal(await codexAssignmentTitle(lineBounded, A), null);
  assert.equal(await codexAssignmentTitle(lineBounded, B), "Inside lines");
  const partial = home(t, [line(A, "x".repeat(INDEX_MAX_BYTES), "2026-09-27T10:00:00Z"),
    line(B, "Complete next line", "2026-09-27T10:00:00Z")]);
  assert.equal(await codexAssignmentTitle(partial, A), null);
  assert.equal(await codexAssignmentTitle(partial, B), "Complete next line");
});

test("assignment refuses a bounded tail that contains no complete line boundary", async (t) => {
  const record = line(A, "Synthetic title", "2026-09-27T10:00:00Z");
  const padded = record.slice(0, -1) + ',"padding":"' + "x".repeat(INDEX_MAX_BYTES - Buffer.byteLength(record) - 13) + '"}';
  assert.equal(Buffer.byteLength(padded), INDEX_MAX_BYTES);
  const dir = home(t);
  fs.writeFileSync(path.join(dir, CODEX_INDEX), "invalid prefix" + padded);
  assert.equal(await codexAssignmentTitle(dir, A), null);
});

test("assignment refuses invalid UTF-8 instead of returning a replacement title", async (t) => {
  const dir = home(t);
  const record = Buffer.from(line(A, "native-title", "2026-09-27T10:00:00Z") + "\n");
  record[record.indexOf("native-title")] = 0xff;
  fs.writeFileSync(path.join(dir, CODEX_INDEX), record);
  assert.equal(await codexAssignmentTitle(dir, A), null);
});

test("assignment refuses ambiguous retained records instead of reusing a stale title", async (t) => {
  for (const newer of ['{"id":"' + A + '","thread_name":"New rename', "not json", "null", "[]", "{}", '{"id":42}']) {
    const dir = home(t, [line(A, "Old valid name", "2026-09-27T10:00:00Z"), newer]);
    assert.equal(await codexAssignmentTitle(dir, A), null, newer);
    assert.equal(readCodexTitles(dir).get(A), "Old valid name", "legacy display reader remains fail-soft");
  }
});
