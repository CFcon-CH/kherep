import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";
import { AppServerClient, type AppServerSpawn, type KillReport } from "../../modules/control-plane/node/codex-app-server-client.mts";
import { codexCommand, findCodex } from "../../modules/control-plane/node/codex-binary.mts";
import { signalGroupReport } from "../../modules/control-plane/node/codex-process.mts";
import { windowsRelations, type ProcessRelation } from "../../modules/control-plane/node/process-relations.mts";
import { CatalogStageError, collectModelCatalog, type CatalogLimits, type CatalogStage } from "./model-catalog.mts";
import type { ModelCatalog } from "./model-policy.mts";

export interface CatalogProcessOptions extends CatalogLimits {
  executable?: string;
  codexHome?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  spawn?: AppServerSpawn;
  find?: () => string | null;
  // Test helpers may start a synthetic JSON-RPC server through this prefix.
  launchPrefix?: string[];
  opened?: (child: ChildProcessWithoutNullStreams) => void;
  killGroup?: (pid: number, signal: NodeJS.Signals) => KillReport;
  relations?: () => Promise<ProcessRelation[]>;
  probeGroup?: (pid: number) => GroupProbe;
  // How long a remaining group may be re-asked: safe integer 1..10000 ms, default 2000.
  cleanupGraceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export type GroupProbe = "absent" | "present" | "denied";
export type { CatalogStage } from "./model-catalog.mts";

// The message names at most the failing stage; never stderr, paths, account data or causes.
// A cleanup-stage failure is unconfirmed cleanup by definition, so it needs no second suffix.
export class CatalogReadError extends Error {
  readonly code = "catalog-unavailable";
  readonly stage?: CatalogStage;
  readonly cleanupConfirmed: boolean;
  constructor(stage?: CatalogStage, cleanupConfirmed = true) {
    const unconfirmed = stage === "cleanup" || !cleanupConfirmed;
    super("Codex model catalog unavailable or cleanup unconfirmed" + (stage
      ? ` (stage: ${stage}${unconfirmed && stage !== "cleanup" ? "; cleanup unconfirmed" : ""})` : ""));
    this.stage = stage;
    this.cleanupConfirmed = !unconfirmed;
  }
}

// Any code other than ESRCH (gone) or EPERM (a member we may not signal) fails closed as "present".
function probeGroup(pid: number): GroupProbe {
  try { process.kill(-pid, 0); return "present"; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "absent" : code === "EPERM" ? "denied" : "present";
  }
}
// Issue #667 (M3-M5): the plugin sync of a fresh home spawns a git fetch whose orphaned child
// outlives the app-server by milliseconds. features.plugins=false keeps a metadata read free of
// it; the -c form only warns on an unknown key, --disable would refuse to start. Measured on macOS
// and Windows 11 (codex-cli 0.160.1): on Windows the fresh-home tree of the argv without the flag
// was codex + conhost + 3 git + git-remote-https, with the flag codex alone.
const CATALOG_SESSION_FLAGS = ["-c", "features.plugins=false"];
const GROUP_POLL_MS = 25, DEFAULT_CLEANUP_GRACE_MS = 2000, MAX_CLEANUP_GRACE_MS = 10_000;
function cleanupGrace(options: CatalogProcessOptions): number {
  const grace = options.cleanupGraceMs ?? DEFAULT_CLEANUP_GRACE_MS;
  if (!Number.isSafeInteger(grace) || grace <= 0 || grace > MAX_CLEANUP_GRACE_MS) {
    throw new CatalogStageError("start", "Invalid cleanup grace");
  }
  return grace;
}

// Issue #667, measured: after the forced close the group can keep one member for a few ms
// (an orphaned helper, ppid 1) and kill(-pgid, 0) may answer EPERM for ~100 ms. Nothing is
// signalled here: a process-group number is no proof of ownership once the owned close has
// run, and a reused number would name a foreign group. The loop only observes. Only a measured
// ESRCH confirms; present or denied at the deadline or at the probe cap is unconfirmed cleanup.
// Deadline and probe cap end the loop independently, so a broken clock cannot extend it.
// The Windows tree probe uses the same loop.
type Probe = () => GroupProbe | Promise<GroupProbe>;
async function settles(probe: Probe, grace: number, options: CatalogProcessOptions): Promise<boolean> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxProbes = Math.ceil(grace / GROUP_POLL_MS) + 1;
  const deadline = now() + grace;
  for (let probes = 1; ; probes++) {
    if (await probe() === "absent") return true;
    const left = deadline - now();
    if (left <= 0 || probes >= maxProbes) return false;
    await sleep(Math.min(GROUP_POLL_MS, left));
  }
}
function hasDescendants(pid: number, rows: ProcessRelation[]): boolean {
  return rows.some((row) => row.pid === pid || row.ppid === pid);
}

