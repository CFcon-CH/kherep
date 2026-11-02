import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  ACCEPTED_SILENCE_CAUSES, isMessageId, isMessageText, MAX_MESSAGE_TEXT, OPERATOR_NODE_ID, senderState, silentlyAccepted, type MessageAddress,
} from "../protocol-messages.mts";
import type { NodePaths } from "./config.mts";
import { getOutbox, getSent, writeOutbox, type OutboxRecord, type SentRecord } from "./exchange.mts";
import { getMessage, markAnswered } from "./inbox.mts";
import {
  CODEX_THREAD_ENV, KHEREP_SESSION_ENV, processTableOnce, resolveSendTarget, senderSession, senderSessionId, SESSION_ENV, sessionIdFromEnv, type IdentityDeps,
} from "./msg-resolve.mts";
import { exactInbox, EXACT_INBOX_FLAGS } from "./msg-inbox-exact.mts";
import { inbox, offerLine, replyLines } from "./msg-inbox.mts";
import { targetLine } from "./msg-intake.mts";
import { sendNew } from "./msg-new.mts";
import { directoryFor, sessions } from "./msg-sessions.mts";
import { stopTask } from "./msg-stop.mts";
import { taskForSession } from "./task-records.mts";

// attach.mts reads the directory through msg-cli.
export { directoryFor };

// kherep-node msg: the session side of messaging (issue #31, step 3a). It only
// reads and writes files in the node's config directory; the daemon does the
// network part.

export const CLI_PATH = fileURLToPath(new URL("./cli.mts", import.meta.url).href);

// The command line a session runs to reach this CLI.
export function cliCommand(): string {
  return `node "${CLI_PATH}"`;
}

// The command line a task session runs (issue #79), with this CLI by absolute
// path in single quotes, which keep it literal. On macOS and Linux the daemon's
// own node goes by absolute path too. On Windows a session may run it through
// Git Bash (Claude's Bash tool) or PowerShell (Codex), so the line must work in
// both: bare `node` (the task's PATH starts with the daemon's node directory,
// task-env.mts) and the CLI path with forward slashes. No quoting of a single
// quote works in both shells, so such a path is refused.
export function taskCliCommand(platform: NodeJS.Platform = process.platform, node: string = process.execPath, cli: string = CLI_PATH): string {
  if (platform === "win32") {
    if (cli.includes("'")) throw new Error("the kherep-node CLI path contains a single quote, which no command line can quote for both Git Bash and PowerShell");
    return `node '${cli.replaceAll("\\", "/")}'`;
  }
  const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
  return `${quote(node)} ${quote(cli)}`;
}

export const MSG_USAGE = `usage:
  kherep-node msg sessions [--from <session>]
  kherep-node msg send <node>/<session> [--from <session>] [--wait <seconds>] [--] <text...>
  kherep-node msg send <node> --new claude|codex --directive <the operator's answer, verbatim> [--cwd <dir>] [--from <session>] [--wait <seconds>] [--] <text...>
  kherep-node msg send --reply-to <messageId> [--to <node>/<session>] [--from <session>] [--wait <seconds>] [--] <text...>
  kherep-node msg inbox [--from <codex-session-id>] [--all | --receive [<messageId>] | --ack <receipt>]
  kherep-node msg inbox --message-id <incoming-UUID> --from <owner-UUID> --expect-node <sender-node-UUID> --expect-session <exact-sender-ref> --expect-target-session <exact-target-ref> --expect-reply-to <sent-root-UUID> --expect-text-sha256 <safe-text-SHA256>
  kherep-node msg status <messageId>
  kherep-node msg stop <taskId | sent messageId | owned requestId> [--expected-run-version <run version>] [--wait <seconds>]
Without --from the session is named by ${SESSION_ENV} (Claude Code), ${CODEX_THREAD_ENV} (Codex) or ${KHEREP_SESSION_ENV} (the node's Codex runs). --from names the resolved current session, or the full id of a Codex session recorded by a Kherep hook within 12 hours. The recorded-session alternative must match any node task binding from ${KHEREP_SESSION_ENV}.`;

