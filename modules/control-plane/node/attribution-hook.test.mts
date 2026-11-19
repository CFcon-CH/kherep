// Issue #325, PR-A. The attribution hook: Claude and Codex PostToolUse write
// the pr-create record, because gh pr create never reaches a git hook; the
// Codex PreToolUse phase leaves a pending marker for the pre-push hook.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { readAttribution } from "./attribution.mts";
import { attributionIntents, handleAttributionHook, type AttributionHookDeps } from "./attribution-hook.mts";
import { nodePaths } from "./config.mts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-attribution-hook-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const workspace = path.join(root, "ws");
const TITLE = "synthetic secret title";
let seq = 0;

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.com", ...args],
    { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function repo(base = workspace): string {
  const dir = path.join(base, `repo-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["remote", "add", "origin", "https://user:secret-token@example.com/example/repo.git"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-q", "-m", "synthetic subject"]);
  git(dir, ["switch", "-q", "-c", "feat/pr"]);
  return dir;
}

function deps(prView: AttributionHookDeps["prView"] = () => null): AttributionHookDeps {
  return { paths: nodePaths(path.join(root, `config-${++seq}`)), env: { KHEREP_WORKSPACE: workspace }, prView };
}

const post = (cwd: string, command: string, response: unknown, tool = "Bash") => ({ hook_event_name: "PostToolUse",
  session_id: "synthetic-claude-1", cwd, tool_name: tool, tool_input: { command }, tool_response: response });

test("finds git push and gh pr create through cd, -C, quotes, shells and heredocs", () => {
  const cwd = "/synthetic/ws/a";
  const cases: [string, { kind: string; dir: string }[]][] = [
    ["git push origin feat", [{ kind: "push", dir: cwd }]],
    ["git -C ../b push", [{ kind: "push", dir: "/synthetic/ws/b" }]],
    ["cd /synthetic/ws/c && gh pr create --fill", [{ kind: "pr-create", dir: "/synthetic/ws/c" }]],
    [`bash -c "gh.exe pr create --title '${TITLE}'"`, [{ kind: "pr-create", dir: cwd }]],
    ["git status; gh pr view 12; gh pr list; git pushx", []],
    ["git commit -F - <<'EOF'\ngit push\ngh pr create\nEOF", []],
    ["echo 'git push'", []],
  ];
  for (const [command, expected] of cases) assert.deepEqual(attributionIntents(command, cwd), expected, command);
});

test("a Claude gh pr create records the PR number from the tool output", () => {
  const dir = repo();
  const d = deps(() => assert.fail("no fallback when the output names the PR"));
  handleAttributionHook(post(dir, `gh pr create --title "${TITLE}" --body x`,
    { stdout: "https://github.com/example/repo/pull/12\n", stderr: "" }), "claude", d);
  const [entry, ...rest] = readAttribution(d.paths);
  assert.equal(rest.length, 0);
  assert.deepEqual({ ...entry, ts: undefined }, { v: 1, ts: undefined, kind: "pr-create", sessionId: "synthetic-claude-1",
    runtime: "claude", sessionSource: "hook", repo: "example/repo", toplevel: git(dir, ["rev-parse", "--show-toplevel"]),
    branch: "feat/pr", remoteRef: null, sha: git(dir, ["rev-parse", "HEAD"]), pr: 12, prSource: "stdout" });
  assert.ok(!fs.readFileSync(d.paths.attribution, "utf8").includes(TITLE), "the PR title is never recorded");
});

// Windows runners hand out the temp directory as an 8.3 short path while git
// reports the long one; a workspace named either way must still match.
test("a workspace given as a Windows short path still scopes the repository", (t) => {
  if (process.platform !== "win32") return t.skip("8.3 short names exist only on Windows");
  const long = path.join(root, "long workspace name");
  fs.mkdirSync(long, { recursive: true });
  const short = spawnSync("cmd", ["/d", "/s", "/c", `"for %I in ("${long}") do @echo %~sI"`],
    { encoding: "utf8", windowsVerbatimArguments: true }).stdout.trim();
  if (!short || short.toLowerCase() === long.toLowerCase() || !fs.existsSync(short)) {
    return t.skip("this volume has no 8.3 short names");
  }
  const dir = repo(long);
  const d = { ...deps(), env: { KHEREP_WORKSPACE: short } };
  handleAttributionHook(post(dir, "gh pr create --fill", { stdout: "https://github.com/example/repo/pull/3\n" }),
    "claude", d);
  assert.equal(readAttribution(d.paths).length, 1);
});

test("without a URL in the output the gh pr view fallback names the PR", () => {
  const dir = repo();
  const seen: string[] = [];
  const d = deps((cwd) => (seen.push(cwd), { number: 34, url: "https://github.com/example/other/pull/34" }));
  handleAttributionHook(post(dir, "gh pr create --fill", { stdout: "", stderr: "" }, "PowerShell"), "claude", d);
  const [entry] = readAttribution(d.paths);
  assert.deepEqual([entry?.pr, entry?.prSource, entry?.repo], [34, "gh", "example/other"]);
  assert.equal(seen.length, 1);
});

test("an unresolved PR is recorded as null, with the origin slug and never its userinfo", () => {
  const dir = repo();
  const d = deps();
  handleAttributionHook(post(dir, "gh pr create --fill", "no url here"), "claude", d);
  const [entry] = readAttribution(d.paths);
  assert.deepEqual([entry?.pr, entry?.prSource, entry?.repo], [null, "unresolved", "example/repo"]);
  assert.ok(!fs.readFileSync(d.paths.attribution, "utf8").includes("secret-token"));
});

test("other commands, a Claude git push and repositories outside the workspace record nothing", () => {
  const inside = repo();
  const outside = repo(path.join(root, "outside"));
  const d = deps();
  handleAttributionHook(post(inside, "gh pr view 12", { stdout: "https://github.com/example/repo/pull/12" }), "claude", d);
  handleAttributionHook(post(inside, "git push origin feat/pr", { stdout: "" }), "claude", d);
  handleAttributionHook(post(outside, "gh pr create --fill", { stdout: "https://github.com/example/repo/pull/5" }), "claude", d);
  handleAttributionHook({ ...post(inside, "gh pr create", {}), tool_name: "Read" }, "claude", d);
  assert.equal(fs.existsSync(d.paths.attribution), false);
});

test("the Codex PreToolUse phase leaves a pending marker for git push and gh pr create", () => {
  const dir = repo();
  const outside = repo(path.join(root, "outside"));
  for (const command of ["git push origin feat/pr", "gh pr create --fill"]) {
    const d = deps();
    const pre = { hook_event_name: "PreToolUse", session_id: "synthetic-codex-1", cwd: dir, tool_name: "shell_command",
      tool_input: { command } };
    handleAttributionHook(pre, "claude", d);
    assert.equal(fs.existsSync(d.paths.attributionPending), false, "Claude needs no marker");
    handleAttributionHook({ ...pre, cwd: outside }, "codex", d);
    handleAttributionHook({ ...pre, session_id: "../bad" }, "codex", d);
    assert.equal(fs.existsSync(d.paths.attributionPending), false, "outside the workspace or a bad id: no marker");
    handleAttributionHook(pre, "codex", d);
    const files = fs.readdirSync(d.paths.attributionPending);
    assert.equal(files.length, 1, command);
    assert.equal(JSON.parse(fs.readFileSync(path.join(d.paths.attributionPending, files[0]!), "utf8")).sessionId,
      "synthetic-codex-1");
    assert.equal(fs.existsSync(d.paths.attribution), false, "PreToolUse writes no record");
  }
});

test("a Codex PostToolUse gh pr create records the Codex session", () => {
  const dir = repo();
  const d = deps();
  handleAttributionHook({ hook_event_name: "PostToolUse", session_id: "synthetic-codex-2", cwd: dir,
    tool_name: "exec_command", tool_input: { command: "gh pr create --fill" },
    tool_response: "https://github.com/example/repo/pull/56" }, "codex", d);
  const [entry] = readAttribution(d.paths);
  assert.deepEqual([entry?.runtime, entry?.sessionId, entry?.sessionSource, entry?.pr], ["codex", "synthetic-codex-2", "hook", 56]);
});

test("the hook entry point exits 0 without stdout on any input", () => {
  const hook = path.join(import.meta.dirname, "attribution-hook.mts");
  for (const input of ["not json", "null", JSON.stringify(post(root, "gh pr create", {}))]) {
    const run = spawnSync(process.execPath, [hook, "--runtime", "codex"], { input, encoding: "utf8",
      env: { ...process.env, KHEREP_CONFIG_DIR: path.join(root, "entry"), KHEREP_WORKSPACE: workspace } });
    assert.deepEqual([run.status, run.stdout], [0, ""], run.stderr);
  }
});

// Issue #780, PR-A: the GitHub App broker opens PRs without gh.
const BROKER = "printf '%s' \"$REQUEST\" | node tools/github-broker/github-claude.mts";
const receipt = (fields: Record<string, unknown>) => JSON.stringify({ ok: true, operationId: "550e8400-e29b-41d4-a716-446655440000",
  runtime: "claude", repository: "example/broker", ...fields, status: "verified", attribution: "bot-author", bot: "synthetic[bot]" });

test("a broker invocation is an intent of its own, in either runtime's entry point and through a pipe", () => {
  const cwd = "/synthetic/ws/a";
  assert.deepEqual(attributionIntents(BROKER, cwd), [{ kind: "broker", dir: cwd }]);
  assert.deepEqual(attributionIntents("node /x/tools/github-broker/github-codex.mts < r.json", cwd), [{ kind: "broker", dir: cwd }]);
  for (const other of ["node tools/github-broker/github-claude-credential.mts x get", "node other.mts", "echo github-claude.mts"]) {
    assert.deepEqual(attributionIntents(other, cwd), [], other);
  }
});

test("a broker pr.create receipt records the PR; other broker results record nothing", () => {
  const dir = repo();
  const d = deps(() => assert.fail("the broker receipt names the PR, so gh is never asked"));
  for (const output of [receipt({ operation: "issue.create", issueNumber: 3, targetId: 4 }), receipt({ operation: "branch.push", branch: "feat/pr" }),
    receipt({ operationId: "x", repository: "example/broker", prNumber: 5, targetId: 6 }), "{\"ok\":false,\"error\":\"auth-refused\"}"]) {
    handleAttributionHook(post(dir, BROKER, { stdout: `${output}\n`, stderr: "" }), "claude", d);
  }
  assert.equal(fs.existsSync(d.paths.attribution), false, "no pr.create receipt, no record");
  handleAttributionHook(post(dir, BROKER, { stdout: `${receipt({ operation: "pr.create", prNumber: 77, targetId: 9 })}\n`, stderr: "" }), "claude", d);
  const [entry, ...rest] = readAttribution(d.paths);
  assert.equal(rest.length, 0);
  assert.deepEqual([entry?.kind, entry?.repo, entry?.pr, entry?.prSource, entry?.sessionId], ["pr-create", "example/broker", 77, "stdout", "synthetic-claude-1"]);
});

test("a Codex broker call leaves the pending marker its push consumes", () => {
  const dir = repo();
  const d = deps();
  handleAttributionHook({ hook_event_name: "PreToolUse", session_id: "synthetic-codex-3", cwd: dir, tool_name: "shell_command",
    tool_input: { command: BROKER } }, "codex", d);
  assert.equal(fs.readdirSync(d.paths.attributionPending).length, 1);
});

test("attribution skips malformed broker lines and records only a valid PR receipt in an unborn repository", () => {
  const dir = path.join(workspace, `unborn-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  const d = deps(() => assert.fail("broker attribution never needs gh pr view"));
  const invalid = ["diagnostic before JSON", "null",
    receipt({ operation: "pr.create", repository: "too/many/parts", prNumber: 15 }),
    receipt({ operation: "pr.create", prNumber: "15" })];
  handleAttributionHook(post(dir, BROKER, { stdout: invalid.join("\r\n") }), "claude", d);
  assert.deepEqual(readAttribution(d.paths), []);

  const output = [...invalid, receipt({ operation: "pr.create", prNumber: 16 })].join("\r\n");
  handleAttributionHook({ ...post(dir, BROKER, output, "PowerShell"), session_id: null }, "claude", d);
  const [entry, ...rest] = readAttribution(d.paths);
  assert.deepEqual(rest, []);
  assert.equal(entry?.repo, "example/broker");
  assert.equal(entry?.pr, 16);
  assert.equal(entry?.prSource, "stdout");
  assert.equal(entry?.sha, null);
  assert.equal(entry?.branch, "main");
  assert.equal(entry?.sessionId, "unknown");
  assert.equal(entry?.runtime, "unknown");
  assert.equal(entry?.sessionSource, "none");
});

test("the attribution entry point reports unknown runtimes without failing the calling tool", () => {
  const hook = path.join(import.meta.dirname, "attribution-hook.mts");
  const run = spawnSync(process.execPath, [hook, "--runtime", "synthetic"], { encoding: "utf8", timeout: 10_000,
    env: { ...process.env, KHEREP_CONFIG_DIR: path.join(root, "unsupported-runtime"), KHEREP_WORKSPACE: workspace } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /kherep attribution-hook: unknown --runtime; expected codex/);
});
