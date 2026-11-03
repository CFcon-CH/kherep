import { messageOwnerMatches } from "./message-owner.mts";
import type { SelectedOwner } from "../protocol-message-binding.mts";
import type { NodePaths } from "./config.mts";
import { getMessage, listInbox, type InboxRecord } from "./inbox.mts";

export type CodexInboxSelector = (refs: string[], owner?: SelectedOwner) => InboxRecord[];

// records: the daemon passes its inbox index (issue #487); each selected record is read again.
export function codexInboxRound(paths: NodePaths, records: InboxRecord[] = listInbox(paths.inbox)): CodexInboxSelector {
  const byTarget = new Map<string, string[]>();
  const rank = new Map<string, number>();
  for (const record of records) {
    rank.set(record.messageId, rank.size);
    const ids = byTarget.get(record.toSession) ?? [];
    ids.push(record.messageId);
    byTarget.set(record.toSession, ids);
  }
  return (refs, owner) => {
    const targets = new Set(refs);
    const ids = new Set(refs.flatMap((ref) => byTarget.get(ref) ?? []));
    const selected: InboxRecord[] = [];
    for (const id of ids) {
      const current = getMessage(paths.inbox, id);
      if (current && messageOwnerMatches(current, owner, [...targets])) selected.push(current);
    }
    return selected.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)
      || rank.get(a.messageId)! - rank.get(b.messageId)!);
  };
}
