#!/usr/bin/env node
// Codex run guard (issue #550). CI runs the Codex suites through this script,
// not through `npm run test:codex`, and turns a green but hollow run red:
// - zero or partial selection: a pattern of the test:codex script selects no
//   file, or the test count falls below the floor;
// - skip drift: the skipped tests differ from the accepted list for the
//   platform in codex-run-expected.json (a runner image that loses pwsh or
//   symlink rights turns tests into skips and stays green otherwise).
// Also todo, fail and cancelled must be zero, every summary counter must agree
// with the records (C4, C8), and a skipped suite, which hides its tests, is refused.
//
//   node codex/scripts/codex-run-guard.mts run --platform <p> [--tap <file>] [--repo <dir>] [--expected <json>]
//   node codex/scripts/codex-run-guard.mts check <tap-file> --platform <p> [--repo <dir>] [--expected <json>]
//   node codex/scripts/codex-run-guard.mts print <tap-file>
//
// `run` reads the patterns from the test:codex script, so the file set stays
// the one developers run locally; it cannot forward reporter flags through npm:
// npm appends them after the patterns, node takes them for patterns and drops
// them, and no TAP file is written (measured, Node 26.10.0, npm 11.19.1).
// Exit 0 pass, 1 check failure or the failing test status, 2 usage or read error.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { errorCode, errorMessage } from "../../bootstrap/shape.mts";
import { compareSkips, formatSkips, observedSkips, parseTap, reconcile, type ParsedTap, type SkipEntry } from "./codex-run-tap.mts";

const REPO = path.resolve(import.meta.dirname, "../..");
const EXPECTED = path.join(import.meta.dirname, "codex-run-expected.json");
const SELF = "node codex/scripts/codex-run-guard.mts";
const SUFFIX = "/*.test.mts";

export interface Expected { minTests: number; skips: Record<string, SkipEntry[]> }

// Exactly `node --test` and double-quoted `<dir>/*.test.mts` patterns. Any
// other token means the script changed shape, and the guard is edited with it.
export function testCodexPatterns(packageJsonText: string): string[] {
  const scripts = (JSON.parse(packageJsonText) as { scripts?: Record<string, unknown> }).scripts;
  const script = scripts?.["test:codex"];
  if (typeof script !== "string") throw new Error('package.json has no string scripts["test:codex"]');
  const [node, flag, ...tokens] = script.trim().split(/\s+/);
  if (node !== "node" || flag !== "--test") throw new Error(`test:codex script form not understood: ${script}`);
  if (!tokens.length) throw new Error("test:codex script form not understood: no pattern");
  return tokens.map((token) => {
    const match = /^"([A-Za-z0-9_./-]+)\/\*\.test\.mts"$/.exec(token);
    if (!match || match[1].includes("..") || match[1].startsWith("/")) {
      throw new Error(`test:codex script form not understood: ${token}`);
    }
    return `${match[1]}${SUFFIX}`;
  });
}

