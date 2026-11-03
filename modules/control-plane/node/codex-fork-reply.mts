import {readCodexSession} from './codex-sessions.mts';
import {bindMessageAdmission} from './message-admission.mts';
import { prepareMessageLaunch } from "./target-delivery-launch.mts";
import { decideMessageRoute, commandProducer } from "./target-delivery-producer.mts";
import { finishRouteEffect } from "./target-delivery-outcome.mts";
import path from "node:path";

import { MESSAGING_PROXY_CAPABILITY } from "../protocol-messages.mts";
import { audit, type AutonomyAction } from "./autonomy.mts";
import { findCodex } from "./codex-binary.mts";
import { busyPolicyFingerprint } from "./codex-busy-policy.mts";
import { admitForkReply, recheckForkReply, FORK_AUDIT, type PreClaimRefusal } from "./codex-fork-admission.mts";
import { advanceForkAttempt, claimForkAttempt, readForkAttempt } from "./codex-fork-attempts.mts";
import { parseFeaturesList } from "./codex-fork-params.mts";
import { markRelayDue } from "./codex-fork-relay.mts";
import { APP_SERVER_ARGS, runForkAttempt, type ForkOutcome, type ForkTimeouts } from "./codex-fork-process.mts";
import { intercomMcpOverrides, MCP_CACHE_MS, runMcpList } from "./codex-mcp.mts";
import type { CodexDeps } from "./codex-process.mts";
import type { QueueProducerIdentity } from "./codex-queue-binding.mts";
import { isDirectNativeQueueIdentity, queueProducerIdentity } from "./codex-queue-context.mts";
import { getMessage } from "./inbox.mts";
import { readPolicy } from "./policy.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { retainServiceAdmission, waitForServiceAdmission, type ServiceAdmission } from "./service-drain.mts";

// The Codex fork reply producer (issue #408, design sections 2 and 6): for an
// opted-in, idle owner with an accepted exact-addressed message, one helper
// at a time on the whole node forks the owner and stores the validated
// answer in the attempt file; the relay sweep (codex-fork-relay.mts, PR 4)
// then hands it to the exchange as one labelled proxy answer. No inbox, progress or session record
// changes. With wake.codexFork absent nothing past the first check runs.
// Every refusal before the claim is one wake.jsonl line, fork- and the code (issue #444).

const pending = new Map<string, Promise<void>>();
let forkLane: Promise<void> = Promise.resolve();
// Tests only: shorter step timeouts for the helper.
export const forkTestTimeouts: { value?: Partial<ForkTimeouts> } = {};

// Every pre-claim refusal once per owner, message and code (issue #444), whatever
// other codes the same message saw in between. Not note() of codex-wake.mts: it
// keeps one action per message, so the hint path's own "wake" note in between
// would audit the same refusal again. Not audited: no due message, a pending
// lane, an owner the scheduler finds not opted in, an unreadable file, a message with an attempt
// (the attempt file is the record) and a lost claim race (the file exists).
// A code counts as noted only once its line was appended: a failed append is retried.
// Keyed by owner, then message: the inbox can readdress a message id to another session.
const noted = new Map<string, Map<string, Set<AutonomyAction>>>();
function noteOnce(deps: RunnerDeps, owner: string, messageIds: string[], action: AutonomyAction): void {
  const mine = noted.get(owner) ?? new Map<string, Set<AutonomyAction>>();
  const fresh = messageIds.filter((id) => !mine.get(id)?.has(action));
  if (fresh.length === 0) return;
  audit(deps.paths, deps.now?.() ?? Date.now(), owner, fresh, action);
  for (const id of fresh) mine.set(id, (mine.get(id) ?? new Set<AutonomyAction>()).add(action));
  noted.set(owner, mine);
}

const refusedLog = new Map<string, PreClaimRefusal>();

export async function forkReplyIdle(): Promise<void> {
  while (pending.size) await Promise.all([...pending.values()]);
}

export function scheduleForkReply(deps: RunnerDeps, owner: string, messageIds: string[], log: (line: string) => void): void {
  if (deps.policy.wake?.codexFork === undefined) return;
  // A message no longer due for this owner is forgotten for this owner only.
  const mine = noted.get(owner);
  if (mine) {
    for (const id of mine.keys()) if (!messageIds.includes(id)) mine.delete(id);
    if (mine.size === 0) noted.delete(owner);
  }
  if (messageIds.length === 0) return;
  const key = path.join(deps.paths.dir, owner);
  if (pending.has(key)) return;
  // The policy as written now, never deps.policy: admission compares against it.
  const policy = readPolicy(deps.paths.policy, true);
  const fork = policy?.wake?.codexFork;
  if (!policy || !fork || !fork.sessions.includes(owner)) return;
  // Design section 12: on another platform the only effect is this audit line.
  if (!fork.platforms.includes(deps.platform ?? process.platform)) return noteOnce(deps, owner, messageIds, "fork-disabled-platform");
  const fingerprint = busyPolicyFingerprint(policy);
  const work = forkLane.then(() => new Promise<void>((resolve) => { setImmediate(resolve); }))
    .then(() => waitForServiceAdmission(deps.paths, (admission) => attempt(deps, owner, messageIds, fingerprint, fork.maxAnswerBytes,
      admission, log), { probe: deps.serviceOwner }))
    .catch(() => { log("kherep-node: Codex fork reply outcome unavailable; the message waits for its owner"); })
    .finally(() => { pending.delete(key); });
  pending.set(key, work);
  forkLane = work;
}

