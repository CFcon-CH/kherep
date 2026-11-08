import { isMessageBinding, type MessageBinding, type SelectedOwner } from "../protocol-message-binding.mts";

type RecordOwner = { toSession: string; from: { session: string }; binding?: MessageBinding };
export const isProtectedMessage = (record: { binding?: MessageBinding } | null | undefined): boolean => record?.binding?.mode === "slot-exact";
export function boundRecordValid(record: Partial<RecordOwner>): boolean {
  if (!Object.hasOwn(record, "binding")) return true;
  return isMessageBinding(record.binding) && record.toSession === record.binding.to.sessionId
    && record.from?.session === record.binding.from.sessionId;
}
export function messageOwnerMatches(record: RecordOwner, owner: SelectedOwner | undefined, legacyRefs: readonly string[], original = false): boolean {
  if (!boundRecordValid(record) || record.binding?.mode === "slot-exact" && !original) return false;
  if (!Object.hasOwn(record, "binding")) return legacyRefs.includes(record.toSession);
  return !!owner && record.binding!.to.sessionId === owner.sessionId && record.binding!.to.runtime === owner.runtime;
}
export function mayRetarget(record: RecordOwner, target: SelectedOwner): boolean {
  return boundRecordValid(record) && (!Object.hasOwn(record, "binding")
    || record.binding!.to.sessionId === target.sessionId && record.binding!.to.runtime === target.runtime);
}
