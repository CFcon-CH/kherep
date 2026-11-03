import type { SelectedOwner } from "../protocol-message-binding.mts";
import { messageOwnerMatches } from "./message-owner.mts";
import { isMessageId, isMessageText } from "../protocol-messages.mts";
import { readInboxRecord } from "./inbox-storage.mts";
import { acknowledgeCodexOffer } from "./codex-inbox-ack.mts";
import { codexSessionRefs, listCodexSessions, readCodexSession } from "./codex-sessions.mts";
import { CODEX_CONTEXT_BYTES, CODEX_ESCALATION_NOTE } from "./deliver-codex.mts";
import { deliveryContext } from "./deliver-core.mts";
import type { NodePaths } from "./config.mts";
import { readDirectory, type LocalSession, type SentRecord } from "./exchange.mts";
import { listInbox, readJson, type InboxRecord } from "./inbox.mts";
import { failureReason, getProxied, relayStateOf } from "./inbox-proxied.mts";
import type { MsgArgs, MsgContext } from "./msg-cli.mts";
import { nodeLabel, senderSession, sessionIdentity } from "./msg-resolve.mts";
import { repliesTo } from "./sent-notices.mts";

type InboxIo = Required<MsgContext>;

// Inspection is read-only. --receive offers bounded peer context to the current
// Codex continuation; only an explicit exact-offer ACK confirms processing.
export function inbox(io: InboxIo, values: MsgArgs["values"], selectors: string[] = []): number {
  const fail = (message: string): number => { io.err("kherep-node msg: " + message); return 1; };
  if ((values.receive || values.ack !== undefined) && Object.keys(values).some(key => !["from", "receive", "ack", "all"].includes(key))) return fail("receive and ACK accept only their own inbox selectors");
  if (selectors.length > 1 || (selectors.length && (!values.receive || !isMessageId(selectors[0])))) return fail("single receive needs exactly one message id and --receive");
  if (values.ack !== undefined && (values.receive || values.all || !values.from)) return fail("--ack needs --from and cannot combine with --receive or --all");
  if (values.receive && values.all) return fail("--receive cannot be combined with --all");
  if (values.receive && !values.from) return fail("--receive needs --from with the recorded Codex session id");

  let refs: string[];
  let owner: SelectedOwner;
  let ackRuntime:"codex"|"claude-code"|undefined;
  const ackIdentity = values.ack !== undefined ? sessionIdentity(io.paths, io.env, io) : null;
  if (ackIdentity?.ok && ackIdentity.runtime === "claude") {
    if (ackIdentity.id !== values.from) return fail("ACK --from must be the exact current Claude session id");
    refs = [ackIdentity.id];
    ackRuntime = "claude-code";
    owner={sessionId:ackIdentity.id,runtime:"claude-code"};
  } else if (values.from !== undefined) {
    try {
      const session = readCodexSession(io.paths, values.from);
      if (!session || session.sessionId !== values.from || session.runtime !== "codex") {
        return fail("--from needs a recorded Codex session id for inbox access");
      }
      owner = { sessionId: session.sessionId, runtime: "codex" };
      const verified = senderSession(io.paths, io.env, values.from, io.now(), io);
      if (!verified.ok) return fail(verified.error);
      ackRuntime = "codex";
      // An unsuccessful listing cannot prove an alias is unambiguous.
      const live = listCodexSessions(io.paths, io.now()).map(s => s.sessionId);
      refs = codexSessionRefs(io.paths, values.from, io.now(), live).refs;
    } catch {
      return fail("cannot read Codex sessions safely; inbox was not received");
    }
  } else {
    const identity = sessionIdentity(io.paths, io.env, io);
    if (!identity.ok) return fail(identity.error);
    const id = identity.id;
    owner = { sessionId: id, runtime: identity.runtime === "claude" ? "claude-code" : "codex" };
    refs = [id];
    try {
      const sessions = readJson<{ sessions?: LocalSession[] }>(io.paths.sessions)?.sessions;
      if (!Array.isArray(sessions) || !sessions.every(s => s && typeof s.sessionId === "string" && s.sessionId.length > 0
        && (s.name === undefined || (typeof s.name === "string" && s.name.length > 0)))) {
        throw new Error("invalid local sessions");
      }
      const name = sessions.find(s => s.sessionId === id)?.name;
      const matches = name ? sessions.filter(s => s.sessionId === name || s.name === name) : [];
      if (name && matches.length === 1 && matches[0].sessionId === id) refs.push(name);
    } catch {
      io.err("kherep-node msg: cannot verify local session names; inspecting only the exact session id");
    }
  }

  if (values.ack !== undefined) {
    try { io.out(acknowledgeCodexOffer(io.paths, values.from!, values.ack, refs, ackRuntime)); return 0; }
    catch (error) { return fail(error instanceof Error ? error.message : "Codex ACK failed"); }
  }
  if (values.receive) {
    let selected: InboxRecord | undefined;
    if (selectors.length) {
      try {
        selected = readInboxRecord(io.paths.inbox, selectors[0]) ?? undefined;
        if (!selected || selected.messageId !== selectors[0] || !messageOwnerMatches(selected, { sessionId: values.from!, runtime: "codex" }, refs)
          || !["accepted", "offered"].includes(selected.state) || !isMessageText(selected.text)) return fail("single receive record is not currently owned and waiting");
      } catch { return fail("single receive record is missing, invalid or unreadable"); }
    }
    const context = deliveryContext("UserPromptSubmit", refs, {
      paths: io.paths, now: io.now, replyFrom: values.from, owner: { sessionId: values.from!, runtime: "codex" },
      maxBytes: (selected ? 128 * 1024 : CODEX_CONTEXT_BYTES) - Buffer.byteLength(CODEX_ESCALATION_NOTE) - 1,
      codexSelected: selected,
      reofferOffered: true, offeredBy: "receive", codexOwner: values.from,
    });
    io.out(context ? context + "\n" + CODEX_ESCALATION_NOTE : "no messages waiting for this continuation");
    return 0;
  }
  const records = listInbox(io.paths.inbox)
    .filter(r => messageOwnerMatches(r, owner, refs) || !Object.hasOwn(r, "binding") && r.closedTo !== undefined && refs.includes(r.closedTo))
    .filter(r => values.all || r.state === "accepted" || r.state === "offered");
  if (records.length === 0) {
    io.out(values.all ? "no messages for this session" : "no undelivered messages for this session (--all includes delivered ones)");
    return 0;
  }
  const directory = readDirectory(io.paths);
  for (const r of records) {
    io.out(r.messageId + "  " + r.state + "  " + r.createdAt);
    io.out("  from: node " + nodeLabel(directory, r.from.nodeId) + ", session " + r.from.session);
    if (r.inReplyTo) io.out("  in reply to: " + r.inReplyTo);
    // Issue #408: the relay state of a proxy answer a fork of this session prepared, and one received.
    const relay = relayStateOf(io.paths, r.messageId);
    if (relay) io.out(`  proxy answer: ${relay.state} ${relay.relayMessageId} at ${relay.sent?.updatedAt ?? claimedAt(io.paths, r.messageId)}`
      + (relay.state === "failed" ? ` ${JSON.stringify(failureReason(relay.sent))}` : ""));
    if (r.proxyOf) io.out("  proxy for: " + r.proxyOf);
    if (r.closedTo !== undefined) io.out("  forwarded to: session " + r.toSession);
    if (r.delivery) {
      io.out("  delivery task: " + r.delivery.taskId);
      if (r.delivery.sessionId) io.out("  delivery session: " + r.delivery.sessionId);
    }
    for (const line of offerLine(r)) io.out(line);
    for (const line of r.text.split("\n")) io.out("  | " + line);
  }
  return 0;
}

