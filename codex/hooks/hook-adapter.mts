import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { HookPayload } from "./hook-adapter-payload.mts";
import { preToolUse, runAdaptedHook } from "./hook-adapter-run.mts";
import { adapterFailure, codeOf, combine, INTENT_PHASE, isObject, labelOf, PRE_TOOL_USE_PHASES, render, SELF, unrunnable, type Verdict }
  from "./hook-adapter-verdict.mts";

// Issue #533. Payload normalization, decisions and guard loops live in the three modules above;
// these re-exports keep every importer's path.
export { inputText, normalizeDeployApproval, normalizePayloads, patchPaths, shellCommandsFromExec, type HookPayload } from "./hook-adapter-payload.mts";
export { budgetFor, runAdaptedHook, type AdaptedOptions, type AdaptedResult } from "./hook-adapter-run.mts";

// Issue #258. Codex blocks a PreToolUse call on exit 2 with a stderr reason, or
// on exit 0 with this JSON on stdout; anything else is a non-blocking failure.
// On Windows Codex runs commandWindows under pwsh, which reports a native exit 2
// as 1, so a guard's exit 2 reaches Codex only as this JSON.
// Issue #507, part 3: in a PreToolUse phase a guard that cannot run is a deny naming
// the file (missing, empty, no regular file, spawn failed or threw, killed, past its
// budget and then killed with SIGKILL, no budget left, exit other than 0 or 2, over
// 1 MiB of output, stdout that is no decision); a printed "ask", which Codex parses
// but does not support, is a deny. PostToolUse phases run exactly as before.

// One integer clock from this process's start, SAFETY_MARGIN_MS before the `timeout = 10`
// of both rendered pre-privacy entries (a test pins it). spawnSync throws on a fractional
// timeout (ERR_OUT_OF_RANGE, measured on Node 26.10), so every budget is an integer.
// The pre-intent entry has `timeout = 15` (pinned too): the hook waits up to 8 s for its receipt.
const HOOK_TIMEOUT_MS = 10_000;
const INTENT_HOOK_TIMEOUT_MS = 15_000;
const SAFETY_MARGIN_MS = 1_500;
const PHASE_ARG = process.argv[3] || "pre"; // never pre-intent when the shell dispatcher imports this module
const START = Math.floor(Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : Date.now());
const DEADLINE = START + (PHASE_ARG === INTENT_PHASE ? INTENT_HOOK_TIMEOUT_MS : HOOK_TIMEOUT_MS) - SAFETY_MARGIN_MS;
const remaining = (): number => Math.max(0, DEADLINE - Date.now());
const GUARD_TIMEOUT_MS = 5_000;
const INTENT_GUARD_TIMEOUT_MS = 12_000;
// A re-check gets <= RECHECK_MAX_MS of what is left, none below RECHECK_MIN_MS; its lib loads within RECHECK_LOAD_MS.
const RECHECK_MAX_MS = 6_000, RECHECK_MIN_MS = 1_000, RECHECK_LOAD_MS = 2_000;
const HEARTBEAT_WINDOW_MS = 1_800_000; // = claude/hooks/lib/integrity-heartbeat.mts
const INVOKED_DIR = path.dirname(SELF);

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const ms = remaining();
    const timer = setTimeout(() => { process.stdin.destroy(); reject(new Error(`stdin not closed within ${ms} ms`)); }, ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => { clearTimeout(timer); resolve(data); });
    process.stdin.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

// `work`, or `late()` after ms; the timer keeps the process alive meanwhile.
function within<T, L>(work: Promise<T>, ms: number, late: () => L): Promise<T | L> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<L>((resolve) => { timer = setTimeout(() => resolve(late()), ms); });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

type RecheckLib = typeof import("../../claude/hooks/lib/guard-recheck.mts");

// Issue #507, part 4. A peer dispatcher is proven only as the bytes the last integrity run judged:
// that run records each dispatcher file's (dev, ino, size, mtimeNs) from an fd-bound snapshot in
// heartbeat.json "peers" (lib/integrity-heartbeat.mts provenPeer). Any difference, no record, or a
// peer that cannot run is a guard failure: the re-check parses and restores it; this process
// compares one bigint stat with the record and parses nothing.
const PEER_FIELDS = [["ino", "inode"], ["dev", "device"], ["size", "size"], ["mtimeNs", "mtime"]] as const;
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
  try { stat = fs.statSync(file, { bigint: true }); } catch (error) { return `stat failed: ${codeOf(error)}`; }
  const changed = PEER_FIELDS.find(([key]) => record[key] !== String(stat[key]));
  return changed && `${changed[1]} changed since the last proven check`;
}

