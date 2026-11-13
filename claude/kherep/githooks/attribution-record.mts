#!/usr/bin/env node
// Issue #325, PR-A. The pre-push writer of the Kherep attribution log, run by
// the pre-push hook beside it: `node attribution-record.mts push <remote-url>
// <toplevel>` with git's pre-push lines on stdin. One record per pushed ref.
//
// It is installed into <CLAUDE_HOME>/kherep/githooks, away from the checkout, so
// it imports nothing. configRoot, repoSlug, markerKey, the session-id rule and
// the 90-day trim are copies of modules/control-plane/node/config.mts and
// attribution.mts; bootstrap/pre-push-hook.test.mts pins each copy to its
// original. The remote URL only yields owner/name: userinfo never reaches the log.
//
// Who pushed: CLAUDE_CODE_SESSION_ID (Claude Code), else KHEREP_SESSION_ID (a
// node-started Codex task), else a fresh marker a Codex PreToolUse hook left for
// this toplevel, else "unknown". Never fails: an error is one stderr line.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RETENTION_MS = 90 * 24 * 60 * 60_000;
const MARKER_MS = 120_000;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Copy of configRoot in modules/control-plane/node/config.mts.
export function configRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.KHEREP_CONFIG_DIR) return path.resolve(env.KHEREP_CONFIG_DIR);
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "kherep");
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "kherep");
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "kherep");
}

// Copy of repoSlug in attribution.mts.
export function repoSlug(url: string): string | null {
  const rest = url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, "").replace(/^[^/\\:][^/\\:@]*@[^:/]+:/, "");
  const parts = rest.split(/[\\/:]+/).filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts.at(-2)}/${parts.at(-1)!.replace(/\.git$/, "")}`;
}

// Copy of markerKey in attribution.mts.
export function markerKey(toplevel: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = toplevel.replace(/\\/g, "/").replace(/(?<!\/)\/+$/, "");
  return crypto.createHash("sha256").update(platform === "win32" ? normalized.toLowerCase() : normalized).digest("hex");
}

interface Session { sessionId: string; runtime: string; sessionSource: string }

// Reads and removes the marker for <toplevel>; only a fresh, valid one counts.
function takeMarker(dir: string, toplevel: string, now: number): Session | null {
  const file = path.join(dir, "attribution", "pending", `${markerKey(toplevel)}.json`);
  let marker: { sessionId?: unknown; runtime?: unknown; at?: unknown };
  try {
    marker = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.rmSync(file, { force: true });
  } catch {
    return null;
  }
  const age = now - Date.parse(String(marker?.at));
  if (!(age >= -5_000 && age <= MARKER_MS) || typeof marker.sessionId !== "string" || !SESSION_ID.test(marker.sessionId)
    || (marker.runtime !== "codex" && marker.runtime !== "claude")) return null;
  return { sessionId: marker.sessionId, runtime: marker.runtime, sessionSource: "marker" };
}

function session(env: NodeJS.ProcessEnv, dir: string, toplevel: string, now: number): Session {
  const claude = env.CLAUDE_CODE_SESSION_ID;
  if (claude && SESSION_ID.test(claude)) return { sessionId: claude, runtime: "claude", sessionSource: "CLAUDE_CODE_SESSION_ID" };
  const kherep = env.KHEREP_SESSION_ID;
  if (kherep && SESSION_ID.test(kherep)) return { sessionId: kherep, runtime: "codex", sessionSource: "KHEREP_SESSION_ID" };
  return takeMarker(dir, toplevel, now) ?? { sessionId: "unknown", runtime: "unknown", sessionSource: "none" };
}

// Copy of trimAttribution in attribution.mts.
function trim(file: string, now: number): void {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const kept = lines.filter((line) => {
    let at = Number.NaN;
    try { at = Date.parse((JSON.parse(line) as { ts?: unknown } | null)?.ts as string); } catch { /* unreadable */ }
    return now - (Number.isNaN(at) ? -Infinity : at) < RETENTION_MS;
  });
  if (kept.length === lines.length) return;
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, kept.map((line) => `${line}\n`).join(""), { mode: 0o600 });
  fs.renameSync(temp, file);
}

// git's pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>` per ref.
export function recordPush(remoteUrl: string, toplevel: string, stdin: string, env: NodeJS.ProcessEnv, now: number): number {
  const refs = stdin.split(/\r?\n/).map((line) => line.split(" ")).filter((fields) => fields.length === 4);
  if (!refs.length || !toplevel) return 0;
  const dir = path.join(configRoot(env), "control-plane");
  const who = session(env, dir, toplevel, now);
  const repo = repoSlug(remoteUrl);
  const ts = new Date(now).toISOString();
  const lines = refs.map(([localRef, sha, remoteRef]) => JSON.stringify({ v: 1, ts, kind: "push", ...who, repo, toplevel,
    branch: localRef!.startsWith("refs/heads/") ? localRef!.slice("refs/heads/".length) : null, remoteRef, sha, pr: null }));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "attribution.jsonl");
  fs.appendFileSync(file, lines.map((line) => `${line}\n`).join(""), { mode: 0o600 });
  trim(file, now);
  return lines.length;
}

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
  try {
    const [verb, remoteUrl = "", toplevel = ""] = process.argv.slice(2);
    const stdin = fs.readFileSync(0, "utf8");
    if (verb === "push") recordPush(remoteUrl, toplevel, stdin, process.env, Date.now());
  } catch (error) {
    process.stderr.write(`kherep pre-push: attribution not recorded: ${(error as Error).message ?? String(error)}\n`);
  }
  process.exitCode = 0;
}
