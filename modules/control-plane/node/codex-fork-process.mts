import {requireMessageEffect} from './message-admission.mts';
import { verifyPreparedLaunch } from "./target-delivery-launch.mts";
import { routeSnapshot } from "./target-delivery-route.mts";
import { getMessage } from "./inbox.mts";
import { canonical } from "./target-delivery-state.mts";
import type { ExecutionContext } from "./target-delivery-operation.mts";
import { checkExecution, beginRouteEffect } from "./target-delivery-route.mts";
import { finishRouteEffect } from "./target-delivery-outcome.mts";
import type { NodePaths } from "./config.mts";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

import { CODEX_FORK_ENV } from "./codex-busy-consume.mts";
import {
  AppServerClient, AppServerExitedError, AppServerRequestError, AppServerTimeoutError, type AppServerSpawn,
} from "./codex-app-server-client.mts";
import {
  classifyForkGoalOutcome, classifyOwnerGoalOutcome, type ForkGoalDetail, type ForkGoalProof, type RpcOutcome,
} from "./codex-fork-goal.mts";
import { forkOutputSchema, forkPrompt, validateForkAnswer } from "./codex-fork-answer.mts";
import type { ForkAttemptReason } from "./codex-fork-attempts.mts";
import { forkRpcError, type ForkRpcMethod } from "./codex-fork-refusal.mts";
import { ForkWatch } from "./codex-fork-watch.mts";
import { lastLine } from "./codex-output.mts";
import { signalGroupReport, type CodexDeps } from "./codex-process.mts";
import type { QueueProducerIdentity } from "./codex-queue-binding.mts";
import type { InboxRecord } from "./inbox.mts";
import { retainServiceAdmission, type ServiceAdmission } from "./service-drain.mts";

export { forkOutputSchema, forkPrompt, validateForkAnswer } from "./codex-fork-answer.mts";
export { forkParams, parseFeaturesList, FORK_FEATURE_KEYS } from "./codex-fork-params.mts";
import { forkParams } from "./codex-fork-params.mts";

// One Codex fork attempt (issue #408, design sections 2 to 4): a short-lived
// `codex app-server` of the approved binary in its own process group, the
// read-only preflight on the owner (never resumed, never given a turn), one
// ephemeral fork at the owner's newest completed turn, one structured turn on
// the fork, then close. Before the attempt is running every failure is
// "failed"; after it, "uncertain", because a turn may have run. A shutdown
// that cannot be confirmed is always "uncertain".

export const FORK_TURN_TIMEOUT_MS = 180_000;
export const APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"];
export interface ForkTimeouts { initializeMs: number; requestMs: number; forkMs: number; turnMs: number; interruptMs: number; graceMs: number }
const TIMEOUTS: ForkTimeouts = { initializeMs: 5_000, requestMs: 10_000, forkMs: 30_000, turnMs: FORK_TURN_TIMEOUT_MS, interruptMs: 5_000,
  graceMs: 250 };
const VERSION = ((): string => {
  try {
    const value = (JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version?: unknown }).version;
    return typeof value === "string" ? value : "0.0.0";
  } catch { return "0.0.0"; }
})();

export interface ForkRunInput {
  context?:ExecutionContext; paths?:NodePaths;
  owner: string; cwd: string; producer: QueueProducerIdentity; features: Set<string>; mcpNames: string[]; record: InboxRecord;
  maxAnswerBytes: number; admission: ServiceAdmission;
  // Step 5: false when the owner read the message meanwhile ("original wins").
  stillAccepted: () => boolean;
  // Fresh permission check, required at every continuation and result boundary.
  continueAllowed: () => boolean;
  // Step 8: persists launching -> running with the goal proof; a throw makes the attempt uncertain.
  running: (lastTurnId: string, forkId: string, goalProof: ForkGoalProof) => void;
  log: (line: string) => void; timeouts?: Partial<ForkTimeouts>; realpath?: (file: string) => string;
}
type Phase = "launching" | "running";
export type ForkOutcome = { state: "completed"; from: "running"; answer: string }
  | { state: "declined"; from: "running"; reason: "needs-owner" | "insufficient-context" }
  | { state: "failed" | "uncertain"; from: Phase; reason: ForkAttemptReason; detail?: ForkGoalDetail }
  | { state: "superseded"; from: Phase };

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class Stop extends Error {
  readonly reason: ForkAttemptReason;
  constructor(reason: ForkAttemptReason) { super(reason); this.reason = reason; }
}

interface Session {
  client: AppServerClient; watch: ForkWatch; input: ForkRunInput; t: ForkTimeouts; gone: () => boolean; phase: Phase;
}

