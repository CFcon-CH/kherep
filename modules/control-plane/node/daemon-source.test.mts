import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SOURCE_MANIFEST, captureSourceIdentity, compareSourceIdentity, createSourceManifest } from "./daemon-source.mts";

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function checkout(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-daemon-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  fs.mkdirSync(path.join(root, "modules", "control-plane", "node"), { recursive: true });
  fs.writeFileSync(path.join(root, "modules", "control-plane", "node", "daemon.mts"), "export const revision = 1;\n");
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  git(root, "add", ".");
  const tree = git(root, "write-tree");
  const commit = git(root, "-c", "user.name=Kherep Fixture", "-c", "user.email=fixture@example.invalid",
    "commit-tree", tree, "-m", "fixture");
  git(root, "update-ref", "HEAD", commit);
  return root;
}

test("startup source identity stays immutable after the checkout advances", (t) => {
  const root = checkout(t);
  const startup = captureSourceIdentity(root);
  fs.writeFileSync(path.join(root, "modules", "control-plane", "node", "daemon.mts"), "export const revision = 2;\n");
  git(root, "add", ".");
  const tree = git(root, "write-tree");
  const commit = git(root, "-c", "user.name=Kherep Fixture", "-c", "user.email=fixture@example.invalid",
    "commit-tree", tree, "-p", startup.commit, "-m", "advance");
  git(root, "update-ref", "HEAD", commit);

  assert.equal(startup.commit === commit, false);
  assert.deepEqual(startup, { ...startup }, "the recorded object is not recomputed from the advanced checkout");
  assert.deepEqual(compareSourceIdentity(startup, captureSourceIdentity(root)), { status: "mismatch", reason: "commit" });
});

test("source identity ignores untracked private input but reports tracked modifications as unknown", (t) => {
  const root = checkout(t);
  const clean = captureSourceIdentity(root);
  fs.writeFileSync(path.join(root, "private-untracked.txt"), "SYNTHETIC_PRIVATE_INPUT\n");
  assert.deepEqual(captureSourceIdentity(root), clean);
  fs.writeFileSync(path.join(root, "package.json"), "{\"changed\":true}\n");
  assert.throws(() => captureSourceIdentity(root), /tracked source is dirty/);
});

test("a source pin rejects a symbolic link before following its target", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-symlink-pin-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-symlink-target-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(outside, "private.txt"), "SYNTHETIC_PRIVATE_INPUT\n");
  try { fs.symlinkSync(outside, path.join(root, "escape"), "junction"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("Windows symlink privilege is unavailable");
    throw error;
  }
  fs.writeFileSync(path.join(root, SOURCE_MANIFEST), JSON.stringify({ version: 1, commit: "a".repeat(40), digest: "b".repeat(64),
    filesDigest: "c".repeat(64), files: [{ path: "escape", mode: "100644", digest: "d".repeat(64) }] }));
  assert.throws(() => captureSourceIdentity(root), /do not support symbolic links/);
});

function pin(t: test.TestContext): string {
  const source = checkout(t);
  const identity = captureSourceIdentity(source);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-source-pin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(source, "modules"), path.join(root, "modules"), { recursive: true });
  fs.copyFileSync(path.join(source, "package.json"), path.join(root, "package.json"));
  fs.writeFileSync(path.join(root, SOURCE_MANIFEST), JSON.stringify(createSourceManifest(source, root, identity.commit, identity.digest)));
  return root;
}

function outsideReads(t: test.TestContext, outside: string): string[] {
  const reads: string[] = [];
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof original>) => {
    const bytes = original(...args);
    if (typeof args[0] === "string" && fs.realpathSync.native(args[0]).startsWith(`${fs.realpathSync.native(outside)}${path.sep}`)) {
      reads.push("outside synthetic target read");
    }
    return bytes;
  }) as typeof original);
  return reads;
}

test("a regular source pin still verifies its archived bytes", (t) => {
  const root = pin(t);
  const result = captureSourceIdentity(root);
  assert.equal(result.root, fs.realpathSync.native(root));
  assert.equal(result.kind, "pin");
  assert.equal(result.verified, true);
});

for (const redirect of ["manifest", "inventory parent"] as const) {
  test(`a linked ${redirect} refuses before any outside payload read`, (t) => {
    const root = pin(t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-source-outside-"));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const manifestPath = path.join(root, SOURCE_MANIFEST);
    if (redirect === "manifest") {
      fs.renameSync(manifestPath, path.join(outside, "manifest.json"));
      try { fs.symlinkSync(path.join(outside, "manifest.json"), manifestPath, "file"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlink creation unavailable");
        throw error;
      }
    } else {
      const bytes = "synthetic outside payload\n";
      fs.writeFileSync(path.join(outside, "payload.txt"), bytes);
      try { fs.symlinkSync(outside, path.join(root, "redirect"), "junction"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlink creation unavailable");
        throw error;
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.files.push({ path: "redirect/payload.txt", mode: "100644", digest: createHash("sha256").update(bytes).digest("hex") });
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    }
    const reads = outsideReads(t, outside);
    let refusal: unknown;
    try { captureSourceIdentity(root); } catch (error) { refusal = error; }
    assert.deepEqual(reads, [], "a later parser/inventory error must not conceal an outside read");
    assert.match(String(refusal), /symbolic links|escapes its root/);
  });
}
