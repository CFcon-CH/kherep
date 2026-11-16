// Issue #808, stage 2b. The live mode is exercised only against stub runtimes (node plus a script), never a
// real claude or codex: a real turn spends tokens. The synthetic mode runs this checkout's dispatcher.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pathToFileURL } from "node:url";

import { argvOf, canaryPrompt, codeOf, main, parseArgs, resolveRuntime, runtimeArgs, type Deps, type Resolved } from "./guard-canary.mts";
import { BAD_PREFIX, CONTROL_PREFIX, DENY_TEXT, EM_DASH } from "./guard-canary-verdict.mts";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO, "bootstrap", "guard-canary.mts");
const tmp = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

// One stub for both runtimes. GUARD_CANARY_STUB picks what the "model" does with the prompt's two commits.
const STUB = `const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("9.9.9 (stub) \\u0007"); process.exit(0); }
if (process.env.GUARD_CANARY_STUB_ARGS) fs.writeFileSync(process.env.GUARD_CANARY_STUB_ARGS, JSON.stringify({ args, cwd: process.cwd() }));
const mode = process.env.GUARD_CANARY_STUB || "nothing";
const prompt = args.find((arg) => arg.includes(${JSON.stringify(CONTROL_PREFIX)})) || "";
const messages = [...prompt.matchAll(/git commit --allow-empty -m "([^"]*)"/g)].map((m) => m[1]);
const commit = (message) => spawnSync("git", ["commit", "-q", "--allow-empty", "-m", message], { stdio: "ignore" });
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "wipe") fs.rmSync(".git", { recursive: true, force: true });
else {
  if (mode !== "nothing") commit(messages[0]);
  if (mode === "allowed") commit(messages[1]);
  if (mode === "denied") console.log(JSON.stringify({ type: "tool_result", content: "hook error: commit-guard blocked this commit:\\n  - " + ${JSON.stringify(DENY_TEXT)} }));
  else console.log("done");
}
`;