function verifyForkInput(input:ForkRunInput,phase:'ready'|'executing'|'settled'):void {
  if(input.context?.kind!=='message'||!input.paths||!input.context.launch)throw Error('fork message context missing');
  const launch=input.context.launch,p=input.producer;
  verifyPreparedLaunch(input.paths,input.context,launch,['fork'],{runtime:'codex',taskId:null,sessionId:input.owner,phase});
  const current=getMessage(input.paths.inbox,input.record.messageId);
  if(!current||routeSnapshot(current)!==routeSnapshot(input.record)||input.record.toSession!==input.owner
    ||p.codexExecutable!==launch.binding.executable||p.launchFile!==launch.inner.file||canonical([...p.launchPrefix,...APP_SERVER_ARGS])!==canonical(launch.inner.args)
    ||p.resolvedCodexHome!==launch.binding.home||canonical(p.approvedFiles)!==canonical(launch.producer.files)||input.cwd!==launch.binding.cwd)throw Error('fork supplied member/producer differs');
}

export async function runForkAttempt(deps: { codex?: CodexDeps }, input: ForkRunInput): Promise<ForkOutcome> {
  if(input.context?.kind!=="message"||!input.paths)throw Error("fork message context missing");
  verifyForkInput(input,"ready");
  if (!allowed(input)) return { state: "superseded", from: "launching" };
  const t = { ...TIMEOUTS, ...input.timeouts };
  const platform = deps.codex?.platform ?? process.platform;
  const { producer } = input;
  const start = (deps.codex?.spawn ?? spawn) as unknown as AppServerSpawn;
  let child: ReturnType<AppServerSpawn>;
  try {
    beginRouteEffect(input.paths,input.context,['fork']);
    requireMessageEffect({paths:input.paths},input.context,'fork-helper');
    child = start(input.context.launch!.outer.file, input.context.launch!.outer.args, { cwd: input.cwd, stdio: "pipe",
      windowsHide: true, detached: input.context.launch!.binding.detached,
      env: { ...process.env, CODEX_HOME: producer.resolvedCodexHome, [CODEX_FORK_ENV]: "1" } });
  } catch {
    return { state: "failed", from: "launching", reason: "helper-exit" };
  }
  // Registered before the client's own listeners, so a request rejected by the
  // exit already sees it.
  let exited = false, neverStarted = false, stderr = "";
  child.once("exit", (code, signal) => {
    exited = true;
    const line = lastLine(stderr);
    // Inside an EventEmitter listener: a throwing logger must not become an uncaught exception.
    try { input.log(`kherep-node: Codex fork helper ended (${String(code ?? signal)})${line ? `: ${line}` : ""}`); } catch { /* the exit is recorded */ }
  });
  child.once("error", () => { if (child.pid === undefined) neverStarted = true; });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
  const killGroup = deps.codex?.killGroup ?? ((pid: number, value: NodeJS.Signals) => signalGroupReport(pid, value, platform));
  const watch = new ForkWatch(input.owner);
  const client = new AppServerClient(child, { requestTimeoutMs: t.requestMs, graceMs: t.graceMs, forceAfterFailure: true, strict: true,
    kill: (value) => (child.pid === undefined ? "unconfirmed" : killGroup(child.pid, value)), onServerRequest: () => watch.refuse("server-request") });
  client.onNotification((note) => watch.add(note));
  // Every violation, whenever it is detected, ends the close with the group SIGKILL.
  watch.onChange(() => { if (watch.violation) client.escalate(); });
  const gone = (): boolean => exited || neverStarted || client.failure instanceof AppServerExitedError;
  const session: Session = { client, watch, input, t, gone, phase: "launching" };
  let outcome: ForkOutcome;
  try {
    outcome = await converse(session);
  } catch {
    outcome = { state: "uncertain", from: session.phase, reason: "helper-exit" };
  }
  if (!await client.shutdown() && !neverStarted) {
    // The lease first: a logger or reporter that throws must cost neither the retention nor the outcome.
    retainServiceAdmission(input.admission);
    try {
      input.log(`kherep-node: Codex fork helper close unconfirmed (${client.killReport === "unconfirmed" ? "group kill not confirmed" : "helper did not end"})`);
    } catch { /* the retention above holds */ }
    try { deps.codex?.onUnconfirmedShutdown?.(); } catch { /* the retention above holds */ }
    return { state: "uncertain", from: outcome.from, reason: "close-unconfirmed" };
  }
  outcome = discardOnViolation(outcome, watch);
  if ((outcome.state === "completed" || outcome.state === "declined") && !allowed(input)) {
    return { state: "superseded", from: outcome.from };
  }
  return outcome;
}

