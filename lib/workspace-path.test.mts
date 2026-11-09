import assert from "node:assert/strict";
import test from "node:test";

import { nativeWorkspacePath } from "./workspace-path.mts";
import { nativeWorkspacePath as localInferenceCopy } from "../modules/local-inference/lib/profile.mts";

const CASES: Array<[string, string, string]> = [
  // [input, win32 result, posix result]
  ["/d/Workspaces", "D:\\Workspaces", "/d/Workspaces"],
  ["/c/Users/example/Kherep", "C:\\Users\\example\\Kherep", "/c/Users/example/Kherep"],
  ["/d", "D:\\", "/d"],
  ["/d/", "D:\\", "/d/"],
  ["D:/Workspaces", "D:/Workspaces", "D:/Workspaces"],
  ["D:\\Workspaces", "D:\\Workspaces", "D:\\Workspaces"],
  ["/ws", "/ws", "/ws"],
  ["/tmp/work", "/tmp/work", "/tmp/work"],
  ["//server/share", "//server/share", "//server/share"],
  ["relative/dir", "relative/dir", "relative/dir"],
];

test("win32 converts an MSYS drive path to the native drive form", () => {
  for (const [input, win32] of CASES) {
    assert.equal(nativeWorkspacePath(input, "win32"), win32, input);
  }
});

test("posix hosts leave every value unchanged", () => {
  for (const platform of ["linux", "darwin"]) {
    for (const [input, , posix] of CASES) {
      assert.equal(nativeWorkspacePath(input, platform), posix, `${platform}: ${input}`);
    }
  }
});

// The local-inference lib is projected on its own, so it carries a copy of the
// helper. This keeps the copy from drifting.
test("the local-inference copy behaves like the shared helper", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    for (const [input] of CASES) {
      assert.equal(localInferenceCopy(input, platform), nativeWorkspacePath(input, platform), `${platform}: ${input}`);
    }
  }
});

test("local-inference resolves an MSYS drive workspace on Windows", { skip: process.platform !== "win32" }, async () => {
  const { portablePaths } = await import("../modules/local-inference/lib/profile.mts");
  assert.equal(portablePaths("win", { KHEREP_WORKSPACE: "/d/Work", HOME: "C:\\Users\\example" }).workspace, "D:\\Work");
});
