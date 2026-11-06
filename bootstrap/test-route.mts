#!/usr/bin/env node
// Windows verdict route (issue #832): runs identically defined suites on a clean committed candidate
// and on a temporary shared clone of a base ref, outside the Codex sandbox, with Git for Windows
// first on the tests' PATH.
//
//   npm run test:route -- --base <ref> [--suites a,b] [--no-typecheck] [--suite-timeout <minutes>]
//
// Run it inside the candidate checkout. Receipt: <tmp>/kherep-test-route/<stamp>-<head>-<random>/receipt.json,
// printed as `test-route: receipt <path>`.
//
// Exit 0: every test that passed on the base passed on the candidate, no test failed only there, the
// known failures stayed under the ceiling, and the candidate did not change. Exit 1: a test failed
// only on the candidate. Exit 2: no verdict. The rules are in bootstrap/test-route-proof.mts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { findTrustedExecutable } from "../claude/hooks/lib/trusted-executable.mts";
import { errorMessage } from "./shape.mts";
import { prepareBase, runLogged, say, type BaseTree } from "./test-route-base.mts";
import { candidateIdentity, gitText, protectedRoots, refuseInside, sameBlob, sameIdentity, type Identity } from "./test-route-candidate.mts";
import {
  cpuBusyPct, fromCharset, gitBashDir, REF_CHARS, sandboxMarkers, scrubEnv, selectedFiles, SUITE_CHARS, suitesFromPackage, withPathFirst, type RunResult, type Suite,
} from "./test-route-compare.mts";
import { nodeOutcome, overallVerdict, suiteVerdict, tscOutcome, unfinished, type Outcome } from "./test-route-proof.mts";

const DEFAULT_SUITES = "control-plane,bootstrap";
const MISSING_SHOWN = 20;

interface Options { candidate: string; base: string; suites: string[]; typecheck: boolean; timeoutMs: number }
interface Measured extends Outcome { exit: number | null; killed: boolean; durationMs: number }
interface Context { timeoutMs: number; env: NodeJS.ProcessEnv; out: string; base: BaseTree }

function suiteTimeoutMinutes(text: string): number {
  const value = Number(text);
  if (!(value > 0 && value <= 1440)) throw new Error(`--suite-timeout must be above 0 and at most 1440: ${text}`);
  return value;
}

function suiteNames(list: string): string[] {
  const names: string[] = [];
  for (const entry of list.split(",")) {
    const name = fromCharset(entry.trim(), SUITE_CHARS);
    if (name === null) throw new Error(`--suites: name not understood: ${entry}`);
    if (name && name !== "typecheck") names.push(name);
  }
  if (!names.length) throw new Error("--suites must name at least one node --test suite");
  return names;
}

function readOptions(args: string[]): Options {
  const { values } = parseArgs({
    args, strict: true,
    options: { base: { type: "string" }, suites: { type: "string" }, "no-typecheck": { type: "boolean" }, "suite-timeout": { type: "string" } },
  });
  if (!values.base) throw new Error("name the base: --base <ref> is required");
  const base = fromCharset(values.base, REF_CHARS);
  if (!base || base.startsWith("-")) throw new Error(`--base must be a ref of letters, digits and ._/~^@{}- not starting with -: ${values.base}`);
  return {
    candidate: process.cwd(), base, suites: suiteNames(values.suites ?? DEFAULT_SUITES), typecheck: !values["no-typecheck"],
    timeoutMs: suiteTimeoutMinutes(values["suite-timeout"] ?? "60") * 60_000,
  };
}

interface Prepared { bash: string | null; identity: Identity; baseSha: string; suites: Suite[] }

// Everything that refuses before a clone exists.
function preflight(options: Options, git: string, env: NodeJS.ProcessEnv): Prepared {
  const { candidate, base } = options;
  const bash = process.platform === "win32" ? gitBashDir(process.env.LOCALAPPDATA, fs.existsSync) : null;
  if (process.platform === "win32" && !bash) throw new Error("Git for Windows not found");
  if (!fs.existsSync(path.join(candidate, "node_modules"))) {
    throw new Error(`candidate has no node_modules: run npm ci there first, the route installs nothing in the candidate (${candidate})`);
  }
  const identity = candidateIdentity(git, candidate, env);
  if (identity.changed) throw new Error(`candidate has ${identity.changed} changed or untracked file${identity.changed === 1 ? "" : "s"}: commit first, a verdict names a commit`);
  const baseSha = gitText(git, candidate, env, "rev-parse", "--verify", "--quiet", `${base}^{commit}`);
  if (!baseSha) throw new Error(`base ${base} does not resolve in ${candidate}; fetch it first`);
  if (baseSha === identity.sha) throw new Error(`base equals the candidate (${baseSha.slice(0, 8)})`);
  if (gitText(git, candidate, env, "merge-base", "--is-ancestor", baseSha, identity.sha) === null) throw new Error(`base ${base} is not an ancestor of the candidate`);
  const baseText = gitText(git, candidate, env, "show", `${baseSha}:package.json`);
  if (baseText === null) throw new Error(`base ${base} has no package.json`);
  if (options.typecheck && !sameBlob(git, candidate, env, "tsconfig.json", baseSha, identity.sha)) {
    throw new Error("tsconfig.json differs between the base and the candidate: the type check would not check the same thing in both");
  }
  return { bash, identity, baseSha, suites: suitesFromPackage(baseText, fs.readFileSync(path.join(candidate, "package.json"), "utf8"), options.suites) };
}

