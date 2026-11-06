// The base tree of the Windows test route (issue #832) and the logged child process it shares
// with bootstrap/test-route.mts.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { errorCode, errorMessage } from "./shape.mts";
import { npmCliPath, type RunResult } from "./test-route-compare.mts";

export interface BaseTree {
  ref: string; sha: string; path: string;
  install: "ok" | "failed" | "pending"; cleanup: "removed" | "leftover" | "pending";
  remove(): void;
}

export const say = (line: string) => console.log(`test-route: ${line}`);

// Output goes to a file, not a pipe: a lingering test child that holds a pipe open would keep
// spawnSync waiting after the runner itself has exited.
export function runLogged(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string, timeoutMs: number): RunResult {
  const fd = fs.openSync(log, "w");
  try {
    const child = spawnSync(command, args, { cwd, env, stdio: ["ignore", fd, fd], timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true });
    return {
      status: child.status, signal: child.signal, error: child.error ? errorMessage(child.error) : null,
      killed: child.signal !== null || errorCode(child.error) === "ETIMEDOUT",
    };
  } finally { fs.closeSync(fd); }
}

function installBase(dir: string, env: NodeJS.ProcessEnv, out: string, timeoutMs: number): "ok" | "failed" {
  const log = path.join(out, "base-npm-ci.log");
  // From the route's own environment: the children's has no npm_* keys.
  const npm = npmCliPath(process.execPath, process.env.npm_execpath, fs.existsSync);
  if (!npm) { fs.writeFileSync(log, "npm-cli.js not found beside the node executable\n"); return "failed"; }
  return runLogged(process.execPath, [npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], dir, env, log, timeoutMs).status === 0 ? "ok" : "failed";
}

// A directory a lingering test child still holds makes rmSync throw after its retries. That is a
// leftover to report, and it must not cost the verdict or hide the error being handled. Only
// ENOENT proves the tree is gone: a stat that fails for another reason shows nothing.
export function removeTree(target: string, rm: typeof fs.rmSync = fs.rmSync, stat: (file: string) => unknown = fs.statSync): "removed" | "leftover" {
  try { rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
  catch { /* the check below decides */ }
  let held = "still there";
  try { stat(target); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return "removed";
    held = errorCode(error);
  }
  say(`leftover base tree ${target} (${held}, remove by hand)`);
  return "leftover";
}

interface BaseRequest {
  candidate: string; ref: string; sha: string; git: string; env: NodeJS.ProcessEnv; out: string; timeoutMs: number;
  rm?: typeof fs.rmSync;
}

// A shared clone registers nothing in the candidate repository and writes nothing there. It reads
// objects through alternates, so a gc in the source during the run could break it; the clone lives
// only as long as the route. No origin: a base test cannot push into the candidate through it.
// core.longpaths: tracked paths reach 139 characters.
export function prepareBase({ candidate, ref, sha, git, env, out, timeoutMs, rm }: BaseRequest): BaseTree {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "kt-"));
  const dir = path.join(parent, "base");
  const tree: BaseTree = {
    ref, sha, path: dir, install: "pending", cleanup: "pending",
    remove() { tree.cleanup = removeTree(parent, rm); },
  };
  const gitStep = (...args: string[]) => {
    const child = spawnSync(git, args, { encoding: "utf8", env, timeout: timeoutMs, killSignal: "SIGKILL" });
    if (child.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${child.stderr || child.error || child.signal}`);
    return child.stdout.trim();
  };
  try {
    gitStep("clone", "--quiet", "--shared", "--no-checkout", candidate, dir);
    gitStep("-C", dir, "remote", "remove", "origin");
    gitStep("-c", "core.longpaths=true", "-C", dir, "checkout", "--quiet", "--detach", sha);
    const head = gitStep("-C", dir, "rev-parse", "HEAD");
    if (head !== sha) throw new Error(`base clone is at ${head}, not at ${sha}`);
    tree.install = installBase(dir, env, out, timeoutMs);
    return tree;
  } catch (error) { tree.remove(); throw error; }
}
