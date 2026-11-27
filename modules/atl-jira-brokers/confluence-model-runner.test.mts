// Tests for the model child (issue #1020): exact argv per runtime, the exact
// environment allowlist, the binary resolver, output parsing and a real
// process-tree kill on timeout.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CODEX_DISABLED_FEATURES } from "./confluence-model-gates.mts";
import { childEnv, claudeArgs, codexArgs, codexEvents, modelCwd, modelCwdCandidates, parseClaude, resolveModelCli, spawnModel, workspaceRoot } from "./confluence-model-runner.mts";
import { claudeEnvelope, codexStream } from "./semantic-model.fixture.mts";

test("Claude argv: safe mode, an empty tool list, no session file, Haiku at medium effort; no --json-schema, no --bare", () => {
  const args = claudeArgs("SYSTEM");
  assert.deepEqual(args, ["-p", "--safe-mode", "--tools", "", "--no-session-persistence", "--model", "haiku", "--effort", "medium",
    "--output-format", "json", "--system-prompt", "SYSTEM"]);
  assert.equal(args.includes("--json-schema"), false);
  assert.equal(args.includes("--bare"), false);
});

test("Codex argv: every pinned --disable name, no project doc, effort from the receipt, no -c features.*", () => {
  const args = codexArgs({ cwd: "C:\\cwd", model: "gpt-6-luna", effort: "medium", schema: "s.json", out: "o.json" });
  for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--json"]) assert.ok(args.includes(flag), flag);
  assert.deepEqual(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2), ["-s", "read-only"]);
  assert.deepEqual(args.slice(args.indexOf("-C"), args.indexOf("-C") + 4), ["-C", "C:\\cwd", "-m", "gpt-6-luna"]);
  for (const value of ['model_reasoning_effort="medium"', "project_doc_max_bytes=0", 'web_search="disabled"']) assert.ok(args.includes(value), value);
  for (const name of CODEX_DISABLED_FEATURES) assert.ok(args.join(" ").includes(`--disable ${name}`), name);
  for (const name of ["hooks", "shell_tool", "apps", "plugins", "browser_use", "computer_use", "multi_agent"]) assert.ok(CODEX_DISABLED_FEATURES.includes(name as never));
  assert.equal(args.some((a) => a.startsWith("features.")), false);
  assert.deepEqual(args.slice(-5), ["--output-schema", "s.json", "-o", "o.json", "-"]);
});

test("child env: exactly the allowlist; desktop-started parents (CLAUDE_CODE_ENTRYPOINT=claude-desktop) and credential variables never pass", () => {
  const parent = {
    PATH: "p", SystemRoot: "r", USERPROFILE: "u", TEMP: "t", APPDATA: "a", LOCALAPPDATA: "l",
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop", CLAUDECODE: "1", CLAUDE_CODE_OAUTH_TOKEN: "x", CLAUDE_CODE_SIMPLE: "1",
    ANTHROPIC_BASE_URL: "x", ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "x", AI_AGENT: "x", KHEREP_ATL_CRED_FILE_CLAUDE: "x",
    CLAUDE_CONFIG_DIR: "c", CODEX_HOME: "h", https_proxy: "hp", HOME: "posix-only",
  };
  const claude = childEnv("claude-code", parent, "win32");
  assert.deepEqual(Object.keys(claude).sort(), ["APPDATA", "CLAUDE_CONFIG_DIR", "LOCALAPPDATA", "PATH", "SystemRoot", "TEMP", "USERPROFILE", "https_proxy"]);
  const codex = childEnv("codex", parent, "win32");
  assert.equal("CLAUDE_CONFIG_DIR" in codex, false);
  assert.equal(codex.CODEX_HOME, "h");
  const mac = childEnv("claude-code", parent, "darwin");
  assert.deepEqual(Object.keys(mac).sort(), ["CLAUDE_CONFIG_DIR", "HOME", "PATH", "https_proxy"]);
  for (const env of [claude, codex, mac]) {
    for (const name of ["CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "AI_AGENT", "OPENAI_API_KEY"]) {
      assert.equal(name in env, false, name);
    }
  }
});

test("resolver: override, then PATH (.exe only on Windows), then the install location; an unusable override fails closed", () => {
  const seen = new Set(["C:\\bin\\claude.exe", "C:\\Users\\u\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe"]);
  const lookup = { platform: "win32", homedir: "C:\\Users\\u", exists: (p: string) => seen.has(p) };
  assert.equal(resolveModelCli("claude-code", { ...lookup, env: { PATH: "C:\\bin" } }), "C:\\bin\\claude.exe");
  assert.equal(resolveModelCli("codex", { ...lookup, env: { PATH: "C:\\bin" } }), "C:\\Users\\u\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe");
  assert.throws(() => resolveModelCli("claude-code", { ...lookup, env: { KHEREP_CLAUDE_BIN: "C:\\missing.exe", PATH: "C:\\bin" } }), /KHEREP_CLAUDE_BIN is not an absolute path/);
  assert.throws(() => resolveModelCli("codex", { ...lookup, env: { KHEREP_CODEX_BIN: "relative.exe" } }), /KHEREP_CODEX_BIN/);
  assert.throws(() => resolveModelCli("claude-code", { ...lookup, exists: () => false, env: {} }), /claude not found/);
});

test("parseClaude: result text, served Haiku id and usage; non-Haiku, errors and garbage are errors", () => {
  assert.deepEqual(parseClaude({ code: 0, stdout: claudeEnvelope('{"ranked":[1]}'), stderr: "", timedOut: false }),
    { text: '{"ranked":[1]}', model: "claude-haiku-5-5", usage: "in=2502 out=30" });
  assert.match((parseClaude({ code: 0, stdout: claudeEnvelope("x", "claude-opus-5-5"), stderr: "", timedOut: false }) as { error: string }).error, /not a Haiku id: claude-opus-5-5/);
  assert.match((parseClaude({ code: 2, stdout: "", stderr: "Not logged in\n", timedOut: false }) as { error: string }).error, /exited with code 2: Not logged in/);
});

test("codexEvents: agent message and reasoning pass, any other item is tool use", () => {
  assert.deepEqual(codexEvents(codexStream(["reasoning", "agent_message"])), { usage: "in=900 out=40" });
  for (const kind of ["command_execution", "mcp_tool_call", "web_search", "file_change"]) {
    assert.deepEqual(codexEvents(codexStream([kind])), { error: `the model child used a tool (${kind})` });
  }
});

test("modelCwd: created empty and reused; a planted file or a path inside the workspace is refused", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "kherep-cwd-test-"));
  const dir = await modelCwd([tmp], path.join(tmp, "elsewhere"));
  assert.equal(await modelCwd([tmp], path.join(tmp, "elsewhere")), dir);
  await assert.rejects(modelCwd([tmp], tmp), /no model working directory lies outside the workspace/);
  writeFileSync(path.join(dir, "CLAUDE.md"), "planted");
  await assert.rejects(modelCwd([tmp], path.join(tmp, "elsewhere")), /not empty/);
});

