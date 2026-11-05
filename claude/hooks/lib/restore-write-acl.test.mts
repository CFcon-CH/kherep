#!/usr/bin/env node
// R5 of restore-write.mts (issue #279; moved out of restore-write.test.mts for
// issue #507, part 2): an access-control list on the target belongs to the inode,
// so an in-place write keeps it, and a write-denying one stops the write before a
// byte lands. Only the target leaf carries the ACL (../acl-fixture.mts); Windows
// runs both cases with icacls, macOS and Linux with their own tools. The W5 cases
// below change a directory instead: where an absent target's file is created, and
// whether the hooks directory may get a new name.
// Runs on its own as `node restore-write-acl.test.mts`, like every suite in CI.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ADD_FILE_DENY, applyAcl, changeDirectory, hasRule, liftAcl, lsAcl, parseWindowsSnapshot, readAcl, sameAcl, WRITE_DENY } from "../acl-fixture.mts";
import { writeExact } from "./restore-write.mts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "restore-write-acl-"));
const WANTED = Buffer.from("export const restored = 1;\n");
let seq = 0;

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test("the no-new-names experiment is owner-only and restores the original directory mode", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (t) => {
  const dir = path.join(TMP, `mode-${++seq}`);
  fs.mkdirSync(dir, { mode: 0o710 });
  const original = fs.statSync(dir).mode & 0o7777;
  await t.test("the owner can traverse but cannot publish a new name", (inner) => {
    assert.equal(changeDirectory(inner, dir, "noNewNames"), true);
    assert.equal(fs.statSync(dir).mode & 0o7777, 0o500);
    assert.throws(() => fs.writeFileSync(path.join(dir, "new"), "x"), { code: "EACCES" });
  });
  assert.equal(fs.statSync(dir).mode & 0o7777, original);
});

