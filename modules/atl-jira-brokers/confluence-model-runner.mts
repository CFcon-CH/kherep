// Starts the small model of the calling runtime through its signed-in CLI
// (issue #1020): Haiku via `claude -p`, Luna via `codex exec`. The child gets an
// exact environment allowlist, a fixed empty working directory outside the
// workspace, the prompt on stdin, a 45 s limit and a process-tree kill.
import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { homedir as osHomedir, tmpdir } from "node:os";
import path, { posix, win32 } from "node:path";

import type { Runtime } from "./confluence-runtime-label.mts";
import { CODEX_DISABLED_FEATURES } from "./confluence-model-gates.mts";

export const MODEL_TIMEOUT_MS = 45_000;

// Forwarded when set, nothing else (design 4.4). CLAUDE_CODE_OAUTH_TOKEN,
// CLAUDE_CODE_ENTRYPOINT, CLAUDECODE, ANTHROPIC_*, OPENAI_*, KHEREP_* never are:
// a desktop-started parent carries CLAUDE_CODE_ENTRYPOINT=claude-desktop.
const WINDOWS_ENV = ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA",
  "LOCALAPPDATA", "PROGRAMDATA", "TEMP", "TMP", "USERNAME", "USERDOMAIN", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"];
const POSIX_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"];
const NETWORK_ENV = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]
  .flatMap((name) => [name, name.toLowerCase()]);

export function childEnv(runtime: Runtime, parent: Record<string, string | undefined>, platform: string): Record<string, string> {
  const own = runtime === "claude-code" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const fold = (name: string) => (platform === "win32" ? name.toUpperCase() : name);
  const allowed = new Set([...(platform === "win32" ? WINDOWS_ENV : POSIX_ENV), ...NETWORK_ENV, own].map(fold));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) if (value !== undefined && allowed.has(fold(name))) out[name] = value;
  return out;
}

export interface BinaryLookup {
  env?: Record<string, string | undefined>;
  platform?: string;
  homedir?: string;
  exists?: (candidate: string) => boolean;
}

const isFile = (candidate: string) => statSync(candidate, { throwIfNoEntry: false })?.isFile() === true;

// As resolveTwg: override, PATH, known install location. A set but unusable
// override fails closed. On Windows only the .exe qualifies: the npm shim
// (claude.cmd) would need a shell. macOS install locations beyond PATH and
// ~/.local/bin are UNKNOWN (design 4.1, 4.2).
export function resolveModelCli(runtime: Runtime, lookup: BinaryLookup = {}): string {
  const env = lookup.env ?? process.env;
  const platform = lookup.platform ?? process.platform;
  const home = lookup.homedir ?? osHomedir();
  const exists = lookup.exists ?? isFile;
  const paths = platform === "win32" ? win32 : posix;
  const base = runtime === "claude-code" ? "claude" : "codex";
  const variable = runtime === "claude-code" ? "KHEREP_CLAUDE_BIN" : "KHEREP_CODEX_BIN";
  const explicit = env[variable];
  if (explicit !== undefined) {
    if (!paths.isAbsolute(explicit) || !exists(explicit)) throw new Error(`${variable} is not an absolute path to an existing file`);
    return explicit;
  }
  const name = platform === "win32" ? `${base}.exe` : base;
  const onPath = String(env.PATH ?? env.Path ?? "").split(paths.delimiter).filter(Boolean).map((entry) => paths.join(entry, name));
  let installed: string;
  if (platform !== "win32") installed = paths.join(home, ".local", "bin", name);
  else if (runtime === "claude-code") {
    installed = paths.join(env.APPDATA || paths.join(home, "AppData", "Roaming"), "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", name);
  } else installed = paths.join(env.LOCALAPPDATA || paths.join(home, "AppData", "Local"), "Programs", "OpenAI", "Codex", "bin", name);
  const found = [...onPath, installed].find(exists);
  if (!found) throw new Error(`${base} not found on ${variable}, PATH or the install location`);
  return found;
}

export function claudeArgs(systemPrompt: string): string[] {
  return ["-p", "--safe-mode", "--tools", "", "--no-session-persistence", "--model", "haiku", "--effort", "medium",
    "--output-format", "json", "--system-prompt", systemPrompt];
}

export function codexArgs(o: { cwd: string; model: string; effort: string; schema: string; out: string }): string[] {
  return ["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "-s", "read-only",
    "-C", o.cwd, "-m", o.model, "-c", `model_reasoning_effort="${o.effort}"`, "-c", "project_doc_max_bytes=0",
    "-c", 'web_search="disabled"', ...CODEX_DISABLED_FEATURES.flatMap((name) => ["--disable", name]),
    "--json", "--output-schema", o.schema, "-o", o.out, "-"];
}