function stubFile(dir: string, name = "stub.cjs", shebang = ""): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${shebang}${STUB}`, { mode: 0o755 });
  return file;
}

interface Run { code: number; lines: string[]; home: string; tmpRoot: string; report: Record<string, unknown> | undefined }
async function inProcess(argv: string[], env: Record<string, string>, resolve?: Deps["resolve"], extra: Partial<Deps> = {}): Promise<Run> {
  const home = tmp("canary-home-"), tmpRoot = tmp("canary-tmp-"), lines: string[] = [];
  const stub = stubFile(tmp("canary-stub-"));
  const resolver = resolve ?? ((): Resolved => ({ file: process.execPath, args: [stub] }));
  const code = await main([...argv, "--home", home], { env: { ...process.env, ...env }, resolve: resolver, tmpRoot, out: (line) => lines.push(line), ...extra });
  const file = path.join(home, ".cache", "guard-canary", "last-report.json");
  const report = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> : undefined;
  return { code, lines, home, tmpRoot, report };
}
const results = (run: Run): Record<string, unknown>[] => run.report!.results as Record<string, unknown>[];

test("argument parsing", () => {
  const env = { HOME: "/h", USERPROFILE: "" };
  const parsed = parseArgs([], env);
  assert.ok(typeof parsed !== "string");
  assert.deepEqual(parsed.runtimes, ["claude", "codex"]);
  assert.equal(parsed.home, path.resolve("/h", ".claude"));
  assert.equal(parsed.timeoutMs, 300_000);
  assert.equal((parseArgs([], { CLAUDE_CONFIG_DIR: "/c" }) as { home: string }).home, path.resolve("/c"));
  assert.equal((parseArgs([], { USERPROFILE: "/u" }) as { home: string }).home, path.resolve("/u", ".claude"));
  assert.equal((parseArgs([], {}) as { home: string }).home, path.join(os.homedir(), ".claude"));
  const codexOnly = parseArgs(["--runtime", "codex", "--timeout", "5"], env) as { runtimes: string[]; timeoutMs: number };
  assert.deepEqual([codexOnly.runtimes, codexOnly.timeoutMs], [["codex"], 5_000]);
  const synthetic = parseArgs(["--synthetic", "--checkout", "rel"], env);
  assert.ok(typeof synthetic !== "string" && synthetic.synthetic && synthetic.checkout === path.resolve("rel"));
  assert.equal(synthetic.timeoutMs, 40_000);
  assert.deepEqual((parseArgs(["--synthetic"], env) as { runtimes: string[] }).runtimes, ["claude"]);
  for (const bad of [["--runtime", "gpt"], ["--runtime"], ["--bogus"], ["--timeout", "0"], ["--timeout", "x"], ["--home"],
    ["--checkout", "x"], ["--synthetic", "--runtime", "codex"], ["--synthetic", "--runtime", "both"]]) {
    assert.equal(typeof parseArgs(bad, env), "string", bad.join(" "));
  }
});

test("a runtime is found on PATH only, never in fallback directories", () => {
  const empty = tmp("canary-path-");
  assert.equal(resolveRuntime("claude", { PATH: empty }), "cli-missing");
  assert.equal(resolveRuntime("codex", { PATH: "" }), "cli-missing");
  assert.equal(resolveRuntime("codex", {}), "cli-missing");
  assert.equal(resolveRuntime("claude", { Path: empty }, { platform: "linux" }), "cli-missing");
  // A POSIX lookup needs a POSIX file system (executable bit); the Windows test below covers win32 hosts.
  if (process.platform === "win32") return;
  const dir = tmp("canary-path-");
  const file = stubFile(dir, "codex");
  assert.deepEqual(resolveRuntime("codex", { PATH: dir }, { platform: "linux" }), { file, args: [] });
});

test("Windows resolution: claude.exe directly, codex.cmd through its npm launcher, a bare shim refused", () => {
  const exe = path.win32.join("C:\\bin", "claude.exe");
  assert.deepEqual(resolveRuntime("claude", { PATH: "C:\\bin" }, { platform: "win32", exists: (f) => f === exe }), { file: exe, args: [] });
  assert.equal(resolveRuntime("claude", { PATH: "C:\\bin" }, { platform: "win32", exists: () => false }), "cli-missing");
  const dir = tmp("canary-win-");
  fs.writeFileSync(path.join(dir, "codex.cmd"), "@echo off\n");
  const deps = { platform: "win32" as const, exists: (f: string) => f.endsWith("codex.js") };
  const resolved = resolveRuntime("codex", { PATH: dir, PATHEXT: ".CMD" }, deps) as Resolved;
  assert.equal(resolved.file, process.execPath);
  assert.ok(resolved.args[0]!.endsWith("codex.js"));
  assert.equal(resolveRuntime("codex", { PATH: dir, PATHEXT: ".CMD" }, { ...deps, exists: () => false }), "cli-unusable");
});

test("an error is named by its Node code only, never its message", () => {
  assert.equal(codeOf(Object.assign(new Error("secret /path"), { code: "ENOENT" })), "ENOENT");
  assert.equal(codeOf(new Error("secret /path")), "unknown");
  assert.equal(codeOf({ code: "not a code" }), "unknown");
  assert.equal(codeOf(null), "unknown");
});

test("importing the module runs nothing, with no argv[1] or a nonexistent one", () => {
  for (const extra of [[], [path.join(os.tmpdir(), "no-such-guard-canary-entry")]]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})`, ...extra], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
});

test("installed command parsing: quoted and bare tokens, nothing else", () => {
  assert.deepEqual(argvOf('node "/a b/entry.mts" pretool "/h/guard-dispatch.mts"'), ["node", "/a b/entry.mts", "pretool", "/h/guard-dispatch.mts"]);
  assert.equal(argvOf('node "/unterminated'), null);
  assert.equal(argvOf("   "), null);
});

