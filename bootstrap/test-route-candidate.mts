// The candidate's identity and the trees the Windows test route (issue #832) must stay out of.

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { insideRoot } from "./test-route-compare.mts";

export interface Identity { sha: string; changed: number }

export function gitText(git: string, cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string | null {
  const child = spawnSync(git, args, { cwd, env, encoding: "utf8" });
  return child.status === 0 ? child.stdout.trim() : null;
}

// Whether a path has the same committed bytes in two commits; absent in both counts as the same.
// Raw blobs: gitText trims, and a checkout may carry other line endings than its commit.
export function sameBlob(git: string, cwd: string, env: NodeJS.ProcessEnv, file: string, left: string, right: string): boolean {
  const blob = (sha: string) => {
    const child = spawnSync(git, ["show", `${sha}:${file}`], { cwd, env, maxBuffer: Infinity });
    return child.status === 0 ? child.stdout : null;
  };
  const [a, b] = [blob(left), blob(right)];
  return a && b ? a.equals(b) : a === b;
}

// --untracked-files=all: status.showUntrackedFiles must not decide what counts as changed.
// --no-optional-locks: a plain status refreshes the candidate's index, and the route writes nothing there.
export function candidateIdentity(git: string, dir: string, env: NodeJS.ProcessEnv): Identity {
  const sha = gitText(git, dir, env, "rev-parse", "HEAD");
  const status = gitText(git, dir, env, "--no-optional-locks", "status", "--porcelain", "--untracked-files=all");
  if (sha === null || status === null) throw new Error(`candidate is not a git checkout: ${dir}`);
  return { sha, changed: status.split("\n").filter(Boolean).length };
}

// The line that says what changed during the run, or null.
export function sameIdentity(before: Identity, after: Identity): string | null {
  if (before.sha === after.sha && before.changed === after.changed) return null;
  const short = (sha: string) => sha.slice(0, 8);
  const head = before.sha === after.sha ? `HEAD ${short(after.sha)}` : `HEAD ${short(before.sha)} -> ${short(after.sha)}`;
  return `candidate changed during the run (${head}, ${after.changed} changed file${after.changed === 1 ? "" : "s"})`;
}

export function protectedRoots(git: string, candidate: string, env: NodeJS.ProcessEnv): string[] {
  const worktrees = (gitText(git, candidate, env, "worktree", "list", "--porcelain") ?? "").split("\n")
    .filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
  const common = gitText(git, candidate, env, "rev-parse", "--git-common-dir");
  const named = [common && path.resolve(candidate, common), env.KHEREP_CONFIG_DIR, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME].filter((dir): dir is string => Boolean(dir));
  return [candidate, ...worktrees, ...named, path.join(os.homedir(), ".claude"), path.join(os.homedir(), ".codex")];
}

export function refuseInside(label: string, dir: string, roots: string[]): void {
  const root = roots.find((candidate) => insideRoot(dir, candidate));
  if (root) throw new Error(`${label} inside ${root}`);
}
