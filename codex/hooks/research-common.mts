import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Exists } from "./research-transcript.mts";

export type EnvLike = Record<string, string | undefined>;
// Byte-identical to claude/hooks/lib/research-evidence.mts (#293).
export const RESEARCH_OPT_OUT = /\[\s*research\s*:\s*none\s*[\-\u2013\u2014]\s*[^\]\[\s][^\]\[\r\n]*\]/i;
const SPACE_KEY = /^[A-Za-z0-9~_-]{1,64}$/;

export function normalize(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\\/g, "/").replace(/(?<!\/)\/+$/, "");
}

export function workspaceFor(value: unknown, env: EnvLike = process.env): string {
  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? value as { cwd?: unknown } : null;
  const cwd = normalize(payload?.cwd);
  const configured = Object.hasOwn(env, "KHEREP_WORKSPACE")
    ? normalize(env.KHEREP_WORKSPACE) : normalize(path.join(env.USERPROFILE || env.HOME || os.homedir(), "Kherep"));
  if (!configured || !cwd) return "";
  const lowerCwd = cwd.toLowerCase();
  const lowerRoot = configured.toLowerCase();
  return lowerCwd === lowerRoot || lowerCwd.startsWith(`${lowerRoot}/`) ? configured : "";
}

export function codexConfigPath(env: EnvLike = process.env): string {
  const home = env.CODEX_HOME || path.join(env.USERPROFILE || env.HOME || os.homedir(), ".codex");
  return path.join(home, "kherep", "confluence.json");
}

export function spaceKeyFrom(configPath: string): string {
  try {
    const key = (JSON.parse(fs.readFileSync(configPath, "utf8")) as { spaceKey?: unknown }).spaceKey;
    if (typeof key === "string" && SPACE_KEY.test(key)) return key;
  } catch {
    // Missing and malformed configuration are represented by a fixed pointer.
  }
  return "<spaceKey from <CODEX_HOME>/kherep/confluence.json>";
}

function shellLiteral(value: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

export function brainSearchCommand(workspace: string, configPath: string): string {
  const windowsPath = /^[A-Za-z]:[\\/]/.test(workspace);
  const pathApi = windowsPath ? path.win32 : path.posix;
  const broker = pathApi.resolve(workspace, "tools", "atl-confluence.mts").replace(/\\/g, "/");
  return `node ${shellLiteral(broker, windowsPath ? "win32" : process.platform)} search --space ${spaceKeyFrom(configPath)} --query "<terms>"`;
}

export function gitRepositoryOf(target: unknown, exists: Exists = fs.existsSync): string {
  let current = normalize(target);
  while (current) {
    if (exists(`${current}/.git`)) return current;
    const slash = current.lastIndexOf("/");
    const parent = slash === 0 ? "/" : current.slice(0, slash);
    if (!parent || parent === current) return "";
    current = parent;
  }
  return "";
}