test("the live command lines carry only the minimal allowance, and the prompt never contains the deny text", () => {
  const prompt = canaryPrompt("n0nce");
  assert.ok(prompt.includes(`git commit --allow-empty -m "${CONTROL_PREFIX} n0nce"`));
  assert.ok(prompt.includes(`git commit --allow-empty -m "${BAD_PREFIX} n0nce ${EM_DASH} dash"`));
  assert.ok(!prompt.includes(DENY_TEXT) && !prompt.includes("U+2014"));
  const repo = path.join("/r", "repo");
  const claude = runtimeArgs("claude", prompt, repo);
  assert.deepEqual(claude.slice(0, 2), ["-p", prompt]);
  for (const arg of ["stream-json", "--verbose", "Bash(git commit *)", "--no-session-persistence", "--strict-mcp-config"]) assert.ok(claude.includes(arg), arg);
  assert.equal(claude[claude.indexOf("--permission-prompts") + 1], "none");
  assert.ok(!claude.some((arg) => /dangerously|bypass|--bare|--safe-mode/.test(arg)));
  const codex = runtimeArgs("codex", prompt, repo);
  assert.deepEqual(codex.slice(0, 3), ["exec", "--json", "--ephemeral"]);
  assert.equal(codex[codex.indexOf("-s") + 1], "workspace-write");
  assert.equal(codex[codex.indexOf("-c") + 1], `sandbox_workspace_write.writable_roots=[${JSON.stringify(path.join(repo, ".git"))}]`);
  assert.equal(codex[codex.indexOf("-C") + 1], repo);
  assert.equal(codex.at(-1), prompt);
  assert.ok(!codex.some((arg) => /dangerously|bypass/.test(arg)));
});

test("stub runtime makes the bad commit: ALLOWED, exit 1, loud", async () => {
  const run = await inProcess(["--runtime", "claude"], { GUARD_CANARY_STUB: "allowed" });
  assert.equal(run.code, 1);
  assert.deepEqual(results(run), [{ runtime: "claude", verdict: "ALLOWED", exitCode: 1, reason: "bad-commit-exists", version: "9.9.9 (stub)" }]);
  assert.ok(run.lines.some((line) => /ALLOWED.*FAILURE/.test(line)));
});

test("stub runtime does nothing: INCONCLUSIVE, exit 2", async () => {
  const run = await inProcess(["--runtime", "codex"], { GUARD_CANARY_STUB: "nothing" });
  assert.equal(run.code, 2);
  assert.equal(results(run)[0]!.reason, "no-control-commit");
});

test("stub runtime makes only the control commit and prints the deny text: DENIED, exit 0; temp repos removed; report has no payload", async () => {
  const argsFile = path.join(tmp("canary-args-"), "args.json");
  const run = await inProcess(["--runtime", "both"], { GUARD_CANARY_STUB: "denied", GUARD_CANARY_STUB_ARGS: argsFile });
  assert.equal(run.code, 0);
  assert.deepEqual(results(run).map((r) => [r.runtime, r.verdict, r.exitCode]), [["claude", "DENIED", 0], ["codex", "DENIED", 0]]);
  assert.deepEqual(fs.readdirSync(run.tmpRoot), []);
  const report = run.report!;
  assert.deepEqual(Object.keys(report).sort(), ["exitCode", "mode", "results", "schema", "timestamp"]);
  assert.equal(report.mode, "live");
  assert.ok(!Number.isNaN(Date.parse(report.timestamp as string)));
  const { args, cwd } = JSON.parse(fs.readFileSync(argsFile, "utf8")) as { args: string[]; cwd: string };
  const nonce = /kherep-canary-control (\w+)/.exec(args.join(" "))![1]!;
  const text = JSON.stringify(report);
  for (const value of [nonce, CONTROL_PREFIX, EM_DASH, DENY_TEXT, cwd, "git commit"]) assert.ok(!text.includes(value), value);
});

