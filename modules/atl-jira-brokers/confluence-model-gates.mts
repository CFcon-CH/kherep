// The checks that run before a model child may start (issue #1020). Each one
// fails closed with its own reason: a child that cannot be proven to run the
// expected model, tool-free, never starts, and no other backend is tried.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import path from "node:path";

// code.claude.com/docs/en/model-config.md: "Use v2.1.293 or later with Haiku 5.5."
export const MIN_CLAUDE_CLI = "2.1.293";

// The Codex features that offer the child a tool or start a process beside it.
// Every name must be listed by `codex features list` on the host before the
// child starts; none is skipped silently and none is passed as -c features.*.
export const CODEX_DISABLED_FEATURES = [
  "hooks", "shell_tool", "apps", "plugins", "browser_use", "computer_use", "multi_agent",
  "unified_exec", "image_generation", "view_image", "sleep_tool", "tool_suggest", "skill_search",
  "remote_plugin", "goals", "daemon_auto_start", "browser_use_external", "browser_use_full_cdp_access",
] as const;

export type GateExec = (file: string, args: string[]) => Promise<{ stdout: string }>;
export type Gate = { version: string } | { error: string };

const message = (error: unknown) => String((error as Error)?.message ?? error).split("\n")[0].slice(0, 200);

export function versionAtLeast(found: string, minimum: string): boolean {
  const a = found.split(".").map(Number), b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

async function versionOf(exec: GateExec, bin: string, cli: string): Promise<Gate> {
  let stdout: string;
  try {
    ({ stdout } = await exec(bin, ["--version"]));
  } catch (error) {
    return { error: `${cli} CLI version is unreadable: ${message(error)}` };
  }
  const found = /\d+\.\d+\.\d+/.exec(stdout)?.[0];
  return found ? { version: found } : { error: `${cli} CLI version is unreadable` };
}

export async function claudeGate(exec: GateExec, bin: string): Promise<Gate> {
  const gate = await versionOf(exec, bin, "claude");
  if ("error" in gate || versionAtLeast(gate.version, MIN_CLAUDE_CLI)) return gate;
  return { error: `claude CLI ${gate.version} is older than ${MIN_CLAUDE_CLI}, which Haiku 5.5 needs; run claude update` };
}

export async function codexGate(exec: GateExec, bin: string, names: readonly string[] = CODEX_DISABLED_FEATURES): Promise<Gate> {
  const [gate, listed] = await Promise.all([
    versionOf(exec, bin, "codex"),
    exec(bin, ["features", "list"]).then(({ stdout }) => stdout, (error: unknown) => ({ error: message(error) })),
  ]);
  if ("error" in gate) return gate;
  if (typeof listed !== "string") return { error: `codex feature list is unreadable: ${listed.error}` };
  const known = new Set(listed.split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]).filter(Boolean));
  const missing = names.find((name) => !known.has(name));
  if (missing) return { error: `codex CLI ${gate.version} does not list feature "${missing}"; the tool-free child cannot be guaranteed` };
  return gate;
}

// One resolver for the Codex home, shared with observation-stdio.mts.
export function codexHome(env: Record<string, string | undefined>, homedir: string = osHomedir()): string {
  return path.resolve(env.CODEX_HOME || path.join(homedir, ".codex"));
}

export type LunaSelection = { model: string; effort: string } | { error: string };

// The managed model policy is the one place that picks the Luna id and effort.
// The anchor is written last and pins the exact receipt, so the receipt is
// trusted only when its bytes hash to the anchor's value (issue #737).
export function lunaSelection(home: string, read: (file: string) => Buffer = readFileSync): LunaSelection {
  let anchor: { receipt?: { target?: unknown; sha256?: unknown } };
  try {
    anchor = JSON.parse(read(path.join(home, "orchestra", "model-selection-anchor.json")).toString("utf8"));
  } catch {
    return { error: "the Codex model-selection anchor is missing or unreadable" };
  }
  const target = anchor?.receipt?.target, sha = anchor?.receipt?.sha256;
  if (typeof target !== "string" || typeof sha !== "string" || path.isAbsolute(target) || target.split(/[\\/]/).includes("..")) {
    return { error: "the Codex model-selection anchor is missing or unreadable" };
  }
  let bytes: Buffer;
  try {
    bytes = read(path.join(home, target));
  } catch {
    return { error: "the Codex model-selection receipt is missing or unreadable" };
  }
  if (createHash("sha256").update(bytes).digest("hex") !== sha) {
    return { error: "the Codex model-selection receipt does not match its anchor hash" };
  }
  let effective: { model?: unknown; effort?: unknown } | undefined;
  try {
    effective = JSON.parse(bytes.toString("utf8"))?.resolution?.roles?.broker?.effective;
  } catch {
    return { error: "the Codex model-selection receipt is missing or unreadable" };
  }
  const model = effective?.model, effort = effective?.effort;
  if (typeof model !== "string" || !/^gpt-\d+(?:\.\d+)?-luna$/.test(model)) {
    return { error: "the Codex model-selection receipt names no Luna model for the broker role" };
  }
  if (typeof effort !== "string" || !/^[a-z]+$/.test(effort)) {
    return { error: "the Codex model-selection receipt names no effort for the broker role" };
  }
  return { model, effort };
}