// Metadata only. No configuration is read here; CODEX_HOME selects the caller's
// runtime context. The process is held, group-scoped and never started via a shell.
async function readCatalogProcess(options: CatalogProcessOptions): Promise<ModelCatalog> {
  const grace = cleanupGrace(options);
  const platform = options.platform ?? process.platform;
  const executable = options.executable ?? (options.find ?? findCodex)();
  if (!executable) throw new Error("Codex executable unavailable for model catalog");
  const command = codexCommand(executable, [...options.launchPrefix ?? [], ...CATALOG_SESSION_FLAGS, "app-server", "--listen", "stdio://"], platform);
  const child = (options.spawn ?? spawn as AppServerSpawn)(command.file, command.args, {
    stdio: "pipe", windowsHide: true, detached: true,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.codexHome ? { env: { ...process.env, CODEX_HOME: options.codexHome } } : {}),
  });
  let exited = false, closed = false;
  child.once("exit", () => { exited = true; });
  child.once("close", () => { closed = true; });
  const owned = (): boolean => child.pid !== undefined && !exited && child.exitCode === null && child.signalCode === null;
  const kill = (signal: NodeJS.Signals): KillReport => {
    // POSIX group identity outlives its leader; Windows tree signalling must
    // retain a live, unreaped child root so a reused PID is never targeted.
    if (child.pid === undefined || platform === "win32" && !owned()) return "unconfirmed";
    return (options.killGroup ?? ((pid, value) => signalGroupReport(pid, value, platform)))(child.pid, signal);
  };
  let serverRequest = false;
  const client = new AppServerClient(child, { requestTimeoutMs: options.timeoutMs ?? 10_000, strict: true, kill,
    onServerRequest: () => { serverRequest = true; client.escalate(); } });
  const shutdown = async (): Promise<boolean> => {
    const root = child.pid;
    if (root === undefined) { await client.shutdown(true); return false; }
    if (platform !== "win32") {
      const stopped = await client.shutdown(true);
      return stopped && await settles(() => (options.probeGroup ?? probeGroup)(root), grace, options);
    }
    // Issue #667, Windows, measured on Windows 11 / codex-cli 0.160.1: taskkill /T /F exited 128
    // with the tree already gone (cause UNKNOWN; possibly members ending during its walk), and once
    // in 40 reads a late child outlived the root, held the inherited stdio pipe (close pending) and
    // was still in the snapshot 0.4 s after exit. The tree signal is attempted only while this exact
    // ChildProcess owns its root; its report proves nothing either way. Cleanup is confirmed by
    // observed state only: exit and close of the owned child, then a snapshot without a tracked
    // member or a descendant of the root, re-read within the same bounded loop. The loop itself
    // signals nothing; only the client's own close may still signal, and only while owned.
    let before: ProcessRelation[];
    try { before = await (options.relations ?? windowsRelations)(); }
    catch (error) { if (owned()) kill("SIGKILL"); await client.shutdown(); throw error; }
    const tracked = new Set<number>([root]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of before) if (tracked.has(row.ppid) && !tracked.has(row.pid)) { tracked.add(row.pid); changed = true; }
    }
    const attempted = owned();
    if (attempted) kill("SIGKILL");
    await client.shutdown();
    const treeGone = async (): Promise<GroupProbe> => {
      if (!exited || !closed) return "present";
      const after = await (options.relations ?? windowsRelations)();
      return after.some((row) => tracked.has(row.pid)) || hasDescendants(root, after) ? "present" : "absent";
    };
    return attempted && await settles(treeGone, grace, options);
  };
  try { options.opened?.(child); }
  catch (error) {
    // Early owned failure: start stage, one cleanup attempt, first error retained.
    const failure = new CatalogStageError("start", "Model catalog start failed", { cause: error });
    try { failure.cleanupConfirmed = await shutdown(); } catch { failure.cleanupConfirmed = false; }
    throw failure;
  }
  // The shared client keeps a notification's transport failure to itself: notify returns void and
  // stores it, and the next request would consume it as a catalog failure. Reading it back here
  // keeps a failed initialized inside the collector's start stage (PR #673 review, P2).
  const notify = (method: string, params: unknown): void => {
    client.notify(method, params);
    if (client.failure) throw client.failure;
  };
  return collectModelCatalog({ request: async (method, params, timeout) => {
    const result = await client.request(method, params, timeout);
    if (serverRequest) throw new Error("Unexpected model catalog server request");
    return result;
  }, notify, shutdown }, options);
}

// Raw RPC errors may include account details. The installer and CLI receive only
// this bounded error type, never stderr, paths, server messages or raw causes.
// Untagged errors arise only before the protocol starts.
export async function readAvailableModels(options: CatalogProcessOptions = {}): Promise<ModelCatalog> {
  try { return await readCatalogProcess(options); }
  catch (error) {
    throw error instanceof CatalogStageError ? new CatalogReadError(error.stage, error.cleanupConfirmed) : new CatalogReadError("start");
  }
}
