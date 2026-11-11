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
// it is a live codex.exe with the same start time. Every failure throws.

// The bound of APP_CANDIDATES (codex-app.mts): RmRegisterResources is expensive.
export const WINDOWS_HOLDER_CANDIDATES = 16;
const FILETIME_UNIX_MS = 11_644_473_600_000n;

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
  public static string Holders(string file) {
    uint handle;
    int result = RmStartSession(out handle, 0, new StringBuilder(33));
    if (result != 0) throw new Exception("session " + result);
    try {
      result = RmRegisterResources(handle, 1, new string[] { file }, 0, null, 0, null);
      if (result != 0) throw new Exception("register " + result);
      uint needed = 0, count = 0, reasons = 0;
      result = RmGetList(handle, out needed, ref count, null, ref reasons);
      if (result == 0) return "";
      if (result != 234) throw new Exception("list " + result);
      var info = new ProcessInfo[needed];
      count = needed;
      result = RmGetList(handle, out needed, ref count, info, ref reasons);
      if (result != 0) throw new Exception("list " + result);
      var parts = new List<string>();
      for (int i = 0; i < count; i++) parts.Add(info[i].Process.Pid + ":" + (((ulong)info[i].Process.Start.High << 32) | info[i].Process.Start.Low));
      return string.Join(",", parts);
    } finally { RmEndSession(handle); }
  }
}
"@
Add-Type -TypeDefinition $source
$files = @([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(files)).toString("base64")}')) | ConvertFrom-Json)
$processes = [KherepRolloutHolders]::Processes()
$processes
if ($processes.Length -gt 0) { for ($i = 0; $i -lt $files.Count; $i++) { "H $i " + [KherepRolloutHolders]::Holders([string]$files[$i]) } }
'E'
`;

const startMs = (fileTime: string): number => Number(BigInt(fileTime) / 10_000n - FILETIME_UNIX_MS);

// Rows P <pid> <filetime>, H <index> [<pid>:<filetime>,...], then E. A missing
// end row or any unparsable row fails the scan.
export function parseWindowsHolders(text: string, files: { file: string; threadId: string }[], at: number): HolderScan {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.at(-1) !== "E") throw new Error("incomplete holder scan");
  const processes: HolderProcess[] = [];
  const holders = new Map<string, Holder[]>();
  const seen = new Set<number>();
  for (const line of lines.slice(0, -1)) {
    let match: RegExpExecArray | null;
    if ((match = /^P (\d{1,10}) (\d{1,20})$/.exec(line))) {
      processes.push({ pid: Number(match[1]), startMs: startMs(match[2]), identity: `${match[1]}:${match[2]}` });
    } else if ((match = /^H (\d{1,3})(?: (\d{1,10}:\d{1,20}(?:,\d{1,10}:\d{1,20})*))?$/.exec(line)) && files[Number(match[1])]) {
      const index = Number(match[1]), { file, threadId } = files[index];
      if (seen.has(index)) throw new Error("unparsable holder row");
      seen.add(index);
      const codex = (match[2] ?? "").split(",").filter(Boolean)
        .flatMap(identity => processes.filter(p => p.identity === identity)).map(p => ({ ...p, file }));
      holders.set(threadId, codex);
    } else throw new Error("unparsable holder row");
  }
  // Without a codex process no thread is held: the scan covers every thread.
  if (processes.length === 0) return { at, processes, holders: new Map() };
  if (seen.size !== files.length) throw new Error("incomplete holder scan");
  return { at, processes, holders, probed: new Set(files.map(f => f.threadId)) };
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
