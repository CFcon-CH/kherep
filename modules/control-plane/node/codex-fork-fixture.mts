import { publishSynthetic, fixtureEvidence } from "./session-authority-fixture.mts";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import type test from "node:test";

import type { AppServerSpawn, KillReport } from "./codex-app-server-client.mts";
import { codexNode } from "./codex-fixture.mts";
import type { CodexDeps } from "./codex-process.mts";
import { markStopEnded, recordCodexSession } from "./codex-sessions.mts";
import { writeDirectory } from "./exchange.mts";
import { storeMessage } from "./inbox.mts";
import type { McpListResult } from "./codex-mcp.mts";
import { T0 } from "./task-fixture.mts";

// Issue #408, PR 3: a fake `codex app-server` for the fork reply tests. It
// never runs a model or a real Codex: a scenario object picks every answer.
// Each spawn is one run with its requests, environment and the signals the
// client sent to its process group.

export const FORK_OWNER = "01a0db74-0000-7000-8000-0000000000f1";
export const FORK_ID = "01a0db74-0000-7000-8000-0000000000f2";
export const LAST_TURN = "01a0db74-0000-7000-8000-00000000a001";
export const FORK_TURN = "01a0db74-0000-7000-8000-00000000a002";
export const ANSWER = JSON.stringify({ kind: "answer", text: "The build is green on main.", code: "none" });
// Unique in the process: the wake audit deduplicates by message id.
let serial = 0;
export const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "public-synthetic-peer" };

type Message = { id?: number | string; method?: string; params?: Record<string, any>; result?: unknown; error?: unknown };
export type GoalReply = { result: unknown } | { error: { code: number; message: string } };
export const ephemeralGoalError = (fork: string) => ({ error: { code: -32600, message: `ephemeral thread does not support goals: ${fork}` } });
export interface ForkScenario {
  cwd: string; owner?: string; forkId?: string;
  ownerThread?: Record<string, unknown>; turnRows?: unknown[];
  // thread/goal/get: the owner answers {goal: null}; the fork answers what a
  // 092d3acd-class server answers for an ephemeral thread (SOURCE-READ
  // thread_goal_processor.rs:332-336), unless replaced. "hang" never answers.
  ownerGoalReply?: GoalReply; forkGoalReply?: GoalReply | "hang";
  // Notifications sent between the fork's goal/get request and its reply.
  beforeForkGoal?: (fork: string) => Message[];
  // Sent in the same stdout write as turn/completed, right after it; the turn's
  // notifications then come a few milliseconds later, while the client waits.
  afterCompleted?: (fork: string, turn: string) => Message[];
  // Sent when stdin ends, before the process ends: during close.
  onClose?: (fork: string) => Message[];
  // A {error} entry answers that method with the error instead; malformed fields and data are sent as given.
  errors?: Record<string, { code?: unknown; message?: unknown; data?: unknown }>;
  forkThread?: Record<string, unknown>; forkTop?: Record<string, unknown>;
  answer?: string; turnStatus?: string; summaryText?: string;
  // Notifications during the turn, after turn/started, sent also with hang.
  during?: (fork: string, turn: string) => Message[];
  // turn/started and turn/completed before the turn/start response.
  early?: boolean; hang?: boolean;
  // A server request at this method, with the id of that pending request.
  serverRequestAt?: string;
  // hangAt: that request is never answered, so the client's request timeout ends it.
  exitAt?: string; malformedAt?: string; hangAt?: string;
  // Called with each request before it is answered.
  onRequest?: (method: string, params: Record<string, any>) => void;
  // stdin end does not end the process; only SIGKILL does, unless neverExit.
  ignoreEnd?: boolean; neverExit?: boolean; exitOnTerm?: boolean;
  // The report of every group signal; "throw" makes the seam throw; sent by default.
  killReport?: KillReport | "throw";
}
export interface ForkRun {
  file: string; args: string[]; cwd?: string; env: NodeJS.ProcessEnv; detached?: boolean; requests: Message[]; signals: string[];
  ended: boolean; startedAt: number; endedAt?: number;
}