// The workspace the broker runs in: the git top-level of the working
// directory, or the directory itself when it is in no repository.
export function workspaceRoot(start: string = process.cwd(), exists: (file: string) => boolean = existsSync): string {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (exists(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return path.resolve(start);
  }
}

// Where the model directory may live: the temp directory, and on Windows a
// per-user directory under ProgramData for the case where %TEMP% lies inside
// the workspace (a session started in the home folder).
export function modelCwdCandidates(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string[] {
  const user = (env.USERNAME ?? env.USER ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  return platform === "win32" && env.ProgramData && user ? [tmpdir(), path.join(env.ProgramData, "kherep", user)] : [tmpdir()];
}

// One directory per user, reused, never written to. A file in it could be an
// AGENTS.md or CLAUDE.md planted as instructions, so it must be empty, and it
// must lie outside the workspace the broker runs in. The first candidate
// outside the workspace is used; with none, the search does not run.
export async function modelCwd(candidates: string[] = modelCwdCandidates(), workspace: string = workspaceRoot()): Promise<string> {
  const root = await realpath(workspace).catch(() => path.resolve(workspace));
  const outside = (dir: string) => {
    const relative = path.relative(root, dir);
    return Boolean(relative) && (relative.startsWith("..") || path.isAbsolute(relative));
  };
  const base = candidates.map((candidate) => path.resolve(candidate)).find((candidate) => outside(path.join(candidate, "kherep-model-cwd")));
  if (!base) throw new Error("no model working directory lies outside the workspace");
  const dir = path.join(base, "kherep-model-cwd");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // The directory may already exist: under a shared /tmp another user could have
  // made it, writable for them or as a link to one they own, and fill it after
  // the emptiness check. Only a plain directory this user owns, that nobody
  // else may write to, is used. Windows reports no owner here; there the
  // per-user temp directory is the first candidate.
  const info = await lstat(dir);
  if (!info.isDirectory()) throw new Error("the model working directory is not a plain directory");
  if (typeof process.getuid === "function" && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0)) {
    throw new Error("the model working directory is not private to this user");
  }
  if ((await readdir(dir)).length) throw new Error("the model working directory is not empty");
  const real = await realpath(dir);
  if (!outside(real)) throw new Error("the model working directory lies inside the workspace");
  return real;
}

export interface ChildResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export interface ChildRun { file: string; args: string[]; env: Record<string, string>; cwd: string; stdin: string; timeoutMs: number }
export type SpawnModel = (run: ChildRun) => Promise<ChildResult>;
export type KillTree = (pid: number) => void;

// Windows: taskkill /T ends the child's helpers too. Elsewhere the child leads
// its own process group, and the group is signalled.
export const killTree: KillTree = (pid) => {
  if (process.platform === "win32") execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
  else { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }
};

export function spawnModel(kill: KillTree = killTree): SpawnModel {
  return (run) => new Promise((resolve) => {
    const child = spawn(run.file, run.args, {
      cwd: run.cwd, env: run.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
    });
    let stdout = "", stderr = "", timedOut = false, done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) kill(child.pid);
      finish(null);
    }, run.timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { stderr += String(error.message); finish(-1); });
    child.on("close", (code) => finish(code));
    child.stdin?.on("error", () => {});
    child.stdin?.end(run.stdin);
  });
}

export type Parsed = { text: string; model: string; usage: string } | { error: string };

const firstLine = (text: string) => text.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 160) ?? "";

// The Claude JSON envelope (probe P4): `result` holds the answer and
// `modelUsage` names the served model per key. Every key must be a Haiku id; a
// fallback model is never accepted silently.
interface ClaudeUsage { inputTokens?: number; outputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number }
interface ClaudeEnvelope { is_error?: unknown; result?: unknown; subtype?: unknown; api_error_status?: unknown; modelUsage?: Record<string, ClaudeUsage> }

export function parseClaude(result: ChildResult): Parsed {
  let envelope: ClaudeEnvelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    return { error: `claude exited with code ${result.code}${result.stderr ? `: ${firstLine(result.stderr)}` : ""}` };
  }
  if (result.code !== 0 || envelope.is_error === true) {
    const category = [envelope.subtype, envelope.api_error_status].filter((value) => value !== undefined && value !== null).join(" ");
    return { error: `claude exited with code ${result.code}${category ? ` (${category})` : ""}` };
  }
  const models = Object.keys(envelope.modelUsage ?? {});
  if (!models.length || models.some((model) => !model.startsWith("claude-haiku-"))) {
    return { error: `the served model is not a Haiku id: ${models.join(",") || "none reported"}` };
  }
  const use = envelope.modelUsage![models[0]];
  const input = (use.inputTokens ?? 0) + (use.cacheCreationInputTokens ?? 0) + (use.cacheReadInputTokens ?? 0);
  return { text: String(envelope.result ?? ""), model: models[0], usage: `in=${input} out=${use.outputTokens ?? 0}` };
}

// The `codex exec --json` event stream (probe P7): any item other than the
// agent message or a reasoning item is a tool the child used.
export function codexEvents(stdout: string): { usage: string } | { error: string } {
  let usage = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: { type?: string; item?: { type?: string }; usage?: { input_tokens?: number; output_tokens?: number } };
    try { event = JSON.parse(line); } catch { return { error: "the codex event stream is unreadable" }; }
    const kind = event.item?.type;
    if (kind && kind !== "agent_message" && kind !== "reasoning") return { error: `the model child used a tool (${kind})` };
    if (event.usage) usage = `in=${event.usage.input_tokens ?? 0} out=${event.usage.output_tokens ?? 0}`;
  }
  return { usage };
}
