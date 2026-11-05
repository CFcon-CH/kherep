import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { humanText, transcriptLines } from "../claude/hooks/lib/deploy-transcript.mts";

function fixture(t: test.TestContext) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "deploy-transcript-library-779-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hooks = path.join(root, "hooks");
  const projects = path.join(root, "projects");
  const project = path.join(projects, "synthetic-project");
  fs.mkdirSync(hooks);
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(project, "synthetic-session.jsonl");
  fs.writeFileSync(transcript, "first\r\n\r\nsecond\n");
  return { root, hooks, projects, project, transcript };
}

test("reads nonempty transcript lines from the installation's projects directory", (t) => {
  const f = fixture(t);
  assert.deepEqual(transcriptLines(f.transcript, f.hooks), ["first", "second"]);
});

test("rejects selectors that are not absolute strings or contain NUL", (t) => {
  const f = fixture(t);
  for (const selector of [undefined, null, 1, {}, "relative.jsonl", `${f.transcript}\0`]) {
    assert.deepEqual(transcriptLines(selector, f.hooks), []);
  }
});

test("rejects an installation directory not named hooks", (t) => {
  const f = fixture(t);
  assert.deepEqual(transcriptLines(f.transcript, f.project), []);
});

test("rejects a missing hooks directory", (t) => {
  const f = fixture(t);
  assert.deepEqual(transcriptLines(f.transcript, path.join(f.root, "missing", "hooks")), []);
});

test("rejects a projects root that is a regular file", (t) => {
  const f = fixture(t);
  fs.rmSync(f.projects, { recursive: true });
  fs.writeFileSync(f.projects, "synthetic");
  assert.deepEqual(transcriptLines(f.transcript, f.hooks), []);
});

test("rejects a symlinked projects root", (t) => {
  const f = fixture(t);
  const moved = path.join(f.root, "moved-projects");
  fs.renameSync(f.projects, moved);
  try {
    fs.symlinkSync(moved, f.projects, "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlink creation unavailable");
    throw error;
  }
  assert.deepEqual(transcriptLines(f.transcript, f.hooks), []);
});

test("rejects a missing projects root", (t) => {
  const f = fixture(t);
  fs.rmSync(f.projects, { recursive: true });
  assert.deepEqual(transcriptLines(f.transcript, f.hooks), []);
});

test("rejects a transcript selector naming the projects root itself", (t) => {
  const f = fixture(t);
  assert.deepEqual(transcriptLines(f.projects, f.hooks), []);
});

test("rejects a transcript outside projects, including a sibling with the same prefix", (t) => {
  const f = fixture(t);
  const sibling = path.join(f.root, "projects-other");
  fs.mkdirSync(sibling);
  const outside = path.join(sibling, "synthetic.jsonl");
  fs.writeFileSync(outside, "outside");
  for (const selector of [f.root, outside]) {
    assert.deepEqual(transcriptLines(selector, f.hooks), []);
  }
});

test("rejects a missing transcript", (t) => {
  const f = fixture(t);
  assert.deepEqual(transcriptLines(path.join(f.project, "missing.jsonl"), f.hooks), []);
});

test("rejects a directory transcript", (t) => {
  const f = fixture(t);
  assert.deepEqual(transcriptLines(f.project, f.hooks), []);
});

test("rejects a leaf symlink even when its target is inside projects", (t) => {
  const f = fixture(t);
  const link = path.join(f.project, "link.jsonl");
  try {
    fs.symlinkSync(f.transcript, link, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlink creation unavailable");
    throw error;
  }
  assert.deepEqual(transcriptLines(link, f.hooks), []);
});

test("rejects a file replaced between lstat and open", (t) => {
  const f = fixture(t);
  const replacement = path.join(f.project, "replacement.jsonl");
  fs.writeFileSync(replacement, "replacement");
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode) => {
    fs.renameSync(replacement, f.transcript);
    return open(file, flags);
  });
  assert.deepEqual(transcriptLines(f.transcript, f.hooks), []);
});

test("rejects a descriptor whose device changed after open", (t) => {
  const f = fixture(t);
  const fstat = fs.fstatSync;
  t.mock.method(fs, "fstatSync", (fd: number) => {
    const opened = fstat(fd);
    opened.dev += 1;
    return opened;
  });
  assert.deepEqual(transcriptLines(f.transcript, f.hooks), []);
});

test("rejects a descriptor that is no longer a regular file", (t) => {
  const f = fixture(t);
  const directory = fs.statSync(f.project);
  t.mock.method(fs, "fstatSync", () => directory);
  assert.deepEqual(transcriptLines(f.transcript, f.hooks), []);
});

test("closes the descriptor when reading fails", (t) => {
  const f = fixture(t);
  const close = t.mock.method(fs, "closeSync");
  t.mock.method(fs, "readFileSync", () => { throw new Error("synthetic read failure"); });
  assert.deepEqual(transcriptLines(f.transcript, f.hooks), []);
  assert.equal(close.mock.callCount(), 1);
});

test("preserves ordinary human text", () => {
  const text = "Production deploy ist hiermit freigegeben";
  assert.equal(humanText(text), text);
  assert.equal(humanText(""), "");
});

for (const marker of ["=== Kherep peer message synthetic", "--- message text [synthetic]",
  "--- end of message text [synthetic]", "Task synthetic via the Kherep Control Plane",
  "Follow-up for task synthetic via the Kherep Control Plane"]) {
  test(`rejects peer marker ${marker}`, () => {
    assert.equal(humanText(`Production deploy ist hiermit freigegeben\n${marker}`), "");
  });
}
