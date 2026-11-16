#!/usr/bin/env node
// Issue #808, stage 2b: the guard canary. Operator-started only (no hook, schedule or CI runs it): a live run
// spends model tokens. Live mode, per runtime: a throwaway git repo, one headless turn (claude -p / codex exec)
// asked to run a control commit and a bad commit with an em dash, which claude/hooks/commit-guard.mts denies.
// The verdict (guard-canary-verdict.mts) comes from git log ground truth plus the raw output. --synthetic pipes
// the known-bad event through the installed Claude dispatcher command (and --checkout <repo>'s dispatcher) and
// spends no tokens. Exit 0 DENIED, 1 ALLOWED, 2 INCONCLUSIVE. Report: <home>/.cache/guard-canary/last-report.json,
// verdicts and runtime versions only, never the nonce, prompt, output or a path.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { codexCommand } from "../modules/control-plane/node/codex-binary.mts";
import { findOnPath } from "../modules/control-plane/node/discovery.mts";
import { findWindowsClaude } from "./claude-binary.mts";
import { BAD_PREFIX, CONTROL_PREFIX, EM_DASH, liveVerdict, overallExit, syntheticVerdict, type Decision } from "./guard-canary-verdict.mts";

export type Runtime = "claude" | "codex";
export interface Options { runtimes: Runtime[]; synthetic: boolean; home: string; checkout?: string; timeoutMs: number }
export interface Resolved { file: string; args: string[] }
export interface Deps { env?: NodeJS.ProcessEnv; resolve?: (runtime: Runtime) => Resolved | string; tmpRoot?: string; out?: (line: string) => void; git?: string | null }
interface Result extends Decision { runtime: Runtime; source?: "installed" | "checkout"; version: string | null }
interface Exec { failure?: string; timedOut: boolean; exitCode: number | null; stdout: string; stderr: string }

const USAGE = "usage: node bootstrap/guard-canary.mts [--runtime claude|codex|both] [--synthetic [--checkout <repo>]] [--home <claude home>] [--timeout <seconds>]";
const LIVE_TIMEOUT_MS = 300_000, SYNTHETIC_TIMEOUT_MS = 40_000, VERSION_TIMEOUT_MS = 15_000, GIT_TIMEOUT_MS = 30_000;
const OUTPUT_CAP = 8 * 1024 * 1024;
const VALUE_FLAGS = ["--runtime", "--home", "--checkout", "--timeout"];

// A Node error code, else "unknown"; never a message.
export const codeOf = (error: unknown): string => { const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,40}$/.test(code) ? code : "unknown"; };

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Options | string {
  const given: Record<string, string> = {};
  let synthetic = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--synthetic") { synthetic = true; continue; }
    if (!VALUE_FLAGS.includes(arg)) return `unknown argument ${arg}`;
    if (argv[i + 1] === undefined) return `${arg} needs a value`;
    given[arg] = argv[++i]!;
  }
  const runtime = given["--runtime"] ?? (synthetic ? "claude" : "both");
  if (!["claude", "codex", "both"].includes(runtime)) return `--runtime must be claude, codex or both`;
  const runtimes: Runtime[] = runtime === "both" ? ["claude", "codex"] : [runtime as Runtime];
  if (synthetic && runtimes.includes("codex")) return "--synthetic covers the Claude dispatcher only";
  if (given["--checkout"] !== undefined && !synthetic) return "--checkout needs --synthetic";
  const timeout = given["--timeout"];
  if (timeout !== undefined && !/^[1-9]\d{0,5}$/.test(timeout)) return "--timeout must be a positive number of seconds";
  const home = given["--home"] ?? env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME || env.USERPROFILE || os.homedir(), ".claude");
  return { runtimes, synthetic, home: path.resolve(home), checkout: given["--checkout"] && path.resolve(given["--checkout"]),
    timeoutMs: timeout ? Number(timeout) * 1000 : synthetic ? SYNTHETIC_TIMEOUT_MS : LIVE_TIMEOUT_MS };
}

// PATH only, never the fallback directories: a canary must run the CLI the operator's shell would run.
export function resolveRuntime(runtime: Runtime, env: NodeJS.ProcessEnv,
  deps: { platform?: NodeJS.Platform; exists?: (file: string) => boolean } = {}): Resolved | string {
  const platform = deps.platform ?? process.platform, pathEnv = env.PATH ?? env.Path ?? "";
  if (runtime === "claude" && platform === "win32") {
    const exe = findWindowsClaude(pathEnv, deps.exists);
    return exe ? { file: exe, args: [] } : "cli-missing";
  }
  const file = findOnPath(runtime, { platform, pathEnv, pathExt: env.PATHEXT, fallback: [] });
  if (!file) return "cli-missing";
  if (runtime === "claude") return { file, args: [] };
  try { return codexCommand(file, [], platform, deps.exists); } catch { return "cli-unusable"; }
}

// Double-quoted and bare tokens of an installed hook command, null for anything else.
export function argvOf(command: string): string[] | null {
  const token = /"([^"]*)"|([^\s"]+)/g;
  if (!command.trim() || command.replace(token, "").trim()) return null;
  return [...command.matchAll(token)].map((m) => m[1] ?? m[2]!);
}

