import { beginSessionDiscovery } from "./exchange-sessions.mts";
import { createConnectionSupervisor } from "./connection-supervisor.mts";
import { createConnectionWatchdog } from "./connection-watchdog.mts";
import { nodeClock, type NodeClock } from "./node-clock.mts";
import { createIntakeDiagnostics, type FrameArrival } from "./intake-diagnostics.mts";
import { createBindingStorage } from "./inbox-storage.mts";
import { MessageReferenceResolver } from "./message-reference.mts";
import { createAdmissionAuthority, revokeAuthority, stopAuthority } from "./session-authority.mts";
import { readLivenessSnapshot } from "./session-lifecycle.mts";
import { targetKey } from "./session-liveness.mts";
import { attachLiveness, createLivenessPass, type LivenessSource } from "./liveness-pass.mts";
import { parseEnvelope, PING_FRAME, PONG_FRAME, type SessionInfo } from "../protocol.mts";
import { isTaskRuntime, type TaskRuntime } from "../protocol-tasks.mts";
import { reconnectDelay } from "./backoff.mts";
import { NodeClient, type CommandHandlers } from "./client.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { codexHome } from "./codex-app.mts";
import { forgetCodexSession } from "./codex-sessions.mts";
import { recoverForkAttemptsAtStart } from "./codex-fork-attempts.mts";
import type { CodexIntakeWindow } from "./codex-intake-window.mts";
import { connectUrl, ensureDir, type NodeConfig, type NodePaths } from "./config.mts";
import {
  carriedOver, previousDaemonState, recordDaemonState, withVerdict, type DaemonServiceBinding, type DaemonState,
} from "./daemon-state.mts";
import { exchangeRound } from "./daemon-round.mts";
import { captureRuntimeSourceIdentity } from "./daemon-source.mts";
import { detectFacts, discoverRuntimes } from "./discovery.mts";
import { enqueued, frameKind, intakeLane, laneTimer, lockRounds, type IntakeConnection, type LaneOptions } from "./frame-lanes.mts";
import { DIRECTORY_INTERVAL_MS, EXCHANGE_INTERVAL_MS, exchangeOptions, recordingSessions } from "./exchange.mts";
import { readPrivateKey } from "./identity.mts";
import { installPaused, markedProbe, noticeInterruptedProbe } from "./install-pause.mts";
import { storeDaemonMessage } from "./daemon-message-store.mts";
import { inboxIndex } from "./inbox-index.mts";
import { DAEMON_RECORD_LOCK_WAIT_MS, runRecordLockRound, setRecordLockWait } from "./inbox-record-lock.mts";
import { MAINTENANCE_FALLBACK_MS, runInboxMaintenance, type MaintenanceOptions } from "./inbox-start.mts";
import { scheduleListenerSweep } from "./listener-sweep.mts";
import { loadPolicy, type NodePolicy } from "./policy.mts";
import { routeFrame } from "./readiness-lane.mts";
import { classifySocketError, roundTally, tallyKind, type SocketErrorClass } from "./round-tally.mts";
import { probeRuntime, type ProbeResult } from "./runtime-probe.mts";
import { createReadiness } from "./runtime-readiness.mts";
import { retainServiceAdmission, waitForServiceAdmission } from "./service-drain.mts";
import { reportSlowSync } from "./sync-timing.mts";
import { continueTask, startTask, stopTask, type RunnerDeps } from "./session-runner.mts";
import { listSessions } from "./sessions.mts";
import { recordAndPublishSessions } from "./periodic-session-publication.mts";
import { recordRequestResult } from "./task-exchange.mts";
import { watchTasks } from "./task-watch.mts";
import { handleTaskControlExecute } from "./task-control-exchange.mts";
import { executeTaskControl } from "./task-control-local.mts";
import {
  applyQueryResult, receiptResult, recordRegistrationReceipt, recoverOperations,
} from "./task-control-store.mts";
import {
  answerMcpInbox, disableMcp, hasMcpCredential, offerMcpInbox, readMcpInbox, recordMcpCredential, recordMcpIntentReceipt,
} from "./mcp-local.mts";

