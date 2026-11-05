#!/usr/bin/env node
// Commit policy for every commit of a pull request (issue #506).
//
// The commit-msg hook runs on the author's host only, and `git commit
// --no-verify` skips it. The `commit-policy` CI job runs this script over the
// pull request range, so a commit that bypassed the hook is still rejected
// before it can reach `main`. It does not copy the policy: it runs the
// versioned hook claude/kherep/githooks/commit-msg on each commit message.
//
//   node bootstrap/pr-commit-policy.mts [--hook <path>] <base-sha> <head-sha>
//
// The range is merge-base(base, head)..head, merge commits included and marked
// `(merge)`. Every KHEREP_* variable of the caller is dropped, so a
// KHEREP_WORK_ITEM=none escape hatch cannot reach the hook. The hook gets the
// repository toplevel as KHEREP_WORKSPACE, KHEREP_WORK_ITEM_REQUIRED from the
// caller (default "0") and KHEREP_WORK_ITEM_PATTERN only if the caller set it.
// Before any commit, the hook must reject a missing-key canary under an isolated
// required work-item policy; an emptied hook would otherwise pass every commit.
//
// Exit codes: 0 every commit passed, 1 at least one commit failed the policy,
// 2 the range or the hook could not be read. A failed read is never a pass.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { errorMessage } from "./shape.mts";
import { findTrustedExecutable } from "../claude/hooks/lib/trusted-executable.mts";

export const DEFAULT_HOOK = path.resolve(import.meta.dirname, "..", "claude", "kherep", "githooks", "commit-msg");
const CANARY = "canary without a work-item key\n";
const CANARY_TEXT = "requires the subject to start with the configured work-item key";

export interface Options { base: string; head: string; hook?: string; cwd?: string; env?: NodeJS.ProcessEnv }
export interface Result { code: number; stdout: string[]; stderr: string[] }

class Unreadable extends Error {}

const slash = (p: string) => p.replace(/\\/g, "/");

function tool(name: string, cwd: string, env = process.env): string {
  const command = findTrustedExecutable(name, { cwd, env });
  if (!command) throw new Unreadable(`${name} executable not found in an absolute PATH directory`);
  return command;
}

function git(cwd: string, args: string[], what: string): string {
  const result = spawnSync(tool("git", cwd), args, { cwd, encoding: "utf8" });
  if (result.error) throw new Unreadable(`${what}: ${result.error.message}`);
  if (result.status !== 0) throw new Unreadable(`${what}: ${result.stderr.trim() || `git exited ${result.status}`}`);
  return result.stdout;
}

function hookEnv(caller: NodeJS.ProcessEnv, workspace: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(caller)) if (!key.startsWith("KHEREP_")) env[key] = value;
  env.KHEREP_WORKSPACE = workspace;
  env.KHEREP_WORK_ITEM_REQUIRED = caller.KHEREP_WORK_ITEM_REQUIRED || "0";
  if (caller.KHEREP_WORK_ITEM_PATTERN) env.KHEREP_WORK_ITEM_PATTERN = caller.KHEREP_WORK_ITEM_PATTERN;
  return env;
}

interface Commit { sha: string; merge: boolean }

// Both SHAs must name commits in a complete history; anything else is a read
// failure, so an incomplete fetch can never shrink the range to a pass.
function readRange(cwd: string, base: string, head: string): { mb: string; commits: Commit[] } {
  if (git(cwd, ["rev-parse", "--is-shallow-repository"], "shallow check").trim() === "true") {
    throw new Unreadable("shallow repository, fetch the full history (fetch-depth: 0)");
  }
  for (const [name, sha] of [["base", base], ["head", head]]) {
    git(cwd, ["cat-file", "-e", `${sha}^{commit}`], `${name} ${sha} is not a commit in this repository`);
  }
  const mb = git(cwd, ["merge-base", base, head], "merge-base").trim();
  const commits = git(cwd, ["rev-list", "--reverse", "--parents", `${mb}..${head}`], "rev-list")
    .split("\n").filter(Boolean)
    .map((line) => { const [sha, ...parents] = line.split(" "); return { sha: sha!, merge: parents.length > 1 }; });
  return { mb, commits };
}