// Never contains the deny text, so the text in the output can only come from the guard.
export function canaryPrompt(nonce: string): string {
  return ["This is an operator-started guard canary in a throwaway git repository.",
    "Run exactly these two shell commands, one at a time, each as its own tool call, unchanged, without retrying and without running anything else:",
    `1. git commit --allow-empty -m "${CONTROL_PREFIX} ${nonce}"`,
    `2. git commit --allow-empty -m "${BAD_PREFIX} ${nonce} ${EM_DASH} dash"`,
    "Then reply with one line per command: ran or blocked, quoting any message you were shown."].join("\n");
}

// The minimal per-process allowance: git commit for Claude, the repo's .git as a writable root for Codex
// (workspace-write keeps .git read-only; measured with `codex sandbox`, codex-cli 0.169.0). Hooks stay on.
export function runtimeArgs(runtime: Runtime, prompt: string, repo: string): string[] {
  if (runtime === "claude") {
    return ["-p", prompt, "--output-format", "stream-json", "--verbose", "--allowedTools", "Bash(git commit *)",
      "--permission-prompts", "none", "--no-session-persistence", "--strict-mcp-config"];
  }
  return ["exec", "--json", "--ephemeral", "-s", "workspace-write",
    "-c", `sandbox_workspace_write.writable_roots=[${JSON.stringify(path.join(repo, ".git"))}]`, "-C", repo, prompt];
}

// Spawns without a shell, bounded by timeoutMs (SIGKILL, streams dropped), output capped.
function execute(target: Resolved, o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; input?: string }): Promise<Exec> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", done = false;
    const finish = (rest: Omit<Exec, "stdout" | "stderr">): void => { if (!done) { done = true; clearTimeout(timer); resolve({ ...rest, stdout, stderr }); } };
    const child = spawn(target.file, target.args, { cwd: o.cwd, env: o.env, windowsHide: true,
      stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      finish({ timedOut: true, exitCode: null });
    }, o.timeoutMs);
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { if (stdout.length < OUTPUT_CAP) stdout += chunk; });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { if (stderr.length < OUTPUT_CAP) stderr += chunk; });
    child.on("error", (error) => finish({ failure: `spawn-failed:${codeOf(error)}`, timedOut: false, exitCode: null }));
    child.on("close", (code) => finish({ timedOut: false, exitCode: code }));
    if (o.input !== undefined) { child.stdin!.on("error", () => {}); child.stdin!.end(o.input); }
  });
}

function versionOf(target: Resolved, env: NodeJS.ProcessEnv): string | null {
  const run = spawnSync(target.file, [...target.args, "--version"], { encoding: "utf8", env, timeout: VERSION_TIMEOUT_MS,
    windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const line = run.status === 0 ? run.stdout.split(/\r?\n/)[0]!.replace(/[^\w .()+-]/g, "").trim().slice(0, 80) : "";
  return line || null;
}

// A fixed system Git, never a PATH lookup: the verdict is read from this Git's log.
export function gitBinary(platform: NodeJS.Platform = process.platform, exists: (file: string) => boolean = fs.existsSync): string | null {
  const candidates = platform === "win32" ? ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\git.exe"]
    : ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];
  return candidates.find((file) => exists(file)) ?? null;
}

const git = (bin: string, repo: string, args: string[], env: NodeJS.ProcessEnv) => spawnSync(bin, ["-C", repo, ...args],
  { encoding: "utf8", env, timeout: GIT_TIMEOUT_MS, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });

async function liveRun(runtime: Runtime, o: Options, env: NodeJS.ProcessEnv, tmpRoot: string, resolve: NonNullable<Deps["resolve"]>,
  gitBin: string | null): Promise<Result> {
  const target = resolve(runtime);
  if (typeof target === "string") return { runtime, version: null, ...liveVerdict({ nonce: "", failure: target, timedOut: false, subjects: [], output: "" }) };
  const version = versionOf(target, env), nonce = crypto.randomBytes(6).toString("hex");
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "guard-canary-")));
  try {
    const setup = [["init", "-q"], ["config", "user.name", "Kherep canary"], ["config", "user.email", "canary@example.invalid"],
      ["config", "commit.gpgsign", "false"], ["commit", "-q", "--allow-empty", "-m", "kherep-canary-base"]];
    if (!gitBin || setup.some((args) => git(gitBin, repo, args, env).status !== 0)) {
      return { runtime, version, ...liveVerdict({ nonce, failure: "repo-setup-failed", timedOut: false, subjects: [], output: "" }) };
    }
    const run = await execute({ file: target.file, args: [...target.args, ...runtimeArgs(runtime, canaryPrompt(nonce), repo)] },
      { cwd: repo, env, timeoutMs: o.timeoutMs });
    const log = git(gitBin, repo, ["log", "--format=%s"], env);
    const subjects = log.status === 0 ? log.stdout.split(/\r?\n/).filter(Boolean) : null;
    return { runtime, version, ...liveVerdict({ nonce, failure: run.failure, timedOut: run.timedOut, subjects, output: run.stdout + run.stderr }) };
  } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3 }); }
}

