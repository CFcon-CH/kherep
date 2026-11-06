import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { HookPayload } from "./hook-adapter.mts";

const GUARDS = [["commit-guard.mts", "pre"], ["deploy-guard.mts", "pre-no-transcript"],
  ["main-checkout-guard.mts", "pre"], ["module-label-guard.mts", "pre"]] as const;
const deny = (reason: string): string => JSON.stringify({ hookSpecificOutput: {
  hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
} });

// Issue #507, part 4. One integer clock from this process's start, SAFETY_MARGIN_MS before the
// `timeout = 40` of the rendered shell entry (codex/lib/parity-config.mts; a test pins it). It bounds
// stdin, every guard, journal capture and the re-check. Order: guards, journal capture, re-check,
// attribution. Attribution runs last, uncapped, so the answer itself has no end-to-end deadline.
const HOOK_TIMEOUT_MS = 40_000;
const SAFETY_MARGIN_MS = 1_500;
const START = Math.floor(Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : Date.now());
const DEADLINE = START + HOOK_TIMEOUT_MS - SAFETY_MARGIN_MS;
// As in hook-adapter.mts: a re-check gets <= 6 s of what is left, none below 1 s; its lib loads within 2 s.
const RECHECK_MAX_MS = 6_000, RECHECK_MIN_MS = 1_000, RECHECK_LOAD_MS = 2_000;
const HEARTBEAT_WINDOW_MS = 1_800_000; // = claude/hooks/lib/integrity-heartbeat.mts
// Both adapter copies (codex/install.mts): the command copy the other groups run and this file's import.
const PEERS = ["codex-hook-adapter.mts", "hook-adapter.mts"];
const PEER_FIELDS = [["ino", "inode"], ["dev", "device"], ["size", "size"], ["mtimeNs", "mtime"]] as const;

type RecheckLib = typeof import("../../claude/hooks/lib/guard-recheck.mts");
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
// A Node error code, else the error's class name, else "unknown"; never a message (hook-adapter-verdict.mts codeOf).
const errorCode = (error: unknown): string => { const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,40}$/.test(code) ? code : typeof name === "string" && /^[A-Za-z]{1,40}Error$/.test(name) ? name : "unknown"; };

// Why the file cannot be run, or undefined (hook-adapter.mts unrunnable, for an absolute path).
function unrunnable(file: string): string | undefined {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch (error) { return errorCode(error) === "ENOENT" ? "missing" : `stat failed: ${errorCode(error)}`; }
  if (!stat.isFile()) return "not a regular file";
  return stat.size === 0 ? "empty, 0 bytes" : undefined;
}

// The peer gate, as in hook-adapter.mts: an adapter copy is proven only as the bytes the last
// integrity run judged and recorded in heartbeat.json "peers" (lib/integrity-heartbeat.mts
// provenPeer). This process compares one bigint stat with that record and parses nothing.
function recordedPeers(home: string): Record<string, unknown> | undefined {
  try {
    const { peers } = JSON.parse(fs.readFileSync(path.join(home, ".cache", "hook-integrity", "heartbeat.json"), "utf8")) as { peers?: unknown };
    return isObject(peers) ? peers : undefined;
  } catch { return undefined; }
}
function peerDrift(file: string, peers: Record<string, unknown> | undefined): string | undefined {
  const record = peers?.[path.basename(file)];
  if (!isObject(record)) return "no proven record";
  let stat: fs.BigIntStats;
  try { stat = fs.statSync(file, { bigint: true }); } catch (error) { return `stat failed: ${errorCode(error)}`; }
  const changed = PEER_FIELDS.find(([key]) => record[key] !== String(stat[key]));
  return changed && `${changed[1]} changed since the last proven check`;
}

// `work`, or `late()` after ms; the timer keeps the process alive meanwhile.
function within<T, L>(work: Promise<T>, ms: number, late: () => L): Promise<T | L> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<L>((resolve) => { timer = setTimeout(() => resolve(late()), ms); });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