const FINAL_OK = ["accepted", "delivered", "replied"];
const WAIT_POLL_MS = 250;

const PROGRESS_TEXT: Record<string, string> = {
  "awaiting-user-turn": "waiting for the target session's next turn; delivery is not confirmed",
  "awaiting-turn-confirmation": "the target turn received it and has not confirmed completion",
  "target-busy": "the target session is busy",
  "wake-unconfirmed": "the automatic wake was not confirmed; start the target turn to retry delivery",
  "retry-pending": "delivery will retry after the current local limit clears",
  "wake-disabled": "automatic wake is disabled on the target node; start the target turn to retry delivery",
  "wake-not-authorized": "the target node's policy did not authorize automatic delivery; start the target turn to retry delivery",
  "permission-restricted": "the target permission mode blocks automatic wake; start the target turn to retry delivery",
  "operator-stopped": "the target session was stopped by its operator and requires an explicit continue",
  "reply-limit": "the automatic reply depth limit was reached",
  "budget-exhausted": "the target's autonomous-turn budget is exhausted",
  "ambiguous-target": "the target session name is ambiguous; send to its full session id",
  "cwd-refused": "the last closed-session delivery attempt was refused: the closed session's working directory is not usable on the "
    + "target node (not absolute, missing, or outside its workspace roots); the message stays queued and is tried again each round",
  "wake-pending": "awaiting automatic wake confirmation",
  "fallback-starting": "a local delivery session is starting",
  "fallback-running": "a local delivery session is running",
  "wake-failed": "the automatic wake failed; start the target turn to retry delivery",
  "fallback-failed": "the local delivery session failed; delivery is not confirmed",
};

// The sender state (accepted, running, stopped, ...) with its reason (issue #197).
function stateText(record: SentRecord, now: number): string {
  const state = senderState(record.state, record.progress);
  if (silentlyAccepted(record.state, record.progress, Date.parse(record.updatedAt), now)) {
    return `${state}: no delivery progress from the target node since ${record.updatedAt}; ${ACCEPTED_SILENCE_CAUSES}; check \`kherep-node msg sessions\``;
  }
  return `${state}${progressText(record)}`;
}

function progressText(record: SentRecord): string {
  if (!record.progress) return record.reason ? `: ${record.reason}` : "";
  const retry = record.progress.retryAt ? `; retry after ${record.progress.retryAt}` : "";
  return `: ${PROGRESS_TEXT[record.progress.code]} [${record.progress.phase}/${record.progress.code}; observed ${record.progress.observedAt}${retry}]`;
}

export interface MsgContext {
  paths: NodePaths;
  env: NodeJS.ProcessEnv;
  now?: () => number;
  out?: (line: string) => void;
  err?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  processTable?: IdentityDeps["processTable"]; // tests inject one; the default lists processes once, only for a nesting
}

export type Io = Required<MsgContext>;

function fail(io: Io, message: string): number {
  io.err(`kherep-node msg: ${message}`);
  return 1;
}

export interface MsgArgs {
  positionals: string[];
  values: { from?: string; to?: string; "reply-to"?: string; wait?: string; all?: boolean; receive?: boolean; ack?: string; new?: string; cwd?: string; directive?: string;
    "expected-run-version"?: string; "message-id"?: string; "expect-node"?: string; "expect-session"?: string;
    "expect-target-session"?: string; "expect-reply-to"?: string; "expect-text-sha256"?: string };
}

