import { children, type ChildRun } from "./child-run.mts";
import { findRollout } from "./codex-app.mts";
import { HOLDER_PROBE_TIMEOUT_MS, type Holder, type HolderProcess, type HolderScan } from "./codex-holder-probe.mts";
import { timedOut } from "./process-relations.mts";
import { timedAsync } from "./sync-timing.mts";

// Issue #706, Phase 2, Windows. UNVERIFIED on a Windows node: the design's
// acceptance spike decides whether the Restart Manager reports the codex
// process that holds a rollout. Restart Manager (MicrosoftDocs/sdk-api):
// RmGetList "Gets a list of all applications and services that are currently
// using resources that have been registered with the Restart Manager
// session."; RM_UNIQUE_PROCESS "Uniquely identifies a process by its PID and
// the time the process began." One session per rollout, because RmGetList
// answers per session; RmShutdown is never called. A holder counts only when
// it is a live codex.exe with the same start time. A scan-wide failure throws;
// since issue #899 a failing file marks only its own thread failed (UNKNOWN).

// The bound of APP_CANDIDATES (codex-app.mts): RmRegisterResources is expensive.
export const WINDOWS_HOLDER_CANDIDATES = 16;
const FILETIME_UNIX_MS = 11_644_473_600_000n;

// Issue #899, measured on a Windows node: Windows PowerShell 5.1 writes a
// ConvertFrom-Json array as ONE pipeline object, so the former
// `@(... | ConvertFrom-Json)` gave Count=1 for 2+ files, $files[0] was every
// path joined by a space, and its sizing RmGetList returned 6. Each path is
// now its own base64 literal, decoded by ForEach-Object, which emits one
// string per path on every PowerShell version: Count=N for N=0, 1 and 2+.
const SCRIPT = (files: string[]): string => String.raw`
$ErrorActionPreference = 'Stop'
$source = @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class KherepRolloutHolders {
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] struct UniqueProcess { public int Pid; public FileTime Start; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceName;
    public int AppType; public uint AppStatus; public uint SessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint files, string[] names, uint apps, UniqueProcess[] procs, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] ProcessInfo[] info, ref uint reasons);
  public static string Processes() {
    var rows = new StringBuilder();
    foreach (var p in Process.GetProcessesByName("codex")) rows.Append("P ").Append(p.Id).Append(' ').Append(p.StartTime.ToFileTimeUtc()).Append('\n');
    return rows.ToString();
  }
  // Issue #899: never throws, so one failing file cannot end the whole scan.
  // H <index> [<pid>:<filetime>,...] or X <index> <stage> <code> [end <code>].
  public static string Row(int index, string file) {
    string stage = "session", holders = null;
    int code = 0, end = 0;
    try {
      uint handle;
      code = RmStartSession(out handle, 0, new StringBuilder(33));
      if (code == 0) {
        try { holders = Query(handle, file, ref stage, ref code); } finally { end = RmEndSession(handle); }
      }
    } catch (Exception e) { stage = "error"; code = Marshal.GetHRForException(e); holders = null; }
    if (holders != null) return ("H " + index + " " + holders).TrimEnd();
    return "X " + index + " " + stage + " " + code + (end != 0 ? " end " + end : "");
  }
  static string Query(uint handle, string file, ref string stage, ref int code) {
    stage = "register";
    code = RmRegisterResources(handle, 1, new string[] { file }, 0, null, 0, null);
    if (code != 0) return null;
    uint needed = 0, count = 0, reasons = 0;
    stage = "list1";
    code = RmGetList(handle, out needed, ref count, null, ref reasons);
    if (code == 0) return "";
    if (code != 234) return null;
    var info = new ProcessInfo[needed];
    count = needed;
    stage = "list2";
    code = RmGetList(handle, out needed, ref count, info, ref reasons);
    if (code != 0) return null;
    var parts = new List<string>();
    for (int i = 0; i < count; i++) parts.Add(info[i].Process.Pid + ":" + (((ulong)info[i].Process.Start.High << 32) | info[i].Process.Start.Low));
    return string.Join(",", parts);
  }
}
"@
Add-Type -TypeDefinition $source
$files = @(@(${files.map(file => `'${Buffer.from(file, "utf8").toString("base64")}'`).join(",")}) | ForEach-Object { [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) })
$processes = [KherepRolloutHolders]::Processes()
$processes
if ($processes.Length -gt 0) { for ($i = 0; $i -lt $files.Count; $i++) { [KherepRolloutHolders]::Row($i, [string]$files[$i]) } }
'E'
`;

