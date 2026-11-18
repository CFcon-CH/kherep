// Issue #965: how deploy-guard.mts reads the last user message of its transcript. Lines that are
// no JSON and rows of other roles are passed over, a string content counts like a text block, and
// a last user message without text approves nothing even when an older one did. The hook and its
// libs are declared copies in a temporary home with hooks/ and projects/ beside each other.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { copyDeclared } from "./copy-declare-fixture.mts";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deploy-guard-transcript-")));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const HOOK = path.join(ROOT, "hooks", "deploy-guard.mts");
const PROJECT = path.join(ROOT, "projects", "synthetic-project");
fs.mkdirSync(PROJECT, { recursive: true });
for (const rel of ["deploy-guard.mts", "lib/git-push-match.mts", "lib/forge-match.mts", "lib/deploy-transcript.mts", "lib/tool-event-shape.mts",
  "lib/tool-event-contract.mts"]) copyDeclared(path.join(import.meta.dirname, rel), path.join(ROOT, "hooks", rel));

const APPROVAL = "deploy to production now, approved";
const user = (content: unknown): string => JSON.stringify({ message: { role: "user", content } });
let seq = 0;

// Exit status of the hook for a production Forge deploy with a transcript of the given lines.
function deployWith(lines: string[]): number | null {
  const transcript = path.join(PROJECT, `transcript-${++seq}.jsonl`);
  fs.writeFileSync(transcript, `${lines.join("\n")}\n`);
  const payload = { tool_name: "Bash", tool_input: { command: "forge deploy -e production" }, transcript_path: transcript };
  return spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: "utf8", windowsHide: true, timeout: 10_000 }).status;
}

test("a string approval behind unparseable lines and an assistant row allows the deploy", () => {
  assert.equal(deployWith([user(APPROVAL), "{not json", JSON.stringify({ message: { role: "assistant", content: "deploying" } }), "[]", "null"]), 0);
});

test("without any approval the production deploy is blocked", () => {
  assert.equal(deployWith([user("please look at the logs")]), 2);
});

test("a last user message without text approves nothing, whatever an older one said", () => {
  for (const content of [{ text: APPROVAL }, [{ type: "image", source: {} }], 7]) {
    assert.equal(deployWith([user(APPROVAL), user(content)]), 2, JSON.stringify(content));
  }
});