export function fakeAppServer(scenario: ForkScenario) {
  const runs: ForkRun[] = [];
  const children: (EventEmitter & { pid: number; end: (signal?: string) => void })[] = [];
  const spawn: AppServerSpawn = ((file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean }) => {
    const stdout = new PassThrough(), stderr = new PassThrough(), stdin = new PassThrough();
    const run: ForkRun = { file, args, cwd: options.cwd, env: options.env ?? {}, detached: options.detached, requests: [], signals: [],
      ended: false, startedAt: Date.now() };
    runs.push(run);
    const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, pid: 40_000 + runs.length, killed: false,
      exitCode: null as number | null, signalCode: null as string | null,
      kill() { return true; },
      end(signal?: string) {
        if (run.ended) return;
        run.ended = true;
        run.endedAt = Date.now();
        child.exitCode = signal ? null : 0;
        child.signalCode = signal ?? null;
        // On the next tick, not a loop turn later: the clean close of codex-app-server-client.mts races its
        // graceMs timer against this end, and a stalled loop turn under load lost that race (issue #565).
        process.nextTick(() => { child.emit("exit", child.exitCode, child.signalCode); child.emit("close", child.exitCode, child.signalCode); });
      } });
    children.push(child);
    const owner = scenario.owner ?? FORK_OWNER, fork = scenario.forkId ?? FORK_ID;
    const send = (message: Message): void => { if (!run.ended) stdout.write(`${JSON.stringify(message)}\n`); };
    const turnNotes = (): Message[] => {
      const text = scenario.answer ?? ANSWER;
      return [
        { method: "item/started", params: { threadId: fork, turnId: FORK_TURN, item: { type: "userMessage", id: "u1" } } },
        { method: "item/completed", params: { threadId: fork, turnId: FORK_TURN, item: { type: "userMessage", id: "u1" } } },
        { method: "item/completed", params: { threadId: fork, turnId: FORK_TURN, item: { type: "agentMessage", id: "a1", text } } },
      ];
    };
    const completed = (status: string): Message => ({ method: "turn/completed", params: { threadId: fork, turn: { id: FORK_TURN, status,
      items: [{ type: "userMessage", id: "u1" }, { type: "agentMessage", id: "a1", text: scenario.summaryText ?? scenario.answer ?? ANSWER }] } } });
    const started: Message = { method: "turn/started", params: { threadId: fork, turn: { id: FORK_TURN, status: "inProgress" } } };
    const result = (request: Message): unknown => {
      const params = request.params ?? {};
      switch (request.method) {
        case "initialize": return {};
        case "thread/read": return { thread: { id: params.threadId ?? owner, ephemeral: false, cwd: scenario.cwd, historyMode: "paginated",
          status: { type: "notLoaded" }, turns: [], ...scenario.ownerThread } };
        case "thread/turns/list": return { data: scenario.turnRows ?? [{ id: LAST_TURN, status: "completed", items: [], itemsView: "notLoaded" }],
          nextCursor: "{\"synthetic\":1}" };
        case "thread/fork": return { thread: { id: fork, forkedFromId: params.threadId ?? owner, ephemeral: true, status: { type: "idle" }, ...scenario.forkThread },
          cwd: scenario.cwd, approvalPolicy: "on-request", approvalsReviewer: "auto_review",
          sandbox: { type: "readOnly", networkAccess: false }, ...scenario.forkTop };
        case "turn/start": return { turn: { id: FORK_TURN, status: "inProgress", items: [] } };
        default: return {};
      }
    };
    let buffer = "";
    stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const request = JSON.parse(buffer.slice(0, end)) as Message;
        buffer = buffer.slice(end + 1);
        run.requests.push(request);
        if (request.id === undefined || !request.method) continue;
        const method = request.method;
        scenario.onRequest?.(method, request.params ?? {});
        if (scenario.exitAt === method) { child.end(); continue; }
        if (scenario.malformedAt === method) { stdout.write("{not json\n"); continue; }
        if (scenario.hangAt === method) continue;
        if (scenario.serverRequestAt === method) {
          send({ id: request.id, method: "item/commandExecution/requestApproval", params: { threadId: fork, command: "synthetic" } });
        }
        const turn = (): void => {
          send(started);
          for (const note of scenario.during?.(fork, FORK_TURN) ?? []) send(note);
          if (scenario.hang) return;
          const rest = (): void => {
            for (const note of turnNotes()) send(note);
            const tail = [completed(scenario.turnStatus ?? "completed"), ...(scenario.afterCompleted?.(fork, FORK_TURN) ?? [])];
            if (!run.ended) stdout.write(tail.map((message) => `${JSON.stringify(message)}\n`).join(""));
          };
          if (scenario.afterCompleted) setTimeout(rest, 10);
          else rest();
        };
        if (method === "turn/start" && scenario.early) turn();
        if (method === "thread/goal/get") {
          const isFork = request.params?.threadId === fork;
          if (isFork) for (const note of scenario.beforeForkGoal?.(fork) ?? []) send(note);
          const reply = isFork ? scenario.forkGoalReply ?? ephemeralGoalError(fork) : scenario.ownerGoalReply ?? { result: { goal: null } };
          if (reply !== "hang") send({ id: request.id, ...reply });
          continue;
        }
        const error = scenario.errors?.[method];
        send(error ? { id: request.id, error } : { id: request.id, result: result(request) });
        if (method === "turn/start" && !scenario.early) turn();
        if (method === "turn/interrupt" && scenario.hang) send(completed("interrupted"));
      }
    });
    stdin.on("finish", () => {
      for (const note of scenario.onClose?.(fork) ?? []) send(note);
      if (!scenario.ignoreEnd) child.end();
    });
    return child as never;
  }) as AppServerSpawn;
  // A signal that was not sent must not end the fake: only "sent" ends it.
  const killGroup = (pid: number, value: NodeJS.Signals): KillReport => {
    const index = children.findIndex((child) => child.pid === pid);
    runs[index]?.signals.push(value);
    if (scenario.killReport === "throw") throw new Error("synthetic group kill failure");
    const report = scenario.killReport ?? "sent";
    if (report === "sent" && !scenario.neverExit && (value === "SIGKILL" || scenario.exitOnTerm)) children[index]?.end(value);
    return report;
  };
  return { spawn, killGroup, runs };
}