function refuseEmptyPatterns(suites: Suite[], trees: Record<string, string>): void {
  for (const suite of suites) for (const pattern of suite.patterns) for (const [tree, root] of Object.entries(trees)) {
    if (!selectedFiles(root, pattern).length) throw new Error(`suite ${suite.name}: pattern ${pattern} selects no file in ${tree}`);
  }
}

function measured(outcome: Outcome, run: RunResult, started: number, tree: string, suite: string): Measured {
  const durationMs = Date.now() - started;
  const counts = outcome.finished
    ? `tests=${outcome.tests} fail=${outcome.fail} cancelled=${outcome.cancelled} skipped=${outcome.skipped}`
    : `did not finish: ${outcome.reason}`;
  say(`${tree} ${suite} ${counts} ${(durationMs / 1000).toFixed(1)}s`);
  return { ...outcome, exit: run.status, killed: run.killed, durationMs };
}

function runNode({ timeoutMs, env, out }: Context, tree: string, root: string, suite: Suite): Measured {
  const tap = path.join(out, `${tree}-${suite.name}.tap`);
  fs.rmSync(tap, { force: true }); // a stale file must not stand in for this run
  const reporters = ["--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=tap", `--test-reporter-destination=${tap}`];
  const started = Date.now();
  const run = runLogged(process.execPath, ["--test", ...suite.flags, ...reporters, ...suite.patterns], root, env, path.join(out, `${tree}-${suite.name}.log`), timeoutMs);
  // Real path: Node reports test locations by it (macOS /var -> /private/var).
  return measured(nodeOutcome(run, fs.existsSync(tap) ? fs.readFileSync(tap, "utf8") : null, fs.realpathSync(root)), run, started, tree, suite.name);
}

function runTsc({ timeoutMs, env, out }: Context, tree: string, root: string): Measured {
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  const log = path.join(out, `${tree}-typecheck.log`);
  const started = Date.now();
  const run: RunResult = fs.existsSync(tsc)
    ? runLogged(process.execPath, [tsc, "-p", "tsconfig.json", "--pretty", "false"], root, env, log, timeoutMs)
    : { status: null, signal: null, error: "no node_modules/typescript in this tree", killed: false };
  return measured(tscOutcome(run, fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""), run, started, tree, "typecheck");
}

// The base run of a suite, unless its install failed: every suite then has no verdict.
function runBase(context: Context, run: () => Measured): Measured {
  if (context.base.install === "ok") return run();
  return { ...unfinished("base install failed, see base-npm-ci.log"), exit: null, killed: false, durationMs: 0 };
}

function concludeSuite(suite: string, candidate: Measured, base: Measured | null) {
  const { fresh, ceiling, ...verdict } = suiteVerdict(suite, candidate, base ?? candidate);
  const { known, fixed, gone, missing } = verdict;
  if (verdict.status === "new-failures") {
    const fileOf = (name: string) => candidate.failing.find((failing) => failing.name === name)?.file;
    for (const name of fresh) say(`new failure: ${name}${fileOf(name) ? ` (${fileOf(name)})` : ""}`);
  }
  for (const name of known) say(`known failure: ${name}`);
  for (const name of missing.slice(0, MISSING_SHOWN)) say(`missing: ${name}`);
  if (missing.length > MISSING_SHOWN) say(`missing: and ${missing.length - MISSING_SHOWN} more, see the receipt`);
  for (const reason of verdict.reasons) say(`${suite} no verdict: ${reason}`);
  say(`${suite} ${verdict.status}${fresh.length ? ` new=${fresh.length}` : ""} known=${known.length} fixed=${fixed.length} gone=${gone.length}${missing.length ? ` missing=${missing.length}` : ""}`);
  const counts = ({ failing: _failing, passing: _passing, ...rest }: Measured) => rest;
  return { ...verdict, new: fresh, proof: { ceiling }, candidate: counts(candidate), base: base && counts(base) };
}

function sampleLoad() {
  const before = os.cpus();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  const loadavg = process.platform === "win32" ? null : os.loadavg();
  return { cpuBusyPct: cpuBusyPct(before, os.cpus()), memFreePct: Math.round((os.freemem() / os.totalmem()) * 100), loadavg };
}