export function parseMsgArgs(argv: string[]): MsgArgs {
  const parsed = parseArgs({
    args: argv, allowPositionals: true, tokens: true,
    options: { from: { type: "string" }, to: { type: "string" }, "reply-to": { type: "string" }, wait: { type: "string" }, all: { type: "boolean" }, receive: { type: "boolean" }, ack: { type: "string" },
      new: { type: "string" }, cwd: { type: "string" }, directive: { type: "string" }, "expected-run-version": { type: "string" },
      "message-id": { type: "string" }, "expect-node": { type: "string" }, "expect-session": { type: "string" },
      "expect-target-session": { type: "string" }, "expect-reply-to": { type: "string" }, "expect-text-sha256": { type: "string" } },
  });
  if (EXACT_INBOX_FLAGS.some(key => parsed.values[key] !== undefined)) {
    const names = parsed.tokens.filter(token => token.kind === "option").map(token => token.name);
    if (new Set(names).size !== names.length) throw new Error("exact-inbox-invalid-selectors");
  }
  return parsed;
}

export function runMsg(argv: string[], context: MsgContext): Promise<number> {
  let parsed: MsgArgs;
  try { parsed = parseMsgArgs(argv); } catch (error) {
    if (!argv.some(arg => EXACT_INBOX_FLAGS.some(flag => arg === `--${flag}` || arg.startsWith(`--${flag}=`)))) throw error;
    (context.err ?? console.error)("kherep-node msg: exact-inbox-invalid-selectors");
    return Promise.resolve(1);
  }
  return runMsgArgs(parsed, context);
}

