#!/usr/bin/env node
// Issue #507, parts 1 and 2: node "<home>/hooks/guard-dispatch.mts" "<home>/hooks/<guard>.mts" ... runs one matcher group's guards in
// parallel to the end (exit 2 = deny, stderr the reason); deny > ask > allow, notices join. A guard that cannot run (missing, empty,
// outside this directory, killed, past its cap, exit other than 0 or 2, stdout that is no accepted decision) is a deny naming it, as is
// stdin that is no JSON object or stays open. Started by kherep/hook-runtime/entry.mts; a heartbeat (<home>/.cache/hook-integrity/
// heartbeat.json) older than 30 minutes or missing, or a guard that could not run, starts live-hook-integrity.mts: a notice, never a
// decision. Issue #504: a delegated run's call is journalled. One deadline before the 30 s timeout bounds it all; exit after the write.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Each PreToolUse entry of claude/settings.user.json has "timeout": 30; a test pins both.
const HOOK_TIMEOUT_MS = 30_000;
// Outside this clock: Node start (<= 2 s assumed; 0.09 s on macOS, Windows UNKNOWN), emit (<= 0.5 s).
const SAFETY_MARGIN_MS = 5_000;
// Admitted by the hook runtime (kherep/hook-runtime): its read capability, whose deadline comes first.
type Runtime = { mode?: string; deadline: number; release: () => void; childArgs: (f: string) => string[];
  writerArgs: (f: string) => string[] };
const RUNTIME = (globalThis as Record<symbol, unknown>)[Symbol.for("kherep.hook-runtime")] as Runtime | undefined;
const CAP = RUNTIME?.mode === "reader" ? RUNTIME : undefined;
const NOT_ADMITTED = /\[hook-runtime\] not admitted \(([a-z -]+)\)/;
const DEADLINE = Math.min(Date.now() + HOOK_TIMEOUT_MS - SAFETY_MARGIN_MS, CAP?.deadline ?? Infinity);
const remaining = (): number => Math.max(0, DEADLINE - Date.now());
const GUARD_TIMEOUT_MS = 10_000;
// A re-check gets <= RECHECK_MAX_MS of what is left, none below RECHECK_MIN_MS; its lib loads within RECHECK_LOAD_MS.
const RECHECK_MAX_MS = 20_000, RECHECK_MIN_MS = 2_000, RECHECK_LOAD_MS = 2_000;
const HEARTBEAT_WINDOW_MS = 1_800_000; // = lib/integrity-heartbeat.mts; each side has a boundary test
const JOURNAL_CAP_MS = 1_500, AGENT_LEAF = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"; // issue #504
const SELF = fileURLToPath(import.meta.url), DIR = path.dirname(SELF), SELF_LABEL = path.basename(SELF);
const INVOKED_DIR = path.dirname(path.resolve(process.argv[1] ?? SELF));
const HOME = path.dirname(INVOKED_DIR);

const DECISIONS = ["deny", "ask", "allow"] as const;
type Decision = typeof DECISIONS[number];
// No decision: a plain allow or a notice only. `broken`: the guard could not run (a re-check follows).
interface Verdict { decision?: Decision; reason: string; notice?: string; broken?: boolean }
interface Outcome { verdict: Verdict; stderr: string }

const failure = (file: string, why: string): Verdict => ({ decision: "deny", broken: true,
  reason: `[guard-dispatch] ${file} cannot run (${why}); the tool call is blocked until hook integrity restores it`,
});

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

// Real directory: a symlinked Claude home (macOS /var -> /private/var) keeps its guards inside.
const realDir = (dir: string): string => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } };
const isInside = (file: string, dir: string): boolean => { const rel = path.relative(dir, file); return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel); };
// A symlinked guard counts where it points; a missing one keeps its name and fails at stat.
const realFile = (file: string): string => { try { return fs.realpathSync(file); } catch { return path.join(realDir(path.dirname(file)), path.basename(file)); } };
// Issue #564, as kherep/hook-runtime/entry.mts names a main: its path inside hooks/ (as given), else its file name.
const labelOf = (file: string): string => isInside(file, INVOKED_DIR) ? path.relative(INVOKED_DIR, file).split(path.sep).join("/") : path.basename(file);
// A Node error code, else the error's class name, else "unknown"; never a message.
const codeOf = (error: unknown): string => { const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,40}$/.test(code) ? code : typeof name === "string" && /^[A-Za-z]{1,40}Error$/.test(name) ? name : "unknown"; };
// Accepts 1 to 64 characters of AGENT_LEAF and returns them rebuilt from that constant; anything else is "".
const leafOf = (value: string): string => { let leaf = ""; for (const ch of value) { const at = AGENT_LEAF.indexOf(ch); if (at < 0) return ""; leaf += AGENT_LEAF[at]; }
  return leaf.length >= 1 && leaf.length <= 64 ? leaf : ""; };

