import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readNativeMcpAssignment } from "./mcp-assignment.mts";
const ID = "11111111-1111-4111-8111-111111111111";
test("assignment producer reads only exact synthetic original metadata and lossless native title", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-assignment-native-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "sessions", "2026", "11", "08");fs.mkdirSync(dir, { recursive: true });
  const rollout = path.join(dir, `rollout-synthetic-${ID}.jsonl`), index = path.join(home, "session_index.jsonl");
  const writeMeta = (extra: object = {}) => fs.writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: {
    id: ID, originator: "Codex Desktop", source: "vscode", ...extra } }) + '\n{"private":"DO NOT READ TRANSCRIPT"}\n');
  const writeTitle = (name: string) => fs.writeFileSync(index, JSON.stringify({ id: ID, thread_name: name, updated_at: "2026-11-08T00:00:00Z" }) + "\n");
  writeMeta();writeTitle("  Exact native title 😀  ");
  assert.deepEqual(await readNativeMcpAssignment(home, ID), { sessionId: ID, chatName: "  Exact native title 😀  ", platform: "darwin", originalMain: true });
  for (const extra of [{ parent_thread_id: ID }, { forked_from_id: ID }, { source: "exec" }, { id: "33333333-3333-4333-8333-333333333333" }]) {
    writeMeta(extra);assert.equal(await readNativeMcpAssignment(home, ID), null);
  }
  writeMeta();for (const name of ["", "\ninvalid", "x".repeat(1025)]) { writeTitle(name);assert.equal(await readNativeMcpAssignment(home, ID), null); }
  fs.unlinkSync(index);assert.equal(await readNativeMcpAssignment(home, ID), null);
  assert.equal(await readNativeMcpAssignment(home, "short"), null);
});