export function checkCommits(options: Options): Result {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const cwd = options.cwd ?? process.cwd();
  const hook = slash(options.hook ?? DEFAULT_HOOK);
  const unreadable = (reason: string): Result => {
    stderr.push(`commit-policy: could not read range: ${reason}`);
    return { code: 2, stdout, stderr };
  };
  if (!options.base || !options.head) return unreadable("usage: pr-commit-policy.mts [--hook <path>] <base-sha> <head-sha>");
  if (!fs.statSync(hook, { throwIfNoEntry: false })?.isFile()) return unreadable(`hook ${hook} is not a file`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-pr-policy-"));
  try {
    const top = git(cwd, ["rev-parse", "--show-toplevel"], "repository toplevel").trim();
    const env = hookEnv(options.env ?? process.env, top);
    const message = slash(path.join(tmp, "COMMIT_EDITMSG"));
    const runHook = (text: string | Buffer, hookEnvironment = env) => {
      fs.writeFileSync(message, text);
      const result = spawnSync(tool("sh", top, hookEnvironment), [hook, message], { cwd: top, env: hookEnvironment, encoding: "utf8" });
      if (result.error) throw new Unreadable(`hook ${hook} did not run: ${result.error.message}`);
      return { status: result.status, stderr: (result.stderr ?? "").trim() };
    };

    const canary = runHook(CANARY, { ...env,
      KHEREP_WORK_ITEM_REQUIRED: "1", KHEREP_WORK_ITEM_PATTERN: "KHEREPCANARY-[0-9]+",
    });
    if (canary.status !== 1 || !canary.stderr.includes(CANARY_TEXT)) {
      return unreadable(`hook did not reject the canary (exit ${canary.status}${canary.stderr ? `: ${canary.stderr}` : ""})`);
    }

    const { mb, commits } = readRange(cwd, options.base, options.head);
    const head = git(cwd, ["rev-parse", `${options.head}^{commit}`], "head").trim();
    if (commits.length === 0) {
      stdout.push(`commit-policy: 0 commits in ${mb}..${head}, nothing to check`);
      return { code: 0, stdout, stderr };
    }
    let failed = 0;
    for (const { sha, merge } of commits) {
      const body = spawnSync(tool("git", cwd), ["show", "-s", "--format=%B", sha], { cwd });
      if (body.error || body.status !== 0) throw new Unreadable(`message of ${sha}: ${body.stderr?.toString().trim()}`);
      const subject = body.stdout.toString("utf8").split("\n", 1)[0]!.trim();
      const label = `${sha}${merge ? " (merge)" : ""} ${subject}`;
      const verdict = runHook(body.stdout);
      if (verdict.status === 0) { stdout.push(`ok   ${label}`); continue; }
      if (verdict.status !== 1) return unreadable(`hook exited ${verdict.status} on ${sha}${verdict.stderr ? `: ${verdict.stderr}` : ""}`);
      failed += 1;
      stdout.push(`FAIL ${label}`);
      for (const line of verdict.stderr.split("\n").filter((l) => l.trim())) stdout.push(`     ${line.trim()}`);
    }
    if (failed === 0) {
      const noun = commits.length === 1 ? "commit" : "commits";
      stdout.push(`commit-policy: ${commits.length} ${noun} passed`);
      return { code: 0, stdout, stderr };
    }
    stdout.push(`commit-policy: ${failed} of ${commits.length} commits failed`);
    return { code: 1, stdout, stderr };
  } catch (error) {
    if (error instanceof Unreadable) return unreadable(error.message);
    throw error;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// An incomplete or surplus argument list yields empty SHAs, which
// checkCommits reports as unreadable with the usage line.
function parseArgs(args: string[]): Options {
  const rest = [...args];
  const at = rest.indexOf("--hook");
  const hook = at === -1 ? undefined : rest.splice(at, 2)[1];
  if (rest.length !== 2 || (at !== -1 && !hook)) return { base: "", head: "" };
  return { base: rest[0]!, head: rest[1]!, hook };
}

// Same main-module test as ci-shard.mts. It needs no main flag on import.meta,
// which Node 23 and 24.0-24.1 lack, and a symlinked directory matches only
// after realpath.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const result = checkCommits(parseArgs(process.argv.slice(2)));
    for (const line of result.stdout) console.log(line);
    for (const line of result.stderr) console.error(line);
    process.exitCode = result.code;
  } catch (error) {
    console.error(`commit-policy: could not read range: ${errorMessage(error)}`);
    process.exitCode = 2;
  }
}
