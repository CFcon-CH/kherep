import { releaseReconciledRouteQueue } from "./target-delivery-queue.mts";
import { readTargetRecord } from "./target-delivery-files.mts";
import path from "node:path";
import { readConfig, type NodePaths } from "./config.mts";
import { releaseNativeOwner } from "./codex-native-pending.mts";
import { getMessage } from "./inbox.mts";
import { nativeQueueGroups, retireNativeQueue } from "./codex-native-attempts.mts";
import { connectNativeQueue } from "./codex-native-queue.mts";
import { cleanupOwnedQueues, sameIdentity, NativeQueueShutdownError } from "./codex-queue-cleanup.mts";
import { isDirectNativeQueueIdentity, queueProducerIdentity } from "./codex-queue-context.mts";
import { retainServiceAdmission, waitForServiceAdmission, type ServiceAdmission } from "./service-drain.mts";

export async function reconcileNativeQueues(paths: NodePaths, owner: string,
  options: { open?: typeof connectNativeQueue; timeoutMs?: number } = {}, admission?: ServiceAdmission): Promise<void> {
  await waitForServiceAdmission(paths, async active => {
    try { await reconcileAdmitted(paths, owner, options); }
    catch (error) {
      if (error instanceof NativeQueueShutdownError) retainServiceAdmission(active, error.whenStopped);
      throw error;
    }
  }, { admission });
}

async function reconcileAdmitted(paths: NodePaths, owner: string,
  options: { open?: typeof connectNativeQueue; timeoutMs?: number }): Promise<void> {
  const config = readConfig(paths.config);
  if (!config) return;
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  const groups = nativeQueueGroups(paths, owner).filter((group) => group.admissionMessageIds.every((id) => {
    const record = getMessage(paths.inbox, id);
    return record?.messageId === id && record.toSession === owner && record.state === "delivered";
  }));
  const checked = new Set<string>();
  for (const group of groups) {
    if (Date.now() >= deadline) return;
    const key = JSON.stringify(group.producer);
    if (checked.has(key)) continue;
    checked.add(key);
    const identity = queueProducerIdentity(group.producer.codexExecutable, ["app-server", "--listen", "stdio://"],
      {}, process.env, deadline);
    if (!isDirectNativeQueueIdentity(identity) || !sameIdentity(group.producer, identity)) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await cleanupOwnedQueues(paths, identity,
      (opened) => (options.open ?? connectNativeQueue)(identity, { requestTimeoutMs: Math.min(2_000, remaining), opened }),
      { owner, timeoutMs: remaining, candidates: groups,
        authorized: () => readConfig(paths.config)?.nodeId === config.nodeId,
        retire: (binding, matchedInput) => {
          // Legacy membership is complete only when the actual fixed pointer count matched.
          if (!matchedInput && !groups.find((item) => item.queuedSubmissionId === binding.queuedSubmissionId)?.batchRecorded) return false;
          retireNativeQueue(paths, binding);
        } });
  }
  const saved=readTargetRecord(path.join(paths.dir,"codex-native-pending",`${owner}.json`));
  if(saved && typeof saved==="object" && (saved as {version?:unknown}).version===3) releaseReconciledRouteQueue(paths,owner);
  else releaseNativeOwner(paths, owner);
}
