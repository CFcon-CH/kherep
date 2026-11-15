import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { CODEX_CONTEXT_BYTES, CODEX_FORK_ENV, deliverForCodex } from "./deliver-codex.mts";
import { midTurnLock } from "./deliver-midturn.mts";
import { writeDirectory, writeLocalSessions } from "./exchange.mts";
import { storeMessage } from "./inbox.mts";

// Issue #828: the passive rename line reaches a Codex receiver on its next
// UserPromptSubmit, inside the Codex budget and after peer context.
const NODE = "00000000-0000-4000-8000-0000000000aa", PEER = "00000000-0000-4000-8000-0000000000cc";
const SELF = "019a2b3c-4d5e-7f60-8123-456789abcdef", NAME = "codex-89abcdef";
const CLAUDE = "00000000-0000-4000-8000-000000000002";
const CLOCK = Date.UTC(2026, 5, 1, 1);
const line = (old: string, name: string) => `Kherep session-label data: node ${NODE}, id ${CLAUDE}, previous name ${JSON.stringify(old)}, `
  + `observed name ${JSON.stringify(name)}. Display hint only; use msg sessions for current lookup. No reply required.`;

function setup(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-rename-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.com", nodeId: NODE, name: "node-a", publicKey: "x",
    privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  writeDirectory(paths, { nodes: [{ nodeId: PEER, name: "node-b", status: "online" }], sessions: [], fetchedAt: new Date(0).toISOString() });
  rename(paths, "A");
  return paths;
}
function rename(paths: NodePaths, name: string): void {
  writeLocalSessions(paths, [{ sessionId: SELF, runtime: "codex", state: "active", name: NAME },
    { sessionId: CLAUDE, runtime: "claude-code", state: "busy", name }]);
}
const hook = (paths: NodePaths, event: string, extra: Record<string, unknown> = {}): string =>
  deliverForCodex({ session_id: SELF, cwd: "/work/repo", hook_event_name: event, ...extra }, { paths, nonce: () => "t", replyCommand: "cli", now: () => CLOCK });
const context = (output: string): string => output ? JSON.parse(output).hookSpecificOutput.additionalContext : "";
const count = (text: string): number => text.split("Kherep session-label data:").length - 1;
const cache = (paths: NodePaths) => path.join(paths.dir, "rename-notices", `${SELF}.json`);

test("#828 a Codex UserPromptSubmit gets the line for a Claude rename exactly once", (t) => {
  const paths = setup(t);
  assert.equal(count(context(hook(paths, "UserPromptSubmit"))), 0, "the first prompt seeds silently");
  rename(paths, "B");
  const shown = context(hook(paths, "UserPromptSubmit"));
  assert.equal(count(shown), 1);
  assert.ok(shown.includes(line("A", "B")));
  assert.ok(Buffer.byteLength(shown) <= CODEX_CONTEXT_BYTES);
  assert.equal(count(context(hook(paths, "UserPromptSubmit"))), 0);
});

test("#828 a full Codex budget drops the hint first and keeps the peer context", (t) => {
  const paths = setup(t);
  hook(paths, "UserPromptSubmit");
  const text = "x".repeat(3900);
  storeMessage(paths.inbox, { messageId: "00000000-0000-4000-8000-000000000050", from: { nodeId: PEER, session: "build" }, toSession: NAME, text,
    createdAt: new Date(CLOCK - 60_000).toISOString() }, CLOCK - 60_000);
  rename(paths, "B");
  const full = context(hook(paths, "UserPromptSubmit"));
  assert.ok(full.includes(text), `the peer message is kept whole: ${full.slice(0, 400)}`);
  assert.equal(count(full), 0);
  assert.ok(CODEX_CONTEXT_BYTES - Buffer.byteLength(full) < Buffer.byteLength(`\n\n${line("A", "B")}`), "the fixture leaves no room for the hint");
  assert.equal(count(context(hook(paths, "UserPromptSubmit"))), 0, "a dropped hint is remembered, never replayed");
});

test("#828 nothing on Stop or in fork helpers", (t) => {
  const paths = setup(t);
  const previous = process.env[CODEX_FORK_ENV];
  t.after(() => { if (previous === undefined) delete process.env[CODEX_FORK_ENV]; else process.env[CODEX_FORK_ENV] = previous; });
  process.env[CODEX_FORK_ENV] = "1";
  assert.equal(hook(paths, "UserPromptSubmit"), "");
  assert.equal(fs.existsSync(cache(paths)), false, "a fork helper reads and records nothing");
  delete process.env[CODEX_FORK_ENV];
  hook(paths, "UserPromptSubmit");
  rename(paths, "B");
  assert.equal(hook(paths, "Stop"), "");
  process.env[CODEX_FORK_ENV] = "1";
  assert.equal(hook(paths, "UserPromptSubmit"), "");
  delete process.env[CODEX_FORK_ENV];
  assert.equal(count(context(hook(paths, "UserPromptSubmit"))), 1, "the next real prompt still gets the line");
});

test("#828 a held owner lock or a lock directory failure keeps the Codex prompt context and skips the comparison", (t) => {
  const paths = setup(t);
  hook(paths, "UserPromptSubmit");
  rename(paths, "B");
  const lock = midTurnLock(paths, SELF);
  fs.writeFileSync(lock, "synthetic");
  const held = context(hook(paths, "UserPromptSubmit"));
  assert.equal(count(held), 0);
  assert.match(held, /msg inbox --from/);
  fs.rmSync(lock);
  const real = fs.mkdirSync;
  const fault = t.mock.method(fs, "mkdirSync", (dir: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: false }) => {
    if (String(dir) === path.dirname(lock)) throw new Error("synthetic lock failure");
    return real(dir, options);
  });
  const failed = context(hook(paths, "UserPromptSubmit"));
  assert.equal(count(failed), 0);
  assert.match(failed, /msg inbox --from/);
  fault.mock.restore();
  assert.equal(count(context(hook(paths, "UserPromptSubmit"))), 1, "the skipped comparison is not lost");
});
