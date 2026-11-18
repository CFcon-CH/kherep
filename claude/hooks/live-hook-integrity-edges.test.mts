// Issue #965: inputs of live-hook-integrity.mts the other integrity suites do not give it. A
// `--trigger` without a name is "unnamed"; stdin that is no JSON is an empty payload; without
// CLAUDE_HOME the home is ~/.claude of HOME (USERPROFILE on Windows); and a writer whose home
// has no hooks/ directory of its own repairs nothing. Throwaway homes only: HOME, USERPROFILE
// and CLAUDE_HOME always point into the mkdtemp tree.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { coordinated, installIntegrity, runIntegrity, runUncoordinated } from "./integrity-sandbox.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "live-hook-edges-")));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
const GOOD = "export const enforces = true;\n";
let seq = 0;

interface Box { home: string; claude: string; hooks: string; env: NodeJS.ProcessEnv }

// A home wiring commit-guard.mts with the given live bytes; no versioned checkout.
function sandbox(live = GOOD): Box {
  const home = path.join(TMP, `case-${++seq}`, "home");
  const claude = path.join(home, ".claude");
  const hooks = path.join(claude, "hooks");
  installIntegrity(hooks);
  fs.writeFileSync(path.join(hooks, "commit-guard.mts"), live);
  const wiring = { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: coordinated("node ~/.claude/hooks/commit-guard.mts") }] }] };
  fs.writeFileSync(path.join(claude, "settings.user.json"), JSON.stringify({ hooks: wiring }));
  return { home, claude, hooks, env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_HOME: claude, KHEREP_WORKSPACE: "" } };
}

const heartbeat = (box: Box): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(box.claude, ".cache", "hook-integrity", "heartbeat.json"), "utf8"));

test("a --trigger without a name runs as the unnamed trigger and records it so", () => {
  const box = sandbox();
  const result = runIntegrity(box.hooks, "{}", box.env, ["--trigger"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^all \d+ files OK \(0 restored\), heartbeat refreshed$/m);
  assert.equal(heartbeat(box).trigger, "unnamed");
});

test("stdin that is no JSON is an empty payload: the run still checks every wired file", () => {
  const box = sandbox();
  const result = runIntegrity(box.hooks, "not json {", box.env, ["--trigger", "test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^all \d+ files OK \(0 restored\), heartbeat refreshed$/m);
});

test("without CLAUDE_HOME the home is .claude under the user's home directory", () => {
  const box = sandbox("");
  const env = { ...box.env };
  delete env.CLAUDE_HOME;
  const result = runUncoordinated(box.hooks, "{}", env, ["--trigger", "test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /commit-guard\.mts: 0 bytes .* NOT restored \(this run is not coordinated/);
});

test("a writer for a home without its own hooks/ directory repairs nothing", () => {
  const box = sandbox("");
  const other = path.join(TMP, `case-${++seq}`, "other", ".claude");
  fs.mkdirSync(other, { recursive: true });
  fs.copyFileSync(path.join(box.claude, "settings.user.json"), path.join(other, "settings.user.json"));
  const otherHome = path.dirname(other);
  const result = runIntegrity(box.hooks, "{}", { ...box.env, HOME: otherHome, USERPROFILE: otherHome, CLAUDE_HOME: other }, ["--trigger", "test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NOT restored \(the coordinated hooks directory is not this installation's hooks\/\)/);
  assert.equal(fs.readFileSync(path.join(box.hooks, "commit-guard.mts"), "utf8"), "", "the live guard is unchanged");
});
