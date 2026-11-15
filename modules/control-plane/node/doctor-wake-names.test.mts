import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SessionInfo } from "../protocol.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { checkWakeNames } from "./doctor-wake-names.mts";
import { readPolicy } from "./policy.mts";
import { labelsFile, policyStamp, recordLocalLabels } from "./session-labels.mts";

// Issue #828: doctor shows, per wake.sessions name, whether it is bound to an id.
const S = "11111111-1111-4111-8111-111111111111", T = "22222222-2222-4222-8222-222222222222";
const NOW = Date.UTC(2026, 10, 15, 12);
const row = (sessionId: string, name: string, at: number): SessionInfo => ({ runtime: "claude-code", sessionId, name, state: "unknown",
  canonicalIdentity: { version: 1, source: "claude-list", runtime: "claude-code", sessionId, observedAt: at, lifecycleGeneration: 0 } });
function fixture(t: test.TestContext, tokens: string[]): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-wake-names-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: true, sessions: tokens } }));
  return paths;
}
const list = (paths: NodePaths, rows: SessionInfo[], at: number) => recordLocalLabels(paths, rows, at, true, policyStamp(paths));
const check = (paths: NodePaths) => checkWakeNames(paths, readPolicy(paths.policy));

test("#828 a name stays bound to its id after a rename and doctor shows the current and previous name", (t) => {
  const paths = fixture(t, ["review", S, "*"]);
  list(paths, [row(S, "review", NOW)], NOW);
  list(paths, [row(S, "analysis", NOW + 1000), row(T, "review", NOW + 1000)], NOW + 1000);
  assert.deepEqual(check(paths), { ok: true, status: "healthy", names: [
    { token: "review", status: "bound", sessionId: S, runtime: "claude-code", name: "analysis", previousName: "review" }] });
});

test("#828 an unbound name and a name without holder are flagged", (t) => {
  const paths = fixture(t, ["review", "ghost"]);
  list(paths, [row(S, "review", NOW), row(T, "review", NOW)], NOW);
  const result = check(paths);
  assert.deepEqual(result.names, [{ token: "review", status: "unbound" }, { token: "ghost", status: "no-holder" }]);
  assert.equal(result.ok, true);
  assert.match(String(result.detail), /unbound/);
});

test("#828 damaged label history reports history-unavailable for every name", (t) => {
  const paths = fixture(t, ["review", "ghost", S]);
  list(paths, [row(S, "review", NOW)], NOW);
  fs.writeFileSync(labelsFile(paths), "{");
  assert.deepEqual(check(paths), { ok: true, status: "history-unavailable",
    names: [{ token: "review", status: "history-unavailable" }, { token: "ghost", status: "history-unavailable" }],
    detail: "label history is unavailable, so wake names are denied until a complete listing rebuilds it; exact ids still work" });
});

test("#828 an unreadable policy is unknown and a disabled wake section lists no names", (t) => {
  const paths = fixture(t, ["review"]);
  assert.deepEqual(checkWakeNames(paths, null), { ok: false, status: "unknown", names: [], detail: "wake names are unknown because policy is unreadable" });
  assert.deepEqual(checkWakeNames(paths, { version: 1, allowedCommands: [] }), { ok: true, status: "disabled", names: [] });
});

test("#828 a bound name without a rename shows no previous name, and a bound id without a label row shows no name", (t) => {
  const paths = fixture(t, ["review"]);
  list(paths, [row(S, "review", NOW)], NOW);
  assert.deepEqual(check(paths).names, [{ token: "review", status: "bound", sessionId: S, runtime: "claude-code", name: "review" }]);
  const state = JSON.parse(fs.readFileSync(labelsFile(paths), "utf8"));
  fs.writeFileSync(labelsFile(paths), JSON.stringify({ ...state, local: [] }));
  assert.deepEqual(check(paths).names, [{ token: "review", status: "bound", sessionId: S, runtime: "claude-code" }]);
});