function allowed(input: ForkRunInput): boolean {
  try { return input.continueAllowed() === true; } catch { return false; }
}

function continuation(s: Session): ForkOutcome | null {
  if (allowed(s.input)) return null;
  return s.watch.violation ? { state: "failed", from: s.phase, reason: s.watch.violation }
    : { state: "superseded", from: s.phase };
}

// A watch rule that fired at any time, also in the stdout chunk that carried
// turn/completed or while the helper closed, discards output, including a withdrawn result.
function discardOnViolation(outcome: ForkOutcome, watch: ForkWatch): ForkOutcome {
  if (!watch.violation || (outcome.state !== "completed" && outcome.state !== "declined" && outcome.state !== "superseded")) return outcome;
  return { state: "failed", from: outcome.from, reason: watch.violation };
}

async function ask(s: Session, method: ForkRpcMethod, params: unknown, ms: number, reason: ForkAttemptReason, lastTurnId?: string): Promise<unknown> {
  try { return await s.client.request(method, params, ms); } catch (error) {
    // Issue #477: a refusal logs content-free metadata; a throwing formatter or logger leaves it as it is.
    if (error instanceof AppServerRequestError && !s.gone()) try { s.input.log(forkRpcError(method, error, s.input, lastTurnId).line); } catch { /* the refusal stands */ }
    throw new Stop(s.gone() ? "helper-exit" : reason);
  }
}

// One thread/goal/get as the RPC outcome the pure checks of codex-fork-goal.mts
// read: the raw code and message of an error, never its redacted line.
async function goalOutcome(s: Session, threadId: string): Promise<RpcOutcome> {
  try { return { kind: "result", result: await s.client.request("thread/goal/get", { threadId }, s.t.requestMs) }; } catch (error) {
    if (error instanceof AppServerRequestError && error.code !== undefined && error.rawMessage !== undefined) {
      return { kind: "error", code: error.code, message: error.rawMessage };
    }
    return error instanceof AppServerTimeoutError ? { kind: "timeout" } : { kind: "transport" };
  }
}

function sameDir(s: Session, value: unknown): boolean {
  if (typeof value !== "string") return false;
  try { return (s.input.realpath ?? fs.realpathSync.native)(value) === s.input.cwd; } catch { return false; }
}

async function converse(s: Session): Promise<ForkOutcome> {
  const { input } = s, owner = input.owner;
  const failed = (reason: ForkAttemptReason): ForkOutcome => ({ state: "failed", from: "launching", reason });
  try {
    await ask(s, "initialize", { clientInfo: { name: "kherep_fork_reply", version: VERSION }, capabilities: { experimentalApi: true } },
      s.t.initializeMs, "initialize");
    let veto = continuation(s);
    if (veto) return veto;
    s.client.notify("initialized", {});
    const read = await ask(s, "thread/read", { threadId: owner, includeTurns: false }, s.t.requestMs, "cwd-mismatch");
    const thread = object(read) && object(read.thread) ? read.thread : null;
    if (!thread || thread.id !== owner || thread.ephemeral !== false || !sameDir(s, thread.cwd)) return failed("cwd-mismatch");
    if ((veto = continuation(s))) return veto;
    const turns = await ask(s, "thread/turns/list", { threadId: owner, limit: 1, sortDirection: "desc", itemsView: "notLoaded" },
      s.t.requestMs, "last-turn-not-completed");
    const rows = object(turns) && Array.isArray(turns.data) ? turns.data : [];
    const newest = rows.length === 1 && object(rows[0]) ? rows[0] : null;
    if (!newest || newest.status !== "completed" || typeof newest.id !== "string" || !newest.id) return failed("last-turn-not-completed");
    if ((veto = continuation(s))) return veto;
    const ownerGoal = classifyOwnerGoalOutcome(await goalOutcome(s, owner));
    if (s.gone()) return failed("helper-exit");
    if (!ownerGoal.ok) return failed(ownerGoal.reason);
    if (s.watch.violation) return failed(s.watch.violation);
    if (!input.stillAccepted()) return { state: "superseded", from: "launching" };
    if ((veto = continuation(s))) return veto;
    verifyForkInput(input,"executing");
    const params=forkParams(owner,newest.id,input.cwd,input.features,input.mcpNames);
    requireMessageEffect({paths:input.paths!},input.context,'thread-fork');
    const fork = await ask(s, "thread/fork", params, s.t.forkMs,
      "fork-rejected", newest.id);
    const forkThread = object(fork) && object(fork.thread) ? fork.thread : null;
    const forkId = forkThread?.id;
    if (!forkThread || typeof forkId !== "string" || !UUID.test(forkId) || forkId === owner || forkThread.forkedFromId !== owner
      || forkThread.ephemeral !== true || !object(fork) || !object(fork.sandbox) || fork.sandbox.type !== "readOnly"
      || fork.approvalPolicy !== "on-request" || !sameDir(s, fork.cwd)) return failed("fork-shape");
    // The watch rules are armed from the fork response on, also during the goal check.
    s.watch.setFork(forkId);
    if ((veto = continuation(s))) return veto;
    const forkGoal = classifyForkGoalOutcome(await goalOutcome(s, forkId), forkId, ownerGoal.outcome);
    if (s.watch.violation) return failed(s.watch.violation);
    if (!forkGoal.ok) return { state: "failed", from: "launching", reason: "fork-goal", detail: forkGoal.detail };
    if ((veto = continuation(s))) return veto;
    try { input.running(newest.id, forkId, forkGoal.proof); } catch { return { state: "uncertain", from: "launching", reason: "helper-exit" }; }
    finishRouteEffect(input.paths!,input.context!,{kind:"fork",forkId,turnId:null});
    s.phase = "running";
    return await turn(s, forkId);
  } catch (error) {
    if (error instanceof Stop) return failed(error.reason);
    throw error;
  }
}

