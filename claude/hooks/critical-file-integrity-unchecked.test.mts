#!/usr/bin/env node
// Issue #965: critical-file-integrity.mts on files it can neither prove healthy nor broken. A
// directory where a git hook belongs and a hook below a regular file are UNCHECKED with their
// reason; a source missing from the checkout makes the comparison impossible, so nothing is
// claimed; a journal that cannot be written never stops a restore. Throwaway homes only: the
// hook runs as `node <hook>.mts` with CLAUDE_HOME, HOME and USERPROFILE inside the mkdtemp tree.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const HOOK = path.join(import.meta.dirname, "critical-file-integrity.mts");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "critical-file-unchecked-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GOOD = "#!/usr/bin/env bash\n# fixture git hook\nexit 0\n";
const FILES = ["commit-msg", "post-checkout", "pre-push", "attribution-record.mts"];
let seq = 0;

interface Box { claude: string; githooks: string; source: string; workspace: string }

// Every critical file live and versioned with the same bytes; a case then breaks one thing.
function sandbox(): Box {
  const root = path.join(TMP, `case-${++seq}`);
  const claude = path.join(root, "home", ".claude");
  const workspace = path.join(root, "ws");
  const box = { claude, githooks: path.join(claude, "kherep", "githooks"), source: path.join(workspace, "kherep", "claude", "kherep", "githooks"), workspace };
  fs.mkdirSync(path.join(workspace, "kherep", "claude", "hooks"), { recursive: true });
  fs.mkdirSync(box.source, { recursive: true });
  fs.mkdirSync(box.githooks, { recursive: true });
  for (const name of FILES) {
    fs.writeFileSync(path.join(box.source, name), GOOD);
    fs.writeFileSync(path.join(box.githooks, name), GOOD);
  }
  return box;
}

function lines(box: Box): string[] {
  const home = path.dirname(box.claude);
  const run = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: "SessionStart", cwd: box.workspace }), encoding: "utf8",
    env: { ...process.env, CLAUDE_HOME: box.claude, HOME: home, USERPROFILE: home, KHEREP_WORKSPACE: box.workspace }, windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  if (!run.stdout.trim()) return [];
  return String(JSON.parse(run.stdout).hookSpecificOutput.additionalContext).split("\n").slice(1).map((line) => line.replace(/^ {2}- /, ""));
}

test("a directory where commit-msg belongs is UNCHECKED, neither healthy nor broken", () => {
  const box = sandbox();
  fs.rmSync(path.join(box.githooks, "commit-msg"));
  fs.mkdirSync(path.join(box.githooks, "commit-msg"));
  assert.deepEqual(lines(box), ["kherep/githooks/commit-msg: UNCHECKED - not a regular file. Neither proven healthy nor proven broken."]);
});

test("git hooks below a regular file fail their stat with the error code only", () => {
  const box = sandbox();
  fs.rmSync(box.githooks, { recursive: true });
  fs.writeFileSync(box.githooks, "not a directory\n");
  // POSIX stat below a regular file fails with ENOTDIR; Windows answers ENOENT, so the hook
  // takes the files as missing and the restore then fails with EEXIST at the blocking file.
  const expected = process.platform === "win32"
    ? FILES.map((name) => new RegExp(`^kherep/githooks/${name.replace(".", "\\.")}: wired but not present on disk -> NOT restored \\(copy failed \\(EEXIST\\)\\)\\. .+ IS OFF\\.$`))
    : FILES.map((name) => new RegExp(`^kherep/githooks/${name.replace(".", "\\.")}: UNCHECKED - stat failed \\(ENOTDIR\\)\\. Neither proven healthy nor proven broken\\.$`));
  const got = lines(box);
  assert.equal(got.length, expected.length);
  got.forEach((line, i) => assert.match(String(line), expected[i]));
});

test("a live file whose versioned source is missing is not compared and not reported", () => {
  const box = sandbox();
  fs.writeFileSync(path.join(box.githooks, "pre-push"), "#!/usr/bin/env bash\n# changed live\n");
  fs.rmSync(path.join(box.source, "pre-push"));
  assert.deepEqual(lines(box), []);
});

test("a journal that cannot be written does not stop the restore or its report", () => {
  const box = sandbox();
  fs.writeFileSync(path.join(box.githooks, "commit-msg"), "");
  fs.writeFileSync(path.join(box.claude, ".cache"), "a file where the cache directory belongs\n");
  const [line, ...rest] = lines(box);
  assert.match(String(line), /^kherep\/githooks\/commit-msg: 0 bytes .* -> RESTORED from the repo, verified at the target \(sha256 [0-9a-f]{12}\)$/);
  assert.deepEqual(rest, []);
  assert.equal(fs.readFileSync(path.join(box.githooks, "commit-msg"), "utf8"), GOOD);
  assert.equal(fs.statSync(path.join(box.claude, ".cache")).isFile(), true);
});