// Why the file cannot be run, or undefined when it can.
function unrunnable(file: string, ownDir: string): string | undefined {
  const real = realFile(file);
  if (!isInside(real, ownDir)) return "outside the hooks directory";
  if (path.relative(real, path.join(ownDir, path.basename(SELF))) === "") return "it is the dispatcher itself";
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "missing" : `stat failed: ${codeOf(error)}`;
  }
  if (!stat.isFile()) return "not a regular file";
  if (stat.size === 0) return "empty, 0 bytes";
  return undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const NOT_DECISION = "stdout is not a PreToolUse decision";
const FIELDS = ["hookEventName", "permissionDecision", "permissionDecisionReason", "additionalContext"];

// The verdict a guard printed on exit 0, or why stdout is not the accepted shape; a field the dispatcher would drop fails.
function printed(stdout: string): Verdict | string {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return NOT_DECISION; }
  if (!isObject(parsed) || !isObject(parsed.hookSpecificOutput)) return NOT_DECISION;
  const output = parsed.hookSpecificOutput;
  if (output.hookEventName !== "PreToolUse") return NOT_DECISION;
  const extra = Object.keys(parsed).find((key) => key !== "hookSpecificOutput")
    ?? Object.keys(output).find((key) => !FIELDS.includes(key));
  if (extra !== undefined) return `${NOT_DECISION} (unsupported field ${extra || '""'})`;
  const { permissionDecision, permissionDecisionReason, additionalContext } = output;
  if (permissionDecision !== undefined && !DECISIONS.includes(permissionDecision as Decision)) {
    return `${NOT_DECISION} (invalid field permissionDecision)`;
  }
  // A reason without a decision would be dropped.
  if (permissionDecisionReason !== undefined && (typeof permissionDecisionReason !== "string" || !permissionDecision)) {
    return `${NOT_DECISION} (invalid field permissionDecisionReason)`;
  }
  if (additionalContext !== undefined && (typeof additionalContext !== "string" || !additionalContext)) {
    return `${NOT_DECISION} (invalid field additionalContext)`;
  }
  if (permissionDecision === undefined && additionalContext === undefined) return NOT_DECISION;
  return {
    decision: permissionDecision as Decision | undefined,
    reason: permissionDecisionReason ?? "",
    ...(additionalContext ? { notice: additionalContext } : {}),
  };
}

function judge(label: string, code: number | null, signal: string | null, stdout: string, stderr: string): Verdict {
  if (signal) return failure(label, `killed by ${signal}`);
  if (code === 2) {
    return { decision: "deny", reason: stderr.trim() || `${label} blocked this tool call without giving a reason` };
  }
  if (code !== 0) return failure(label, `exit code ${code}`);
  if (!stdout.trim()) return { reason: "" };
  const result = printed(stdout);
  return typeof result === "string" ? failure(label, result) : result;
}

// The type-stripping warning of a .mts guard, also after its unterminated output: only it is dropped, every diagnostic stays.
const TYPE_STRIPPING_WARNING = new RegExp("\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n(?:\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning "
  + "was created\\)\\r?\\n)?", "g");

function runGuard(file: string, label: string, payload: string): Promise<Outcome> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", settled = false;
    const filtered = (): string => stderr.replace(TYPE_STRIPPING_WARNING, "");
    const settle = (verdict: Verdict): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ verdict, stderr: filtered() });
    };
    // Under the runtime each guard is admitted itself and reports ready; without that it did not run.
    const child = spawn(process.execPath, CAP ? CAP.childArgs(file) : [file],
      { stdio: CAP ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"], windowsHide: true });
    let ready = !CAP;
    child.on("message", (m: { kherep?: unknown; v?: unknown; pid?: unknown }) => { ready ||= m?.kherep === "ready" && m.v === 1 && m.pid === child.pid; });
    const cap = Math.min(GUARD_TIMEOUT_MS, remaining());
    const timer = setTimeout(() => {
      settle(failure(label, `timed out after ${Number((cap / 1000).toFixed(1))} s`));
      child.kill("SIGKILL");
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
    }, cap);
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => settle(failure(label, `spawn failed (${codeOf(error)})`)));
    child.on("close", (code, signal) => settle(ready ? judge(label, code, signal, stdout, filtered())
      : failure(label, `not admitted: ${NOT_ADMITTED.exec(stderr)?.[1] ?? "it ended before admission"}`)));
    // A guard may exit without reading its payload; the broken pipe is no verdict.
    child.stdin!.on("error", () => {});
    child.stdin!.end(payload);
  });
}

// The strongest decision with its reasons, every notice in argument order; a printed allow passes (no permission prompt).
function combine(verdicts: Verdict[]): Verdict | undefined {
  const decision = DECISIONS.find((candidate) => verdicts.some((verdict) => verdict.decision === candidate));
  const reason = verdicts.filter((verdict) => decision && verdict.decision === decision)
    .map((verdict) => verdict.reason).filter(Boolean).join("\n");
  const notice = verdicts.map((verdict) => verdict.notice).filter(Boolean).join("\n");
  if (!decision && !notice) return undefined;
  return { decision, reason, ...(notice ? { notice } : {}) };
}

// `work`, or `late()` after ms; the timer keeps the process alive meanwhile (not unref'd).
function within<T, L>(work: Promise<T>, ms: number, late: () => L): Promise<T | L> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<L>((resolve) => { timer = setTimeout(() => resolve(late()), ms); });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

