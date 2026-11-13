// Issue #761: the notice the Worker writes when the operator moves the
// kherep-lead slot to another session. Pure text, shared by the Worker (which
// writes it) and the node (which recognizes and frames it). Nothing new on the
// wire: the notice is an ordinary message from OPERATOR_NODE_ID /
// CONTROL_PLANE_SESSION.
import { CONTROL_PLANE_SESSION, OPERATOR_NODE_ID, type MessageAddress } from "./protocol-messages.mts";

// Only the lead slot carries a role; the runtime slots are platform addresses.
export const NOTIFY_SLOTS = ["kherep-lead"] as const;
export type NotifySlot = typeof NOTIFY_SLOTS[number];

export function isNotifySlot(slot: string): slot is NotifySlot {
  return (NOTIFY_SLOTS as readonly string[]).includes(slot);
}

// previous: the session that held the slot, told who holds it now (or none).
// next: the session that holds it now, told whom to ask for the HANDOVER.
export type SlotNotice =
  | { recipient: "previous"; slot: NotifySlot; revision: number; at: string; newLead: MessageAddress | null }
  | { recipient: "next"; slot: NotifySlot; revision: number; at: string; previousLead: MessageAddress };

const address = (a: MessageAddress): string => `${a.nodeId}/${a.session}`;

export function slotNoticeText(notice: SlotNotice): string {
  const slot = `SLOT: ${notice.slot} revision ${notice.revision}`;
  if (notice.recipient === "next") {
    return [
      "ROLE CHANGED: team-lead -> lead", slot, `PREVIOUS-LEAD: ${address(notice.previousLead)}`, `AT: ${notice.at}`,
      "NEXT: request HANDOVER: from PREVIOUS-LEAD as your role text says, then act as the lead.",
    ].join("\n");
  }
  return [
    "ROLE CHANGED: lead -> team-lead", slot, `NEW-LEAD: ${notice.newLead ? address(notice.newLead) : "none"}`, `AT: ${notice.at}`,
    notice.newLead
      ? "NEXT: send HANDOVER: to NEW-LEAD as your role text says, then act as a session team lead."
      : "NEXT: no session holds the lead slot; act as a session team lead and ask the operator.",
  ].join("\n");
}

// True for the sender of a Worker-written notice. Only the Worker can write
// this sender (see CONTROL_PLANE_SESSION); a peer that copies the text keeps
// its own sender and is framed as peer content.
export function isControlPlaneNotice(from: MessageAddress): boolean {
  return from.nodeId === OPERATOR_NODE_ID && from.session === CONTROL_PLANE_SESSION;
}