// One `codex features list` result per binary identity (resolved path and
// sha256 of guard 10) for MCP_CACHE_MS: an upgraded or replaced binary is
// listed again at once, and nothing is pinned to a version or hash.
let featureCache: { identity: string; at: number; result: Promise<Set<string> | null> } | null = null;
export const resetForkFeatureCache = (): void => { featureCache = null; };

function forkFeatures(file: string, identity: string, codex: CodexDeps, now: number): Promise<Set<string> | null> {
  if (featureCache && featureCache.identity === identity && now - featureCache.at < MCP_CACHE_MS) return featureCache.result;
  const list = codex.featuresList ?? runMcpList(file, codex);
  const result = list(["features", "list"]).then((run) => (run.code === 0 ? parseFeaturesList(run.stdout) : null), () => null);
  featureCache = { identity, at: now, result };
  return result;
}

export type ForkGuards = { ok: true; producer: QueueProducerIdentity; mcpNames: string[]; features: Set<string> }
  | { ok: false; reason: PreClaimRefusal };

// Guards 10 to 13, before admission, so a refusal spends no turn.
export async function forkGuards(deps: RunnerDeps, codex: CodexDeps, log: (line: string) => void): Promise<ForkGuards> {
  const file = (codex.findCodex ?? findCodex)();
  if (!file) return { ok: false, reason: "fork-producer" };
  const producer = queueProducerIdentity(file, APP_SERVER_ARGS, deps);
  if (producer.route !== "local" || producer.approvedFiles.length !== 1 || !isDirectNativeQueueIdentity(producer)) {
    return { ok: false, reason: "fork-producer" };
  }
  const mcp = await intercomMcpOverrides(codex, deps.now?.() ?? Date.now());
  if ("reason" in mcp) return { ok: false, reason: "fork-mcp-unknown" };
  if (mcp.unnamed > 0) log(`kherep-node: ${mcp.unnamed} MCP server(s) without a bare name stay as configured in a Codex fork`);
  const binary = producer.approvedFiles[0]!;
  const features = await forkFeatures(file, `${binary.realpath}\0${binary.sha256}`, codex, deps.now?.() ?? Date.now());
  if (!features) return { ok: false, reason: "fork-features-unknown" };
  // 13 (PR 4): an answer the Worker of the current connection cannot take as a proxy answer is never produced.
  return deps.workerCapabilities?.()?.includes(MESSAGING_PROXY_CAPABILITY) === true ? { ok: true, producer, mcpNames: mcp.names, features }
    : { ok: false, reason: "fork-relay-unsupported" };
}

// The oldest of the listed messages that is still accepted and has no
// attempt yet: the inbox keeps a forked message accepted for its owner. A
// store that cannot be read keeps the message, and admission refuses it.
function hasAttempt(deps: RunnerDeps, owner: string, messageId: string): boolean {
  try { return readForkAttempt(deps.paths, owner, messageId) !== null; } catch { return false; }
}

function oldestAccepted(deps: RunnerDeps, owner: string, messageIds: string[]): string | null {
  const records = messageIds.flatMap((id) => {
    const record = getMessage(deps.paths.inbox, id);
    return record?.messageId === id && record.state === "accepted" && !hasAttempt(deps, owner, id) ? [record] : [];
  });
  records.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.messageId.localeCompare(b.messageId));
  return records[0]?.messageId ?? null;
}

const AUDIT: Record<ForkOutcome["state"], AutonomyAction> = { completed: "fork", declined: "fork-declined", failed: "fork-failed",
  uncertain: "fork-uncertain", superseded: "fork-superseded" };