const startMs = (fileTime: string): number => Number(BigInt(fileTime) / 10_000n - FILETIME_UNIX_MS);

type RolloutFile = { file: string; threadId: string };

// Rows P <pid> <filetime>, H <index> [<pid>:<filetime>,...] or X <index>
// <stage> <code> [end <code>], then E. An X row marks only its thread failed;
// a missing end row, an X row without any P row or any unparsable row fails the scan.
export function parseWindowsHolders(text: string, files: RolloutFile[], at: number): HolderScan {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.at(-1) !== "E") throw new Error("incomplete holder scan");
  const processes: HolderProcess[] = [];
  const holders = new Map<string, Holder[]>();
  const failed = new Map<string, string>();
  const seen = new Set<number>();
  const row = (index: number): RolloutFile => {
    if (seen.has(index)) throw new Error("unparsable holder row");
    seen.add(index);
    return files[index];
  };
  for (const line of lines.slice(0, -1)) {
    let match: RegExpExecArray | null;
    if ((match = /^P (\d{1,10}) (\d{1,20})$/.exec(line))) {
      processes.push({ pid: Number(match[1]), startMs: startMs(match[2]), identity: `${match[1]}:${match[2]}` });
    } else if ((match = /^H (\d{1,3})(?: (\d{1,10}:\d{1,20}(?:,\d{1,10}:\d{1,20})*))?$/.exec(line)) && files[Number(match[1])]) {
      const { file, threadId } = row(Number(match[1]));
      const codex = (match[2]?.split(",") ?? [])
        .flatMap(identity => processes.filter(p => p.identity === identity)).map(p => ({ ...p, file }));
      holders.set(threadId, codex);
    } else if ((match = /^X (\d{1,3}) ((?:session|register|list1|list2|error) -?\d{1,11}(?: end -?\d{1,11})?)$/.exec(line)) && files[Number(match[1])]) {
      failed.set(row(Number(match[1])).threadId, match[2]);
    } else throw new Error("unparsable holder row");
  }
  // Without a codex process no thread is held: the scan covers every thread.
  if (processes.length === 0) {
    if (failed.size > 0) throw new Error("unparsable holder row");
    return { at, processes, holders: new Map() };
  }
  if (seen.size !== files.length) throw new Error("incomplete holder scan");
  return { at, processes, holders, probed: new Set(files.map(f => f.threadId)), ...(failed.size > 0 ? { failed } : {}) };
}

export async function probeCodexHoldersWindows(home: string, candidates: string[], signal: AbortSignal,
  run: ChildRun = children.run, now: () => number = Date.now): Promise<HolderScan> {
  signal.throwIfAborted();
  const at = now();
  const files = candidates.slice(0, WINDOWS_HOLDER_CANDIDATES)
    .flatMap(threadId => { const file = findRollout(home, threadId); return file ? [{ file, threadId }] : []; });
  const query = () => timedAsync("codex-holder-windows", () => run("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", SCRIPT(files.map(f => f.file))], { timeoutMs: HOLDER_PROBE_TIMEOUT_MS }));
  let text: string;
  // A cold powershell.exe with Add-Type may hit the limit once (process-relations.mts).
  try { text = await query(); } catch (error) {
    if (!timedOut(error)) throw error;
    signal.throwIfAborted();
    text = await query();
  }
  signal.throwIfAborted();
  return parseWindowsHolders(text, files, at);
}