const writeReceipt = (file: string, body: unknown) => fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);

function prove(options: Options, git: string, env: NodeJS.ProcessEnv, out: string, startedAt: string, receipt: string): number {
  const { bash, identity, baseSha, suites } = preflight(options, git, env);
  const short = identity.sha.slice(0, 8);
  say(`candidate ${short} (clean) at ${options.candidate}`);
  const load = sampleLoad();
  say(`host ${process.platform} node ${process.version} bash ${bash ?? "as on PATH"} load cpu ${load.cpuBusyPct}% mem ${load.memFreePct}% free`);
  const testEnv = bash ? withPathFirst(env, bash, process.platform) : env;
  const base = prepareBase({ candidate: options.candidate, ref: options.base, sha: baseSha, git, env: testEnv, out, timeoutMs: options.timeoutMs });
  const context: Context = { timeoutMs: options.timeoutMs, env: testEnv, out, base };
  const results: Record<string, ReturnType<typeof concludeSuite>> = {};
  try {
    refuseEmptyPatterns(suites, { candidate: options.candidate, base: base.path });
    say(`base ${base.ref} = ${baseSha.slice(0, 8)} in ${base.path} (install ${base.install})`);
    if (options.typecheck) {
      const candidate = runTsc(context, "candidate", options.candidate);
      const clean = candidate.finished && !candidate.failing.length && base.install === "ok";
      results.typecheck = concludeSuite("typecheck", candidate, clean ? null : runBase(context, () => runTsc(context, "base", base.path)));
    }
    for (const suite of suites) {
      const candidate = runNode(context, "candidate", options.candidate, suite);
      results[suite.name] = concludeSuite(suite.name, candidate, runBase(context, () => runNode(context, "base", base.path, suite)));
    }
  } finally { base.remove(); }
  const after = candidateIdentity(git, options.candidate, env);
  const changed = sameIdentity(identity, after);
  const { verdict, exitCode } = overallVerdict(Object.values(results).map((result) => result.status), changed === null);
  writeReceipt(receipt, {
    route: "bootstrap/test-route.mts", state: "finished", startedAt, finishedAt: new Date().toISOString(),
    candidate: { path: options.candidate, sha: identity.sha, shaAfter: after.sha, changedBefore: identity.changed, changedAfter: after.changed },
    base, host: { platform: process.platform, node: process.version, bashFirst: bash && `${bash}/bash.exe`, load },
    suites: results, verdict, exitCode,
  });
  if (changed) say(changed);
  const undecided = Object.keys(results).filter((name) => results[name].status === "no-verdict");
  const missing = Object.values(results).reduce((sum, result) => sum + result.missing.length, 0);
  say(`VERDICT ${verdict} candidate=${short} base=${baseSha.slice(0, 8)} suites=${Object.keys(results).join(",")}${missing ? ` missing=${missing}` : ""}${changed ? " identity=changed" : ""}${verdict === "new-failures" && undecided.length ? ` unfinished=${undecided.join(",")}` : ""} receipt=${receipt}`);
  return exitCode;
}

function main(args: string[]): number {
  const options = readOptions(args);
  const markers = sandboxMarkers(process.env);
  if (markers.length) throw new Error(`running inside a Codex sandbox or Codex shell (${markers.join(", ")}); run the route outside it`);
  const env = scrubEnv(process.env);
  const git = findTrustedExecutable("git", { cwd: options.candidate });
  if (!git) throw new Error("git not found on an absolute PATH entry");
  const roots = protectedRoots(git, options.candidate, env);
  const temp = os.tmpdir();
  refuseInside("temp dir", temp, roots);
  const startedAt = new Date().toISOString();
  const head = gitText(git, options.candidate, env, "rev-parse", "HEAD");
  const parent = path.join(temp, "kherep-test-route");
  fs.mkdirSync(parent, { recursive: true });
  const stamp = startedAt.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const out = fs.mkdtempSync(path.join(parent, `${stamp}-${head?.slice(0, 7) ?? "none"}-`));
  const receipt = path.join(out, "receipt.json");
  writeReceipt(receipt, { verdict: "no-verdict", exitCode: 2, state: "running" });
  say(`receipt ${receipt}`); // a refusal's VERDICT line names no receipt
  try { return prove(options, git, env, out, startedAt, receipt); }
  catch (error) {
    writeReceipt(receipt, { verdict: "no-verdict", exitCode: 2, state: "refused", reason: errorMessage(error) });
    throw error;
  }
}

// Node loads the main module from its real path, so a script started through a symlinked
// directory (macOS /var -> /private/var) matches only after realpath (see ci-shard.mts).
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
  catch (error) { say(`VERDICT no-verdict: ${errorMessage(error)}`); process.exitCode = 2; }
}
