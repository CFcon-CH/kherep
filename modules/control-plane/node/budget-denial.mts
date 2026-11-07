import { blockerDiagnostic } from "../protocol-diagnostics.mts";
import { inspectBudgetHold, type Budget } from "./autonomy-budget.mts";
import type { NodePaths } from "./config.mts";
import { progressRecords } from "./delivery-progress.mts";
import type { InboxRecord } from "./inbox.mts";
import type { TurnBudget } from "./policy.mts";

// The progress of a takeTurn denial, for a daemon-owned producer: spacing and
// lock contention retry next round; exhaustion waits until the ledger's release.
export function publishBudgetDenial(paths: NodePaths, records: InboxRecord[], sessionId: string, budget: Exclude<Budget, "ok">,
  now: number, limits: TurnBudget): void {
  if (budget !== "exhausted") {
    progressRecords(paths, records, "waiting", "retry-pending", now, undefined,
      blockerDiagnostic(budget === "spacing" ? "turn-spacing" : "budget-lock-unavailable", now));
    return;
  }
  const hold = inspectBudgetHold(paths, sessionId, now, limits);
  progressRecords(paths, records, "waiting", "budget-exhausted", now, hold.kind === "exhausted" ? hold.retryAt : undefined);
}
