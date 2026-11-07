import { isNodeId } from "../../protocol.mts";
import { fullSessionId, identityRuntime, type IdentityRuntime } from "../../protocol-session-identity.mts";

export const INTERCOM_SLOTS = ["kherep-lead", "codex-windows", "claude-windows", "codex-mac", "claude-mac"] as const;
export type IntercomSlot = typeof INTERCOM_SLOTS[number];

// An address and display name only, never proof of native caller ownership.
export interface SlotOccupant { nodeId: string; runtime: IdentityRuntime; sessionId: string; chatName: string }

export interface IntercomSlotView { slot: IntercomSlot; revision: number; occupant: SlotOccupant | null }

export function readIntercomSlots(sql: SqlStorage): IntercomSlotView[] {
  const rows = sql.exec<{ slot: string; revision: number; node_id: string | null; runtime: IdentityRuntime | null;
    session_id: string | null; chat_name: string | null }>(
    "SELECT slot, revision, node_id, runtime, session_id, chat_name FROM intercom_slots",
  ).toArray();
  if (rows.length !== INTERCOM_SLOTS.length) throw new Error("invalid Intercom slot row set");
  const bySlot = new Map(rows.map(row => [row.slot, row]));
  return INTERCOM_SLOTS.map(slot => {
    const row = bySlot.get(slot);
    if (!row) throw new Error("invalid Intercom slot row set");
    return { slot, revision: row.revision, occupant: row.node_id === null ? null : {
      nodeId: row.node_id, runtime: row.runtime!, sessionId: row.session_id!, chatName: row.chat_name!,
    } };
  });
}

export function replaceIntercomSlot(sql: SqlStorage, slot: IntercomSlot, expectedRevision: number, occupant: SlotOccupant | null): number | null {
  if (!(INTERCOM_SLOTS as readonly unknown[]).includes(slot)) throw new TypeError("invalid Intercom slot");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("invalid Intercom slot revision");
  }
  if (occupant !== null) {
    if (typeof occupant !== "object" || Array.isArray(occupant)
      || !isNodeId(occupant.nodeId) || !identityRuntime(occupant.runtime) || !fullSessionId(occupant.sessionId)
      || typeof occupant.chatName !== "string" || !occupant.chatName.trim()
      || (slot.startsWith("codex-") && occupant.runtime !== "codex")
      || (slot.startsWith("claude-") && occupant.runtime !== "claude-code")) {
      throw new TypeError("invalid Intercom slot occupant");
    }
  }
  // One synchronous statement decides the CAS; no read, await or retry can intervene.
  const result = sql.exec<{ revision: number }>(
    `UPDATE intercom_slots SET node_id=?, runtime=?, session_id=?, chat_name=?, revision=revision+1
      WHERE slot=? AND revision=? RETURNING revision`,
    occupant?.nodeId ?? null, occupant?.runtime ?? null, occupant?.sessionId ?? null, occupant?.chatName ?? null,
    slot, expectedRevision,
  ).toArray();
  return result[0]?.revision ?? null;
}