// Display only: the time of the sidecar's claim.
function claimedAt(paths: NodePaths, messageId: string): string {
  try { return getProxied(paths.inbox, messageId)?.at ?? "unknown"; } catch { return "unknown"; }
}

// Issue #417: which path made the record's last offer, and when; nothing before any offer.
export function offerLine(r: InboxRecord): string[] {
  return r.offeredAt ? [`  offered by: ${r.offeredBy ?? "unknown"} at ${r.offeredAt} (offer ${r.offers ?? 1})`] : [];
}

// Issue #200: the replies to a sent message that reached this node (repliesTo).
export function replyLines(paths: NodePaths, sent: SentRecord): string[] {
  const replies = repliesTo(listInbox(paths.inbox), sent);
  if (replies.length === 0) return [];
  const directory = readDirectory(paths);
  return replies.flatMap((r) => {
    const lines = [`  reply ${r.messageId} from node ${nodeLabel(directory, r.from.nodeId)}, session ${r.from.session}`
      + ` (${r.state}, received ${r.receivedAt})`, ...offerLine(r).map((line) => "  " + line)];
    // Issue #389: a reply handed to another session names where it went.
    if (r.closedTo === undefined) return lines;
    if (r.toSession !== r.closedTo) lines.push(`    forwarded to: session ${r.toSession}`);
    if (r.delivery) lines.push(`    delivery task: ${r.delivery.taskId}`);
    if (r.delivery?.sessionId) lines.push(`    delivery session: ${r.delivery.sessionId}`);
    return lines;
  });
}
