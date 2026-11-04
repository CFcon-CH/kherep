# Native Queue Reconciliation Implementation Plan

> **For agentic workers:** Execute inline with the executing-plans skill. One writer owns this worktree; no commit, publication or live mutation is authorized in this implementation pass.

**Goal:** Retire an exact native Kherep pointer after every message it represents is confirmed delivered, before normal Stop returns.

**Architecture:** Retain the native per-message attempt ledger as the permanent duplicate barrier. Derive complete owner-bound queue groups from that ledger and reuse the public list/delete/readback cleanup algorithm with explicit candidates. Await reconciliation at normal Stop and after producer settlement; schedule bounded recovery in the existing queue poll. Legacy bindings remain untouched.

**Tech Stack:** Node.js TypeScript `.mts`, native filesystem records, experimental Codex app-server Queue API, node:test.

## Approved boundaries

Issue: https://github.com/CFcon-CH/kherep/issues/410. `accepted` and `offered` never authorize deletion. Require exact owner, queue ID, input, complete delivered batch and unchanged captured local producer identity. Keep attempts after cleanup. Never resume, interrupt or modify permissions, profiles, Worker behavior, Composer preferences or foreign/legacy cards. Native calls in this worktree are synthetic tests only.

The actual producer's 0.161.0 experimental schema confirms `thread/queue/list` and `thread/queue/delete`; delete takes `threadId` and `queuedSubmissionId` and returns `deleted`. A complete post-read must confirm absence. Already-started queues and admission whose ID arrives after Stop remain outside an absolute no-empty-turn guarantee. No global lock is introduced.

## Implementation sequence

- [x] Baseline: run existing native producer, owned cleanup and Stop tests. Inspect a clean baseline before production changes.
- [x] RED: add a normal-Stop regression using real Inbox confirmation and a synthetic cleanup boundary. Expect cleanup to observe `delivered` and finish before the hook returns; baseline ignores it.
- [x] Add `codex-native-attempts.mts`: validate bounded complete attempt snapshots, form groups, include full batch IDs/input for new records, retain malformed/partial/uncertain groups. Keep per-message attempts permanently; separate reconciled receipts prevent repeat work.
- [x] Adapt `codex-queue-cleanup.mts` narrowly to accept explicit candidates and a retirement callback; preserve existing legacy defaults/tests. Reuse exact-ID, full-input, complete-pagination and delivery recheck gates.
- [x] Add `codex-native-reconcile.mts`: reconstruct/revalidate captured producer identity, invoke existing public client with bounded deadline, and retire only native groups after readback. Reuse the connector without changing its public methods.
- [x] Wire normal Stop in `deliver-hook.mts`, producer late-settle in `codex-queue-producer.mts`, and bounded recovery in `codex-queue.mts`. Retain existing admission guards and turn accounting.
- [x] GREEN: test complete/mixed batches, offered/abort, foreign/input/identity mismatch, v1 partial records, late settle, restart, new arrivals, already absent/delete false, pagination and deadline. Native operations use fake clients only.
- [x] Update `modules/control-plane/README.md`, `codex/ARCHITECTURE.md`, root README and `docs/CODEX.md` to describe actual lifecycle and race limits.
- [x] Verify `npm run typecheck`, `npm run test:bootstrap`, focused Control Plane and Codex suites. Inspect final diff. Return review evidence without commit/deploy.

## Functional acceptance

Normal active case: exact queued pointer exists, Receive offers its content, Stop confirms delivery, cleanup removes that exact pointer and verifies absence before returning. New messages retain their own queue/inbox state. Idle production behavior stays unchanged. Interrupted/offered messages keep their pointer. A late producer result triggers reconciliation only after confirmed delivery. Recovery is bounded and never creates a model turn.

Root owns independent review, live Windows/Mac canaries, commit and integration. Synthetic tests establish code behavior, not delivery to a host.

## Verification record

- Baseline focused checks: 27 passed before production changes.
- RED: normal Stop returned without awaiting reconciliation. Two additional RED regressions exposed enrollment revocation during list and premature retirement of an absent partial v1 group. All three now pass.
- Final typecheck: passed. Final focused Control Plane/Codex checks after the reviewed behavior-preserving simplification: 389 tests, 358 passed, 31 skipped, zero failures.
- Required bootstrap run: 490 tests, 477 passed, 10 skipped, three reported failures (two unchanged Windows symlink EPERM cases and their parent). Root independently reproduced both symlink failures on clean baseline `d144d24` with OS TEMP outside the policy workspace and Git Bash on the process PATH.
- Broad Codex run: 475 tests, 466 passed, four skipped, five failures in existing shared-guard installation and hook replay tests. A bounded rerun of the two affected files with isolated OS TEMP outside the managed workspace passed all four previously failing shared-guard cases: five tests passed and only hook replay remained failing. Root independently reproduced that remaining replay assertion on clean baseline `d144d24` in the same corrected environment. No guard, test, permission or persistent configuration changes were made; no further full-suite rerun was started.
- Independent specification and quality review reported no important findings. Accepted simplifier feedback was applied and rechecked with typecheck and the focused suite. Final diff whitespace check passed.

The remaining broad-suite failures are recorded rather than treated as passing acceptance. No live queue mutation, commit, publication or deployment occurred. Public Queue deletion versus a concurrent native turn claim remains an API-level UNKNOWN; the normal synthetic Stop path does not establish an absolute no-empty-turn guarantee.
