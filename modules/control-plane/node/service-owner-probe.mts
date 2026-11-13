import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import os from "node:os";

import { timedSync } from "./sync-timing.mts";

export interface ServiceFileOwner { version: 1; pid: number; startedAt: string; owner: string }
export interface ServiceOwnerProbe {
  current(): ServiceFileOwner;
  active(owner: ServiceFileOwner): boolean | "unknown";
}

type OwnerSpawn = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;
export interface ServiceOwnerProbeDeps { platform?: NodeJS.Platform; spawn?: OwnerSpawn; timeoutMs?: number }

export const IDENTITY_UNVERIFIED = "service controller identity cannot be verified";
export const IDENTITY_TIMED_OUT = "service controller identity lookup timed out";

const WINDOWS_SID = /^S-\d+(?:-\d+)+$/i;
const timedOut = (result: SpawnSyncReturns<string>): boolean =>
  (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
const OBSERVED_OWNER_SCRIPT = "try{$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:KHEREP_OWNER_PID) -ErrorAction Stop}"
  + "catch{@{status='unknown'}|ConvertTo-Json -Compress;exit};"
  + "if($null-eq$p){@{status='missing'}|ConvertTo-Json -Compress;exit};"
  + "try{$startedAt=$p.CreationDate.ToUniversalTime().ToString('o')}"
  + "catch{@{status='unknown'}|ConvertTo-Json -Compress;exit};"
  + "$sid=$null;try{$o=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop;"
  + "if($o.ReturnValue-eq0){$sid=[string]$o.Sid}}catch{};"
  + "@{status='found';startedAt=$startedAt;owner=$sid}|ConvertTo-Json -Compress";

export function createServiceOwnerProbe(deps: ServiceOwnerProbeDeps = {}): ServiceOwnerProbe {
  const platform = deps.platform ?? process.platform;
  const spawn: OwnerSpawn = deps.spawn ?? spawnSync;
  const timeout = deps.timeoutMs ?? 10_000;
  let cachedWindowsOwner: string | undefined;

  // Issue #427: the first powershell.exe start after a boot or a service
  // restart can exceed the timeout. As in issues #219 and #221, a timeout alone
  // runs once more (spawnSync returns only after the killed child exited);
  // every other failure is final at once.
  // Issue #441: name is logged when the call, retry included, exceeds SLOW_SYNC_MS.
  const powerShell = (name: string, script: string, options: Partial<SpawnSyncOptionsWithStringEncoding> = {}): SpawnSyncReturns<string> =>
    timedSync(name, () => {
      const run = () => spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", windowsHide: true, timeout, ...options });
      const first = run();
      return timedOut(first) ? run() : first;
    });

  const currentOwner = (): string => {
    if (platform !== "win32") return os.userInfo().username;
    if (cachedWindowsOwner) return cachedWindowsOwner;
    const result = powerShell("owner-identity", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value", { stdio: ["ignore", "pipe", "pipe"] });
    if (timedOut(result)) throw new Error(IDENTITY_TIMED_OUT);
    const sid = result.stdout.trim();
    if (result.status !== 0 || !WINDOWS_SID.test(sid)) throw new Error(IDENTITY_UNVERIFIED);
    cachedWindowsOwner = sid.toUpperCase();
    return cachedWindowsOwner;
  };

  const observedOwner = (pid: number): { startedAt: string; owner: string | null } | null | "unknown" => {
    if (platform === "win32") {
      const result = powerShell("owner-observe", OBSERVED_OWNER_SCRIPT, { env: { ...process.env, KHEREP_OWNER_PID: String(pid) } });
      if (result.error || result.status !== 0) return "unknown";
      try {
        const observed = JSON.parse(result.stdout) as { status?: unknown; startedAt?: unknown; owner?: unknown };
        if (observed.status === "missing") return null;
        if (observed.status !== "found") return "unknown";
        if (typeof observed.startedAt !== "string" || !Number.isFinite(Date.parse(observed.startedAt))) return "unknown";
        return { startedAt: observed.startedAt,
          owner: typeof observed.owner === "string" && WINDOWS_SID.test(observed.owner) ? observed.owner.toUpperCase() : null };
      } catch { return "unknown"; }
    }
    const result = spawn("ps", ["-p", String(pid), "-o", "user=", "-o", "lstart="], { encoding: "utf8", timeout });
    if (result.status === 1 && result.stdout.trim() === "") return null;
    if (result.status !== 0) return "unknown";
    const match = /^(\S+)\s+(\S.*)$/.exec(result.stdout.trim());
    const startedAt = match ? new Date(match[2]).toISOString() : "";
    return match && startedAt !== "Invalid Date" ? { owner: match[1], startedAt } : "unknown";
  };

  return {
    current: () => ({ version: 1, pid: process.pid, startedAt: processStartedAt, owner: currentOwner() }),
    active: (owner) => {
      if (platform === "win32" && !WINDOWS_SID.test(owner.owner)) return "unknown";
      if (!Number.isFinite(Date.parse(owner.startedAt))) return "unknown";
      const observed = observedOwner(owner.pid);
      if (observed === "unknown") return "unknown";
      if (observed === null) return false;
      if (Math.abs(Date.parse(observed.startedAt) - Date.parse(owner.startedAt)) > 2_000) return false;
      if (observed.owner === null) return "unknown";
      return observed.owner === owner.owner;
    },
  };
}

export const defaultServiceOwnerProbe: ServiceOwnerProbe = createServiceOwnerProbe();