// The hook integrity re-check notice, or undefined; never a decision. Only the
// installed copy (<home>/hooks/kherep-maestro) re-checks, through the installed
// lib/guard-recheck.mts and codex-hook-integrity.mts beside it; no environment
// variable is read. The shell dispatcher, which no hook checks for itself, is
// checked first; a line about it heads the notice.
async function recheck(payload: string, broken: boolean): Promise<string | undefined> {
  if (path.basename(INVOKED_DIR) !== "kherep-maestro" || path.basename(path.dirname(INVOKED_DIR)) !== "hooks") return undefined;
  const home = path.dirname(path.dirname(INVOKED_DIR));
  const peer = path.join(INVOKED_DIR, "codex-shell-checks.mts");
  const drift = unrunnable(peer) ?? peerDrift(peer, recordedPeers(home));
  const notice = await recheckRun(home, payload, broken || drift !== undefined)
    .catch((error) => `hook integrity re-check unavailable (lib/guard-recheck.mts cannot be loaded (${codeOf(error)}))`);
  return drift ? `${labelOf(peer)} cannot be trusted (${drift})\n${notice}` : notice;
}

// A broken lib throws here or at its first call.
async function recheckRun(home: string, payload: string, broken: boolean): Promise<string | undefined> {
  const loadMs = Math.min(RECHECK_LOAD_MS, remaining());
  const lib = await within(import(pathToFileURL(path.join(INVOKED_DIR, "lib", "guard-recheck.mts")).href) as Promise<RecheckLib>,
    loadMs, () => undefined);
  if (!lib) return `hook integrity re-check unavailable (lib/guard-recheck.mts did not load within ${loadMs} ms)`;
  const { stale, lastOk } = lib.heartbeatState(home, HEARTBEAT_WINDOW_MS);
  if (!stale && !broken) return undefined;
  const context = { why: !stale ? "guard failure" : lastOk ? "stale heartbeat" : "no heartbeat", lastOk };
  const script = path.join(INVOKED_DIR, "codex-hook-integrity.mts");
  const why = unrunnable(script);
  if (why) return lib.recheckNotice(context, [`${labelOf(script)} cannot run (${why})`]);
  const budgetMs = Math.max(0, Math.min(RECHECK_MAX_MS, remaining() - 250));
  if (budgetMs < RECHECK_MIN_MS) return lib.recheckNotice(context, [`skipped, ${budgetMs} ms left of the hook budget; the next matching call re-checks`]);
  return lib.runRecheck({ script, home, payload, budgetMs, ...context, trigger: "hook-adapter", env: { CODEX_HOME: home }, label: labelOf(script) });
}

type JournalLib = typeof import("../../claude/hooks/lib/denial-journal.mts");
type Verdicts = Parameters<JournalLib["journalVerdict"]>[2];
// The Codex home of the installed copy (<home>/hooks/kherep-maestro), else undefined.
const installedHome = (): string | undefined => path.basename(INVOKED_DIR) === "kherep-maestro"
  && path.basename(path.dirname(INVOKED_DIR)) === "hooks" ? path.dirname(path.dirname(INVOKED_DIR)) : undefined;

// Issue #504. A delegated run's call line in <home>/.cache/denied-calls through the installed
// lib/denial-journal.mts beside this copy, else a capture-failed marker; never a decision. The lib
// has min(1 s, end - now) less 400 ms; the marker write is then awaited until end (issue #612):
// main() exits through process.exit(0) in emit(), which abandons a pending fs.promises write, so a
// marker given a fixed slice was missing after a slow write (measured: ENOENT on windows-latest).
// Inert until a Codex child payload carries agent_id (#537). Hook integrity inventories the lib
// (hook-integrity-sources.mts).
export async function journalCall(payload: HookPayload, verdicts: Verdicts, end = DEADLINE - 250): Promise<void> {
  const home = installedHome(), id = payload.agent_id;
  if (!home || typeof id !== "string" || payload.tool_name === "SubagentHandback") return;
  const leaf = leafOf(id);
  if (!leaf) return;
  const cap = Math.max(0, Math.min(1_000, end - Date.now()) - 400);
  const fail = await within((import(pathToFileURL(path.join(INVOKED_DIR, "lib", "denial-journal.mts")).href) as Promise<JournalLib>)
    .then((lib) => lib.journalVerdict(home, payload, verdicts, Date.now() + cap - 50)), cap, () => "lib-timeout").catch(() => "lib-load");
  if (fail) await within(markUnjournalled(home, leaf, fail), Math.max(0, end - Date.now()), () => {}).catch(() => {});
}

