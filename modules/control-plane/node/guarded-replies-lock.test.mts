import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nodePaths } from "./config.mts";
import { rememberGuardedMcpReply, wasGuardedMcpReply } from "./guarded-replies.mts";
import { storeMessage } from "./inbox.mts";
import { recordLockFile, withRecordLock } from "./inbox-record-lock.mts";

const PARENT = "00000000-0000-4000-8000-000000000003";
const INDEX = "00000000-0000-4000-8000-000000000000";
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-marker-lock-")), paths = nodePaths(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  storeMessage(paths.inbox, { messageId: PARENT, from: { nodeId: PARENT, session: "synthetic-peer" },
    toSession: "synthetic-owner", text: "Synthetic guarded parent", createdAt: new Date().toISOString(),
    loop: { version: 1, threadId: PARENT, depth: 1, generation: 0, ordinal: 2 } }, Date.now(), 1);
  const dir = path.join(paths.mcp, "guarded-replies"); fs.mkdirSync(dir, { recursive: true });
  return { paths, dir, lock: recordLockFile(dir, INDEX) };
}

test("successive marker writers release only their empty directory at the exact existing lock path", (t) => {
  const f = fixture(t), original = fs.writeFileSync, removed: string[] = [];
  const rmdir = fs.rmdirSync;
  fs.writeFileSync = function (...args: Parameters<typeof original>) {
    if (typeof args[0] === "string" && path.dirname(args[0]) === f.dir && args[0].endsWith(".tmp")) {
      assert.ok(fs.lstatSync(f.lock).isDirectory());
      // The actual old helper must fail before invoking its callback or moving the directory.
      const ino = fs.lstatSync(f.lock).ino;
      assert.throws(() => withRecordLock(f.dir, INDEX, () => assert.fail("old writer entered")));
      assert.equal(fs.lstatSync(f.lock).ino, ino);
    }
    return Reflect.apply(original, fs, args);
  } as typeof original;
  fs.rmdirSync = function (file, options) {
    assert.equal(options, undefined, "owner release is nonrecursive"); removed.push(String(file));
    return Reflect.apply(rmdir, fs, [file]);
  } as typeof rmdir;
  try {
    for (let i = 0; i < 2; i++) {
      const id = crypto.randomUUID(); rememberGuardedMcpReply(f.paths, id, PARENT);
      assert.ok(wasGuardedMcpReply(f.paths, id)); assert.equal(fs.existsSync(f.lock), false);
    }
    assert.deepEqual(removed, [f.lock, f.lock]);
  } finally { fs.writeFileSync = original; fs.rmdirSync = rmdir; }
});

for (const kind of ["old-file", "corrupt-file", "directory"] as const) {
  test(`leftover ${kind} is a bounded conservative fence, never displaced`, (t) => {
    const f = fixture(t), id = crypto.randomUUID();
    if (kind === "directory") fs.mkdirSync(f.lock);
    else fs.writeFileSync(f.lock, kind === "old-file" ? '{"pid":1,"at":"2000-01-01T00:00:00.000Z"}' : "corrupt");
    fs.utimesSync(f.lock, 1, 1); const before = fs.lstatSync(f.lock);
    const started = performance.now();
    assert.throws(() => rememberGuardedMcpReply(f.paths, id, PARENT), /guarded-reply-provenance-unavailable/);
    assert.ok(performance.now() - started < 2500, "bounded contention");
    const after = fs.lstatSync(f.lock);
    assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(wasGuardedMcpReply(f.paths, id), false);
    assert.deepEqual(fs.readdirSync(f.dir), [path.basename(f.lock)]);
    if (kind === "directory") {
      assert.throws(() => withRecordLock(f.dir, INDEX, () => assert.fail("old writer entered stale-looking directory")));
      assert.equal(fs.lstatSync(f.lock).ino, before.ino);
      assert.deepEqual(fs.readdirSync(f.dir), [path.basename(f.lock)]);
    }
    // Genuine legacy returns before attempting even an unavailable capacity lock.
    assert.doesNotThrow(() => rememberGuardedMcpReply(f.paths, crypto.randomUUID(), crypto.randomUUID()));
  });
}

test("a new writer cannot enter an actual old file-lock owner's callback", (t) => {
  const f = fixture(t);
  withRecordLock(f.dir, INDEX, () => {
    const bytes = fs.readFileSync(f.lock, "utf8"), ino = fs.lstatSync(f.lock).ino;
    assert.throws(() => rememberGuardedMcpReply(f.paths, crypto.randomUUID(), PARENT), /guarded-reply-provenance-unavailable/);
    assert.equal(fs.readFileSync(f.lock, "utf8"), bytes); assert.equal(fs.lstatSync(f.lock).ino, ino);
  });
  assert.equal(fs.existsSync(f.lock), false);
});

test("release never recursively removes an unexpected nonempty owner directory", (t) => {
  const f = fixture(t), original = fs.writeFileSync;
  fs.writeFileSync = function (...args: Parameters<typeof original>) {
    if (typeof args[0] === "string" && path.dirname(args[0]) === f.dir && args[0].endsWith(".tmp")) {
      Reflect.apply(original, fs, [path.join(f.lock, "foreign"), "synthetic foreign entry"]);
    }
    return Reflect.apply(original, fs, args);
  } as typeof original;
  try {
    assert.throws(() => rememberGuardedMcpReply(f.paths, crypto.randomUUID(), PARENT), { code: 'ENOTEMPTY' });
    assert.equal(fs.readFileSync(path.join(f.lock, "foreign"), "utf8"), "synthetic foreign entry");
  } finally { fs.writeFileSync = original; }
});

test("owner releases its directory after marker failure and leaves a replaced entry untouched", (t) => {
  const f = fixture(t), original = fs.writeFileSync;
  let replace = false;
  fs.writeFileSync = function (...args: Parameters<typeof original>) {
    if (typeof args[0] === "string" && path.dirname(args[0]) === f.dir && args[0].endsWith(".tmp")) {
      if (replace) {
        fs.renameSync(f.lock, `${f.lock}.owned`); fs.mkdirSync(f.lock);
      }
      throw new Error("synthetic marker write failure");
    }
    return Reflect.apply(original, fs, args);
  } as typeof original;
  try {
    assert.throws(() => rememberGuardedMcpReply(f.paths, crypto.randomUUID(), PARENT), /synthetic marker write failure/);
    assert.equal(fs.existsSync(f.lock), false);
    replace = true;
    assert.throws(() => rememberGuardedMcpReply(f.paths, crypto.randomUUID(), PARENT), /guarded-reply-provenance-unavailable/);
    assert.ok(fs.lstatSync(f.lock).isDirectory()); assert.ok(fs.lstatSync(`${f.lock}.owned`).isDirectory());
  } finally { fs.writeFileSync = original; }
});
