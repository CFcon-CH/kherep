// Issue #922. dispatch-contract-guard requires the dispatching session's id as
// the first non-empty brief line, exactly `Session id: <id>`
// (claude/hooks/lib/obs-session-policy.mts). This pins the agent's half: it reads
// the id only from that line, of the guard's shape, and never invents one. Its
// own file because observation-agent-contract.test.mts is at its size cap.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const REPO = path.resolve(import.meta.dirname, "..");
const CLAUDE_OBS = fs.readFileSync(path.join(REPO, "claude", "agents", "claude-obs.md"), "utf8");
const POLICY = fs.readFileSync(path.join(REPO, "claude", "hooks", "lib", "obs-session-policy.mts"), "utf8");

test("the Claude text takes the session id only from the first non-empty brief line", () => {
  assert.match(CLAUDE_OBS, /session id only from the brief's first non-empty line[\s\S]{0,60}exactly `Session id: <id>`/);
  assert.match(CLAUDE_OBS, /label `session-<id>`, body `<p>Session id: <id><\/p>`/);
});

test("the Claude text treats an id elsewhere or of another shape as not given", () => {
  assert.match(CLAUDE_OBS, /session id anywhere\s+else, or of another shape, is not given/);
  assert.match(CLAUDE_OBS, /never derive, shorten or invent one/);
});

test("the shape the agent accepts is the shape the guard requires", () => {
  assert.match(CLAUDE_OBS, /`<id>` of\s+lowercase letters, digits and hyphens/);
  assert.match(POLICY, /const SESSION_ID = \/\^\[a-z0-9\]\[a-z0-9-\]\{0,79\}\$\/;/);
  assert.match(POLICY, /`Session id: \$\{sessionId\}`/);
});
