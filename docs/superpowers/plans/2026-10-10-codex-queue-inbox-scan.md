# Codex Queue Inbox Scan Implementation Plan

> For agentic workers: use subagent-driven-development with one implementation writer and independent specification/quality review. Execute continuously under the existing solve, PR and green-merge authority.

**Goal:** Remove the measured repeated full-Inbox scans from Codex owner wake polling while preserving its routing and safety decisions.

**Architecture:** Capture one sorted full-record Inbox snapshot per synchronous Codex queue round and build an index by target reference. Keep the snapshot rank as the tie-breaker for equal `receivedAt` values. Re-read selected records before admission and discard records already deleted or readdressed at that read. The existing `readQueued` cleanup may still enumerate filename identities without reparsing unrelated records. The shared Inbox/Delivery-Core and Claude implementation remain unchanged; there is no cache across rounds.

**Tech stack:** Node TypeScript type stripping, node:test, existing synthetic Codex fixtures.

**Tracker:** https://github.com/CFcon-CH/kherep/issues/371

## 1. Regression before production code

Files: create `modules/control-plane/node/codex-queue-inbox.test.mts` and, if needed to keep files below 250 lines, a separate queue-round regression test. Use existing `codexNode`, `fakeCodexBin`, `recordCodexSession`, `storeMessage`, `pollCodexQueue`, and `codexQueueIdle` fixtures. Never launch a real runtime in tests.

- [x] Record many synthetic plain Codex owners with default permission, one task owner, and mostly unrelated accepted Inbox messages. Spy on the actual fixture filesystem calls. One real empty-target round takes one directory snapshot; a multi-owner round with accepted targets parses every unrelated JSON record exactly once, reaches the correct queue targets and leaves messages accepted after producer success. On the baseline the directory-snapshot assertion failed with 16 reads instead of 1.
- [x] Record an empty candidate round and assert no full Inbox-record snapshot. Existing filename-only note cleanup may still enumerate identities when prior decisions exist.
- [x] Inject a state transition after snapshot but before the targeted refresh: delivered, deleted and readdressed records must not queue. Check current depth too. Inject a new message after the snapshot: it must queue once in the next eligible round.
- [x] Exercise full IDs, legacy/current aliases, ambiguous aliases, task exclusion and oldest-first selection. Equal timestamps retain their original snapshot order across references. Preserve existing queue guards and slow/failing producer tests unchanged.
- [x] Run `node --test modules/control-plane/node/codex-queue-inbox*.test.mts`; record expected RED before production edits. Use filesystem spying only to count or create the concurrency window, never replace production routing/guard decisions.

## 2. Minimal Codex-only snapshot helper

Create `modules/control-plane/node/codex-queue-inbox.mts`. The intended contract is a round-local selector `(refs: string[]) => InboxRecord[]`. A concrete implementation basis is:

```ts
import type { NodePaths } from "./config.mts";
import { getMessage, listInbox, type InboxRecord } from "./inbox.mts";

export function codexInboxRound(paths: NodePaths): (refs: string[]) => InboxRecord[] {
  const byTarget = new Map<string, string[]>();
  const rank = new Map<string, number>();
  for (const record of listInbox(paths.inbox)) {
    rank.set(record.messageId, rank.size);
    const ids = byTarget.get(record.toSession) ?? [];
    ids.push(record.messageId);
    byTarget.set(record.toSession, ids);
  }
  return (refs) => {
    const targets = new Set(refs);
    const ids = new Set(refs.flatMap(ref => byTarget.get(ref) ?? []));
    const selected: InboxRecord[] = [];
    for (const id of ids) {
      const current = getMessage(paths.inbox, id);
      if (current && targets.has(current.toSession)) selected.push(current);
    }
    return selected.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)
      || rank.get(a.messageId)! - rank.get(b.messageId)!);
  };
}
```

- [x] Implement only after RED. Keep error propagation fail-closed; do not add retry, timeout, background-discovery, new configuration or persistent indexing.
- [x] In `codex-queue.mts`, return before snapshot creation when `candidates.length === 0`. Create the selector once for that round with a caught/logged snapshot error. Pass it into `queueFor`; replace its two `sessionInbox` calls with selector calls. Remove only the now-unused Codex queue import of `sessionInbox`.
- [x] Leave `readQueued` unchanged, including its existing-file-identity cleanup. Preserve policy, kill switch, permissions, app/TUI grant, reply depth, spacing, budget, attempts and in-flight order. Do not introduce a new delayed-lane authorization semantic.
- [x] Explain one full Inbox-record read and index per round, targeted state refresh, unchanged filename-only attempt cleanup and next-round handling of new arrivals in `docs/CODEX.md` beside existing original-owner queue documentation. No host/runtime inventories in the repository.
- [x] Run the new regression GREEN and the existing queue, intake-window, delivery and lifecycle functional tests.

## 3. Verification and integration

- [x] Run `npm run typecheck`, `npm run test:bootstrap`, focused tests and `git diff --check`. Typecheck and 88 focused tests pass. Final serialized local bootstrap: 477 total, 464 passed, 3 known Windows symlink EPERM failures, 10 skipped. Hosted Windows CI must pass; do not weaken tests or guards to hide the local limitation.
- [x] Inspect the complete diff. Only Codex queue code, its tests and relevant documentation changed. Independent specification, quality and simplifier reviews pass after ordering, test-isolation and documentation refinements. The coordinator independently reran the eight new tests and typecheck successfully.
- [ ] Commit with a neutral subject and configured noreply identity, without tracker prefix, skip-CI or AI attribution. Create a PR with `Closes #371`, concrete bottleneck/behavior and measured validation. Attach it to this task. Merge by rebase only after every required check is green and the reviewed head is unchanged.

## 4. Actual target acceptance

- [ ] Update the clean Windows daemon source to the exact merged identity and reuse the verified existing supervisor. Verify source bytes, one running instance, unchanged policy/configuration and supervisor definition. No broad installer or Claude change.
- [ ] Send one new unknown-value synthetic peer message to the existing authorized original desktop test owner. No native poke or resend after submission. Independently read its final response and receipt convergence; record send-to-receive and receive-to-native-turn delay.
- [ ] Coordinate the same exact source and passive Mac/cross-host acceptance with the existing Mac session. Source tests alone are not target acceptance.
- [ ] Publish anonymous evidence to #371 and #367, retain raw proofs locally, and clean only this completed worktree once its integrated result and evidence are recoverable. Preserve unrelated and unintegrated worktrees.
