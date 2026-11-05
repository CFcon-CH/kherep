import type { AppServerMessage } from "./codex-app-server-client.mts";
import type { ForkAttemptReason } from "./codex-fork-attempts.mts";
import { frameForFork } from "./deliver-core.mts";
import type { InboxRecord } from "./inbox.mts";

// What one Codex fork is told and what it may answer (issue #408, design
// sections 4.5 and 5). The instruction is daemon-owned text; the peer message
// follows it in one framed block without a reply line. The answer is accepted
// only as the structured object, from the one agent message of the turn.

export const forkOutputSchema = {
  type: "object", additionalProperties: false, required: ["kind", "text", "code"],
  properties: {
    kind: { type: "string", enum: ["answer", "decline"] },
    text: { type: "string" },
    code: { type: "string", enum: ["none", "needs-owner", "insufficient-context"] },
  },
} as const;

export type ForkAnswer = { kind: "answer"; text: string } | { kind: "decline"; code: "needs-owner" | "insufficient-context" }
  | { kind: "failed"; reason: ForkAttemptReason };

export function forkPrompt(record: InboxRecord, tag: string, maxAnswerBytes: number): string {
  const instruction = "You are an ephemeral fork of this conversation, started by Kherep to answer one peer message while the "
    + "owner of this session is idle. Answer only what the peer asked, from this conversation's context, as the structured object "
    + "with kind, text and code. Use kind \"decline\" with code \"needs-owner\" for anything that needs the owner's judgement, an "
    + "action, an approval or knowledge from outside this conversation, and code \"insufficient-context\" when this conversation "
    + "does not contain the answer; a decline has empty text. An answer has code \"none\" and text of at most "
    + `${maxAnswerBytes} bytes. Quote nothing private beyond what the question needs. You have no tools and no messaging commands.`;
  return `${instruction}\n\n${frameForFork(record, tag)}`;
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
// C0 control characters other than tab and newline.
const CONTROL = /[\u0000-\u0008\u000b-\u001f]/;

function agentText(item: unknown): string | null {
  return object(item) && item.type === "agentMessage" && typeof item.text === "string" ? item.text : null;
}

// The answer, a decline, or the reason the turn gives none. turnCompleted is
// the params of the turn/completed notification for forkId.
export function validateForkAnswer(notifications: readonly AppServerMessage[], turnCompleted: unknown, forkId: string,
  turnId: string, maxAnswerBytes: number): ForkAnswer {
  const failed = (reason: ForkAttemptReason): ForkAnswer => ({ kind: "failed", reason });
  const turn = object(turnCompleted) && turnCompleted.threadId === forkId && object(turnCompleted.turn) ? turnCompleted.turn : null;
  if (!turn || turn.id !== turnId) return failed("answer-invalid");
  if (turn.status === "interrupted") return failed("turn-interrupted");
  if (turn.status !== "completed") return failed(turn.status === "failed" ? "turn-failed" : "answer-invalid");
  const messages = notifications.flatMap((note) => {
    const params = object(note.params) ? note.params : {};
    if (note.method !== "item/completed" || params.threadId !== forkId || params.turnId !== turnId) return [];
    const text = agentText(params.item);
    return text === null ? [] : [text];
  });
  const summary = Array.isArray(turn.items) ? turn.items.map(agentText).filter((text) => text !== null) : [];
  if (messages.length !== 1 || summary.length !== 1 || summary[0] !== messages[0]) return failed("answer-invalid");
  let value: unknown;
  try { value = JSON.parse(messages[0]!); } catch { return failed("answer-invalid"); }
  if (!object(value) || Array.isArray(value) || Object.keys(value).sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }).join() !== "code,kind,text") return failed("answer-invalid");
  const { kind, text, code } = value;
  if (typeof text !== "string" || typeof code !== "string") return failed("answer-invalid");
  if (kind === "answer") {
    const bytes = Buffer.byteLength(text, "utf8");
    return code === "none" && bytes >= 1 && bytes <= maxAnswerBytes && !CONTROL.test(text) ? { kind: "answer", text }
      : failed("answer-invalid");
  }
  if (kind === "decline" && text === "" && (code === "needs-owner" || code === "insufficient-context")) return { kind: "decline", code };
  return failed("answer-invalid");
}