// The files `<dir>/*.test.mts` selects: files only, not recursive. A missing
// directory selects nothing, as it does for node; any other read error throws.
export function selectedFiles(repo: string, pattern: string): string[] {
  const dir = path.join(repo, pattern.slice(0, -SUFFIX.length));
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mts"))
      .map((entry) => entry.name);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

export function loadExpected(text: string): Expected {
  const raw = JSON.parse(text) as { minTests?: unknown; skips?: unknown };
  if (!Number.isInteger(raw.minTests) || (raw.minTests as number) <= 0) throw new Error("expected file: minTests must be a positive integer");
  if (!raw.skips || typeof raw.skips !== "object" || Array.isArray(raw.skips)) throw new Error("expected file: skips must be an object");
  const skips: Record<string, SkipEntry[]> = {};
  for (const [platform, entries] of Object.entries(raw.skips)) {
    if (!Array.isArray(entries)) throw new Error(`expected file: skips.${platform} must be an array`);
    const seen = new Set<string>();
    skips[platform] = entries.map((entry: Record<string, unknown>) => {
      const shape = entry && typeof entry === "object" && Object.keys(entry).sort((left, right) => Number(left > right) - Number(left < right)).join(",") === "name,reason";
      if (!shape || typeof entry.name !== "string" || !entry.name || (entry.reason !== null && typeof entry.reason !== "string")) {
        throw new Error(`expected file: skips.${platform} entry is not { name, reason }: ${JSON.stringify(entry)}`);
      }
      const key = JSON.stringify([entry.name, entry.reason]);
      if (seen.has(key)) throw new Error(`expected file: skips.${platform} lists twice: ${key}`);
      seen.add(key);
      return { name: entry.name, reason: entry.reason as string | null };
    });
  }
  return { minTests: raw.minTests as number, skips };
}

export interface Evaluation { parsed: ParsedTap; expected: Expected; platform: string; selection: [string, number][] }
// The failure lines of one run, empty on a pass. skipDrift: a skip check (C3, C4, C7) failed, so the
// observed block is printed; listDrift: C3 failed, the only one an edit of the expected file clears.
export interface Verdict { failures: string[]; skipDrift: boolean; listDrift: boolean }

export function evaluate({ parsed, expected, platform, selection }: Evaluation): Verdict {
  const { summary, records } = parsed;
  const observed = observedSkips(parsed);
  const { missing, extra } = compareSkips(expected.skips[platform], observed);
  const verdict: Verdict = { failures: [], skipDrift: false, listDrift: missing.length + extra.length > 0 };
  const fail = (line: string) => verdict.failures.push(line);
  const drift = (line: string) => { verdict.skipDrift = true; fail(line); };
  for (const [pattern, count] of selection) if (count === 0) fail(`C1 pattern ${pattern} selects no file`);
  if (summary.tests < expected.minTests) fail(`C2 tests ${summary.tests} below floor ${expected.minTests}`);
  for (const entry of missing) drift(`C3 missing skip ${JSON.stringify(entry)}`);
  for (const entry of extra) drift(`C3 extra skip ${JSON.stringify(entry)}`);
  if (observed.length !== summary.skipped) drift(`C4 ${observed.length} skip records but # skipped ${summary.skipped}`);
  for (const line of reconcile(parsed)) fail(`C8 ${line}`);
  const todos = records.filter((record) => record.directive === "TODO").map((record) => record.name);
  if (summary.todo || todos.length) fail(`C5 todo ${summary.todo}, TODO records: ${todos.join("; ") || "none"}`);
  if (summary.fail) fail(`C6 fail ${summary.fail}`);
  if (summary.cancelled) fail(`C6 cancelled ${summary.cancelled}`);
  for (const record of records) {
    if (record.directive !== "SKIP" || record.type === "test") continue;
    drift(record.type === "suite" ? `C7 suite-level skip hides its tests: ${record.name}` : `C7 skip record of type ${record.type}: ${record.name}`);
  }
  return verdict;
}

function readText(file: string, what: string): string {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { throw new Error(`cannot read ${what} ${file}: ${errorMessage(error)}`); }
}

// What `check` needs besides the TAP file, read once; an unknown platform or a
// changed test:codex script is refused here, before `run` starts any test.
interface Inputs { platform: string; expected: Expected; repo: string; patterns: string[] }

function inputs(platform: string, repo: string, expectedPath: string): Inputs {
  const expected = loadExpected(readText(expectedPath, "expected file"));
  if (!Object.hasOwn(expected.skips, platform)) throw new Error(`no expectation for platform ${platform} in ${expectedPath}`);
  const patterns = testCodexPatterns(readText(path.join(repo, "package.json"), "package.json"));
  return { platform, expected, repo, patterns };
}

function check(tap: string, { platform, expected, repo, patterns }: Inputs): number {
  const parsed = parseTap(readText(tap, "TAP file"));
  const selection = patterns.map((pattern): [string, number] => [pattern, selectedFiles(repo, pattern).length]);
  const { failures, skipDrift, listDrift } = evaluate({ parsed, expected, platform, selection });
  const { tests, skipped, todo } = parsed.summary;
  if (!failures.length) {
    console.log(`codex-run-guard: ${platform} tests=${tests} skipped=${skipped} todo=${todo} ok`);
    return 0;
  }
  for (const failure of failures) console.log(`codex-run-guard: ${failure}`);
  if (skipDrift) {
    console.log(`codex-run-guard: observed skips (${platform}) begin`);
    console.log(formatSkips(observedSkips(parsed)));
    console.log(`codex-run-guard: observed skips (${platform}) end`);
  }
  if (listDrift) {
    console.log(`codex-run-guard: a legitimate change updates codex/scripts/codex-run-expected.json "${platform}" in the same pull request:`);
    console.log("codex-run-guard:   from the CI log: gh run view --job <job-id> --log | cut -f3- | sed -E 's/^[^ ]+ //', copy the block between the observed skips markers");
    console.log(`codex-run-guard:   only on a host that matches the ${platform} CI image (another host yields its own list): ${SELF} run --platform ${platform} --tap <dir>/codex-run.tap, then ${SELF} print <dir>/codex-run.tap`);
  }
  return 1;
}

function run(tap: string, ready: Inputs): number {
  fs.rmSync(tap, { force: true });
  // A `node --test` child that inherits NODE_TEST_CONTEXT=child-v8 runs as a test
  // child: status 0, no reporter output, no TAP file (measured, Node 26.10.0).
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const reporters = ["--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=tap", `--test-reporter-destination=${tap}`];
  const child = spawnSync(process.execPath, ["--test", ...reporters, ...ready.patterns], { cwd: ready.repo, stdio: "inherit", env });
  if (child.error) throw child.error;
  if (child.status !== 0) return child.status ?? 1;
  return check(tap, ready);
}

function main(args: string[]): number {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, strict: true,
    options: { platform: { type: "string" }, tap: { type: "string" }, repo: { type: "string" }, expected: { type: "string" } },
  });
  const [command, file, ...rest] = positionals;
  const repo = path.resolve(values.repo ?? REPO);
  const expected = path.resolve(values.expected ?? EXPECTED);
  if (command === "print" && file && !rest.length) {
    console.log(formatSkips(observedSkips(parseTap(readText(file, "TAP file")))));
    return 0;
  }
  if (command === "check" && file && !rest.length && values.platform) return check(file, inputs(values.platform, repo, expected));
  if (command === "run" && !file && values.platform) {
    const tap = path.resolve(values.tap ?? path.join(os.tmpdir(), `kherep-codex-run-${process.pid}.tap`));
    return run(tap, inputs(values.platform, repo, expected));
  }
  console.error("usage: codex-run-guard.mts run --platform <p> [--tap <file>] | check <tap-file> --platform <p> | print <tap-file>  [--repo <dir>] [--expected <json>]");
  return 2;
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath.
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
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(`codex-run-guard: ${errorMessage(error)}`); process.exitCode = 2; }
}