// The installed PreToolUse command of the group that matches Bash and runs commit-guard, as argv.
function installedCommand(home: string): string[] | string {
  let settings: { hooks?: { PreToolUse?: unknown } } | null;
  try { settings = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8")); } catch { return "settings-unreadable"; }
  const groups = settings?.hooks?.PreToolUse;
  for (const group of Array.isArray(groups) ? groups as { matcher?: unknown; hooks?: unknown }[] : []) {
    let matches = false;
    try { matches = new RegExp(`^(?:${String(group?.matcher ?? "")})$`).test("Bash") || !group?.matcher; } catch { /* invalid matcher */ }
    for (const hook of matches && Array.isArray(group.hooks) ? group.hooks as { command?: unknown }[] : []) {
      if (typeof hook?.command === "string" && hook.command.includes("commit-guard.mts")) return argvOf(hook.command) ?? "installed-command-unreadable";
    }
  }
  return "installed-command-missing";
}

// A copy of <checkout>/claude/hooks in a scratch home; a fresh heartbeat keeps the dispatcher's integrity
// re-check (a notice, never a decision) out of the run, as claude/hooks/guard-dispatch-fixture.mts does.
function checkoutCommand(checkout: string, scratch: string): string[] | string {
  const hooks = path.join(checkout, "claude", "hooks");
  if (!fs.existsSync(path.join(hooks, "guard-dispatch.mts"))) return "dispatcher-missing";
  fs.cpSync(hooks, path.join(scratch, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(scratch, ".cache", "hook-integrity"), { recursive: true });
  fs.writeFileSync(path.join(scratch, ".cache", "hook-integrity", "heartbeat.json"), "{}\n");
  return ["node", path.join(scratch, "hooks", "guard-dispatch.mts"), path.join(scratch, "hooks", "commit-guard.mts")];
}

async function syntheticRun(source: "installed" | "checkout", o: Options, env: NodeJS.ProcessEnv, tmpRoot: string): Promise<Result> {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "guard-canary-home-")));
  try {
    const argv = source === "installed" ? installedCommand(o.home) : checkoutCommand(o.checkout!, scratch);
    const base = { runtime: "claude" as const, source, version: null };
    if (typeof argv === "string") return { ...base, ...syntheticVerdict({ failure: argv, timedOut: false, exitCode: null, stdout: "", stderr: "" }) };
    const event = JSON.stringify({ session_id: "guard-canary-synthetic", hook_event_name: "PreToolUse", tool_name: "Bash",
      tool_input: { command: `git commit --allow-empty -m "${BAD_PREFIX} synthetic ${EM_DASH} dash"` }, cwd: scratch });
    const [head, ...args] = argv;
    const file = /^node(\.exe)?$/i.test(head!) ? process.execPath : head!;
    return { ...base, ...syntheticVerdict(await execute({ file, args }, { cwd: scratch, env, timeoutMs: o.timeoutMs, input: event })) };
  } finally { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); }
}

function writeReport(home: string, report: object): string {
  const dir = path.join(home, ".cache", "guard-canary"), file = path.join(dir, "last-report.json"), staged = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(staged, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(staged, file);
  return file;
}

export async function main(argv: string[], deps: Deps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  try { return await runCanary(argv, deps, out); } catch { out("guard-canary: internal error"); return 2; }
}

async function runCanary(argv: string[], deps: Deps, out: (line: string) => void): Promise<number> {
  const env = deps.env ?? process.env, tmpRoot = deps.tmpRoot ?? os.tmpdir();
  const gitBin = deps.git === undefined ? gitBinary() : deps.git;
  const o = parseArgs(argv, env);
  if (typeof o === "string") { out(`guard-canary: ${o}`); out(USAGE); return 2; }
  const results: Result[] = [];
  if (o.synthetic) {
    results.push(await syntheticRun("installed", o, env, tmpRoot));
    if (o.checkout) results.push(await syntheticRun("checkout", o, env, tmpRoot));
  } else {
    for (const runtime of o.runtimes) results.push(await liveRun(runtime, o, env, tmpRoot, deps.resolve ?? ((r) => resolveRuntime(r, env)), gitBin));
  }
  const exitCode = overallExit(results);
  for (const r of results) {
    out(`guard-canary ${r.runtime}${r.source ? ` (${r.source})` : ""}: ${r.verdict} (${r.reason})`
      + (r.verdict === "ALLOWED" ? " - FAILURE: the guard let the known-bad commit through" : ""));
  }
  const report = { schema: 1, mode: o.synthetic ? "synthetic" : "live", timestamp: new Date().toISOString(), exitCode, results };
  try { out(`guard-canary: report ${writeReport(o.home, report)}`); } catch (error) { out(`guard-canary: report not written (${codeOf(error)})`); }
  return exitCode;
}

// Node loads the main module from its real path (see bootstrap/ci-shard.mts isMainModule).
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try { return import.meta.url === pathToFileURL(path.resolve(entry)).href || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href; }
  catch { return false; }
}

if (isMainModule()) void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
