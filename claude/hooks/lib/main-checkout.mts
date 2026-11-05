// Issue #325. Does a shell command move the HEAD of a repository's main
// checkout? main-checkout-guard asks this before a Bash or PowerShell call.
//
// Sessions share the main checkout. A branch switch there moves every other
// session's working tree under its feet; branch work belongs in a linked
// worktree (`git worktree add <path> -b <branch>`).
//
// checkoutIntents() is the pure part: the token walk of command-walk.mts,
// narrowed to `git [-C dir] [flags] checkout|switch`. judge() then asks git
// about one intent: is the directory in the workspace, is it the main checkout
// (git-dir equals common-dir), and which branch is the default.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { findTrustedExecutable } from "./trusted-executable.mts";

import { commandSegments, gitSubcommand, resolveDir, type Segment } from "./command-walk.mts";
import { isWithinWorkspace } from "./real-path-policy.mts";
import { normalizePathLike, type EnvLike } from "./workspace-scope.mts";

export interface CheckoutIntent {
  dir: string;
  verb: "checkout" | "switch";
  // A flag that always creates a branch or detaches HEAD.
  flag?: string;
  // Otherwise the first positional: a branch, a SHA, `-`, or for checkout a path.
  ref?: string;
  command: string;
}

export type Judgement = { action: "pass" } | { action: "warn" | "block"; message: string };

// The escape marker. Inline it must sit among the assignments that start a
// segment; the PowerShell spelling is a segment of its own and covers the rest
// of the command. Neither is ever read from the environment.
export const MARKER = "KHEREP_MAIN_CHECKOUT=switch";
const POWERSHELL_MARKER = /^\$env:KHEREP_MAIN_CHECKOUT=switch$/i;

const MOVES: Record<CheckoutIntent["verb"], Set<string>> = {
  checkout: new Set(["-b", "-B", "--orphan", "--detach"]),
  switch: new Set(["-c", "-C", "--create", "--force-create", "--orphan", "--detach", "-d"]),
};
// checkout options that make it a file checkout whatever else is given.
const FILE_MODE = new Set(["--ours", "--theirs", "-p", "--patch", "--pathspec-from-file"]);

function verbIntent(verb: CheckoutIntent["verb"], args: string[], dir: string, command: string): CheckoutIntent | null {
  const dashdash = args.indexOf("--");
  // `checkout -- <paths>` and `checkout <ref> -- <paths>` only restore files.
  if (verb === "checkout" && dashdash >= 0) return null;
  const positionals: string[] = [];
  for (const arg of dashdash >= 0 ? args.slice(0, dashdash) : args) {
    if (arg === "-" || !arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    // A short cluster such as -qb is -q -b.
    const names = /^-[A-Za-z]{2,}$/.test(arg) ? [...arg.slice(1)].map((letter) => `-${letter}`) : [arg.split("=")[0]!];
    const flag = names.find((name) => MOVES[verb].has(name));
    if (flag) return { dir, verb, flag, command };
    if (verb === "checkout" && names.some((name) => FILE_MODE.has(name))) return null;
  }
  // `checkout <tree-ish> <pathspec>...` restores files as well.
  if (!positionals.length || (verb === "checkout" && positionals.length > 1)) return null;
  return { dir, verb, ref: positionals[0], command };
}

function gitIntent(segment: Segment): CheckoutIntent | null {
  const { verb, rest, dir } = gitSubcommand(segment.args, segment.dir);
  return verb === "checkout" || verb === "switch" ? verbIntent(verb, rest, dir, segment.text) : null;
}

// Every segment of <command> that would move HEAD, with the directory it runs
// in. Segments carrying the escape marker are left out.
export function checkoutIntents(command: string, cwd: string): CheckoutIntent[] {
  return commandSegments(command, cwd, { inline: MARKER, powershell: POWERSHELL_MARKER })
    .filter((segment) => segment.name === "git" && !segment.escaped)
    .flatMap((segment) => gitIntent(segment) ?? []);
}

function git(dir: string, args: string[]): string | null {
  const command = findTrustedExecutable("git");
  if (!command) return null;
  const result = spawnSync(command, ["-C", dir, ...args], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

// origin/HEAD, else a local main or master. init.defaultBranch alone says
// nothing about this repository, so it is never consulted.
export function defaultBranch(dir: string): string | null {
  const head = git(dir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (head?.startsWith("refs/remotes/origin/")) return head.slice("refs/remotes/origin/".length);
  return ["main", "master"].find((name) => git(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]) !== null)
    ?? null;
}

function isMainCheckout(dir: string): boolean {
  const dirs = git(dir, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])?.split(/\r?\n/);
  if (!dirs || dirs.length !== 2) return false;
  const [gitDir, commonDir] = dirs.map((value) => normalizePathLike(value).toLowerCase());
  return gitDir === commonDir;
}

// True when the intent leaves the checkout on <main>: it names main, HEAD, a
// previous branch that is main, or (checkout only) a path rather than a ref.
function staysOnDefault(intent: CheckoutIntent, main: string): boolean {
  const ref = intent.ref!;
  if (ref === main || ref === `refs/heads/${main}` || ref === "HEAD" || ref === "@") return true;
  if (ref === "-") return git(intent.dir, ["rev-parse", "--symbolic-full-name", "@{-1}"]) === `refs/heads/${main}`;
  return intent.verb === "checkout"
    && git(intent.dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]) === null
    && fs.existsSync(resolveDir(intent.dir, ref));
}

export function judge(intent: CheckoutIntent, env: EnvLike = process.env): Judgement {
  if (!isWithinWorkspace(intent.dir, env) || !isMainCheckout(intent.dir)) return { action: "pass" };
  const main = defaultBranch(intent.dir);
  if (!main) {
    return { action: "warn", message: `main-checkout-guard could not determine the default branch of ${intent.dir} `
      + `(no origin/HEAD, main or master); \`${intent.command}\` was not checked.` };
  }
  if (!intent.flag && staysOnDefault(intent, main)) return { action: "pass" };
  return { action: "block", message: `\`${intent.command}\` would move the main checkout ${intent.dir} off its default branch ${main}` };
}
