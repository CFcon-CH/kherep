import { isPlainSessionId } from "./autonomy.mts";
import { scheduleForkReply } from "./codex-fork-reply.mts";
import { relayPending } from "./codex-fork-relay.mts";
import { pollCodexQueue } from "./codex-queue.mts";
import { listCodexSessions } from "./codex-sessions.mts";
import { listInbox } from "./inbox.mts";
import { automaticReplyDecision } from "./reply-admission.mts";
import type { RunnerDeps } from "./session-runner.mts";

// Issue #890 (retirement R3): the poll no longer runs the Codex fork relay
// sweep or schedules a fork reply. Until the fork modules are deleted (R6a),
// their tests drive them with this test-only stand-in for the retired calls:
// the real poll, then the sweep and the producer for every live plain owner
// and its accepted, reply-admitted messages. Never imported by production code.
export function legacyForkPoll(deps: RunnerDeps, log: (line: string) => void = () => {}): void {
  pollCodexQueue(deps, log);
  const now = deps.now?.() ?? Date.now();
  for (const owner of listCodexSessions(deps.paths, now).map((s) => s.sessionId).filter(isPlainSessionId)) {
    relayPending(deps, owner, log);
    scheduleForkReply(deps, owner, listInbox(deps.paths.inbox, owner)
      .filter((record) => record.state === "accepted" && automaticReplyDecision(record).allowed).map((record) => record.messageId), log);
  }
}
