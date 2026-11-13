import { CONTROL_PLANE_SESSION, OPERATOR_NODE_ID, type MessageAddress } from "../../protocol-messages.mts";
import { isNotifySlot, slotNoticeText, type SlotNotice } from "../../protocol-slot-notice.mts";
import { replaceIntercomSlot, slotOccupantAt, type IntercomSlot, type SlotOccupant } from "./intercom-slots.mts";
import type { MessageEffects, MessageStore } from "./message-store.mts";

// Issue #761: the one place a slot changes occupant. The caller runs this in
// one transactionSync, so the CAS, the notices and their audit row commit or
// roll back together; a storage failure leaves no slot change and no notice.
// A notice the target cannot take (revoked node, full queue) is stored as
// refused like any message; the slot change still commits. Replays return
// before this call, so a revision gets at most one notice set.

type Audit = (actor: string, action: string, target: string | null, detail: unknown) => void;
export interface SlotChange { revision: number | null; effects: MessageEffects }

const sameSession = (a: SlotOccupant, b: SlotOccupant | null): boolean => b !== null && a.nodeId === b.nodeId && a.sessionId === b.sessionId;
const addressOf = (o: SlotOccupant): MessageAddress => ({ nodeId: o.nodeId, session: o.sessionId });

export function commitSlotChange(sql: SqlStorage, messages: MessageStore, audit: Audit, slot: IntercomSlot,
  expectedRevision: number, occupant: SlotOccupant | null, now: number): SlotChange {
  const before = slotOccupantAt(sql, slot, expectedRevision);
  const revision = replaceIntercomSlot(sql, slot, expectedRevision, occupant);
  const effects: MessageEffects = { deliveries: [], statuses: [] };
  // No notice for a conflict, a runtime slot, a first assignment or the same session again.
  if (revision === null || !isNotifySlot(slot) || !before || sameSession(before, occupant)) return { revision, effects };
  const at = new Date(now).toISOString();
  const previousLead = addressOf(before), newLead = occupant && addressOf(occupant);
  const notices: [MessageAddress, SlotNotice][] = [[previousLead, { recipient: "previous", slot, revision, at, newLead }]];
  if (newLead) notices.push([newLead, { recipient: "next", slot, revision, at, previousLead }]);
  const sent = notices.map(([to, notice]) => {
    const messageId = crypto.randomUUID();
    const result = messages.send({ messageId, from: { nodeId: OPERATOR_NODE_ID, session: CONTROL_PLANE_SESSION }, to,
      text: slotNoticeText(notice) }, CONTROL_PLANE_SESSION, now);
    if (result.ok) {
      effects.deliveries.push(...result.effects.deliveries);
      effects.statuses.push(...result.effects.statuses);
    }
    return { messageId, recipient: notice.recipient, to, ...(result.ok ? { state: result.status.state } : { error: result.error }) };
  });
  audit(CONTROL_PLANE_SESSION, "intercom.slot-notice", slot, { revision, notices: sent });
  return { revision, effects };
}

// The frames the caller routes after its answer; attached only when there are any,
// so a result without a notice keeps its exact earlier shape.
export function withEffects<T extends object>(result: T, effects: MessageEffects): T & { effects?: MessageEffects } {
  return effects.deliveries.length || effects.statuses.length ? { ...result, effects } : result;
}

export function withoutEffects<T extends object>(result: T & { effects?: MessageEffects }): T {
  const copy = { ...result };
  delete copy.effects;
  return copy;
}