test("a runtime that destroys the repo leaves git log unreadable: INCONCLUSIVE, never DENIED", async () => {
  const run = await inProcess(["--runtime", "claude"], { GUARD_CANARY_STUB: "wipe" });
  assert.equal(run.code, 2);
  assert.equal(results(run)[0]!.reason, "git-log-unreadable");
});

test("a hanging runtime is killed at the timeout: INCONCLUSIVE", async () => {
  const run = await inProcess(["--runtime", "claude", "--timeout", "1"], { GUARD_CANARY_STUB: "hang" });
  assert.equal(run.code, 2);
  assert.equal(results(run)[0]!.reason, "timeout");
  assert.deepEqual(fs.readdirSync(run.tmpRoot), []);
});

test("a missing or unusable runtime is INCONCLUSIVE, and a runtime that cannot start too", async () => {
  const run = await inProcess(["--runtime", "both"], {}, (runtime) => runtime === "claude" ? "cli-missing" : { file: path.join(os.tmpdir(), "no-such-codex"), args: [] });
  assert.equal(run.code, 2);
  assert.deepEqual(results(run).map((r) => [r.reason, r.version]), [["cli-missing", null], [results(run)[1]!.reason, null]]);
  assert.match(results(run)[1]!.reason as string, /^spawn-failed:/);
});

test("no git on PATH: the throwaway repo cannot be set up, INCONCLUSIVE", { skip: process.platform === "win32" ? "an emptied PATH key is not the only Path key in a copied Windows environment" : false }, async () => {
  const run = await inProcess(["--runtime", "claude"], { GUARD_CANARY_STUB: "allowed" }, undefined, { git: null });
  assert.equal(run.code, 2);
  assert.equal(results(run)[0]!.reason, "repo-setup-failed");
  assert.deepEqual(fs.readdirSync(run.tmpRoot), []);
});

test("an unwritable report directory does not change the verdict", async () => {
  const home = tmp("canary-home-");
  fs.writeFileSync(path.join(home, ".cache"), "a file, not a directory");
  const stub = stubFile(tmp("canary-stub-")), lines: string[] = [];
  const code = await main(["--runtime", "claude", "--home", home], { env: { ...process.env, GUARD_CANARY_STUB: "denied" },
    resolve: () => ({ file: process.execPath, args: [stub] }), tmpRoot: tmp("canary-tmp-"), out: (line) => lines.push(line) });
  assert.equal(code, 0);
  assert.ok(lines.some((line) => /report not written \(E[A-Z]+\)/.test(line)));
});

test("a usage error exits 2 without a report", async () => {
  const run = await inProcess(["--runtime", "gpt"], {});
  assert.equal(run.code, 2);
  assert.equal(run.report, undefined);
  assert.ok(run.lines.some((line) => line.startsWith("usage:")));
});

// PATH stubs need a shebang; Windows resolves claude.exe and codex.cmd instead, covered in-process above.
const posixOnly = { skip: process.platform === "win32" ? "a PATH stub needs a shebang; Windows is covered by the in-process resolver tests" : false };
for (const [mode, runtime, code] of [["allowed", "claude", 1], ["nothing", "claude", 2], ["denied", "claude", 0], ["denied", "codex", 0]] as const) {
  test(`CLI with a stub ${runtime} on PATH that is ${mode}: exit ${code}`, posixOnly, () => {
    const bin = tmp("canary-bin-"), home = tmp("canary-home-");
    stubFile(bin, runtime, `#!${process.execPath}\n`);
    const result = spawnSync(process.execPath, [SCRIPT, "--runtime", runtime, "--home", home, "--timeout", "30"], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GUARD_CANARY_STUB: mode },
    });
    assert.equal(result.status, code, result.stdout + result.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(home, ".cache", "guard-canary", "last-report.json"), "utf8"));
    assert.equal(report.results[0].version, "9.9.9 (stub)");
  });
}
