import childProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fullyQualifiedPath, requireTrustedExecutable, type ExecutableLookup } from "../../claude/hooks/lib/trusted-executable.mts";

function quoteWindowsArgument(value: string) {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function resolveCodexCommand(options: ExecutableLookup = {}) {
  return requireTrustedExecutable("codex", { ...options, preferNative: true });
}

export function codexInvocation(command: string, args: string[], platform: string = process.platform,
  comSpec = process.env.ComSpec || "", systemRoot = process.env.SystemRoot || process.env.WINDIR || "") {
  if (platform !== "win32") return { command, args };
  if (!fullyQualifiedPath(command, platform)) throw new Error("Codex executable must have an absolute path");
  const extension = path.win32.extname(command).toLowerCase();
  if ([".exe", ".com"].includes(extension) && !/[\\/]WindowsApps[\\/]/i.test(command)) {
    return { command, args };
  }
  const commandLine = [command, ...args].map(quoteWindowsArgument).join(" ");
  const shell = comSpec || path.win32.join(systemRoot, "System32", "cmd.exe");
  if (!fullyQualifiedPath(shell, platform)) throw new Error("Codex shell must have an absolute path");
  return {
    command: shell,
    args: ["/d", "/s", "/c", commandLine],
  };
}

export function codexEnvironment(
  codexHome?: string,
  platform: string = process.platform,
  environment = process.env,
  home = os.homedir(),
) {
  const requestedHome = codexHome || environment.CODEX_HOME;
  const platformPath = platform === "win32" ? path.win32 : path;
  if (platform === "win32" && requestedHome &&
      platformPath.resolve(requestedHome) === platformPath.resolve(home, ".codex")) {
    const cleaned = { ...environment };
    delete cleaned.CODEX_HOME;
    return cleaned;
  }
  return codexHome ? { ...environment, CODEX_HOME: codexHome } : environment;
}

// A command whose stdout is a document to parse (--json) asks for stdout only:
// Codex prints warnings to stderr, for example when CODEX_HOME lies under a
// temporary directory, and appending them breaks JSON.parse (#55).
export function codexOutput(stdout: string | null | undefined, stderr: string | null | undefined, stdoutOnly = false) {
  return (stdoutOnly ? stdout || "" : `${stdout || ""}\n${stderr || ""}`).trim();
}

export function runCodex(args: string[], options: { cwd?: string; codexHome?: string; stdoutOnly?: boolean } = {}) {
  const command = resolveCodexCommand({ cwd: options.cwd });
  const invocation = codexInvocation(command, args);
  const result = childProcess.spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: codexEnvironment(options.codexHome),
    stdio: [process.platform === "win32" ? "inherit" : "ignore", "pipe", "pipe"],
    windowsHide: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(`codex ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return codexOutput(result.stdout, result.stderr, options.stdoutOnly);
}