// Synthetic `codex features list` output in the measured shape (name, stage, enabled).
export const FEATURES_STDOUT = ["hooks                       stable             true", "goals                       stable             true",
  "shell_tool                  stable             true", "apps                        stable             true",
  "plugins                     stable             true", "multi_agent                 stable             true",
  "multi_agent_v2              stable             false", "code_mode                   under development  false",
  "request_permissions_tool    under development  false", "browser_use                 stable             true",
  "computer_use                stable             true", "image_generation            stable             true",
  "tool_suggest                stable             true", "skill_search                stable             true",
  "view_image                  stable             true", "js_repl                     removed            false",
  "tool_search                 removed            false", ""].join("\n");

// The rows the measured binaries add to that shape (2026-10-16, raw stdout of
// 0.160.1, 0.162.0-alpha.17.2 and 0.163.0): the stage deprecated, a dotted
// removed key, and one trailing empty line. Their WARNING goes to stderr.
export const FEATURES_STDOUT_MEASURED_ROWS = FEATURES_STDOUT.replace(/\n$/, "\n" + ["transcript_v2               deprecated         false",
  "use_legacy_landlock         deprecated         false", "web_search_cached           deprecated         false",
  "web_search_request          deprecated         false", "guardianv2.thread_context   removed            false", ""].join("\n"));
export const FEATURES_STDERR_WARNING = "WARNING: synthetic warning a real binary prints on stderr\n";

// A node with an opted-in, idle Codex owner and one accepted message for it.
// capability: false leaves the Worker's messaging.proxy.v1 out of directory.json (PR 4).
export function forkNode(t: test.TestContext, scenario: Partial<ForkScenario> = {},
  options: { fork?: boolean; platform?: string; capability?: boolean } = {}) {
  const node = codexNode(t);
  writeDirectory(node.paths, { nodes: [], sessions: [], fetchedAt: new Date(T0).toISOString(),
    ...(options.capability === false ? {} : { worker: { capabilities: ["messaging.proxy.v1"] } }) });
  const cwd = fs.realpathSync.native(node.workspace);
  const home = path.join(node.root, "synthetic-codex-home");
  fs.mkdirSync(home);
  // A file with a native executable's magic: identified, hashed, never run.
  const binary = path.join(node.root, "synthetic-codex");
  fs.writeFileSync(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8"));
  policy.wake = { enabled: true, sessions: [FORK_OWNER], ...(options.fork === false ? {} : { codexFork: { enabled: true, sessions: [FORK_OWNER] } }) };
  policy.sessions.runtimes = ["codex"];
  fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
  const idle = (owner: string): void => {
    recordCodexSession(node.paths, owner, cwd, T0 - 10 * 60_000, "default", "Stop");
    markStopEnded(node.paths, owner);
  };
  idle(FORK_OWNER);
  publishSynthetic(node.paths,[{...fixtureEvidence({runtime:"codex",sessionId:FORK_OWNER},"idle-loaded",T0),
    lifecycle:{status:"value",value:{state:"restored",generation:7},source:"native-lifecycle",observedAt:T0,complete:true,reasonCode:"observed"}}],T0,
    [{runtime:"codex",sessionId:FORK_OWNER,state:"idle-loaded"}],node.livenessAuthority);
  const app = fakeAppServer({ cwd, ...scenario });
  const calls: string[][] = [];
  let featuresStdout = FEATURES_STDOUT, featuresCode = 0, featuresStderr = "";
  const codex: CodexDeps = {
    findCodex: () => binary, home, spawn: app.spawn as never, killGroup: app.killGroup, postToolHook: () => true,
    featuresList: async (args): Promise<McpListResult> => {
      calls.push(args);
      return { code: featuresCode, stdout: featuresStdout, stderr: featuresStderr };
    },
    mcpList: async (args): Promise<McpListResult> => { calls.push(args); return { code: 0, stdout: "[]", stderr: "" }; },
  };
  const add = (toSession = FORK_OWNER, text = "Is the build green?"): string => {
    const id = `4080${(++serial).toString(16).padStart(4, "0")}-0000-4000-8000-000000000001`;
    storeMessage(node.paths.inbox, { messageId: id, from: PEER, toSession, text, createdAt: new Date(T0 - serial).toISOString(),senderOrigin:{nodeId:PEER.nodeId,sentAt:new Date(T0-serial).toISOString()} }, T0 - 1000 + serial);
    return id;
  };
  // The capability as the current connection proved it (client.mts), not directory.json.
  const deps = (extra: CodexDeps = {}) => ({ ...node.deps({ ...codex, ...extra }), platform: (options.platform ?? "darwin") as NodeJS.Platform,
    workerCapabilities: () => (options.capability === false ? [] : ["messaging.proxy.v1"]) });
  return { ...node, cwd, home, binary, app, calls, codex, add, deps, idle,
    features: (stdout: string, code = 0, stderr = "") => { featuresStdout = stdout; featuresCode = code; featuresStderr = stderr; } };
}