test("modelCwd: a session in the home folder falls back to the next candidate; a drive root fails closed", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "kherep-cwd-home-"));
  const home = path.join(root, "Users", "u"), temp = path.join(home, "AppData", "Local", "Temp"), shared = path.join(root, "ProgramData", "kherep", "u");
  mkdirSync(temp, { recursive: true });
  const chosen = await modelCwd([temp, shared], home);
  assert.equal(chosen, await realpath(path.join(shared, "kherep-model-cwd")), "%TEMP% lies under the home folder, so the ProgramData candidate is used");
  await assert.rejects(modelCwd([temp, shared], root), /no model working directory lies outside the workspace/, "a drive root contains every candidate");
  assert.deepEqual(modelCwdCandidates({ ProgramData: "C:\\ProgramData", USERNAME: "u" }, "win32").slice(1), [path.join("C:\\ProgramData", "kherep", "u")]);
  assert.equal(modelCwdCandidates({ ProgramData: "C:\\ProgramData", USERNAME: "u" }, "darwin").length, 1);
});

test("workspaceRoot: the git top-level of the working directory, else the directory itself", () => {
  const repo = path.resolve("/r/repo"), seen = new Set([path.join(repo, ".git")]);
  assert.equal(workspaceRoot(path.join(repo, "a", "b"), (file) => seen.has(file)), repo);
  assert.equal(workspaceRoot(path.resolve("/home/u"), () => false), path.resolve("/home/u"));
});

test("spawnModel: prompt on stdin; on timeout the whole tree is killed and no grandchild survives", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kherep-kill-test-"));
  mkdirSync(path.join(dir, "cwd"));
  const echo = await spawnModel()({ file: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], env: { ...process.env } as Record<string, string>, cwd: path.join(dir, "cwd"), stdin: "-q data", timeoutMs: 20_000 });
  assert.deepEqual([echo.code, echo.stdout, echo.timedOut], [0, "-q data", false]);
  const pidFile = path.join(dir, "grandchild.pid");
  const parentScript = `const {spawn}=require("node:child_process");const g=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(g.pid));setInterval(()=>{},1000);`;
  const slow = await spawnModel()({ file: process.execPath, args: ["-e", parentScript], env: { ...process.env } as Record<string, string>, cwd: path.join(dir, "cwd"), stdin: "", timeoutMs: 1500 });
  assert.equal(slow.timedOut, true);
  const pid = Number((await import("node:fs")).readFileSync(pidFile, "utf8"));
  let alive = true;
  for (let i = 0; i < 40 && alive; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    try { process.kill(pid, 0); } catch { alive = false; }
  }
  if (alive) spawnSync(process.platform === "win32" ? "taskkill" : "kill", process.platform === "win32" ? ["/PID", String(pid), "/F"] : ["-9", String(pid)]);
  assert.equal(alive, false, "the grandchild survived the tree kill");
});