// The re-check notice (lib/guard-recheck.mts) or undefined, never a verdict. A broken or empty lib throws; a hanging one is not waited for.
async function recheck(payload: string, guards: Promise<Outcome[]>, ownDir: string): Promise<string | undefined> {
  const loadMs = Math.min(RECHECK_LOAD_MS, remaining());
  const lib = await within(import("./lib/guard-recheck.mts"), loadMs, () => undefined);
  if (!lib) return `hook integrity re-check unavailable (lib/guard-recheck.mts did not load within ${loadMs} ms)`;
  return lib.recheckAfter({ home: HOME, script: path.join(INVOKED_DIR, "live-hook-integrity.mts"), payload, guards,
    unrunnable: (file) => unrunnable(file, ownDir), remaining, windowMs: HEARTBEAT_WINDOW_MS,
    maxMs: RECHECK_MAX_MS, minMs: RECHECK_MIN_MS, runtime: CAP });
}

// Issue #504: a delegated run's call line (lib/denial-journal.mts), else a marker; never a verdict, never past its caps. The lib has
// JOURNAL_CAP_MS; the marker write is then awaited until DEADLINE (issue #614): emit() exits through process.exit(0), which abandons a
// pending fs.promises write, so a marker given a fixed 400 ms slice was missing after a slow write (ENOENT in the Codex twin, #612).
async function journal(payload: Record<string, unknown>, verdicts: Verdict[]): Promise<void> {
  const id = payload.agent_id, leaf = typeof id === "string" ? leafOf(id) : "", cap = Math.min(JOURNAL_CAP_MS, remaining()); // a lib that is missing, empty, throws or hangs is caught
  if (!leaf || payload.tool_name === "SubagentHandback") return;
  const fail = await within(import("./lib/denial-journal.mts").then((lib) => lib.journalVerdict(HOME, payload, verdicts, Date.now() + cap - 50)),
    cap, () => "lib-timeout").catch(() => "lib-load"), base = path.join(HOME, ".cache", "denied-calls", leaf);
  if (fail) await within(fs.promises.mkdir(path.dirname(base), { recursive: true, mode: 0o700 }).then(() => fs.promises.appendFile(`${base}.failed`,
    `${fail}\n`, { mode: 0o600 })).catch(() => fs.promises.rename(`${base}.jsonl`, `${base}.failed`)), remaining(), () => {}).catch(() => {});
}

async function dispatch(guards: string[]): Promise<{ verdict?: Verdict; stderr: string[] }> {
  let raw: string;
  try { raw = await readStdin(); } catch (error) { // readStdin's own timeout text, else the stream error's code
    const own = /^stdin not closed within \d+ ms$/.exec(String((error as Error)?.message))?.[0];
    return { verdict: failure(SELF_LABEL, own ?? `stdin read failed (${codeOf(error)})`), stderr: [] };
  }
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { /* not JSON */ }
  if (!isObject(payload)) return { verdict: failure(SELF_LABEL, "stdin is not a JSON object"), stderr: [] };
  if (!guards.length) return { verdict: failure(SELF_LABEL, "no guard given"), stderr: [] };
  const ownDir = realDir(DIR);
  const running = Promise.all(guards.map((arg) => {
    const file = path.resolve(arg), label = labelOf(file), why = unrunnable(file, ownDir);
    return why ? { verdict: failure(label, why), stderr: "" } : runGuard(file, label, raw);
  }));
  const checking = within(recheck(raw, running, ownDir)
    .catch((error) => `hook integrity re-check unavailable (lib/guard-recheck.mts cannot be loaded (${codeOf(error)}))`),
  remaining(), () => "hook integrity re-check unavailable (no result before the hook deadline)");
  const [outcomes, notice] = await Promise.all([running, checking]);
  const verdicts = outcomes.map((outcome) => outcome.verdict);
  const stderr = outcomes.map((outcome) => outcome.stderr);
  await journal(payload, verdicts);
  if (notice) { verdicts.push({ reason: "", notice }); stderr.push(notice); }
  return { verdict: combine(verdicts), stderr };
}

// Exits in its last write's callback (every used stream flushed), at once with nothing to write.
function emit(verdict: Verdict | undefined, stderr: string[]): void {
  let pending = 0;
  const flushed = (): void => { if (--pending === 0) process.exit(0); };
  const put = (stream: NodeJS.WriteStream, text: string): void => { pending++; stream.write(text, flushed); };
  for (const text of stderr) if (text) put(process.stderr, text.endsWith("\n") ? text : `${text}\n`);
  if (verdict) put(process.stdout, JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse",
    ...(verdict.decision ? { permissionDecision: verdict.decision } : {}),
    ...(verdict.reason ? { permissionDecisionReason: verdict.reason } : {}),
    ...(verdict.notice ? { additionalContext: verdict.notice } : {}) } }));
  if (pending === 0) process.exit(0);
}

dispatch(process.argv.slice(2)).then(
  ({ verdict, stderr }) => emit(verdict, stderr),
  () => emit(failure(SELF_LABEL, "internal error"), []), // fixed text: no raw error, no path
);
