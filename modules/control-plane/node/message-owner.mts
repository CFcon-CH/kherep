import { isMessageBinding, type MessageBinding, type SelectedOwner } from "../protocol-message-binding.mts";

type RecordOwner = { toSession: string; from: { session: string }; binding?: MessageBinding };
export function boundRecordValid(record: Partial<RecordOwner>): boolean {
  if (!Object.hasOwn(record, "binding")) return true;
  return isMessageBinding(record.binding) && record.toSession === record.binding.to.sessionId
    && record.from?.session === record.binding.from.sessionId;
}
export function messageOwnerMatches(record: RecordOwner, owner: SelectedOwner | undefined, legacyRefs: readonly string[]): boolean {
  if (!boundRecordValid(record)) return false;
  if (!Object.hasOwn(record, "binding")) return legacyRefs.includes(record.toSession);
  return !!owner && record.binding!.to.sessionId === owner.sessionId && record.binding!.to.runtime === owner.runtime;
}
export function mayRetarget(record: RecordOwner, target: SelectedOwner): boolean {
  return boundRecordValid(record) && (!Object.hasOwn(record, "binding")
    || record.binding!.to.sessionId === target.sessionId && record.binding!.to.runtime === target.runtime);
}