type TurnEnd = { kind: "completed"; params: unknown } | { kind: "violation" } | { kind: "gone" } | { kind: "timeout" };

function waitTurn(s: Session, forkId: string, turnId: string): Promise<TurnEnd> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (end: TurnEnd): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(end);
    };
    const scan = (): void => {
      if (s.watch.violation) return finish({ kind: "violation" });
      const completed = s.watch.notifications.find((note) => note.method === "turn/completed" && object(note.params)
        && note.params.threadId === forkId && object(note.params.turn) && note.params.turn.id === turnId);
      if (completed) finish({ kind: "completed", params: completed.params });
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), s.t.turnMs);
    const unsubscribe = s.watch.onChange(scan);
    s.client.onFailure(() => { scan(); finish({ kind: "gone" }); });
    scan();
  });
}

async function turn(s: Session, forkId: string): Promise<ForkOutcome> {
  const failed = (reason: ForkAttemptReason): ForkOutcome => ({ state: "failed", from: "running", reason });
  const uncertain = (reason: ForkAttemptReason): ForkOutcome => ({ state: "uncertain", from: "running", reason });
  let veto = continuation(s);
  if (veto) return veto;
  const prompt = forkPrompt(s.input.record, crypto.randomUUID().slice(-12), s.input.maxAnswerBytes);
  s.watch.turnRequested();
  let started: unknown;
  try {
    verifyForkInput(s.input,"executing");
    requireMessageEffect({paths:s.input.paths!},s.input.context,'turn-start');
    started = await s.client.request("turn/start", { threadId: forkId, input: [{ type: "text", text: prompt, text_elements: [] }],
      outputSchema: forkOutputSchema }, s.t.requestMs);
  } catch {
    return uncertain(s.gone() ? "helper-exit" : "turn-failed");
  }
  const turnId = object(started) && object(started.turn) && typeof started.turn.id === "string" ? started.turn.id : null;
  if (!turnId) return uncertain("turn-failed");
  finishRouteEffect(s.input.paths!,s.input.context!,{kind:"fork",forkId,turnId});
  s.watch.setTurn(turnId);
  const interrupt = (): Promise<unknown> => s.client.request("turn/interrupt", { threadId: forkId, turnId }, s.t.interruptMs)
    .catch(() => undefined);
  if ((veto = continuation(s))) {
    s.client.escalate();
    await interrupt();
    return veto;
  }
  const end = await waitTurn(s, forkId, turnId);
  if (end.kind === "violation" || end.kind === "timeout") {
    s.client.escalate();
    await interrupt();
    return end.kind === "timeout" ? uncertain("turn-timeout") : failed(s.watch.violation!);
  }
  if (end.kind === "gone") return uncertain("helper-exit");
  if (s.watch.violation) return failed(s.watch.violation);
  if ((veto = continuation(s))) return veto;
  const answer = validateForkAnswer(s.watch.notifications, end.params, forkId, turnId, s.input.maxAnswerBytes);
  if (answer.kind === "answer") return { state: "completed", from: "running", answer: answer.text };
  if (answer.kind === "decline") return { state: "declined", from: "running", reason: answer.code };
  return failed(answer.reason);
}
