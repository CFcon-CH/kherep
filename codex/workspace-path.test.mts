import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveWorkspace } from "./install.mts";

// Issue #75. A Git Bash workspace value reached path.resolve unchanged and
// became D:\d\Workspaces on Windows.
test("resolveWorkspace turns an MSYS drive path into the Windows drive", { skip: process.platform !== "win32" }, () => {
  assert.equal(resolveWorkspace({ workspace: "/d/Workspaces" }, "win32"), "D:\\Workspaces");
  assert.equal(resolveWorkspace({ workspace: "D:/Workspaces" }, "win32"), "D:\\Workspaces");
});

test("resolveWorkspace keeps a POSIX workspace on a POSIX host", { skip: process.platform === "win32" }, () => {
  assert.equal(resolveWorkspace({ workspace: "/d/Workspaces" }, process.platform), "/d/Workspaces");
});

test("resolveWorkspace still resolves an ordinary workspace", () => {
  const workspace = path.resolve("kherep-workspace-fixture");
  assert.equal(resolveWorkspace({ workspace }), workspace);
});
