import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths, type NodePaths } from "./config.mts";
import { deliverForHook } from "./deliver-hook.mts";
import { MIDTURN_LOCK_STALE_MS, midTurnLock } from "./deliver-midturn.mts";
import { writeDirectory, writeLocalSessions } from "./exchange.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import { CONTENTION_ATTEMPTS } from "./lock-contention.mts";

// Issue #602: on Windows the mid-turn lock of a releasing PostToolUse call is
// delete-pending for a moment and its exclusive create fails with EPERM. Such a
// code is waited out within a bound and is never taken for a stale lock.

const PEER = "00000000-0000-4000-8000-0000000000cc";
const REPLY = 'node "/opt/kherep/modules/control-plane/node/cli.mts"';
const SELF = "s-self";

function setup(t: test.TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-midturn-contention-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  writeLocalSessions(paths, [{ sessionId: SELF, runtime: "claude-code", state: "busy", name: "review" }]);
  writeDirectory(paths, { nodes: [{ nodeId: PEER, name: "node-b", status: "online" }], sessions: [], fetchedAt: new Date(0).toISOString() });
  return paths;
}

function inbox(paths: NodePaths): string {
  const messageId = "00000000-0000-4000-8000-000000000001";
  storeMessage(paths.inbox, { messageId, from: { nodeId: PEER, session: "build" }, toSession: "review", text: "message 1",
    createdAt: new Date(Date.UTC(2026, 5, 1)).toISOString() }, Date.UTC(2026, 5, 1));
  return messageId;
}

const toolUse = (paths: NodePaths): string => deliverForHook({ session_id: SELF, hook_event_name: "PostToolUse",
  permission_mode: "default", tool_name: "Bash", tool_input: { command: "true" }, tool_response: {}, tool_use_id: "toolu_1" },
{ paths, nonce: () => "t0k3n", replyCommand: REPLY });

const state = (paths: NodePaths, messageId: string) => {
  const record = getMessage(paths.inbox, messageId);
  return [record?.state, record?.offers];
};

// Opens of `lock` fail with `codes` in turn, later ones open for real; returns
// the codes seen ("open" for a real one) and the descriptors really opened.
function lockOpens(t: test.TestContext, lock: string, codes: readonly string[]): { seen: string[]; fds: number[]; live: Set<number> } {
  const real = fs.openSync;
  const seen: string[] = [], fds: number[] = [], live = new Set<number>();
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
    if (String(file) !== lock) return real(file, flags, mode);
    const code = codes[seen.length];
    seen.push(code ?? "open");
    if (code) throw Object.assign(new Error(`synthetic ${code}`), { code, syscall: "open" });
    const fd = real(file, flags, mode);
    fds.push(fd); live.add(fd);
    return fd;
  });
  return { seen, fds, live };
}

for (const codes of [["EPERM"], ["EPERM", "EPERM"], ["EBUSY", "EACCES"]]) {
  test(`a mid-turn lock open failing ${codes.join(" then ")} is retried and delivers once`, (t) => {
    const paths = setup(t);
    const messageId = inbox(paths);
    const { seen } = lockOpens(t, midTurnLock(paths, SELF), codes);
    const output = toolUse(paths);
    assert.equal(output.split(`=== Kherep peer message ${messageId} `).length - 1, 1, output);
    assert.deepEqual(state(paths, messageId), ["offered", 1]);
    assert.deepEqual(seen, [...codes, "open"]);
    assert.equal(fs.existsSync(midTurnLock(paths, SELF)), false, "the lock is released after the call");
  });
}

test("a mid-turn lock reported transient past the bound defers and never counts as stale", (t) => {
  const paths = setup(t);
  const messageId = inbox(paths);
  const lock = midTurnLock(paths, SELF);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "4242");
  const old = new Date(Date.now() - MIDTURN_LOCK_STALE_MS - 1_000);
  fs.utimesSync(lock, old, old);
  const { seen } = lockOpens(t, lock, Array<string>(CONTENTION_ATTEMPTS).fill("EPERM"));
  assert.equal(toolUse(paths), "");
  assert.deepEqual(state(paths, messageId), ["accepted", undefined]);
  assert.equal(seen.length, CONTENTION_ATTEMPTS);
  assert.equal(fs.readFileSync(lock, "utf8"), "4242", "an old lock is not removed on a transient code");
});

test("a mid-turn lock open failing with another code defers at once", (t) => {
  const paths = setup(t);
  const messageId = inbox(paths);
  const { seen } = lockOpens(t, midTurnLock(paths, SELF), ["ENOSPC"]);
  assert.equal(toolUse(paths), "");
  assert.deepEqual(seen, ["ENOSPC"]);
  assert.deepEqual(state(paths, messageId), ["accepted", undefined]);
});

test("a failed PID write after the open removes the own lock and delivers nothing", (t) => {
  const paths = setup(t);
  const messageId = inbox(paths);
  const lock = midTurnLock(paths, SELF);
  const { seen, fds } = lockOpens(t, lock, []);
  const real = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView,
    options?: fs.WriteFileOptions) => {
    if (typeof file === "number" && fds.includes(file)) throw Object.assign(new Error("synthetic EIO"), { code: "EIO" });
    return real(file, data, options);
  });
  assert.equal(toolUse(paths), "");
  assert.deepEqual(seen, ["open"]);
  assert.equal(fs.existsSync(lock), false, "no lock is left behind");
  assert.deepEqual(state(paths, messageId), ["accepted", undefined]);
});

test("a failed close after the PID write is not repeated; the own lock is removed", (t) => {
  const paths = setup(t);
  const messageId = inbox(paths);
  const lock = midTurnLock(paths, SELF);
  const { fds, live } = lockOpens(t, lock, []);
  const real = fs.closeSync, closes: number[] = [];
  const closing = t.mock.method(fs, "closeSync", (fd: number) => {
    if (!live.delete(fd)) return real(fd);
    closes.push(fd);
    real(fd); // close(2) on Linux releases the number even when it reports an error
    throw Object.assign(new Error("synthetic EIO"), { code: "EIO" });
  });
  assert.equal(toolUse(paths), "");
  assert.deepEqual([fds.length, closes], [1, fds], "one create, closed exactly once");
  assert.equal(fs.existsSync(lock), false, "no lock is left behind");
  closing.mock.restore();
  assert.deepEqual(state(paths, messageId), ["accepted", undefined]);
});