// The re-check notice, or undefined; never a decision. Own wiring, not through the adapter, which
// may be the broken file; it mirrors recheck() in hook-adapter.mts. Only the installed copy
// (<home>/hooks/kherep-maestro) re-checks, through lib/guard-recheck.mts and
// codex-hook-integrity.mts beside it; no environment variable is read.
async function recheck(payload: string, broken: boolean, remaining: () => number): Promise<string | undefined> {
  const dir = import.meta.dirname;
  if (path.basename(dir) !== "kherep-maestro" || path.basename(path.dirname(dir)) !== "hooks") return undefined;
  const home = path.dirname(path.dirname(dir));
  const label = (file: string): string => path.relative(path.dirname(dir), file).split(path.sep).join("/"); // kherep-maestro/<name>, issue #564
  const recorded = recordedPeers(home);
  const peers = PEERS.map((name) => path.join(dir, name)).flatMap((peer) => {
    const why = unrunnable(peer) ?? peerDrift(peer, recorded);
    return why ? [`${label(peer)} cannot be trusted (${why})`] : [];
  });
  const run = async (): Promise<string | undefined> => {
    const loadMs = Math.min(RECHECK_LOAD_MS, remaining());
    const lib = await within(import(pathToFileURL(path.join(dir, "lib", "guard-recheck.mts")).href) as Promise<RecheckLib>,
      loadMs, () => undefined);
    if (!lib) return `hook integrity re-check unavailable (lib/guard-recheck.mts did not load within ${loadMs} ms)`;
    const { stale, lastOk } = lib.heartbeatState(home, HEARTBEAT_WINDOW_MS);
    if (!stale && !broken && !peers.length) return undefined;
    const context = { why: !stale ? "guard failure" : lastOk ? "stale heartbeat" : "no heartbeat", lastOk };
    const script = path.join(dir, "codex-hook-integrity.mts");
    const why = unrunnable(script);
    if (why) return lib.recheckNotice(context, [`${label(script)} cannot run (${why})`]);
    const budgetMs = Math.max(0, Math.min(RECHECK_MAX_MS, remaining() - 250));
    if (budgetMs < RECHECK_MIN_MS) return lib.recheckNotice(context, [`skipped, ${budgetMs} ms left of the hook budget; the next matching call re-checks`]);
    return lib.runRecheck({ script, home, payload, budgetMs, ...context, trigger: "codex-shell-checks", env: { CODEX_HOME: home }, label: label(script) });
  };
  const notice = await run().catch((error) => `hook integrity re-check unavailable (lib/guard-recheck.mts cannot be loaded (${errorCode(error)}))`);
  return [...peers, notice].filter(Boolean).join("\n") || undefined;
}