// Runs parsed arguments; the Worker tests call it directly because workerd
// has no node:util parseArgs.
export async function runMsgArgs({ positionals, values }: MsgArgs, context: MsgContext): Promise<number> {
  const io: Io = {
    paths: context.paths, env: context.env, now: context.now ?? Date.now, processTable: context.processTable ?? processTableOnce(),
    out: context.out ?? ((line) => console.log(line)), err: context.err ?? ((line) => console.error(line)),
    sleep: context.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
  const positionalSelector = positionals[0] === "inbox" && positionals.slice(1).some(arg =>
    ["from", ...EXACT_INBOX_FLAGS].some(flag => arg === `--${flag}` || arg.startsWith(`--${flag}=`)));
  if (positionalSelector || EXACT_INBOX_FLAGS.some(key => values[key] !== undefined)) return exactInbox(io, positionals, values);
  const [command, ...rest] = positionals;
  if (command === "sessions") return sessions(io, values.from);
  if (command === "send") return send(io, rest, values);
  if (command === "inbox") return inbox(io, values, rest);
  if (command === "status" && rest.length === 1) return status(io, rest[0]);
  if (command === "stop" && rest.length === 1) return stopTask(io, rest[0], values);
  io.err(MSG_USAGE);
  return 2;
}

async function send(io: Io, rest: string[], values: MsgArgs["values"]): Promise<number> {
  const replyTo = values["reply-to"];
  if (values.new !== undefined) {
    if (replyTo !== undefined || values.to !== undefined) return fail(io, "--new starts a conversation and takes neither --reply-to nor --to");
    const [node, ...words] = rest;
    if (!node) return fail(io, `no target node\n${MSG_USAGE}`);
    const directory = directoryFor(io);
    return directory ? sendNew(io, directory, node, words, values) : 1;
  }
  if (values.cwd !== undefined || values.directive !== undefined) return fail(io, "--cwd and --directive go with --new");
  let to: MessageAddress | null = null;
  let target = values.to;
  let words = rest;
  // A reply is one hop deeper than the message it answers, and belongs to its task.
  let depth = 0;
  let guarded = false;
  let taskId: string | undefined;
  if (replyTo !== undefined) {
    if (!isMessageId(replyTo)) return fail(io, `--reply-to needs a message id, got "${replyTo}"`);
    const original = getMessage(io.paths.inbox, replyTo);
    if (!original) return fail(io, `message ${replyTo} is not in this node's inbox`);
    depth = (original.depth ?? 0) + 1;
    guarded = original.loop !== undefined;
    taskId = original.taskId;
    if (!target) {
      if (original.from.nodeId === OPERATOR_NODE_ID) return fail(io, "the message came from the operator API and cannot be answered with msg send");
      to = { nodeId: original.from.nodeId, session: original.from.session };
    }
  } else {
    [target, ...words] = rest;
    if (!target) return fail(io, `no target\n${MSG_USAGE}`);
  }
  if (!to) {
    const directory = directoryFor(io);
    if (!directory) return 1;
    const resolved = resolveSendTarget(directory, target as string);
    if (!resolved.ok) return fail(io, resolved.error);
    to = resolved.value;
    if (resolved.note) io.err(`kherep-node msg: note: ${resolved.note}`);
  }
  const text = words.join(" ");
  if (!isMessageText(text)) return fail(io, `message text must be 1 to ${MAX_MESSAGE_TEXT} characters`);
  const from = senderSession(io.paths, io.env, values.from, io.now(), io);
  if (!from.ok) return fail(io, from.error);
  const wait = values.wait === undefined ? 0 : Number(values.wait);
  if (!Number.isFinite(wait) || wait < 0) return fail(io, `--wait needs a number of seconds, got "${values.wait}"`);

  // A session started for a task tags its messages with that task (item 5).
  // A task the Worker does not know (issue #102) tags nothing.
  const own = taskForSession(io.paths, sessionIdFromEnv(io.paths, io.env, io));
  taskId = (own && !own.local ? own.taskId : undefined) ?? taskId;
  const record: OutboxRecord = { messageId: crypto.randomUUID(), fromSession: from.value,
    fromSessionId: senderSessionId(io.paths, io.env, from.value, io), to, text,
    ...(replyTo ? { inReplyTo: replyTo } : {}), ...(taskId ? { taskId } : {}), createdAt: new Date(io.now()).toISOString(), depth, ...(guarded ? { guarded: true as const } : {}) };
  writeOutbox(io.paths, record);
  if (replyTo) markAnswered(io.paths.inbox, replyTo);
  io.out(record.messageId);
  return wait > 0 ? waitForAnswer(io, record.messageId, wait * 1000) : 0;
}

// Waits until the target node accepted or refused the message, or the Worker
// gave up on it. queued is not an answer yet.
async function waitForAnswer(io: Io, messageId: string, timeoutMs: number): Promise<number> {
  const deadline = io.now() + timeoutMs;
  for (;;) {
    const sent = getSent(io.paths, messageId);
    if (sent && sent.state !== "queued") {
      io.out(stateText(sent, io.now()));
      return FINAL_OK.includes(sent.state) ? 0 : 1;
    }
    if (io.now() >= deadline) {
      io.out(`no answer yet: ${sent ? sent.state : "not sent by the daemon yet"}`);
      return 1;
    }
    await io.sleep(WAIT_POLL_MS);
  }
}

function status(io: Io, messageId: string): number {
  if (!isMessageId(messageId)) return fail(io, `not a message id: "${messageId}"`);
  const sent = getSent(io.paths, messageId);
  if (sent) {
    io.out(`${messageId} ${stateText(sent, io.now())} (updated ${sent.updatedAt})`);
    // Issue #441: while queued, whether its target node takes its messages.
    if (sent.state === "queued" && sent.to?.nodeId) io.out(targetLine(directoryFor(io), sent.to.nodeId, io.now()));
    for (const line of replyLines(io.paths, sent)) io.out(line);
    return 0;
  }
  if (getOutbox(io.paths, messageId)) {
    io.out(`${messageId} pending: waiting for the daemon to send it`);
    return 0;
  }
  // Issue #417: a message this node received.
  const received = getMessage(io.paths.inbox, messageId);
  if (received) {
    io.out(`${messageId} ${received.state} (received ${received.receivedAt})`);
    for (const line of offerLine(received)) io.out(line);
    return 0;
  }
  return fail(io, `unknown message ${messageId}: not in the outbox, sent messages or inbox of this node`);
}
