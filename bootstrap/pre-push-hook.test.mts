// Issue #325, PR-A. The pre-push git hook writes one attribution record per
// pushed ref, for repositories inside the workspace only, and never fails a
// push. Real git runs the hook from a copy with the mode bit set, beside the
// self-contained attribution-record.mts, the way the installer places both.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import * as record from "../claude/kherep/githooks/attribution-record.mts";
import { appendAttribution, readAttribution, repoSlug, writePendingMarker } from "../modules/control-plane/node/attribution.mts";
import { configRoot, nodePaths } from "../modules/control-plane/node/config.mts";

const githooks = path.resolve(import.meta.dirname, "..", "claude", "kherep", "githooks");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-pre-push-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const workspace = path.join(root, "ws");
const hooks = path.join(root, "hooks");
fs.mkdirSync(hooks);
for (const name of ["pre-push", "attribution-record.mts"]) fs.copyFileSync(path.join(githooks, name), path.join(hooks, name));
fs.chmodSync(path.join(hooks, "pre-push"), 0o755);

const DAY = 24 * 60 * 60_000;
const SUBJECT = "synthetic secret subject do-not-record";
// The host's own session and Kherep variables must not leak into a case.
const hostEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !key.startsWith("KHEREP_") && key !== "CLAUDE_CODE_SESSION_ID"));

let seq = 0;

interface Case { repo: string; config: string; branch: string }