for (const deny of [false, true]) {
  test(`a target with ${deny ? "a write-denying" : "a restricting"} ACL keeps that ACL and its inode`, (t) => {
    const hooks = path.join(TMP, `case-${++seq}`, "hooks");
    const file = path.join(hooks, "lib", "dep.mts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "", "utf8");
    const acl = applyAcl(t, file, deny);
    if (!acl) return;
    const before = fs.statSync(file, { bigint: true });
    const result = writeExact(file, WANTED, hooks, {}, { dev: before.dev, ino: before.ino });
    assert.equal(result, deny ? `open failed (${acl.denied}); nothing was written` : "");
    sameAcl(file, acl.before);
    const after = fs.statSync(file, { bigint: true });
    assert.deepEqual([after.dev, after.ino], [before.dev, before.ino]);
    assert.equal(fs.readFileSync(file, "utf8"), deny ? "" : WANTED.toString());
    liftAcl(file);
    fs.rmSync(file);
    assert.equal(fs.existsSync(file), false, "the file can be removed after the reset");
  });
}

// The macOS reader on synthetic `ls -le` output, on every platform: a listing with ACE
// lines is a read, and another ACE is another ACL; a listing without an ACE proves
// nothing (ls prints the same for an ACL it could not read), nor does a failed or
// incomplete one.
test("an ls -le listing is a read only with its ACE lines; without one, failed or partial it is none", () => {
  const head = "-rw-r--r--@ 1 someone staff 0 Oct 19 12:00 /tmp/example\n";
  const one = lsAcl(0, `${head} 0: group:everyone allow readattr\n`);
  const two = lsAcl(0, `${head} 0: group:everyone allow readattr\n 1: group:everyone allow readextattr\n`);
  assert.ok(one !== null && two !== null, "both listings are complete reads");
  assert.ok(one !== two, "an added ACE is a different ACL");
  assert.equal(lsAcl(0, `${head.replace("@", "+")} 0: group:everyone allow readattr\n`), one, "the mode flag is not part of the ACL");
  assert.equal(lsAcl(0, head), null, "no ACE line: an empty ACL and an unread one look the same");
  assert.equal(lsAcl(1, head), null, "a failed run");
  assert.equal(lsAcl(0, ""), null, "no listing line");
  assert.equal(lsAcl(0, `${head}ls: something else\n`), null, "a line that is no ACE");
  assert.equal(lsAcl(null, head), null, "a run that never ended");
});

// The Windows snapshot on synthetic Get-Acl output, on every platform. Whether a rule of
// the current user is there comes from the access rules by SID, so an SDDL that writes
// the user as an alias (LA here) still shows it; a failed, short or inconsistent
// snapshot is none. Synthetic values only.
test("a Windows ACL snapshot finds the user's rule by SID whatever the SDDL calls it; a broken one is none", () => {
  const out = (own: string, sddl = "D:PAI(A;;0x12019f;;;LA)(A;;FR;;;BU)", prot = "True") => `${sddl}\r\n${prot}\r\n${own}\r\ninherited=0\r\n`;
  const allow = parseWindowsSnapshot(0, out("own=Allow:1180063:0"), "");
  assert.ok(allow !== null && hasRule(allow, "Allow") && !hasRule(allow, "Deny"), "the aliased user's allow rule is found");
  const deny = parseWindowsSnapshot(0, out("own=Deny:6:0", "D:AI(D;;DCLC;;;LA)(A;ID;FA;;;BA)", "False"), "");
  assert.ok(hasRule(deny, "Deny", WRITE_DENY) && !hasRule(deny, "Deny", ADD_FILE_DENY), "a deny rule counts only with its rights");
  assert.equal(parseWindowsSnapshot(3, out("own=Allow:1180063:0"), ""), null, "a failed run");
  assert.equal(parseWindowsSnapshot(0, out("own=Allow:1180063:0"), "warning"), null, "anything on stderr");
  assert.equal(parseWindowsSnapshot(0, "D:PAI(A;;FR;;;BU)\r\nTrue\r\n", ""), null, "a short snapshot");
  assert.equal(parseWindowsSnapshot(0, out("own=Allow:1180063:0", "D:AI(A;;FR;;;BU)"), ""), null, "protection that contradicts the SDDL");
  assert.equal(parseWindowsSnapshot(0, out("own=Allow"), ""), null, "a rule without its rights");
  const inheritOnly = parseWindowsSnapshot(0, out("own=Deny:6:1", "D:AI(D;OIIO;DCLC;;;LA)(A;ID;FA;;;BA)", "False"), "");
  assert.ok(inheritOnly !== null && !hasRule(inheritOnly, "Deny", WRITE_DENY), "an inherit-only rule does not act on the object");
  assert.equal(parseWindowsSnapshot(0, out("own=Allow:1180063"), ""), null, "a rule without its propagation");
  assert.equal(hasRule(null, "Allow"), false, "no snapshot, no rule");
});

const tree = (): { hooks: string; lib: string } => {
  const hooks = path.join(TMP, `case-${++seq}`, "hooks");
  fs.mkdirSync(path.join(hooks, "lib"), { recursive: true });
  return { hooks, lib: path.join(hooks, "lib") };
};

// Issue #507, part 2 (W5): an absent target is created in its own directory, so it gets
// that directory's inheritable entries, not those of the hooks directory where its
// second name lives until the publication. Both directories carry an entry of their
// own, so every compared file has an ACE (macOS cannot read an empty ACL as one).
test("a published nested file has the ACL of a file created in its own directory", (t) => {
  const { hooks, lib } = tree();
  if (!changeDirectory(t, hooks, "inheritOther") || !changeDirectory(t, lib, "inherit")) return;
  const file = path.join(lib, "dep.mts");
  assert.equal(writeExact(file, WANTED, hooks), "");
  const reference = path.join(lib, "reference.mts");
  const inRoot = path.join(hooks, "root-reference.mts");
  fs.writeFileSync(reference, "");
  fs.writeFileSync(inRoot, "");
  const [published, wanted, root] = [readAcl(file), readAcl(reference), readAcl(inRoot)];
  if (!published || !wanted || !root) assert.fail("an ACL could not be read completely");
  assert.ok(published === wanted, "the published file has the ACL a file created in its directory gets");
  assert.ok(published !== root, "and not the one a file created in the hooks directory gets");
});

// The second name needs the right to add a name to the hooks directory. Without it a
// missing file is not repaired (fail closed, before any byte); an existing one still is.
test("without the right to add a name to the hooks directory a missing file is refused, an existing one written", (t) => {
  const { hooks, lib } = tree();
  const existing = path.join(lib, "existing.mts");
  fs.writeFileSync(existing, "");
  if (!changeDirectory(t, hooks, "noNewNames")) return;
  const file = path.join(lib, "dep.mts");
  const result = writeExact(file, WANTED, hooks);
  assert.ok(/^publication failed \((EPERM|EACCES)\); the target stays absent$/.test(result), result);
  assert.equal(fs.existsSync(file), false);
  const left = (fs.readdirSync(path.dirname(hooks), { recursive: true }) as string[]).filter((name) => name.endsWith(".kherep-tmp"));
  assert.deepEqual(left, []);
  assert.equal(writeExact(existing, WANTED, hooks), "");
  assert.deepEqual(fs.readFileSync(existing), WANTED);
});
