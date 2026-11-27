// Tests for the gates before a model child starts (issue #1020): the Claude
// CLI minimum, the Codex feature-name check and the anchored Luna selection.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { claudeGate, codexGate, codexHome, lunaSelection, MIN_CLAUDE_CLI, versionAtLeast } from "./confluence-model-gates.mts";
import { fakeGate } from "./semantic-model.fixture.mts";

test("Claude gate: 2.1.289 fails naming both versions; 2.1.293 and 2.2.0 pass; unreadable fails", async () => {
  assert.equal(MIN_CLAUDE_CLI, "2.1.293");
  assert.deepEqual(await claudeGate(fakeGate({ claude: "2.1.289" }).exec, "claude"),
    { error: "claude CLI 2.1.289 is older than 2.1.293, which Haiku 5.5 needs; run claude update" });
  assert.deepEqual(await claudeGate(fakeGate({ claude: "2.1.293" }).exec, "claude"), { version: "2.1.293" });
  assert.deepEqual(await claudeGate(fakeGate({ claude: "2.2.0" }).exec, "claude"), { version: "2.2.0" });
  assert.deepEqual(await claudeGate(async () => ({ stdout: "Claude Code" }), "claude"), { error: "claude CLI version is unreadable" });
  assert.match((await claudeGate(fakeGate({ fail: true }).exec, "claude") as { error: string }).error, /unreadable: spawn failed/);
  assert.equal(versionAtLeast("2.10.0", "2.9.9"), true);
});

test("Codex gate: every pinned name must be listed; a missing name or an unreadable list fails", async () => {
  assert.deepEqual(await codexGate(fakeGate().exec, "codex"), { version: "0.169.0" });
  assert.deepEqual(await codexGate(fakeGate({ features: ["hooks", "apps"] }).exec, "codex", ["hooks", "shell_tool"]),
    { error: 'codex CLI 0.169.0 does not list feature "shell_tool"; the tool-free child cannot be guaranteed' });
  const broken = async (_file: string, args: string[]) => {
    if (args[0] === "features") throw new Error("boom");
    return { stdout: "codex-cli 0.169.0" };
  };
  assert.deepEqual(await codexGate(broken, "codex"), { error: "codex feature list is unreadable: boom" });
});

function codexHomeWith(receipt: unknown, options: { sha?: string; target?: string } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "kherep-anchor-"));
  mkdirSync(path.join(home, "orchestra"));
  const bytes = Buffer.from(JSON.stringify(receipt));
  writeFileSync(path.join(home, "orchestra", "model-selection-receipt.json"), bytes);
  const sha = options.sha ?? createHash("sha256").update(bytes).digest("hex");
  writeFileSync(path.join(home, "orchestra", "model-selection-anchor.json"),
    JSON.stringify({ receipt: { target: options.target ?? "orchestra/model-selection-receipt.json", sha256: sha } }));
  return home;
}

const RECEIPT = { resolution: { roles: { broker: { effective: { model: "gpt-6-luna", effort: "medium" } } } } };

test("Luna selection: a matching anchor yields model and effort; four failures have four reasons", () => {
  assert.deepEqual(lunaSelection(codexHomeWith(RECEIPT)), { model: "gpt-6-luna", effort: "medium" });
  const empty = mkdtempSync(path.join(tmpdir(), "kherep-anchor-"));
  const missingReceipt = codexHomeWith(RECEIPT, { target: "orchestra/absent.json" });
  const reasons = [
    lunaSelection(empty),
    lunaSelection(missingReceipt),
    lunaSelection(codexHomeWith(RECEIPT, { sha: "0".repeat(64) })),
    lunaSelection(codexHomeWith({ resolution: { roles: { broker: { effective: { model: "gpt-6-sol", effort: "medium" } } } } })),
  ].map((r) => (r as { error: string }).error);
  assert.deepEqual(reasons, [
    "the Codex model-selection anchor is missing or unreadable",
    "the Codex model-selection receipt is missing or unreadable",
    "the Codex model-selection receipt does not match its anchor hash",
    "the Codex model-selection receipt names no Luna model for the broker role",
  ]);
  assert.match((lunaSelection(codexHomeWith(RECEIPT, { target: "../escape.json" })) as { error: string }).error, /anchor/);
});

test("codexHome is the one resolver the observation adapter uses as well", () => {
  assert.equal(codexHome({ CODEX_HOME: "/x/home" }, "/u"), path.resolve("/x/home"));
  assert.equal(codexHome({}, "/u"), path.resolve("/u/.codex"));
  const stdio = readFileSync(path.join(import.meta.dirname, "observation-stdio.mts"), "utf8");
  assert.match(stdio, /codexHome\(process\.env\)/, "observation-stdio.mts resolves CODEX_HOME through codexHome");
});