// Issue #504. Without the adapter there is no journal either: a delegated call (valid agent_id) of the
// installed copy leaves the capture-failed marker, else the journal renamed to it.
function unjournalled(payload: HookPayload): Promise<unknown> {
  const dir = import.meta.dirname, id = payload.agent_id;
  if (path.basename(dir) !== "kherep-maestro" || typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return Promise.resolve();
  const journal = path.join(path.dirname(path.dirname(dir)), ".cache", "denied-calls"), base = path.join(journal, id);
  return fs.promises.mkdir(journal, { recursive: true, mode: 0o700 }).then(() => fs.promises.appendFile(`${base}.failed`, "lib-load\n", { mode: 0o600 }))
    .catch(() => fs.promises.rename(`${base}.jsonl`, `${base}.failed`));
}

// The journalled form of the dispatcher's own deny: its guard as the bracket tag (issue #504); the decision keeps the plain text.
const tagged = (guard: string, why: string): string => `[${guard.replace(/\.mts$/, "")}] ${why}`;

// deadline: an absolute end (ms since the epoch), a test seam; raw: the payload as read, for the re-check.
export interface ShellOptions { deadline?: number; raw?: string }

// Privacy stays in its independent group. All shell guards still run through
// the shared adapter's phase-specific normalization, even when another denies.
// Order (issue #507, part 4): guards, journal capture, re-check, attribution.
export async function shellChecks(payload: HookPayload, attributionHook?: string, options: ShellOptions = {}): Promise<string> {
  const deadline = options.deadline ?? DEADLINE;
  const remaining = (): number => Math.max(0, deadline - Date.now());
  let decision = "";
  let broken = false;
  const denials: { decision: string; reason: string; broken?: boolean }[] = []; // issue #504: every denying guard
  let runAdaptedHook: typeof import("./hook-adapter.mts").runAdaptedHook | undefined;
  let journalCall: typeof import("./hook-adapter.mts").journalCall | undefined;
  // An adapter that does not load is a deny and a guard failure: this call's re-check restores it.
  try { ({ runAdaptedHook, journalCall } = await import("./hook-adapter.mts")); } catch { /* reported below */ }
  if (typeof runAdaptedHook !== "function") {
    runAdaptedHook = undefined; // an empty file loads as a module without it
    decision = deny("Shell guard adapter could not load; this tool call is blocked.");
    broken = true;
  }
  for (const [guard, phase] of runAdaptedHook ? GUARDS : []) {
    let fault = true; // a guard file that cannot be statted or is empty: the re-check restores it
    try {
      const target = path.join(import.meta.dirname, guard);
      if (!fs.statSync(target).size) throw new Error("empty guard");
      fault = false;
      const result = runAdaptedHook!(target, phase, payload, 10_000, { deadline });
      broken ||= result.broken === true;
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.status !== 0) {
        const why = `${guard} failed; this tool call is blocked.`;
        decision ||= deny(why);
        denials.push({ decision: "deny", reason: tagged(guard, why) });
      }
      else if (result.stdout.trim()) {
        // These guards allow silently; their only supported stdout is
        // the adapter's native deny. Unexpected output must not allow a call.
        const output = JSON.parse(result.stdout) as { hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string;
          permissionDecisionReason?: string } };
        if (output.hookSpecificOutput?.hookEventName !== "PreToolUse"
          || output.hookSpecificOutput.permissionDecision !== "deny") throw new Error("unsupported guard output");
        decision ||= result.stdout;
        denials.push({ decision: "deny", reason: output.hookSpecificOutput.permissionDecisionReason ?? "", broken: result.broken === true });
      }
    } catch {
      broken ||= fault;
      const why = `${guard} could not complete; this tool call is blocked.`;
      decision ||= deny(why);
      denials.push({ decision: "deny", reason: tagged(guard, why), broken: fault });
    }
  }
  // Issue #621: journal and failure marker share at most 2 s before the re-check.
  // The lib keeps its 600 ms cap; a marker still pending at the end may be lost.
  const journalEnd = Date.now() + Math.max(0, Math.min(2_000, remaining() - 250));
  if (journalCall) await journalCall(payload, denials, journalEnd).catch(() => {});
  else await within(unjournalled(payload), journalEnd - Date.now(), () => {}).catch(() => {});
  const notice = await within(recheck(options.raw ?? JSON.stringify(payload), broken, remaining), remaining(),
    () => "hook integrity re-check unavailable (no result before the hook deadline)");
  // After every guard and the re-check, in-process with the payload already read:
  // a failure here writes one stderr line and never changes the decision.
  if (attributionHook) {
    try {
      if (!path.isAbsolute(attributionHook)) throw new Error("invalid attribution path");
      // Issue #503. The stable entry point names the attribution hook of the
      // installed source; an older command names the hook itself.
      let hook = attributionHook;
      if (path.basename(attributionHook) === "codex-control-plane-hook.mts") {
        const entry = await import(pathToFileURL(attributionHook).href) as typeof import("./control-plane-hook.mts");
        hook = entry.resolveControlPlaneHook("attribution");
      }
      const { handleAttributionHook } = await import(pathToFileURL(hook).href);
      const { nodePaths } = await import(pathToFileURL(path.join(path.dirname(hook), "config.mts")).href);
      handleAttributionHook(payload, "codex", { paths: nodePaths(), env: process.env });
    } catch { process.stderr.write("kherep shell-checks: attribution could not complete\n"); }
  }
  if (!notice) return decision;
  // The block goes to stderr always, to a top-level systemMessage on a deny (after the guard's
  // own line, as the adapter does), to additionalContext otherwise; it never changes the decision.
  process.stderr.write(`${notice}\n`);
  if (!decision) return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: notice } });
  const lines = notice.split("\n");
  const doc = JSON.parse(decision) as Record<string, unknown>;
  const integrity = `Kherep hook integrity: ${lines[0]}${lines.length > 1 ? ` (+${lines.length - 1} more)` : ""}`;
  return JSON.stringify({ ...doc, systemMessage: [doc.systemMessage, integrity].filter(Boolean).join("\n") });
}

// stdin within the clock; a stdin that stays open is no input.
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const ms = Math.max(0, DEADLINE - Date.now());
    const timer = setTimeout(() => { process.stdin.destroy(); reject(new Error(`stdin not closed within ${ms} ms`)); }, ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => { clearTimeout(timer); resolve(data); });
    process.stdin.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  let output: string;
  try {
    const raw = await readStdin();
    const payload: unknown = JSON.parse(raw);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid input");
    output = await shellChecks(payload as HookPayload, process.argv[2], { raw });
  } catch { output = deny("Shell checks received invalid input; this tool call is blocked."); }
  // CLI only: drain previously issued diagnostics as well as the answer, then release
  // any lingering journal handles. Always queue both barriers, even on a silent allow.
  let pending = 2;
  const flushed = (): void => { if (--pending === 0) process.exit(0); };
  process.stdout.write(output, flushed);
  process.stderr.write("", flushed);
}
