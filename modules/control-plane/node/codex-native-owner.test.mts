import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nodePaths } from "./config.mts";
import { recordLockFile } from "./inbox-record-lock.mts";
import { releaseNativeOwner, reserveNativeOwner } from "./codex-native-pending.mts";
const OWNER = "00000000-0000-4000-8000-000000000706", ID = "00000000-0000-4000-8000-000000000707";
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-owner-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root), dir = path.join(paths.dir, "codex-native-pending"); fs.mkdirSync(dir, { recursive: true });
  return { paths, dir, lock: recordLockFile(dir, OWNER), file: path.join(dir, `${OWNER}.json`) };
}
const modern = () => JSON.stringify({ version: 1, pid: 4242, startedAt: new Date(0).toISOString(), owner: "synthetic-owner-token" });
for (const kind of ["legacy", "empty", "corrupt", "live", "reused", "unknown"]) test(`reservation AND release fence ${kind} at exact leading-dot mutex`, t => {
  const f = fixture(t), bytes = kind === "legacy" ? JSON.stringify({ pid: process.pid, at: new Date(0).toISOString() })
    : kind === "empty" ? "" : kind === "corrupt" ? "{" : modern();
  fs.writeFileSync(f.lock, bytes); fs.utimesSync(f.lock, 0, 0);
  t.mock.method(process, "kill", (() => {
    if (kind === "unknown") throw Object.assign(Error("synthetic unknown"), { code: "EPERM" }); return true;
  }) as typeof process.kill);
  assert.throws(() => reserveNativeOwner(f.paths, OWNER, [ID]));
  assert.equal(fs.existsSync(f.file), false); assert.equal(fs.readFileSync(f.lock, "utf8"), bytes);
  fs.writeFileSync(f.file, JSON.stringify({ version: 1, owner: OWNER, messageIds: [ID] }));
  assert.throws(() => releaseNativeOwner(f.paths, OWNER, [ID]));
  assert.equal(fs.existsSync(f.file), true); assert.equal(fs.readFileSync(f.lock, "utf8"), bytes);
  assert.equal(fs.existsSync(`${f.file}.lock`), false, "no second mutex without leading dot");
});
test("positive absence reclaims on both paths, default process inventory probe is never needed", t => {
  const f = fixture(t); let probes = 0;
  t.mock.method(process, "kill", (() => { probes++; throw Object.assign(Error("synthetic absent"), { code: "ESRCH" }); }) as typeof process.kill);
  fs.writeFileSync(f.lock, modern()); assert.equal(reserveNativeOwner(f.paths, OWNER, [ID]), true);
  fs.writeFileSync(f.lock, modern()); releaseNativeOwner(f.paths, OWNER, [ID]);
  assert.equal(fs.existsSync(f.file), false); assert.ok(probes >= 4); assert.equal(fs.existsSync(f.lock), false);
});
test("same-path recursive reclaim remains bounded, leaves unresolved bytes untouched", t => {
  const f = fixture(t); let probes = 0;
  t.mock.method(process, "kill", (() => { probes++; throw Object.assign(Error("gone"), { code: "ESRCH" }); }) as typeof process.kill);
  for (let n = 0; n < 6; n++) fs.writeFileSync(f.lock + ".reclaim".repeat(n), modern());
  assert.throws(() => reserveNativeOwner(f.paths, OWNER, [ID])); assert.ok(probes <= 24);
  assert.equal(fs.readdirSync(f.dir).length, 6);
});
test("successor token survives delayed release on reserve and no-submit release paths", t => {
  for (const releasePath of [false, true]) {
    const f = fixture(t); if (releasePath) assert.equal(reserveNativeOwner(f.paths, OWNER, [ID]), true);
    const read = fs.readFileSync; let replaced = false;
    t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof read>) => {
      if (args[0] === f.lock && !replaced) { replaced = true; fs.writeFileSync(f.lock, modern()); }
      return Reflect.apply(read, fs, args);
    }) as typeof read);
    if (releasePath) releaseNativeOwner(f.paths, OWNER, [ID]); else assert.equal(reserveNativeOwner(f.paths, OWNER, [ID]), true);
    t.mock.restoreAll(); assert.equal(fs.readFileSync(f.lock, "utf8"), modern());
    assert.equal(replaced, true);
    t.mock.method(process, "kill", (() => true) as typeof process.kill);
    assert.throws(() => releaseNativeOwner(f.paths, OWNER, [ID]), "delayed/double release cannot remove successor");
    assert.equal(fs.readFileSync(f.lock, "utf8"), modern());
  }
});