// Application heartbeat uses the existing static Worker auto-response.
export { PING_INTERVAL_MS } from "./connection-watchdog.mts";
// The session list is checked this often; a snapshot goes out only on change.
export const SESSIONS_INTERVAL_MS = 60_000;

export interface DaemonHandle { stop(): void; done: Promise<void> }

const enabledRuntimes = (policy: NodePolicy): TaskRuntime[] =>
  (policy.sessions?.enabled ? policy.sessions.runtimes : []).filter(isTaskRuntime);

// runner: read per command (issue #463); the client runs them only when the policy enables sessions.
export function commandHandlers(config: NodeConfig, startedAt: number,
  sessions: () => Promise<SessionInfo[]> = () => listSessions(), runner?: () => RunnerDeps,
  runtimes: () => ReturnType<typeof discoverRuntimes> = () => discoverRuntimes()): CommandHandlers {
  return {
    "node.status": async () => ({
      nodeId: config.nodeId, name: config.name, facts: detectFacts(), uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }),
    "runtime.list": runtimes,
    // A failed listing rejects, and the command result reports ok:false.
    "session.list": sessions,
    ...(runner ? {
      "session.start": (args) => startTask(args, runner()),
      "session.stop": (args) => stopTask(args, runner()),
      "session.continue": (args) => continueTask(args, runner()),
    } satisfies Partial<CommandHandlers> : {}),
  };
}

