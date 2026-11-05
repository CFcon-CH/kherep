import type { FrameArrival, IntakeDiagnostics } from "./intake-diagnostics.mts";
import type { NodeClient } from "./client.mts";
import { relaySendGate } from "./codex-fork-relay.mts";
import { codexIntakeWindow, type CodexIntakeWindow } from "./codex-intake-window.mts";
import { pollCodexQueue } from "./codex-queue.mts";
import { pollCodexInbound } from "./codex-wake.mts";
import type { NodePaths } from "./config.mts";
import { observeClaudeDeliveryProgress, observeCodexTaskProgress } from "./delivery-progress.mts";
import { pollExchange, type ExchangeCounts, type ProxySend } from "./exchange.mts";
import type { InboxRecord } from "./inbox.mts";
import type { InboxIndex } from "./inbox-index.mts";
import { pollMcpIntents } from "./mcp-local.mts";
import { loadPolicy } from "./policy.mts";
import { tallyKind, type RoundTally, type TallyKind } from "./round-tally.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { pollTaskControl } from "./task-control-exchange.mts";
import { pollTasks } from "./task-exchange.mts";

// One exchange round of the daemon's frame lane (moved here from daemon.mts,
// issue #487). The round's synchronous consumers share one validated read of
// the inbox index; whatever runs after an await reads the index again, which
// re-reads only records whose file changed.

// A round that sent or handled more frames than this logs its counters (D1).
export const ROUND_COUNTERS_MIN = 32;

export interface RoundContext {
  client: NodeClient;
  paths: NodePaths;
  policyFile: string;
  runner: RunnerDeps;
  inbox: InboxIndex;
  log: (line: string) => void;
  inflight: Map<string, number>;
  requestsInflight: Set<string>;
  taskControlInflight: () => Set<string>;
  mcpInflight: () => Set<string>;
  send(frame: string): boolean;
  publishRegistration(frames: string[]): boolean;
  // The round's connection is still the daemon's, open and not stopping.
  live(): boolean;
  defer(data: string, arrival?: FrameArrival): void;
  diagnostics?: IntakeDiagnostics;
  window(window: CodexIntakeWindow | null): void;
  // Inbound items handled since the previous round, by kind (issue #493 D2); take() resets it.
  tally: RoundTally;
}

export async function exchangeRound(ctx: RoundContext): Promise<void> {
  if (!ctx.live()) return;
  const { client, paths, runner, log } = ctx;
  const current = loadPolicy(ctx.policyFile);
  let applied = current;
  // Issue #444: the gate's presence check follows the round's policy, as the queue does; the relay guards read the file.
  const proxySend = (): ProxySend => relaySendGate({ ...runner, policy: applied }, log);
  const counts: ExchangeCounts = { status: 0, outbox: 0 };
  const exchange = (records?: InboxRecord[]): void => pollExchange(client, paths, ctx.inflight, ctx.send, Date.now(), Math.random,
    proxySend(), { unreported: (now) => ctx.inbox.unreported(now, records), counts });
  const refreshed = await client.refreshPolicy(applied);
  if (!ctx.live()) return;
  let published = ctx.publishRegistration(refreshed);
  const records = ctx.inbox.records();
  const round: RunnerDeps = { ...runner, inbox: () => records };
  observeClaudeDeliveryProgress({ ...round, policy: current });
  observeCodexTaskProgress(round);
  exchange(records);
  pollTasks(client, paths, applied, ctx.requestsInflight, ctx.send);
  const enabled = current.sessions?.enabled === true && current.sessions.ownTaskControl === true
    && current.sessions.runtimes.length > 0;
  pollTaskControl(client, paths, ctx.taskControlInflight(), ctx.send, Date.now(), enabled);
  await pollMcpIntents(client, paths, ctx.mcpInflight(), ctx.send, async () => {
    applied = loadPolicy(ctx.policyFile);
    const refreshed = await client.refreshPolicy(applied);
    if (!ctx.live()) return false;
    const sent = ctx.publishRegistration(refreshed);
    published = published && sent;
    return sent;
  });
  if (!ctx.live()) return;
  // Peer messages for ended Codex task sessions resume them (issue #63).
  // Keep runtime mutation serialized while the existing queue lane and
  // admitted Codex peer transport can progress (issue #369).
  // Frames the window handles bypass the daemon's lanes; deferred ones are counted there.
  // Round-local, as base's windowHandled: discarded when the round throws. Bounded by TALLY_KINDS.
  const windowKinds = new Map<TallyKind, number>();
  const window = published ? codexIntakeWindow({ client, paths, policyFile: ctx.policyFile, policy: applied,
    connected: ctx.live, send: (frame) => ctx.live() && ctx.send(frame), exchange: () => exchange(),
    queue: () => pollCodexQueue({ ...runner, policy: applied }, log), defer: ctx.defer, diagnostics: ctx.diagnostics,
    handled: (data) => { const kind = tallyKind(data); windowKinds.set(kind, (windowKinds.get(kind) ?? 0) + 1); }, log }) : null;
  ctx.window(window);
  try { await pollCodexInbound({ ...runner, policy: applied }, log); }
  finally { await window?.drain(); ctx.window(null); }
  if (!ctx.live()) return;
  // ... and wake idle interactive Codex sessions with a pointer (issue #66).
  // Not awaited: queue runs have their own lane and never block this chain.
  // Issue #444: this round's policy, as the intake window passes it; the fork gate and queue authorization re-read the file.
  pollCodexQueue({ ...runner, policy: applied }, log);
  for (const [kind, count] of windowKinds) ctx.tally.add(kind, count);
  const { total, summary } = ctx.tally.take();
  if (counts.status + counts.outbox > ROUND_COUNTERS_MIN || total > ROUND_COUNTERS_MIN) {
    log(`kherep-node: round sent ${counts.status} status/${counts.outbox} outbox frames, handled ${total} inbound items${summary && `: ${summary}`}`);
  }
}