function git(cwd: string, args: string[], env: Record<string, string | undefined> = {}): string {
  const result = spawnSync("git", ["-c", `core.hooksPath=${hooks}`, "-c", "user.name=Synthetic",
    "-c", "user.email=synthetic@example.com", ...args], { cwd, encoding: "utf8", env: { ...hostEnv, ...env } });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// A repository at <base>/<name> with a bare remote named example/repo and one
// commit on a fresh branch, ready to push.
function setup(base = workspace): Case {
  const n = ++seq;
  const repo = path.join(base, `repo-${n}`);
  const remote = path.join(root, "remotes", `r${n}`, "example", "repo.git");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(remote, { recursive: true });
  git(remote, ["init", "-q", "--bare"]);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  fs.writeFileSync(path.join(repo, "a.txt"), `${n}\n`);
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-q", "-m", SUBJECT]);
  const branch = `feat/case-${n}`;
  git(repo, ["switch", "-q", "-c", branch]);
  return { repo, config: path.join(root, `config-${n}`), branch };
}

function push(c: Case, env: Record<string, string | undefined> = {}): void {
  git(c.repo, ["push", "-q", "origin", c.branch], { KHEREP_WORKSPACE: workspace, KHEREP_CONFIG_DIR: c.config, ...env });
}

const logOf = (c: Case) => nodePaths(c.config).attribution;
const recordsOf = (c: Case) => readAttribution(nodePaths(c.config));

function assertPushRecord(c: Case, session: { sessionId: string; runtime: string; sessionSource: string }): void {
  const records = recordsOf(c);
  assert.equal(records.length, 1, JSON.stringify(records));
  const [entry] = records;
  assert.deepEqual({ ...entry, ts: undefined }, {
    v: 1, ts: undefined, kind: "push", ...session, repo: "example/repo",
    toplevel: git(c.repo, ["rev-parse", "--show-toplevel"]), branch: c.branch, remoteRef: `refs/heads/${c.branch}`,
    sha: git(c.repo, ["rev-parse", "HEAD"]), pr: null,
  });
  assert.ok(Math.abs(Date.parse(entry!.ts) - Date.now()) < 60_000, entry!.ts);
  assert.ok(!fs.readFileSync(logOf(c), "utf8").includes(SUBJECT), "the commit subject is never recorded");
}

test("a push from a Claude session records CLAUDE_CODE_SESSION_ID", () => {
  const c = setup();
  push(c, { CLAUDE_CODE_SESSION_ID: "synthetic-claude-1" });
  assertPushRecord(c, { sessionId: "synthetic-claude-1", runtime: "claude", sessionSource: "CLAUDE_CODE_SESSION_ID" });
});

test("a push from a node-started Codex task records KHEREP_SESSION_ID", () => {
  const c = setup();
  push(c, { KHEREP_SESSION_ID: "synthetic-codex-1" });
  assertPushRecord(c, { sessionId: "synthetic-codex-1", runtime: "codex", sessionSource: "KHEREP_SESSION_ID" });
});

test("a push after a Codex PreToolUse marker records and consumes the marker", () => {
  const c = setup();
  const paths = nodePaths(c.config);
  const toplevel = git(c.repo, ["rev-parse", "--show-toplevel"]);
  writePendingMarker(paths, toplevel, "synthetic-codex-2", "codex", Date.now());
  push(c);
  assertPushRecord(c, { sessionId: "synthetic-codex-2", runtime: "codex", sessionSource: "marker" });
  assert.deepEqual(fs.readdirSync(paths.attributionPending), [], "the marker is consumed");
});

test("a push without any session source, or with a stale marker, records unknown", () => {
  const c = setup();
  writePendingMarker(nodePaths(c.config), git(c.repo, ["rev-parse", "--show-toplevel"]), "synthetic-codex-3", "codex",
    Date.now() - 121_000);
  push(c, { CLAUDE_CODE_SESSION_ID: "../not-an-id" });
  assertPushRecord(c, { sessionId: "unknown", runtime: "unknown", sessionSource: "none" });
});

test("nothing is recorded for a repository outside the workspace", () => {
  const c = setup(path.join(root, "outside"));
  push(c, { CLAUDE_CODE_SESSION_ID: "synthetic-claude-2" });
  assert.equal(fs.existsSync(logOf(c)), false);
});

test("reads the workspace from commit-policy when KHEREP_WORKSPACE is unset", () => {
  fs.writeFileSync(path.join(hooks, "commit-policy"), `workspace=${workspace.replace(/\\/g, "/")}\r\n`);
  try {
    const inside = setup();
    push(inside, { KHEREP_WORKSPACE: undefined, CLAUDE_CODE_SESSION_ID: "synthetic-claude-3" });
    assertPushRecord(inside, { sessionId: "synthetic-claude-3", runtime: "claude", sessionSource: "CLAUDE_CODE_SESSION_ID" });
    const outside = setup(path.join(root, "outside-policy"));
    push(outside, { KHEREP_WORKSPACE: undefined, CLAUDE_CODE_SESSION_ID: "synthetic-claude-3" });
    assert.equal(fs.existsSync(logOf(outside)), false);
  } finally {
    fs.rmSync(path.join(hooks, "commit-policy"), { force: true });
  }
});

// The coordinator's retention proof on the git-hook path.
test("a push trims records older than 90 days and keeps the fresh ones", () => {
  const c = setup();
  const paths = nodePaths(c.config);
  const base = { v: 1 as const, kind: "push" as const, sessionId: "synthetic-old", runtime: "claude" as const,
    sessionSource: "CLAUDE_CODE_SESSION_ID", repo: "example/old", toplevel: "/synthetic/old", branch: "old",
    remoteRef: "refs/heads/old", pr: null };
  appendAttribution(paths, { ...base, ts: new Date(Date.now() - 95 * DAY).toISOString(), sha: "1".repeat(40) }, Date.now() - 95 * DAY);
  appendAttribution(paths, { ...base, ts: new Date(Date.now() - DAY).toISOString(), sha: "2".repeat(40) }, Date.now() - DAY);
  push(c, { CLAUDE_CODE_SESSION_ID: "synthetic-claude-4" });
  assert.deepEqual(recordsOf(c).map((entry) => entry.sha), ["2".repeat(40), git(c.repo, ["rev-parse", "HEAD"])]);
});

test("the hook never fails a push, even when the log cannot be written", () => {
  const c = setup();
  fs.writeFileSync(c.config, "a file where the config directory should be\n");
  push(c, { CLAUDE_CODE_SESSION_ID: "synthetic-claude-5" });
  assert.equal(git(c.repo, ["ls-remote", "origin", c.branch]).split(/\s/)[0], git(c.repo, ["rev-parse", "HEAD"]));
});

test("the hook's config-root rule equals configRoot in config.mts on win32, darwin and linux", () => {
  const envs: NodeJS.ProcessEnv[] = [{}, { KHEREP_CONFIG_DIR: path.join(root, "explicit") },
    { APPDATA: path.join(root, "appdata") }, { XDG_CONFIG_HOME: path.join(root, "xdg") }];
  for (const platform of ["win32", "darwin", "linux"] as const) {
    for (const env of envs) assert.equal(record.configRoot(env, platform), configRoot(env, platform), `${platform} ${JSON.stringify(env)}`);
  }
});

test("the hook's repo slug and marker key equal the node module's", () => {
  for (const url of ["https://user:secret@git.example.test/example/repo.git", "git@git.example.test:example/repo.git",
    "/synthetic/example/repo.git", "C:\\synthetic\\example\\repo", ""]) assert.equal(record.repoSlug(url), repoSlug(url), url);
  const paths = nodePaths(path.join(root, "keys"));
  writePendingMarker(paths, "C:/Synthetic/Repo", "synthetic-codex-4", "codex", Date.now());
  const [file] = fs.readdirSync(paths.attributionPending);
  assert.equal(file, `${record.markerKey("C:/Synthetic/Repo", process.platform)}.json`);
});
