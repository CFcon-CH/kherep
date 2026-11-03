import { boundRecordValid } from "./message-owner.mts";
import { MAX_REPLY_DEPTH } from "../protocol-messages.mts";
import { isLoopAdmissionV1 } from "../protocol-loop-brake.mts";
import type { InboxRecord } from "./inbox.mts";

export type ReplyAdmission = { allowed: true; mode: "legacy" | "guarded" }
  | { allowed: false; code: "legacy-depth" | "invalid-admission" };

export function automaticReplyDecision(record: Pick<InboxRecord, "depth" | "loop"> & Partial<Pick<InboxRecord, "binding" | "from" | "toSession">>): ReplyAdmission {
  if (!boundRecordValid(record)) return { allowed: false, code: "invalid-admission" };
  const depth = record.depth === undefined ? 0 : record.depth;
  if (Object.hasOwn(record, "loop")) {
    return isLoopAdmissionV1(record.loop) && record.depth === record.loop.depth
      ? { allowed: true, mode: "guarded" } : { allowed: false, code: "invalid-admission" };
  }
  return Number.isSafeInteger(depth) && depth >= 0 && depth < MAX_REPLY_DEPTH
    ? { allowed: true, mode: "legacy" } : { allowed: false, code: "legacy-depth" };
}