// Accepts 1 to 64 characters of AGENT_LEAF and returns them rebuilt from that constant; anything else is "".
const AGENT_LEAF = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
function leafOf(value: string): string {
  let leaf = "";
  for (const ch of value) {
    const at = AGENT_LEAF.indexOf(ch);
    if (at < 0) return "";
    leaf += AGENT_LEAF[at];
  }
  return leaf.length >= 1 && leaf.length <= 64 ? leaf : "";
}

// The marker without the lib: one line, else the journal renamed to it.
function markUnjournalled(home: string, leaf: string, code: string): Promise<unknown> {
  const dir = path.join(home, ".cache", "denied-calls"), base = path.join(dir, leaf);
  return fs.promises.mkdir(dir, { recursive: true, mode: 0o700 }).then(() => fs.promises.appendFile(`${base}.failed`, `${code}\n`, { mode: 0o600 }))
    .catch(() => fs.promises.rename(`${base}.jsonl`, `${base}.failed`));
}

// One document on stdout, the guards' stderr and the re-check block on stderr; exits
// once every write called back. The notice goes to additionalContext on an allow,
// to a top-level systemMessage on a deny, never into the decision. In pre-intent it goes
// to stderr only, so the document is exactly the hook's own (issue #538).
function emit(verdict: Verdict | undefined, stderr: string, notice?: string, phase = "pre"): void {
  let doc: string;
  if (phase === INTENT_PHASE) {
    doc = render(verdict);
  } else if (verdict?.decision === "deny") {
    const lines = notice ? notice.split("\n") : [];
    const integrity = notice ? `Kherep hook integrity: ${lines[0]}${lines.length > 1 ? ` (+${lines.length - 1} more)` : ""}` : "";
    // render() writes the guard's own systemMessage; the integrity line follows it (issue #507, part 4).
    doc = render(verdict, integrity ? { systemMessage: [verdict.system, integrity].filter(Boolean).join("\n") } : {});
  } else {
    doc = render(notice ? combine([...(verdict ? [verdict] : []), { reason: "", notice }]) : verdict);
  }
  let pending = 0;
  const flushed = (): void => { if (--pending === 0) process.exit(0); };
  const put = (stream: NodeJS.WriteStream, text: string): void => { pending++; stream.write(text, flushed); };
  if (stderr) put(process.stderr, stderr);
  if (notice) put(process.stderr, `${notice}\n`);
  if (doc) put(process.stdout, doc);
  if (pending === 0) process.exit(0);
}

// PostToolUse phases: as before #507 part 3.
function postMain(target: string | undefined, phase: string): void {
  if (!target || !path.isAbsolute(target)) return;
  let payload: HookPayload;
  try { payload = JSON.parse(fs.readFileSync(0, "utf8")); } catch { return; }
  const result = runAdaptedHook(target, phase, payload);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status;
}

// readStdin's own timeout text as is; a stream error by its code only (issue #538, every phase since #564).
function stdinWhy(error: unknown): string {
  const own = /^stdin not closed within \d+ ms$/.exec(String((error as Error)?.message))?.[0];
  return own ?? `stdin read failed (${codeOf(error)})`;
}

async function main(target: string | undefined, phase: string): Promise<void> {
  const fail = (why: string): void => emit(adapterFailure(phase, why), "", undefined, phase);
  if (!target) return fail("no guard given");
  if (!path.isAbsolute(target)) return fail("guard path is not absolute");
  let raw: string;
  try { raw = await readStdin(); } catch (error) { return fail(stdinWhy(error)); }
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { /* not JSON */ }
  if (!isObject(payload)) return fail("stdin is not a JSON object");
  const cap = phase === INTENT_PHASE ? INTENT_GUARD_TIMEOUT_MS : GUARD_TIMEOUT_MS;
  const result = preToolUse(target, phase, payload as HookPayload, Math.min(cap, remaining()),
    { guardArgs: process.argv.slice(4), deadline: DEADLINE });
  const [notice] = await Promise.all([within(recheck(raw, result.broken), remaining(),
    () => "hook integrity re-check unavailable (no result before the hook deadline)"), journalCall(payload as HookPayload, result.verdicts)]);
  emit(result.verdict, result.stderr, notice, phase);
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
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
  const target = process.argv[2];
  const phase = process.argv[3] || "pre";
  if (!PRE_TOOL_USE_PHASES.has(phase)) postMain(target, phase);
  else main(target, phase).catch(() => emit(adapterFailure(phase, "internal error"), "", undefined, phase)); // fixed text: no raw error
}