// probe: the runtime readiness probe (issue #197); tests replace it.
// lanes: the slow-item and slow-intake log thresholds (issue #441); tests lower them.
// maintenance: the start maintenance's fallback and slicing (issue #581); tests replace them.
export function startDaemon(config: NodeConfig, paths: NodePaths, log: (line: string) => void = (line) => console.error(line),
  sessionSource?: (signal?: AbortSignal) => Promise<SessionInfo[]>,
  probe: (runtime: TaskRuntime, onUnconfirmedShutdown?: () => void) => Promise<ProbeResult> = (runtime, onUnconfirmedShutdown) =>
    probeRuntime(runtime, { forgetSession: (threadId) => forgetCodexSession(paths, threadId), onUnconfirmedShutdown }),
  service?: DaemonServiceBinding, lanes: LaneOptions = {}, maintenance: MaintenanceOptions = {}, livenessSource?: LivenessSource, clock: NodeClock = nodeClock): DaemonHandle {
  const identity = readPrivateKey(config.privateKeyFile);
  if (identity.publicKey !== config.publicKey) throw new Error("private key does not match the enrolled public key");
  const policy = loadPolicy(config.policyFile);
  // Issue #627: a record another process holds is left to the next round
  // after this wait, shared by every lock of one lane item (lockRounds); the
  // wait is synchronous and would block the frame lanes.
  setRecordLockWait(DAEMON_RECORD_LOCK_WAIT_MS);
  // Issue #72. For nodes enrolled before onboard created it: a sandboxed
  // `msg send` can write into the outbox but not create it.
  ensureDir(paths.outbox);
  // Issue #420: before anything overwrites them, the previous daemon's fresh
  // ready verdicts and a Claude probe its stop interrupted (daemon-state.mts).
  let state: DaemonState = { pid: process.pid, startedAt: new Date().toISOString(), source: captureRuntimeSourceIdentity(),
    ...(service ? { service } : {}), ...carriedOver(previousDaemonState(paths), noticeInterruptedProbe(paths, log), Date.now()) };
  recordDaemonState(paths, state, log);
  // Issue #225: locks of wake listeners whose process is gone, now and hourly.
  const stopSweep = scheduleListenerSweep(paths, log);
  // Successful listings update sessions.json and include hook-recorded Codex sessions.
  let backgroundDiscovery: { controller: AbortController; socket: WebSocket } | null = null;
  const rawSource = sessionSource ?? ((signal?: AbortSignal) => listSessions({ paths, codexHome: codexHome(), signal }));
  const livenessAuthority = createAdmissionAuthority(paths);
  const liveness = createLivenessPass(livenessSource, Date.now, livenessAuthority);
  const source = (signal?: AbortSignal) => waitForServiceAdmission(paths, async () => {
    revokeAuthority(livenessAuthority);
    const rows = await rawSource(signal);
    const targets = new Map([...rows, ...(readLivenessSnapshot(paths)?.sessions ?? [])].map(s => [targetKey(s), s]));
    const observation = await liveness.observe([...targets.values()], signal);
    signal?.throwIfAborted();
    return attachLiveness(rows, observation);
  }, { signal });
  // Filesystem/loopback runtime discovery starts no user runtime process and
  // must remain available while a replacement service authenticates.
  const runtimeDiscovery = () => discoverRuntimes();
  // Issue #403: a Claude probe is marked in flight for the installer (install-pause.mts).
  // Issue #420: a stopping daemon gives up a probe that still waits for a service drain.
  const halt = new AbortController();
  const admittedProbe = (runtime: TaskRuntime) => waitForServiceAdmission(paths, (admission) => {
    const run = () => probe(runtime, () => retainServiceAdmission(admission));
    return runtime === "claude" ? markedProbe(paths, run) : run();
  }, { signal: halt.signal });
  // Issue #581: the start maintenance (inbox-start.mts) runs once, after the first authenticated connection or the fallback.
  let maintaining: Promise<void> | null = null; // the run-once guard
  const fallback = setTimeout(() => maintain(), maintenance.fallbackMs ?? MAINTENANCE_FALLBACK_MS).unref();
  const maintain = (): void => {
    clearTimeout(fallback); // issue #589: no pending fallback once it ran
    // Issue #627: a round of its own, not the rest of the lane item that connected.
    maintaining ??= runRecordLockRound(DAEMON_RECORD_LOCK_WAIT_MS, () => runInboxMaintenance(paths, log, { ...maintenance, signal: halt.signal }))
      .catch((error: unknown) => log(`kherep-node: start maintenance failed: ${String(error)}`));
  };
  // Issue #487: one in-process inbox index for the daemon's readers (inbox-index.mts); issue #589: the
  // session listing's refusal check reads it too, so a snapshot costs one stat per record, not a read.
  const selectedReferences = new MessageReferenceResolver(paths);
  const indexedInbox = inboxIndex(paths.inbox);
  const bindingStorage = createBindingStorage(paths.inbox, () => { indexedInbox.records(); });
  const storageFault = (): void => { bindingStorage.fault(); indexedInbox.invalidate(); selectedReferences.clear(); };
  const inbox = { ...indexedInbox, records: () => {
    try { return indexedInbox.records(); } catch (error) { storageFault(); throw error; }
  }, unreported: (...args: Parameters<typeof indexedInbox.unreported>) => {
    try { return indexedInbox.unreported(...args); } catch (error) { storageFault(); throw error; }
  } };
  const sessions = recordingSessions(paths, (signal) => {
    backgroundDiscovery?.controller.abort();
    return source(signal);
  }, log, undefined, undefined, () => inbox.records(), livenessAuthority);
  // Issue #197: one readiness probe per enabled runtime at the start, then only
  // when a run needs a runtime whose verdict aged out (runtime-readiness.mts).
  // Issue #420: none at the start for a runtime with a carried-over verdict.
  // Each completed probe goes to daemon.json for doctor (issue #222), off the frame lane.
  // Issue #403: no Claude probe while install.sh runs the claude CLI (install-pause.mts).
  const readiness = createReadiness(admittedProbe, { log, seed: state.readiness, onVerdict: (runtime, verdict) => {
    state = withVerdict(state, runtime, verdict);
    recordDaemonState(paths, state, log);
  }, defer: (runtime) => runtime === "claude" && installPaused(paths) });
  // Issue #420: a stop waits for the probe in flight instead of leaving it to a
  // kill that may cut a login renewal short; no new probe starts meanwhile.
  const drainProbes = (): Promise<void> => {
    stopAuthority(livenessAuthority);
    const drained = readiness.stop();
    halt.abort(); // also stops the start maintenance (issue #581)
    clearTimeout(fallback);
    return Promise.all([drained, liveness.stop()]).then(() => {});
  };
  // Issue #427: unless a seeded ready verdict (issue #420), a drain or an install pause defers it,
  // the first check runs the Windows identity lookup before connect().
  for (const runtime of enabledRuntimes(policy)) void readiness.check(runtime);
  // Issue #408, PR 4: the capability proven on the current connection, read lazily from the client below.
  const runner: RunnerDeps = { paths, policy, livenessAuthority, log, readiness, workerCapabilities: () => client.workerCapabilities, inbox: () => inbox.records() };
  const live = (): RunnerDeps => ({ ...runner, policy: loadPolicy(config.policyFile) });
  recoverOperations(paths);
  recoverForkAttemptsAtStart(paths, Date.now(), log);
  let taskControlInflight = new Set<string>();
  let mcpInflight = new Set<string>();
  if (policy.remoteMcp?.enabled !== true) {
    try { disableMcp(paths, mcpInflight); } catch (error) { log(`kherep-node: remote MCP cleanup failed: ${String(error)}`); }
  }
  const client = new NodeClient({
    nodeId: config.nodeId, identity, policy, handlers: commandHandlers(config, Date.now(), sessions, live, runtimeDiscovery),
    facts: detectFacts, runtimes: runtimeDiscovery, readyRuntimes: () => readiness.ready(),
    sessions, deferInitialSessions: true,
    // Issue #520: a reply records the sent message it answers replied; settleReplied never throws.
    storeMessage: (body) => storeDaemonMessage(paths, body, Date.now(), storageFault, log),
    taskRequestResult: (result) => recordRequestResult(paths, result),
    taskControlRegistrationReceipt: (body) => {
      taskControlInflight.delete("register:" + body.registrationId);
      recordRegistrationReceipt(paths, body);
    },
    taskControlResultReceipt: (body) => {
      taskControlInflight.delete("result:" + body.operationId);
      receiptResult(paths, body.operationId);
    },
    taskControlQueryResult: (body) => {
      taskControlInflight.delete("submit:" + body.requestId);
      applyQueryResult(paths, body);
    },
    mcpCredentialPresent: () => hasMcpCredential(paths),
    mcpCredential: (body) => recordMcpCredential(paths, body),
    mcpIntentReceipt: (body) => recordMcpIntentReceipt(paths, mcpInflight, body),
    mcpDisabled: () => disableMcp(paths, mcpInflight),
    readMcpInbox: (sessionId, limit, messageId, runtime, original) => readMcpInbox(paths, sessionId, limit, messageId, runtime, original),
    offerMcpInbox: (messageIds, sessionId, runtime, original) => offerMcpInbox(paths, messageIds, Date.now(), { sessionId, runtime }, original),
    answerMcpInbox: (messageIds, sessionId, runtime, original) => answerMcpInbox(paths, messageIds, { sessionId, runtime }, original),
    taskControlExecute: (body) => handleTaskControlExecute(paths, body,
      (execute) => executeTaskControl(execute, { nodeId: config.nodeId, paths, runner })),
    ...exchangeOptions(paths), selectedReferences, bindingStorageReady: bindingStorage.snapshot, bindingStorageFault: storageFault, log,
  });
  let knownPending = (): boolean => false;
  const diagnostics = createIntakeDiagnostics({ log, clock, pending: () => knownPending(), publish: intake => {
    state = { ...state, intake }; recordDaemonState(paths, state, log);
  } });
  const timed = lockRounds(laneTimer(log, lanes.slowLaneMs), DAEMON_RECORD_LOCK_WAIT_MS);
  const tally = roundTally(); // inbound items since the last round, by kind (issues #487, #493)
  // Issue #441: deliveries on a lane of their own (frame-lanes.mts); spans reconnects like chain.
  const intake = intakeLane({ client, policyFile: config.policyFile, inbox: paths.inbox, log, intakeSlowMs: lanes.intakeSlowMs,
    diagnostics, timed: (lane, kind, run, at) => timed(lane, kind, () => { tally.add("frame:message.deliver"); return run(); }, at) });
  const stopSlowSync = reportSlowSync(log);

  let stopped = false;
  let attempt = 0;
  let socket: WebSocket | null = null;
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => { finish = resolve; }).then(drainProbes).finally(() => { stopSlowSync(); diagnostics.stop(); });
  // One lane spans reconnects so an old socket cannot finish a state mutation
  // concurrently with the replacement connection.
  let chain = Promise.resolve();
  // Inbound commands that wait for a first readiness verdict (issue #197).
  let commands = Promise.resolve();

  const connections = createConnectionSupervisor({ clock, connect: () => connect(), log,
    delay: () => reconnectDelay(attempt++),
    reset: () => {
      const reset = (): void => { client.connectionClosed(); };
      chain = chain.then(reset, (error: unknown) => {
        log(`kherep-node: connection chain failed: ${String(error)}`);
        reset();
      });
    },
    disconnected: () => {
      state = { ...state, disconnectedAt: new Date().toISOString() }; recordDaemonState(paths, state, log);
    },
    finish: () => { stopped = true; stopSweep(); finish(); },
  });
  const connect = (): void => {
    if (stopped) return;
    const ws = new WebSocket(connectUrl(config.controlUrl, config.nodeId));
    let socketError: SocketErrorClass | "none" = "none"; // issue #493 D2b: this socket's last error, classified
    socket = ws;
    let snapshots: NodeJS.Timeout | null = null;
    let exchange: NodeJS.Timeout | null = null;
    let directory: NodeJS.Timeout | null = null;
    let exchangePending = false;
    let authenticated = false;
    let intakeWindow: CodexIntakeWindow | null = null;
    // Outbox records sent on this connection, with their send time; an
    // unanswered one is sent again with backoff (send-schedule.mts), or at
    // once after a reconnect, which starts with a new map.
    const inflight = new Map<string, number>();
    const requestsInflight = new Set<string>();
    knownPending = () => generation.current() && inflight.size + taskControlInflight.size + mcpInflight.size > 0;
    taskControlInflight = new Set<string>();
    mcpInflight = new Set<string>();
    const send = (frame: string): boolean => {
      if (!generation.current() || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(client.stamp(frame)); diagnostics.sent(frame); // issue #441: the only path to the socket; stamps the wire seq
      return true;
    };
    const generation = connections.begin(() => {
      // Revoke connection proof immediately; serialize the full reset after old work.
      authenticated = false; client.authenticated = false; client.workerCapabilities = null; selectedReferences.clear();
      watchdog.stop(); intakeWindow?.close();
      for (const timer of [snapshots, exchange, directory]) if (timer) clearInterval(timer);
      if (backgroundDiscovery?.socket === ws) {
        backgroundDiscovery.controller.abort(); backgroundDiscovery = null;
      }
      if (socket === ws) socket = null;
    });
    const watchdog = createConnectionWatchdog({ clock, sendPing: () => {
      if (generation.current() && ws.readyState === WebSocket.OPEN) { ws.send(PING_FRAME); diagnostics.sent(PING_FRAME); }
    }, expire: event => {
      if (!generation.current()) return;
      log(`${event.code} open_ms=${event.openMs} pong_age_ms=${event.pongAgeMs} delay_ms=${event.delayMs}`);
      generation.retireConnection({ code: 4000, error: socketError });
      try { ws.close(4000, "heartbeat timeout"); } catch { /* retry does not depend on close */ }
    } });
    const publishRegistration = (frames: string[]): boolean => {
      if (frames.length === 0) return true;
      for (const frame of frames) if (!send(frame)) return false;
      client.registrationSent();
      return true;
    };
    // Allocate and publish every frame on the same lane. Periodic discovery
    // waits outside it so an unrelated slow listing cannot postpone native ACKs.
    ws.addEventListener("open", () => {
      if (!generation.current()) return;
      watchdog.open();
      snapshots = setInterval(() => {
        if (!generation.current()) return;
        // Issue #197: a runtime that is not ready is probed again in the
        // background, at most every NOT_READY_TTL_MS, so a re-login is noticed
        // and advertised without a run asking for it.
        for (const runtime of enabledRuntimes(loadPolicy(config.policyFile))) readiness.revalidate(runtime);
        if (backgroundDiscovery) return;
        const controller = new AbortController();
        backgroundDiscovery = { controller, socket: ws };
        const discovery=beginSessionDiscovery(paths);
        void source(controller.signal).catch((error: unknown) => {
          if (!controller.signal.aborted) log(`kherep-node: session listing failed, snapshot skipped: ${String(error)}`);
          return null;
        }).then((listed) => {
          chain = chain.then(enqueued(timed, "chain", "snapshot", async () => {
            if (!generation.current() || ws.readyState !== WebSocket.OPEN) return;
            if (listed && !controller.signal.aborted) await recordAndPublishSessions(client, paths, listed, send, log, controller.signal, () => inbox.records(), livenessAuthority, discovery);
            if (!generation.current()) return;
            await watchTasks(runner, log);
            if (!generation.current()) return;
            await deliverToClosed(live(), log);
          })).catch((error: unknown) => log(`kherep-node: session snapshot failed: ${String(error)}`));
          return chain;
        }).finally(() => {
          if (backgroundDiscovery?.controller === controller) backgroundDiscovery = null;
        });
      }, SESSIONS_INTERVAL_MS);
      exchange = setInterval(() => {
        if (!generation.current()) return;
        if (intakeWindow) { intakeWindow.tick(); return; }
        // Coalesce ticks while one round waits or runs so inbound receipts
        // cannot accumulate behind redundant periodic exchange work.
        if (exchangePending) return;
        exchangePending = true;
        chain = chain.then(enqueued(timed, "chain", "exchange-round", () => {
          if (!generation.current()) return;
          if (!bindingStorage.recheck()) { indexedInbox.invalidate(); selectedReferences.clear(); }
          return exchangeRound({ client, paths, policyFile: config.policyFile,
          runner, inbox, log, inflight, requestsInflight, taskControlInflight: () => taskControlInflight, mcpInflight: () => mcpInflight,
          send, publishRegistration, live: () => generation.current() && ws.readyState === WebSocket.OPEN, defer: dispatchFrame,
          window: (window) => { intakeWindow = window; }, diagnostics, tally }); }))
          .catch((error: unknown) => log(`kherep-node: message exchange failed: ${String(error)}`))
          .finally(() => { exchangePending = false; });
      }, EXCHANGE_INTERVAL_MS);
      directory = setInterval(() => {
        chain = chain.then(enqueued(timed, "chain", "directory", () => { if (generation.current()) client.directoryRequest().forEach(send); }));
      }, DIRECTORY_INTERVAL_MS);
    });
    const connection: IntakeConnection = { live: () => generation.current() && authenticated && ws.readyState === WebSocket.OPEN, send, publishRegistration };
    ws.addEventListener("message", (event) => {
      if (!generation.current() || typeof event.data !== "string") return;
      const arrival = diagnostics.receive(event.data);
      if (event.data === PONG_FRAME) watchdog.pong();
      if (!intakeWindow?.frame(event.data, arrival)) dispatchFrame(event.data, arrival);
    });
    // The listener after the Codex intake window, which also defers to it. Auth barrier: until
    // auth.ok is handled on chain, a delivery stays behind it there, never unauthenticated on intake.
    const dispatchFrame = (data: string, arrival?: FrameArrival): void => {
      if (!generation.current()) return;
      const route = routeFrame(data, paths);
      const parsed = parseEnvelope(data);
      if ((route.kind === "deliver" || parsed.ok && parsed.envelope.type === "message.resolve.request") && authenticated) intake(data, arrival?.wallMs ?? Date.now(), connection, arrival);
      else if (route.kind !== "command") handleFrame(data, arrival);
      else {
        // Issue #197: a session command for a runtime without any readiness
        // verdict waits for its first probe here, outside the frame lane;
        // commands keep their order (readiness-lane.mts).
        const runtime = route.runtime;
        commands = commands.then(async () => {
          if (runtime) await readiness.check(runtime);
          if (generation.current()) handleFrame(data, arrival);
        }).catch((error: unknown) => log(`kherep-node: command handling failed: ${String(error)}`));
      }
    };
    const handleFrame = (data: string, arrival?: FrameArrival): void => {
      chain = chain.then(enqueued(timed, "chain", () => frameKind(data), () => diagnostics.process(arrival, async () => {
        if (!generation.current()) return;
        tally.add(tallyKind(data));
        const refreshed = await client.refreshPolicy(loadPolicy(config.policyFile));
        if (!generation.current()) return;
        publishRegistration(refreshed);
        const wasAuthed = client.authenticated;
        // Issue #408 (design r3 section 3.3): live is decided when the lane reaches the frame.
        const frames = await client.onFrame(data, generation.current() && ws.readyState === WebSocket.OPEN);
        if (!generation.current()) return;
        authenticated = client.authenticated;
        let sent = true;
        for (const frame of frames) if (!send(frame)) { sent = false; break; }
        if (!wasAuthed && client.authenticated && sent) client.registrationSent();
        if (!wasAuthed && client.authenticated) {
          attempt = 0;
          state = { ...state, connectedAt: new Date().toISOString(), disconnectedAt: undefined };
          recordDaemonState(paths, state, log);
          const sinceStart = ((Date.now() - Date.parse(state.startedAt)) / 1000).toFixed(1);
          log(`kherep-node: connected as ${config.nodeId} (${sinceStart} s after start, process up ${process.uptime().toFixed(1)} s)`);
          maintain();
          // Session discovery may be service-drained. Start it after the
          // authenticated health record, then serialize publication back onto
          // the frame lane without fabricating an empty snapshot.
          if (sent && !backgroundDiscovery) {
            const controller = new AbortController();
            backgroundDiscovery = { controller, socket: ws };
            const discovery=beginSessionDiscovery(paths);
            void source(controller.signal).then((listed) => {
              chain = chain.then(enqueued(timed, "chain", "snapshot", async () => {
                if (!generation.current() || ws.readyState !== WebSocket.OPEN || controller.signal.aborted) return;
                await recordAndPublishSessions(client, paths, listed, send, log, controller.signal, () => inbox.records(), livenessAuthority, discovery);
              }));
              return chain;
            }).catch((error: unknown) => {
              if (!controller.signal.aborted) log(`kherep-node: initial session snapshot failed: ${String(error)}`);
            }).finally(() => {
              if (backgroundDiscovery?.controller === controller) backgroundDiscovery = null;
            });
          }
        }
      }))).catch((error: unknown) => log(`kherep-node: frame handling failed: ${String(error)}`));
    };
    ws.addEventListener("close", event => generation.retireConnection({ code: event.code, wasClean: event.wasClean, error: socketError }));
    ws.addEventListener("error", (event) => {
      if (!generation.current()) return;
      socketError = classifySocketError(event); // the close event follows, names it and schedules the reconnect
    });
  };

  connect();
  return {
    stop() {
      stopped = true;
      void drainProbes();
      stopSweep();
      const closing = socket;
      connections.stop();
      if (closing && closing.readyState <= WebSocket.OPEN) {
        try { closing.close(1000, "node stopping"); } catch { /* retirement already finished */ }
      }
    },
    done,
  };
}
