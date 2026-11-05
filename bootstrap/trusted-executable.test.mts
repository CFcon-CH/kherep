import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findTrustedExecutable, fullyQualifiedPath, requireTrustedExecutable } from "../claude/hooks/lib/trusted-executable.mts";

test("POSIX searches absolute directories only, preserving order and executable access", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trusted-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, "first"), second = path.join(root, "second");
  fs.mkdirSync(first); fs.mkdirSync(second);
  fs.writeFileSync(path.join(first, "git"), "not executable", { mode: 0o644 });
  fs.writeFileSync(path.join(second, "git"), "#!/bin/sh\n", { mode: 0o755 });
  if (process.platform !== "win32") {
    assert.equal(findTrustedExecutable("git", { platform: "linux", env: { PATH: `:.:relative:${first}:${second}:` } }), path.join(second, "git"));
    assert.equal(findTrustedExecutable("git", { platform: "linux", env: { PATH: first } }), null);
  }
  const checked: string[] = [];
  assert.equal(findTrustedExecutable("git", { platform: "linux", env: { PATH: ":.:relative:/trusted:" },
    isExecutable(file) { checked.push(file); return true; } }), "/trusted/git");
  assert.deepEqual(checked, ["/trusted/git"]);
  assert.equal(findTrustedExecutable("git", { platform: "linux", cwd: "/trusted", env: { PATH: "/trusted\\" },
    isExecutable: () => true }), "/trusted\\/git", "POSIX backslash is a filename character");
});

test("Windows skips cwd, empty, relative, drive-relative and rooted PATH entries", () => {
  const checked: string[] = [];
  const command = findTrustedExecutable("git", { platform: "win32", env: {
    Path: ';.;relative;C:tools;\\tools;"C:\\Trusted Tools";\\\\server\\share\\tools;', Pathext: ".EXE;.CMD",
  }, isExecutable(file) { checked.push(file); return file === "\\\\server\\share\\tools\\git.exe"; } });
  assert.equal(command, "\\\\server\\share\\tools\\git.exe");
  assert.deepEqual(checked, ["C:\\Trusted Tools\\git.exe", "\\\\server\\share\\tools\\git.exe"]);
  assert.equal(fullyQualifiedPath("\\tools", "win32"), false);
  assert.equal(findTrustedExecutable("git", { platform: "win32", cwd: "C:\\Cwd\\", env: { PATH: "c:/cwd/;C:\\Alias" },
    realpath: (file) => file === "C:\\Alias" ? "C:\\Cwd" : file, isExecutable: () => true }), null);
});

test("PATHEXT is case-insensitive, filtered, deduplicated and prefers exe over shims when requested", () => {
  const env = { PATH: "C:\\Shims;C:\\Native", PATHEXT: ".CMD;.COM;.EXE;.exe;.;relative;.bad/path" };
  const isExecutable = (file: string) => ["C:\\Shims\\codex.cmd", "C:\\Native\\codex.exe", "C:\\Native\\codex.com"].includes(file);
  assert.equal(findTrustedExecutable("codex", { platform: "win32", env, isExecutable, preferNative: false }), "C:\\Shims\\codex.cmd");
  assert.equal(findTrustedExecutable("codex", { platform: "win32", env, isExecutable }), "C:\\Native\\codex.exe");
  for (const tool of ["git", "sh", "gh"]) {
    assert.equal(findTrustedExecutable(tool, { platform: "win32", env,
      isExecutable: (file) => ["C:\\Shims\\" + tool + ".cmd", "C:\\Native\\" + tool + ".exe"].includes(file) }),
    "C:\\Native\\" + tool + ".exe");
  }
  assert.equal(findTrustedExecutable("codex", { platform: "win32", env, isExecutable, preferNative: true }), "C:\\Native\\codex.exe");
  assert.equal(findTrustedExecutable("codex.exe", { platform: "win32", env, isExecutable, preferNative: true }), "C:\\Native\\codex.exe");
  assert.equal(findTrustedExecutable("codex", { platform: "win32", env: { PATH: "C:\\Shims" }, isExecutable, preferNative: true }), "C:\\Shims\\codex.cmd");
});

test("lookup never falls back to the bare name, a default cwd, or an invalid command", () => {
  for (const platform of ["linux", "win32"]) {
    for (const env of [{}, { PATH: "" }, { PATH: "." }]) {
      assert.equal(findTrustedExecutable("git", { platform, env }), null);
      assert.throws(() => requireTrustedExecutable("git", { platform, env }), { code: "ENOENT" });
    }
  }
  for (const name of ["", "../git", "a/b", "a\\b", "git;echo"]) assert.equal(findTrustedExecutable(name), null);
  assert.equal(requireTrustedExecutable("git", { platform: "linux", env: { PATH: "/bin" }, isExecutable: () => true }), "/bin/git");
  assert.equal(findTrustedExecutable("missing", { platform: "linux", env: { PATH: "/does-not-exist" } }), null);
});
