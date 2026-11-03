#!/usr/bin/env node
// Issue #748. Recorder of the weekly usage watcher, a CLI the status line starts detached,
// never wired as a hook (hook integrity does not restore it; the installers do):
//   node "<CLAUDE_HOME>/hooks/usage-record.mts" --used <number> --resets-at <epoch-seconds|iso>
//        [--home <dir>] [--now <epoch-ms>]
// It evaluates the documented rate_limits.seven_day window, shows at most one notification
// per condition per reset window (exclusive-create markers; a Windows toast, or on macOS
// osascript's display notification, issue #757), and writes
// <home>/.cache/usage-watch/state.json for hooks/usage-watch.mts, then last-input, the
// throttle the status line compares. Every failure prints one line to stderr and exits 0.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  CONDITIONS, evaluate, parseState, parseWindow, toastText, windowKey, type Condition, type UsageState,
} from "./lib/usage-window.mts";

export const TOAST_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

type Env = Record<string, string | undefined>;

export interface RecordArgs { used?: string; resetsAt?: string; home?: string; now?: string }

export function parseArgs(argv: readonly string[]): RecordArgs {
  const flags: Record<string, keyof RecordArgs> = { "--used": "used", "--resets-at": "resetsAt", "--home": "home", "--now": "now" };
  const out: RecordArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const key = flags[argv[i]];
    if (key && i + 1 < argv.length) out[key] = argv[++i];
  }
  return out;
}

const xmlEscape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Windows PowerShell 5.1 loads the WinRT toast types; pwsh 7 cannot. -EncodedCommand avoids
// every quoting problem between Node, Git Bash and PowerShell.
export function toastArgs(title: string, body: string): string[] {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text></binding></visual></toast>`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$xml.LoadXml('${xml}')`,
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${TOAST_APP_ID}').Show($toast)`,
  ].join("\n");
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

function powershellPath(env: Env): string {
  const full = path.join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(full) ? full : "powershell.exe";
}

// The AppleScript string literal takes \ and " escaped; the command is argv, never a shell.
const appleEscape = (text: string) => text.replace(/[\\"]/g, (c) => `\\${c}`);

export function notifierArgs(platform: "win32" | "darwin", title: string, body: string, env: Env = process.env): { command: string; args: string[] } {
  if (platform === "win32") return { command: powershellPath(env), args: toastArgs(title, body) };
  return { command: "osascript", args: ["-e", `display notification "${appleEscape(body)}" with title "${appleEscape(title)}"`] };
}

// "sent" or "skipped:<reason>". KHEREP_USAGE_TOAST_LOG is the test seam: it records the
// toast instead of showing it, on every platform.
export function deliverToast(text: { title: string; body: string }, env: Env = process.env, platform: string = process.platform): string {
  if (env.KHEREP_USAGE_TOAST === "0") return "skipped:disabled";
  if (env.KHEREP_USAGE_TOAST_LOG) {
    fs.appendFileSync(env.KHEREP_USAGE_TOAST_LOG, `${text.title}\t${text.body}\n`, "utf8");
    return "sent";
  }
  if (platform !== "win32" && platform !== "darwin") return "skipped:platform";
  const { command, args } = notifierArgs(platform, text.title, text.body, env);
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => { /* a toast that cannot start is not worth an error */ });
  child.unref();
  return "sent";
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// temp + rename, so the hook never reads a half-written file; Windows refuses the rename
// with EPERM or EBUSY while a reader holds the target, then a direct write follows.
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    fs.rmSync(tmp, { force: true });
    if (code !== "EPERM" && code !== "EBUSY") throw error;
    fs.writeFileSync(file, text, "utf8");
  }
}

function removeOtherMarkers(dir: string, key: string): void {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith("toast-") && !name.startsWith(`toast-${key}-`)) fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    /* best effort */
  }
}

// Claims the marker of one condition exclusively. Returns the ISO time of a toast another
// recorder already sent, "claimed" when this run owns the toast, or null when it failed.
function claim(marker: string): string | null {
  try {
    fs.closeSync(fs.openSync(marker, "wx"));
    return "claimed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
    try {
      return fs.statSync(marker).mtime.toISOString();
    } catch {
      return new Date().toISOString();
    }
  }
}

export function record(args: RecordArgs, env: Env = process.env, platform: string = process.platform): { out: string; err: string } {
  const window = parseWindow(args.used, args.resetsAt);
  if (!window) return { out: "", err: "usage-record: no weekly window in input\n" };
  const nowArg = Number(args.now);
  const now = Number.isFinite(nowArg) ? nowArg : Date.now();
  const home = args.home || env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
  const dir = path.join(home, ".cache", "usage-watch");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const verdict = evaluate(window, now);
  const key = windowKey(window.resetsAt);
  const previous = parseState(readText(path.join(dir, "state.json")));
  const sameWindow = previous?.window_key === key;
  const notified: UsageState["notified"] = sameWindow && previous ? { ...previous.notified } : {};
  if (!sameWindow) removeOtherMarkers(dir, key);

  const toasted: Condition[] = [];
  for (const condition of CONDITIONS) {
    if (!verdict[condition] || notified[condition]) continue;
    const marker = path.join(dir, `toast-${key}-${condition}`);
    const claimed = claim(marker);
    if (claimed === null) continue;
    if (claimed !== "claimed") {
      notified[condition] = claimed;
      continue;
    }
    let delivered: string;
    try {
      delivered = deliverToast(toastText(verdict, condition), env, platform);
    } catch {
      delivered = "skipped:error";
    }
    if (delivered === "sent") {
      notified[condition] = new Date(now).toISOString();
      toasted.push(condition);
    } else {
      fs.rmSync(marker, { force: true });
    }
  }

  const state: UsageState = {
    v: 1, window_key: key, resets_at: window.resetsAt, used_percentage: window.used,
    elapsed_percentage: verdict.elapsed, observed_at: new Date(now).toISOString(),
    conditions: { threshold: verdict.threshold, pace: verdict.pace }, notified,
  };
  writeAtomic(path.join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  writeAtomic(path.join(dir, "last-input"), `${args.used}|${args.resetsAt}\n`);
  const yes = (b: boolean) => (b ? "yes" : "no");
  return {
    out: `usage-record: used ${Math.round(verdict.used)}% elapsed ${Math.round(verdict.elapsed)}% threshold=${yes(verdict.threshold)} pace=${yes(verdict.pace)} toast=${toasted.join(",") || "none"}\n`,
    err: "",
  };
}

function main(): void {
  try {
    const result = record(parseArgs(process.argv.slice(2)));
    if (result.out) process.stdout.write(result.out);
    if (result.err) process.stderr.write(result.err);
  } catch (error) {
    process.stderr.write(`usage-record: ${(error as Error).message.split("\n")[0]}\n`);
  }
  process.exitCode = 0;
}

// Same main-module check as research-first.mts: realpath for symlinked directories.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) main();
