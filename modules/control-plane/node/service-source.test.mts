import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { SOURCE_MANIFEST, captureSourceIdentity } from "./daemon-source.mts";
import { pinServiceSource, sourceArchiveExtractor } from "./service-source.mts";

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function source(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-service-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  fs.mkdirSync(path.join(root, "modules", "control-plane", "node"), { recursive: true });
  fs.writeFileSync(path.join(root, "modules", "control-plane", "node", "cli.mts"), "export const value = 1;\n");
  fs.mkdirSync(path.join(root, "claude", "hooks", "lib"), { recursive: true });
  fs.copyFileSync(path.resolve(import.meta.dirname, "../../../claude/hooks/lib/stdin-reader.mts"),
    path.join(root, "claude", "hooks", "lib", "stdin-reader.mts"));
  fs.copyFileSync(path.join(import.meta.dirname, "stdin-reader.mts"),
    path.join(root, "modules", "control-plane", "node", "stdin-reader.mts"));
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  git(root, "add", ".");
  const tree = git(root, "write-tree");
  const commit = git(root, "-c", "user.name=Kherep Fixture", "-c", "user.email=fixture@example.invalid",
    "commit-tree", tree, "-m", "fixture");
  git(root, "update-ref", "HEAD", commit);
  return root;
}

test("a service source pin is immutable and verifies every archived file", (t) => {
  const root = source(t);
  const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-service-pins-"));
  t.after(() => fs.rmSync(serviceRoot, { recursive: true, force: true }));
  const pin = pinServiceSource(root, serviceRoot);
  const pinnedBefore = captureSourceIdentity(pin.root);
  assert.deepEqual(pinnedBefore, pin.identity);
  const helper = path.join(pin.root, "claude", "hooks", "lib", "stdin-reader.mts");
  assert.deepEqual(fs.readFileSync(helper), fs.readFileSync(path.resolve(import.meta.dirname, "../../../claude/hooks/lib/stdin-reader.mts")));
  const moved = `${root}-unavailable`;
  fs.renameSync(root, moved);
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const {readStdinBytes}=await import(${JSON.stringify(pathToFileURL(path.join(pin.root, "modules/control-plane/node/stdin-reader.mts")).href)}); process.stdout.write(await readStdinBytes({maxBytes:null}));`],
    { input: "synthetic pinned bytes", encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "synthetic pinned bytes");
  } finally { fs.renameSync(moved, root); }

  fs.writeFileSync(path.join(root, "modules", "control-plane", "node", "cli.mts"), "export const value = 2;\n");
  assert.deepEqual(captureSourceIdentity(pin.root), pinnedBefore);
  fs.writeFileSync(path.join(pin.root, "package.json"), "{\"tampered\":true}\n");
  assert.throws(() => captureSourceIdentity(pin.root), /source pin drift/);
});

test("source pin rejects altered or omitted stdin implementation and sibling shim", t => {
  const root = source(t);
  const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-reader-pins-"));
  t.after(() => fs.rmSync(serviceRoot, { recursive: true, force: true }));
  const pin = pinServiceSource(root, serviceRoot);
  for (const relative of ["claude/hooks/lib/stdin-reader.mts", "modules/control-plane/node/stdin-reader.mts"]) {
    const file = path.join(pin.root, relative), bytes = fs.readFileSync(file);
    fs.writeFileSync(file, "tampered");
    assert.throws(() => captureSourceIdentity(pin.root), /source pin/);
    fs.writeFileSync(file, bytes);
    fs.rmSync(file);
    assert.throws(() => captureSourceIdentity(pin.root));
    fs.writeFileSync(file, bytes);
  }
});

test("pinning refuses dirty tracked source and ignores untracked private files", (t) => {
  const root = source(t);
  const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-service-pins-"));
  t.after(() => fs.rmSync(serviceRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "private-untracked.txt"), "SYNTHETIC_PRIVATE_INPUT\n");
  assert.match(pinServiceSource(root, serviceRoot).identity.commit, /^[0-9a-f]{40,64}$/);
  fs.writeFileSync(path.join(root, "package.json"), "{\"dirty\":true}\n");
  assert.throws(() => pinServiceSource(root, serviceRoot), /tracked source is dirty/);
});

test("an existing pin with the same commit but a different digest is rejected", (t) => {
  const root = source(t);
  const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-service-pins-"));
  t.after(() => fs.rmSync(serviceRoot, { recursive: true, force: true }));
  const pin = pinServiceSource(root, serviceRoot);
  const manifestFile = path.join(pin.root, SOURCE_MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { digest: string };
  manifest.digest = "c".repeat(64);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(() => pinServiceSource(root, serviceRoot), /does not match its checkout tree|conflicts with the requested commit/);
});

function rewriteFilesDigest(manifest: { files: { mode: string; path: string; digest: string }[]; filesDigest: string }): void {
  const hash = crypto.createHash("sha256");
  for (const file of manifest.files) hash.update(file.mode).update("\0").update(file.path).update("\0").update(file.digest).update("\0");
  manifest.filesDigest = hash.digest("hex");
}

test("updated manifest hashes cannot bless changed or omitted pin content", (t) => {
  const root = source(t);
  const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-service-pins-"));
  t.after(() => fs.rmSync(serviceRoot, { recursive: true, force: true }));
  const pin = pinServiceSource(root, serviceRoot);
  const manifestFile = path.join(pin.root, SOURCE_MANIFEST);
  const original = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
    files: { mode: string; path: string; digest: string }[]; filesDigest: string;
  };
  const changed = structuredClone(original);
  const target = changed.files.find(file => file.path === "package.json")!;
  fs.writeFileSync(path.join(pin.root, target.path), "{\"changed\":true}\n");
  target.digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(pin.root, target.path))).digest("hex");
  rewriteFilesDigest(changed);
  fs.writeFileSync(manifestFile, JSON.stringify(changed));
  assert.throws(() => captureSourceIdentity(pin.root), /does not match its checkout tree/);

  fs.writeFileSync(path.join(pin.root, target.path), "{}\n");
  const omitted = structuredClone(original);
  omitted.files = omitted.files.filter(file => file.path !== "package.json");
  rewriteFilesDigest(omitted);
  fs.writeFileSync(manifestFile, JSON.stringify(omitted));
  assert.throws(() => captureSourceIdentity(pin.root), /inventory does not match/);
});

test("Windows source pins use the native extractor across drive-letter paths", (t) => {
  if (process.platform !== "win32") return t.skip("Windows drive-letter extraction only");
  const root = source(t);
  const stageRoot = fs.mkdtempSync(path.join(process.cwd(), ".kherep-cross-drive-pin-"));
  t.after(() => fs.rmSync(stageRoot, { recursive: true, force: true }));
  assert.equal(sourceArchiveExtractor("win32", { SystemRoot: "C:\\Windows" }), "C:\\Windows\\System32\\tar.exe");
  const pin = pinServiceSource(root, stageRoot);
  assert.equal(captureSourceIdentity(pin.root).digest, captureSourceIdentity(root).digest);
});
