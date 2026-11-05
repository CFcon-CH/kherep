import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { auditRepository } from "./publication-audit.mts";
import { exportRevision } from "./public-export.mts";
import { checkCommits } from "./pr-commit-policy.mts";
import { captureSourceIdentity } from "../modules/control-plane/node/daemon-source.mts";
import { handleAttributionHook } from "../modules/control-plane/node/attribution-hook.mts";
import { nodePaths } from "../modules/control-plane/node/config.mts";
import { defaultBranch, judge } from "../claude/hooks/lib/main-checkout.mts";
import { runCodex } from "../codex/lib/codex-cli.mts";

test("missing trusted tools preserve CLI errors and hook fail-soft results", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trusted-callers-"));
  const previous = process.env.PATH;
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    fs.rmSync(root, { recursive: true, force: true }); });
  process.env.PATH = ".";
  assert.equal(checkCommits({ base: "HEAD", head: "HEAD", cwd: root }).code, 2);
  assert.throws(() => exportRevision(root, "HEAD", path.join(root, "out")), { code: "ENOENT" });
  assert.throws(() => auditRepository(root, []), { code: "ENOENT" });
  assert.throws(() => captureSourceIdentity(root), /source identity unavailable/);
  assert.throws(() => runCodex(["--version"], { cwd: root }), { code: "ENOENT" });
  assert.equal(defaultBranch(root), null);
  assert.deepEqual(judge({ dir: root, verb: "switch", ref: "feature", command: "git switch feature" },
    { KHEREP_WORKSPACE: root }), { action: "pass" });
  const paths = nodePaths(root);
  handleAttributionHook({ hook_event_name: "PreToolUse", session_id: "01a00000-0000-7000-8000-000000000001", cwd: root,
    tool_name: "shell_command", tool_input: { command: "git push origin main" } }, "codex",
  { paths, env: { KHEREP_WORKSPACE: root } });
  assert.equal(fs.existsSync(paths.attributionPending), false);
  const planted = path.join(root, process.platform === "win32" ? "codex.exe" : "codex");
  if (process.platform === "win32") fs.copyFileSync(process.execPath, planted);
  else fs.writeFileSync(planted, "#!/bin/sh\nprintf planted\n", { mode: 0o755 });
  process.env.PATH = root;
  assert.throws(() => runCodex(["--version"], { cwd: root }), { code: "ENOENT" }, "exclude the spawn cwd, not only the parent cwd");
});
