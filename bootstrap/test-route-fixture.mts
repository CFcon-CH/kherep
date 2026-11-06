// Fixtures of the Windows test route's end-to-end tests (issue #832): a repository of two commits,
// base first and candidate on top, and the route started on it. No real suite runs here. Every
// tree lives in the temp folder and is removed afterwards.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type TestContext } from "node:test";

import { findTrustedExecutable } from "../claude/hooks/lib/trusted-executable.mts";
import { SANDBOX_MARKERS } from "./test-route-compare.mts";

const ROUTE = path.join(import.meta.dirname, "test-route.mts");
const PACKAGE = JSON.stringify({ name: "fx", scripts: { "test:fixture": 'node --test "t/*.test.mts"', "test:bootstrap": 'node --test "t/*.test.mts"' } });
const LOCK = JSON.stringify({ name: "fx", lockfileVersion: 3, requires: true, packages: { "": { name: "fx" } } });

export const HEADER = `import { test } from "node:test";\n`;
export const KNOWN = `${HEADER}test("passes", () => {});\ntest("known symlink", () => { throw new Error("x"); });\n`;
export const GIT = findTrustedExecutable("git");
export const hasGit = GIT !== null && spawnSync(GIT, ["--version"]).status === 0;

export type Files = Record<string, string | null>;

export function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kt-fx-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}

function write(dir: string, files: Files): void {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    if (text === null) { fs.rmSync(file, { force: true }); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

export function git(dir: string, ...args: string[]): string {
  if (!GIT) throw new Error("git not found on an absolute PATH entry");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const done = spawnSync(GIT, ["-c", "user.name=fx", "-c", "user.email=fx@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", env });
  assert.equal(done.status, 0, done.stderr);
  return done.stdout.trim();
}

// Commit `base` over the default tree, then `candidate` on top; null deletes a file.
export function gitRepo(t: TestContext, base: Files = {}, candidate: Files = {}): string {
  const dir = tempDir(t);
  write(dir, { "package.json": PACKAGE, "package-lock.json": LOCK, ".gitignore": "node_modules/\n", "t/a.test.mts": KNOWN, ...base });
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "--no-verify", "-m", "base");
  write(dir, candidate);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--no-verify", "--allow-empty", "-m", "candidate");
  return dir;
}

// All three spellings: Windows reads TEMP then TMP, POSIX reads TMPDIR.
export const tempVars = (dir: string) => ({ TMP: dir, TEMP: dir, TMPDIR: dir });

function route(args: string[], env: Record<string, string>, cwd: string) {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const marker of SANDBOX_MARKERS) delete clean[marker];
  // Other spellings of these keys would compete with the ones set below.
  for (const key of Object.keys(clean)) if (/^(?:TMP|TEMP|TMPDIR)$/i.test(key)) delete clean[key];
  return spawnSync(process.execPath, [ROUTE, ...args], { cwd, encoding: "utf8", env: { ...clean, ...env } });
}

function readReceipt(out: string) {
  const file = path.join(out, "receipt.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

// The route in `cwd`, with a temp folder of its own. `out` and `receipt` come from the path it
// printed, and are null when it refused before making a directory. `env` overrides.
export function routeIn(t: TestContext, cwd: string, args: string[], env: Record<string, string> = {}) {
  const tmp = tempDir(t);
  const run = route(args, { ...tempVars(tmp), ...env }, cwd);
  const printed = /^test-route: receipt (.+)$/m.exec(run.stdout)?.[1];
  const out = printed ? path.dirname(printed) : null;
  return { run, tmp, out, receipt: out && readReceipt(out) };
}

// The route on the fixture suite, `--base HEAD~1`, without the type check. `extra` overrides.
export function onCommits(t: TestContext, repo: string, extra: string[] = [], env: Record<string, string> = {}) {
  return routeIn(t, repo, ["--base", "HEAD~1", "--no-typecheck", "--suites", "fixture", ...extra], env);
}
