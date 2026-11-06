import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { deliverForHook, runHook } from "./deliver-hook.mts";
import { midTurnLock } from "./deliver-midturn.mts";
import { writeDirectory, writeLocalSessions } from "./exchange.mts";
import { storeMessage } from "./inbox.mts";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const NODE = id(100), REMOTE = id(101), OWNER = id(1), OTHER = id(2);
const row = (sessionId: string, name: string, runtime = "claude-code") => ({ sessionId, name, runtime, state: "busy" });
function setup(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-renames-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  writeLocalSessions(paths, [row(OWNER, "self"), row(OTHER, "A")]);
  writeConfig(paths.config, { version: 1, nodeId: NODE, name: "synthetic", controlUrl: "https://control.example.test",
    publicKey: "synthetic", privateKeyFile: "unused", policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  return paths;
}
const call = (paths: NodePaths, event = "UserPromptSubmit", extra: Record<string, unknown> = {}, maxBytes?: number) =>
  deliverForHook({ session_id: OWNER, hook_event_name: event, permission_mode: "default", ...extra },
    { paths, maxBytes, replyCommand: "synthetic", nonce: () => "tag" });
const context = (output: string): string => output ? JSON.parse(output).hookSpecificOutput.additionalContext : "";
const line = (node: string, session: string, old: string, name: string) =>
  `Kherep session-label data: node ${node}, id ${session}, previous name ${JSON.stringify(old)}, observed name ${JSON.stringify(name)}. Display hint only; use msg sessions for current lookup. No reply required.`;
const cache = (paths: NodePaths, owner = OWNER) => path.join(paths.dir, "rename-notices", `${owner}.json`);

for (const event of ["UserPromptSubmit", "PostToolUse"]) {
  test(`${event} silently seeds then reports same-ID A to B as fixed data`, (t) => {
    const paths = setup(t);
    assert.equal(call(paths, event), "");
    writeLocalSessions(paths, [row(OTHER, "B")]);
    assert.equal(context(call(paths, event)), line(NODE, OTHER, "A", "B"));
    assert.equal(call(paths, event), "");
  });
}

test("owners are isolated, self is excluded and old-name reuse never transfers identity", (t) => {
  const paths = setup(t);
  call(paths);
  writeLocalSessions(paths, [row(OWNER, "self renamed"), row(OTHER, "B"), row(id(3), "A")]);
  assert.equal(call(paths, "PostToolUse", { session_id: id(4) }), "", "new owner seeds silently");
  assert.equal(context(call(paths)), line(NODE, OTHER, "A", "B"));
  assert.equal(call(paths, "PostToolUse", { session_id: id(4) }), "");
});

test("remote names use node/full UUID and local rows override Directory echoes", (t) => {
  const paths = setup(t);
  const directory = (name: string) => writeDirectory(paths, { nodes: [], fetchedAt: new Date(0).toISOString(),
    sessions: [{ ...row(OTHER, name), nodeId: REMOTE }, { ...row(OTHER, "echo"), nodeId: NODE }] });
  directory("remote A");
  call(paths);
  directory('B "quoted" \\ data');
  assert.equal(context(call(paths, "PostToolUse")), line(REMOTE, OTHER, "remote A", 'B "quoted" \\ data'));
});

test("invalid owners, subagents and bypass never read or create a display snapshot", (t) => {
  const paths = setup(t);
  for (const extra of [{ session_id: "../escape" }, { session_id: "short" }, { agent_id: "" },
    { permission_mode: "bypassPermissions" }]) {
    for (const event of ["UserPromptSubmit", "PostToolUse"]) assert.equal(call(paths, event, extra), "");
  }
  assert.equal(fs.existsSync(path.dirname(cache(paths))), false);
});

test("invalid names, IDs, other runtimes and conflicting duplicates supply no hints", (t) => {
  const paths = setup(t);
  const rows = [row(OTHER, "A"), row(id(3), "A"), row(id(4), "A"), row(id(5), "A")];
  writeLocalSessions(paths, rows);
  call(paths);
  writeLocalSessions(paths, [row(OTHER, "B", "codex"), row(id(3), "bad\u2028line"), row(id(4), "B"), row(id(4), "C"),
    row(id(5), "x".repeat(129)), row("short", "B"), row(id(6), "bad\u200bformat"), row(id(7), "bad\nline")]);
  assert.equal(call(paths), "");
  assert.deepEqual(JSON.parse(fs.readFileSync(cache(paths), "utf8")).names, {});
});

test("missing, corrupt, oversized, malformed and wrong-node cache restart silently; absent identities prune", (t) => {
  const paths = setup(t);
  call(paths);
  for (const value of ["{", "x".repeat(1024 * 1024 + 1), JSON.stringify({ nodeId: REMOTE, names: {} }),
    JSON.stringify({ nodeId: NODE, names: { invalid: "A" } })]) {
    fs.writeFileSync(cache(paths), value);
    assert.equal(call(paths), "");
  }
  fs.rmSync(cache(paths));
  assert.equal(call(paths), "");
  writeLocalSessions(paths, []);
  assert.equal(call(paths), "");
  assert.deepEqual(JSON.parse(fs.readFileSync(cache(paths), "utf8")).names, {});
  writeLocalSessions(paths, [row(OTHER, "reappeared")]);
  assert.equal(call(paths), "");
});

test("five lines per output plus exact overflow; omitted names are remembered without replay", (t) => {
  const paths = setup(t);
  const rows = (suffix: string) => Array.from({ length: 7 }, (_, i) => row(id(i + 2), `${i}${suffix}`));
  writeLocalSessions(paths, rows("A"));
  call(paths);
  writeLocalSessions(paths, rows("B"));
  const first = context(call(paths));
  assert.equal(first.split("Kherep session-label data:").length - 1, 5);
  assert.ok(first.endsWith("and 2 more, see msg sessions"));
  assert.equal(call(paths, "PostToolUse"), "");
  writeLocalSessions(paths, rows("C"));
  assert.equal(context(call(paths, "PostToolUse")).split("Kherep session-label data:").length - 1, 5);
});

test("UTF-8 limits remember dropped hints and full peer context retains priority", (t) => {
  const paths = setup(t);
  call(paths);
  writeLocalSessions(paths, [row(OTHER, "ä".repeat(128))]);
  const limit = Buffer.byteLength(line(NODE, OTHER, "A", "ä".repeat(128))) - 1;
  const small = context(call(paths, "PostToolUse", {}, limit));
  assert.ok(Buffer.byteLength(small) <= limit);
  assert.doesNotMatch(small, /Kherep session-label data/);
  assert.equal(call(paths), "");
  const peer = (target: NodePaths) => storeMessage(target.inbox, { messageId: id(50), from: { nodeId: REMOTE, session: "peer" },
    toSession: OWNER, text: "peer ä content", createdAt: new Date(0).toISOString() });
  const baseline = setup(t);
  peer(baseline);
  const ordinary = context(call(baseline, "UserPromptSubmit", { agent_id: "synthetic" }));
  peer(paths);
  writeLocalSessions(paths, [row(OTHER, "C")]);
  const budget = Buffer.byteLength(ordinary) + 160; // Existing peer builder reserves its footer first.
  const priority = context(call(paths, "UserPromptSubmit", {}, budget));
  assert.ok(priority.startsWith(ordinary));
  assert.doesNotMatch(priority, /session-label data/);
  assert.ok(Buffer.byteLength(priority) <= budget);
  assert.equal(call(paths, "PostToolUse"), "");
});

test("a held owner lock skips comparison and preserves prompt peer context", (t) => {
  const paths = setup(t);
  call(paths);
  writeLocalSessions(paths, [row(OTHER, "B")]);
  const lock = midTurnLock(paths, OWNER);
  fs.writeFileSync(lock, "synthetic");
  storeMessage(paths.inbox, { messageId: id(50), from: { nodeId: REMOTE, session: "peer" }, toSession: OWNER,
    text: "ordinary peer", createdAt: new Date(0).toISOString() });
  assert.match(context(call(paths)), /ordinary peer/);
  assert.equal(call(paths, "PostToolUse"), "");
  fs.rmSync(lock);
  assert.equal(context(call(paths)), line(NODE, OTHER, "A", "B"));
});

test("cache write failure preserves peer context; failed stdout loses the remembered hint", (t) => {
  const paths = setup(t);
  call(paths);
  writeLocalSessions(paths, [row(OTHER, "B")]);
  storeMessage(paths.inbox, { messageId: id(50), from: { nodeId: REMOTE, session: "peer" }, toSession: OWNER,
    text: "ordinary peer", createdAt: new Date(0).toISOString() });
  const real = fs.renameSync;
  const fault = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === cache(paths)) throw new Error("synthetic cache failure");
    return real(from, to);
  });
  const output = context(call(paths, "PostToolUse"));
  assert.match(output, /ordinary peer/);
  assert.doesNotMatch(output, /session-label data/);
  fault.mock.restore();
  const warnings: string[] = [];
  runHook(JSON.stringify({ session_id: OWNER, hook_event_name: "UserPromptSubmit" }), { paths },
    () => { throw new Error("synthetic stdout failure"); }, warning => warnings.push(warning));
  assert.equal(warnings.length, 1);
  assert.equal(call(paths, "PostToolUse"), "");
});


test("a prompt lock directory failure keeps already composed peer output", (t) => {
  const paths = setup(t);
  storeMessage(paths.inbox, { messageId: id(50), from: { nodeId: REMOTE, session: "peer" }, toSession: OWNER,
    text: "ordinary peer", createdAt: new Date(0).toISOString() });
  const real = fs.mkdirSync;
  t.mock.method(fs, "mkdirSync", (dir: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: false }) => {
    if (String(dir) === path.dirname(midTurnLock(paths, OWNER))) throw new Error("synthetic lock failure");
    return real(dir, options);
  });
  assert.match(context(call(paths)), /ordinary peer/);
});