async function attempt(deps: RunnerDeps, owner: string, messageIds: string[], fingerprint: string, maxAnswerBytes: number,
  admission: ServiceAdmission, log: (line: string) => void): Promise<void> {
  const messageId = oldestAccepted(deps, owner, messageIds);
  if (!messageId) return;
  const codex: CodexDeps = { ...deps.codex, onUnconfirmedShutdown: () => {
    retainServiceAdmission(admission);
    deps.codex?.onUnconfirmedShutdown?.();
  } };
  const guards = await forkGuards(deps, codex, log);
  if (!guards.ok) {
    // A missing or changed capability is visible: one log line per owner and code, a fixed code only,
    // and one audit line per owner, message and code (issue #444).
    if (refusedLog.get(owner) !== guards.reason) log(`kherep-node: Codex fork reply refused before admission: ${guards.reason}`);
    refusedLog.set(owner, guards.reason);
    return noteOnce(deps, owner, [messageId], FORK_AUDIT[guards.reason]);
  }
  refusedLog.delete(owner);
  const now = (): number => deps.now?.() ?? Date.now();
  const admissionDeps = { paths: deps.paths, now: deps.now, platform: deps.platform, readiness: deps.readiness,
    realpath: deps.realpath, postToolHook: deps.codex?.postToolHook };
  const decision = admitForkReply(admissionDeps, owner, messageId, fingerprint);
  if (!decision.ok) return noteOnce(deps, owner, [messageId], FORK_AUDIT[decision.reason]);
  const selected=getMessage(deps.paths.inbox,messageId);
  if(!selected)return;
  const launch=await prepareMessageLaunch(deps,{runtime:"codex",file:guards.producer.codexExecutable,args:APP_SERVER_ARGS,cwd:decision.cwd,detached:(codex.platform??process.platform)!=="win32"});
  const forkMode=readCodexSession(deps.paths,owner)?.permissionMode;
  const routeDecision=decideMessageRoute({...deps,messageRoute:{route:'fork-reply',grant:'fork',permissionMode:forkMode}},[selected],owner,"fork",{runtime:"codex",sessionId:owner,taskId:null},launch.producer,owner,launch);
  if(routeDecision.status!=="granted")return noteOnce(deps,owner,[messageId],routeDecision.status==="denied-no-debit"?routeDecision.reason==="exhausted"?"fork-budget-exhausted":"fork-budget-spacing":routeDecision.status==="owned"?"fork-in-flight":"awaiting-user-turn");
  let context=routeDecision.context;if(context.kind!=="message")return;
  const claim = claimForkAttempt(deps.paths, { owner, messageId, attemptedAt: now(), policyFingerprint: fingerprint,
    producer: { ...guards.producer }, targetAttempt:context.handle });
  if (!claim) return;
  context=bindMessageAdmission(deps,context,{route:"fork-reply",grant:"fork",attemptId:claim.attemptId,permissionMode:forkMode},[selected]);
  let vetoed = false;
  const continueAllowed = (): boolean => {
    if (vetoed) return false;
    try {
      const fresh = recheckForkReply(admissionDeps, owner, messageId, fingerprint);
      vetoed = !fresh.ok || fresh.cwd !== decision.cwd
        || deps.workerCapabilities?.()?.includes(MESSAGING_PROXY_CAPABILITY) !== true;
    } catch { vetoed = true; }
    return !vetoed;
  };
  // A record gone or read since admission: the owner was first.
  const record = getMessage(deps.paths.inbox, messageId);
  let outcome: ForkOutcome = record?.state !== "accepted" ? { state: "superseded", from: "launching" }
    : await runForkAttempt({ codex }, { context,paths:deps.paths,owner, cwd: decision.cwd, producer: guards.producer, features: guards.features,
      mcpNames: guards.mcpNames, record, maxAnswerBytes, admission, log, timeouts: forkTestTimeouts.value, realpath: deps.realpath,
      continueAllowed, stillAccepted: () => getMessage(deps.paths.inbox, messageId)?.state === "accepted",
      running: (lastTurnId, forkId, goalProof) => {
        finishRouteEffect(deps.paths,context,{kind:"fork",forkId,turnId:null});
        advanceForkAttempt(deps.paths, owner, messageId, "launching", "running", { lastTurnId, forkId, goalProof }, now());
      } }).catch((): ForkOutcome => ({ state: "uncertain", from: "launching", reason: "helper-exit" }));
  if ((outcome.state === "completed" || outcome.state === "declined") && !continueAllowed()) {
    outcome = { state: "superseded", from: outcome.from };
  }
  // Each outcome carries exactly its write-once fields: answer, or reason and detail.
  const { state, from, ...fields } = outcome;
  if(state==="uncertain")finishRouteEffect(deps.paths,context,{kind:"uncertain"});
  try {
    advanceForkAttempt(deps.paths, owner, messageId, from, state, fields, now());
  } finally {
    audit(deps.paths, now(), owner, [messageId], AUDIT[state]);
  }
  // The next poll's sweep relays it (design r3 section 2.2).
  if (state === "completed") markRelayDue(owner);
}
