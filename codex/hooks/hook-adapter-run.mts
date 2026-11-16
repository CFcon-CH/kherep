// Issue #533. The guard loops of the Codex hook adapter: every item of a PreToolUse phase
// within one budget, and the PostToolUse loop. The shell dispatcher reuses runAdaptedHook.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import { normalizeDeployApproval, normalizePayloads, type HookPayload } from "./hook-adapter-payload.mts";
import { codeOf, combine, failureFor, INTENT_PHASE, judge, labelOf, MIN_SPAWN_MS, PRE_TOOL_USE_PHASES, render, unrunnable, type Verdict }
  from "./hook-adapter-verdict.mts";

type Spawn = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;
// guardArgs reach the guard after its path; deadline is an absolute end (ms since the epoch); spawn is a test seam.
export interface AdaptedOptions { guardArgs?: string[]; deadline?: number; spawn?: Spawn }
export interface AdaptedResult { stdout: string; stderr: string; status: number; broken?: boolean }

// The budget of one guard item: an integer, whatever the clock's fraction.
export const budgetFor = (capEnd: number, hardEnd: number, now: number): number => Math.floor(Math.min(capEnd, hardEnd) - now);

type ShapeLib = typeof import("../../claude/hooks/lib/tool-event-shape.mts");
const require = createRequire(import.meta.url);
// Only the source layout can resolve a checkout dependency. Installed/copied modules
// require their own lib, even if a different checkout happens to exist nearby.
export function toolEventShapeLib(): ShapeLib {
  const source = path.basename(import.meta.dirname) === "hooks" && path.basename(path.dirname(import.meta.dirname)) === "codex";
  return require(source ? path.resolve(import.meta.dirname, "../../claude/hooks/lib/tool-event-shape.mts")
    : path.join(import.meta.dirname, "lib/tool-event-shape.mts")) as ShapeLib;
}

// Every item of a PreToolUse phase within one budget; the first deny ends the loop.
export function preToolUse(target: string, phase: string, payload: HookPayload, timeoutMs: number | undefined,
  options: AdaptedOptions): { verdict?: Verdict; stderr: string; broken: boolean; verdicts: Verdict[] } {
  const fail = failureFor(phase);
  const intent = phase === INTENT_PHASE;
  const why = unrunnable(target), label = labelOf(target); // reasons name the label, the spawn takes the target
  if (why) {
    const verdict = fail(label, why);
    return { verdict, stderr: "", broken: verdict.broken === true, verdicts: [verdict] };
  }
  const begin = Date.now();
  const capEnd = timeoutMs === undefined ? Infinity : begin + timeoutMs;
  const hardEnd = options.deadline ?? Infinity;
  const verdicts: Verdict[] = [];
  let stderr = "";
  // Issue #808: a guard whose contract row has a native Codex shape is classified before normalization.
  let guard: ReturnType<ShapeLib["codexShapeGuard"]>;
  let warning: string | undefined;
  if (!intent) {
    try {
      const lib = toolEventShapeLib();
      guard = lib.codexShapeGuard(path.basename(target, ".mts"));
      const shape = guard && lib.classifyToolEvent(payload, guard, "codex");
      if (guard && shape && shape.kind === "unclassifiable") warning = lib.warningText(guard, shape.reason);
    } catch (error) {
      const verdict = fail(label, `event shape helper cannot load (${codeOf(error)})`);
      return { verdict, stderr, broken: true, verdicts: [verdict] };
    }
  }
  // pre-intent: one item by construction, so the rewrite never depends on normalization.
  const items = intent ? [payload] : normalizePayloads(payload, phase);
  for (const [index, item] of items.entries()) {
    const normalized = phase === "pre-no-transcript" ? normalizeDeployApproval({ ...item, transcript_path: null }) : item;
    const budget = budgetFor(capEnd, hardEnd, Date.now());
    let verdict: Verdict;
    if (budget < MIN_SPAWN_MS) {
      verdict = fail(label, `budget exhausted before item ${index + 1} of ${items.length} (${Date.now() - begin} ms used)`, false);
    } else {
      try {
        // Node 22/24 print a type-stripping ExperimentalWarning for an .mts guard on stderr.
        const result = (options.spawn ?? spawnSync)(process.execPath, ["--disable-warning=ExperimentalWarning", target, ...(options.guardArgs ?? [])],
          { encoding: "utf8", input: JSON.stringify(normalized), windowsHide: true, timeout: budget, killSignal: "SIGKILL" });
        if (!intent) stderr += result.stderr ?? ""; // pre-intent forwards no raw error text (issue #538)
        verdict = judge(label, result, budget, phase, normalized.tool_input);
        // judge/render rebuild JSON and would erase duplicate keys or whitespace.
        // Only raw notice-only output from a guard with a codex row has the shape contract;
        // keep existing decisions/failures and adapter-originated warnings unchanged.
        if (!verdict.decision && verdict.notice && guard && !toolEventShapeLib().parseShapeWarning(result.stdout, guard)) {
          verdict = fail(label, "stdout is not a canonical event shape warning");
        }
      } catch (error) {
        // Option validation or anything else Node throws before the child exists: no file fault.
        verdict = fail(label, `spawn threw (${codeOf(error)})`, false);
      }
    }
    verdicts.push(verdict);
    if (verdict.decision === "deny") break;
  }
  if (warning) {
    // The shared guard may already have emitted the same line. Keep one reason
    // per guard/call while retaining all old policy decisions and failures.
    for (const verdict of verdicts) if (verdict.notice) {
      const lines = verdict.notice.split("\n").filter(line => line !== warning);
      verdict.notice = lines.join("\n") || undefined;
    }
    verdicts.push({ reason: "", notice: warning });
    if (!stderr.split("\n").includes(warning)) stderr += `${warning}\n`;
  }
  return { verdict: combine(verdicts), stderr, broken: verdicts.some((verdict) => verdict.broken), verdicts };
}

// The PostToolUse loop as before #507 part 3: no kill signal, no guard arguments, status passed through.
function postToolUse(target: string, phase: string, payload: HookPayload, timeoutMs?: number): AdaptedResult {
  let held = "";
  let stderr = "";
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  for (const item of normalizePayloads(payload, phase)) {
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", target], { encoding: "utf8",
      input: JSON.stringify(item), windowsHide: true, ...(deadline === undefined ? {} : { timeout: Math.max(1, deadline - Date.now()) }) });
    if (result.stdout) held += result.stdout;
    if (result.stderr) stderr += result.stderr;
    if (result.error || result.signal || result.status !== 0) return { stdout: held, stderr, status: result.status || 1 };
  }
  return { stdout: held, stderr, status: 0 };
}

// Also used by the shell dispatcher: reuse the exact normalization and guard
// invocation without starting one adapter process per guard. A PreToolUse
// result has status 0 and at most one decision document on stdout.
export function runAdaptedHook(target: string, phase: string, payload: HookPayload, timeoutMs?: number,
  options: AdaptedOptions = {}): AdaptedResult {
  if (!PRE_TOOL_USE_PHASES.has(phase)) return postToolUse(target, phase, payload, timeoutMs);
  const { verdict, stderr, broken } = preToolUse(target, phase, payload, timeoutMs, options);
  return { stdout: render(verdict), stderr, status: 0, broken };
}
