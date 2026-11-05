import fs from "node:fs";
import path from "node:path";

import type { NodePaths } from "./config.mts";
import { pidAlive, type InterruptedProbe } from "./daemon-state.mts";
import { PROBE_TIMEOUT_MS, type ProbeResult } from "./runtime-probe.mts";

// Issue #403. While bootstrap/install.sh runs the claude CLI (npm globals,
// plugins, the MCP registry, its own readiness check) it leaves this file in
// the node directory, and the daemon starts no Claude readiness probe
// (runtime-readiness.mts), so a probe and an install step never renew the saved
// login at the same time. Only a fresh file counts: an installer that was
// killed cannot pause the probe for good.
export const INSTALL_PAUSE_STALE_MS = 30 * 60_000;

export const installPauseFile = (paths: Pick<NodePaths, "dir">): string => path.join(paths.dir, "install.lock");

const fresh = (file: string, bound: number, now: number): boolean => {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && Math.abs(now - stat.mtimeMs) < bound;
  } catch {
    return false;
  }
};

export const installPaused = (paths: Pick<NodePaths, "dir">, now: number = Date.now()): boolean =>
  fresh(installPauseFile(paths), INSTALL_PAUSE_STALE_MS, now);

// A probe already running when the lock appears is not stopped; the daemon
// marks it in flight and the installer waits for it, at most this long.
export const PROBE_MARKER_STALE_MS = PROBE_TIMEOUT_MS + 15_000;

export const probeMarkerFile = (paths: Pick<NodePaths, "dir">): string => path.join(paths.dir, "claude-probe.inflight");

export const probeInFlight = (paths: Pick<NodePaths, "dir">, now: number = Date.now()): boolean =>
  fresh(probeMarkerFile(paths), PROBE_MARKER_STALE_MS, now);

// Marks the probe in flight and only then reads the lock. The installer writes
// the lock and only then reads the marker, so at least one of them sees the
// other. A lock that appeared in between gives a not-ready verdict, probed again
// after the install. Issue #420: the marker names the daemon and the probe
// start, "<pid> <ISO time>"; the installer reads only its file time.
export async function markedProbe(paths: Pick<NodePaths, "dir">, probe: () => Promise<ProbeResult>): Promise<ProbeResult> {
  const marker = probeMarkerFile(paths);
  try {
    fs.writeFileSync(marker, `${process.pid} ${new Date().toISOString()}\n`);
  } catch {
    // Without a marker the installer cannot wait; the probe still runs.
  }
  try {
    if (installPaused(paths)) return { ok: false, cause: "error", detail: "probe deferred: install in progress" };
    return await probe();
  } finally {
    fs.rmSync(marker, { force: true });
  }
}

// Issue #420: a daemon killed during a probe never runs the finally above, so
// its marker outlives it. The next daemon reports it before its first probe
// instead of overwriting it, since a kill during a login renewal can leave the
// login unusable. A live pid on a fresh marker is another daemon's probe in
// flight (close code 4409); on a stale one it is a reused pid.
export function noticeInterruptedProbe(paths: Pick<NodePaths, "dir">, log: (line: string) => void,
  alive: (pid: unknown) => boolean = pidAlive, now: number = Date.now()): InterruptedProbe | null {
  const marker = probeMarkerFile(paths);
  let content: string;
  let mtime: number;
  try {
    content = fs.readFileSync(marker, "utf8");
    mtime = fs.statSync(marker).mtimeMs;
  } catch {
    return null;
  }
  const tokens = content.trim().split(/\s+/);
  const [pidText = "", started = ""] = tokens;
  const pidValue = tokens.length <= 2 && /^[1-9]\d{0,9}$/.test(pidText) ? Number(pidText) : Number.NaN;
  const pid = Number.isSafeInteger(pidValue) && pidValue <= 2_147_483_647 ? pidValue : null;
  if (pid !== null && alive(pid) && probeInFlight(paths, now)) {
    log(`kherep-node: another daemon's claude probe (daemon pid ${pid}) is in flight`);
    return null;
  }
  const timestamp = tokens.length === 2 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(started)
    ? Date.parse(started) : Number.NaN;
  const canonical = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  const at = canonical !== null && canonical === started ? canonical : new Date(mtime).toISOString();
  log(`kherep-node: the previous daemon stop interrupted a claude probe (daemon pid ${pid ?? "unknown"}, started ${at}); `
    + "if the next probe reports sign-in required, that stop likely interrupted a login renewal");
  fs.rmSync(marker, { force: true });
  return { runtime: "claude", pid, at, noticedAt: new Date(now).toISOString() };
}
