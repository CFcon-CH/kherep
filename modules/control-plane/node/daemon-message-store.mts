import type { MessageDeliverBody } from "../protocol-messages.mts";
import type { NodePaths } from "./config.mts";
import { deliveryDepth } from "./exchange.mts";
import { storeMessage } from "./inbox.mts";
import { RecordLockBusy } from "./inbox-record-lock.mts";
import { settleReplied } from "./sent-notices.mts";

// Shared by the daemon and its real-record-lock regression test.
export function storeDaemonMessage(paths: NodePaths, body: MessageDeliverBody, now: number,
  storageFault: () => void, log: (line: string) => void): void {
  try { storeMessage(paths.inbox, body, now, deliveryDepth(paths, body)); }
  catch (error) { if (!(error instanceof RecordLockBusy)) storageFault(); throw error; }
  settleReplied(paths, body, now, (error) => log(`kherep-node: could not record ${body.inReplyTo} replied: ${String((error as Error).message ?? error)}`));
}
