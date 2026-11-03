import {boundRecordValid} from './message-owner.mts';
import crypto from "node:crypto";
import { checkOrigin, isSenderOrigin, MESSAGE_ADMISSION_MS, senderTime, type SenderOrigin } from "../message-origin.mts";
import { isNodeId } from "../protocol.mts";
import { isMessageAddress, isMessageId, isSessionRef, type MessageAddress } from "../protocol-messages.mts";
import type { InboxRecord } from "./inbox.mts";
import type { QueueProducerIdentity } from "./codex-queue-binding.mts";

export const MAX_TARGET_MEMBERS = 8;
export const uuid = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
export const hash = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
export const integer = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
export const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
export const keys = (x: object, fields: string[]): boolean => Object.keys(x).sort().join() === [...fields].sort().join();
export function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (object(x)) return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(",")}}`;
  return JSON.stringify(x);
}
const digest = (x: unknown): string => crypto.createHash("sha256").update(canonical(x)).digest("hex");
function freeze<T>(x: T): T {
  if (x && typeof x === "object") { for (const item of Object.values(x)) freeze(item); Object.freeze(x); }
  return x;
}
export interface TargetMember {
  messageId: string; from: MessageAddress; to: MessageAddress; origin: SenderOrigin; deadlineMs: number;
  contentFingerprint: string; lineageFingerprint: string; offer: InboxRecord["codexOffer"] | null;
}
export interface TargetGroupInput {
  runtime: "codex" | "claude-code"; originalId: string; nodeId: string;
  policyFingerprint: string; lifecycleGeneration: number; producer: QueueProducerIdentity | null;
}
export interface TargetDeliveryGroup extends TargetGroupInput {
  version: 1; groupId: string; generation: string; members: TargetMember[]; deadlineMs: number;
}
function validProducer(x: unknown): boolean {
  if (x === null) return true; // Explicit UNKNOWN, never executable authorization.
  if (!object(x) || !keys(x, ["codexExecutable", "launchFile", "launchPrefix", "approvedFiles", "resolvedCodexHome", "route", ...(Object.hasOwn(x, "cwd") ? ["cwd"] : [])])) return false;
  const text = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 4096 && !s.includes("\0");
  return text(x.codexExecutable) && text(x.launchFile) && text(x.resolvedCodexHome) && (x.route === "local" || x.route === "unknown")
    && (x.cwd === undefined || text(x.cwd)) && Array.isArray(x.launchPrefix) && x.launchPrefix.length <= 32 && x.launchPrefix.every(text)
    && Array.isArray(x.approvedFiles) && x.approvedFiles.length > 0 && x.approvedFiles.length <= 64
    && x.approvedFiles.every(f => object(f) && keys(f, ["path", "realpath", "sha256"]) && text(f.path) && text(f.realpath) && hash(f.sha256));
}
function member(record: InboxRecord, nodeId: string, owner: string): TargetMember {
  if (!isMessageId(record.messageId) || !isMessageAddress(record.from) || !isSessionRef(record.toSession)
    || !isSenderOrigin(record.senderOrigin) || record.senderOrigin.nodeId !== record.from.nodeId || typeof record.text !== "string") throw Error("unbound target member");
  let offer: NonNullable<InboxRecord["codexOffer"]> | null = null;
  if (Object.hasOwn(record, "codexOffer")) {
    const value: unknown = record.codexOffer;
    if (!object(value) || !keys(value, ["owner", "generation", "fingerprint"]) || value.owner !== owner
      || !uuid(value.generation) || !hash(value.fingerprint)) throw Error("invalid target offer");
    offer = { owner, generation: value.generation, fingerprint: value.fingerprint };
  }
  return { messageId: record.messageId, from: { ...record.from }, to: { nodeId, session: record.toSession }, origin: { ...record.senderOrigin },
    deadlineMs: senderTime(record.senderOrigin.sentAt)! + MESSAGE_ADMISSION_MS, contentFingerprint: digest(record.text),
    lineageFingerprint: digest([record.createdAt, record.inReplyTo ?? null, record.proxyOf ?? null, record.taskId ?? null,
      record.depth ?? null, record.binding ?? null, record.loop ?? null, record.delivery ?? null, record.closedTo ?? null, record.closedAttempt ?? null]), offer };
}
export function parseTargetGroup(value: unknown): TargetDeliveryGroup {
  if (!object(value) || !keys(value, ["version", "groupId", "generation", "runtime", "originalId", "nodeId", "policyFingerprint", "lifecycleGeneration", "producer", "members", "deadlineMs"])
    || value.version !== 1 || !uuid(value.groupId) || !uuid(value.generation) || (value.runtime !== "codex" && value.runtime !== "claude-code")
    || !uuid(value.originalId) || !isNodeId(value.nodeId) || !hash(value.policyFingerprint) || !integer(value.lifecycleGeneration)
    || !validProducer(value.producer) || !integer(value.deadlineMs) || !Array.isArray(value.members)
    || value.members.length === 0 || value.members.length > MAX_TARGET_MEMBERS) throw Error("invalid target group");
  const ids = new Set<string>();
  for (const m of value.members) {
    if (!object(m) || !keys(m, ["messageId", "from", "to", "origin", "deadlineMs", "contentFingerprint", "lineageFingerprint", "offer"])
      || !isMessageId(m.messageId) || ids.has(m.messageId) || !isMessageAddress(m.from) || !keys(m.from, ["nodeId", "session"])
      || !isMessageAddress(m.to) || !keys(m.to, ["nodeId", "session"]) || m.to.nodeId !== value.nodeId
      || !isSenderOrigin(m.origin) || m.origin.nodeId !== m.from.nodeId || m.deadlineMs !== senderTime(m.origin.sentAt)! + MESSAGE_ADMISSION_MS
      || !hash(m.contentFingerprint) || !hash(m.lineageFingerprint)) throw Error("invalid target group member");
    if (m.offer !== null && (!object(m.offer) || !keys(m.offer, ["owner", "generation", "fingerprint"])
      || m.offer.owner !== value.originalId || !uuid(m.offer.generation) || !hash(m.offer.fingerprint))) throw Error("invalid target group offer");
    ids.add(m.messageId);
  }
  if (value.deadlineMs !== Math.min(...value.members.map(m => m.deadlineMs as number))) throw Error("target deadline differs");
  return freeze(JSON.parse(JSON.stringify(value)) as TargetDeliveryGroup);
}
export function createTargetGroup(input: TargetGroupInput, records: InboxRecord[], now: number): TargetDeliveryGroup {
  if (!records.every(r => checkOrigin(r.senderOrigin, r.from.nodeId, now).ok)) throw Error("target origin not eligible");
  if(records.some(r=>!boundRecordValid(r)||r.binding&&(r.binding.to.sessionId!==input.originalId||r.binding.to.runtime!==input.runtime||r.binding.to.lifecycleGeneration!==input.lifecycleGeneration)))throw Error('bound target lifecycle differs');
  const members = records.map(r => member(r, input.nodeId, input.originalId));
  return parseTargetGroup({ ...input, version: 1, groupId: crypto.randomUUID(), generation: crypto.randomUUID(), members,
    deadlineMs: Math.min(...members.map(m => m.deadlineMs)) });
}
export const targetGroupFingerprint = (group: TargetDeliveryGroup): string => digest(parseTargetGroup(group));
export function targetMembersMatch(group: TargetDeliveryGroup, records: InboxRecord[], nodeId: string): boolean {
  try {
    if (nodeId !== group.nodeId || records.length !== group.members.length) return false;
    return canonical(records.map(r => member(r, nodeId, group.originalId))) === canonical(group.members);
  } catch { return false; }
}

// Processing after submission may create a new, independently ACK-validated
// offer. It cannot alter the immutable group or authorize another submission.
// Reconciliation compares the stable original content/address/lineage/origin;
// pre-submit admission always uses the stricter targetMembersMatch above.
export function targetProcessedMembersMatch(group: TargetDeliveryGroup, records: InboxRecord[], nodeId: string): boolean {
  try {
    if (nodeId !== group.nodeId || records.length !== group.members.length || records.some(r => r.state !== "delivered")) return false;
    const stable = (m: TargetMember) => { const { offer: _offer, ...binding } = m; return binding; };
    return canonical(records.map(r => stable(member(r, nodeId, group.originalId)))) === canonical(group.members.map(stable));
  } catch { return false; }
}
