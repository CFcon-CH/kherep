# Codex hook starts

Issue [#386](https://github.com/CFcon-CH/kherep/issues/386) compares the public
`main` at `87c317b2f88ecf689d7fb5f82bbd3bdbbdfb820f` with the shell dispatcher.
The reported Desktop total of 846 runs has no per-hook attribution. It does
not establish a loop, and these synthetic savings cannot be extrapolated to
that total.

## Reproduce the comparison

Use the repository's supported Node runtime and Git, from the checkout:

```sh
node codex/scripts/hook-run-baseline.mts --before /tmp/hooks-before.json
node codex/scripts/hook-run-baseline.mts /tmp/hooks-after.json
node --test codex/scripts/hook-run-baseline.test.mts
```

Choose writable output paths on Windows. The before command needs the named
base Git object; a shallow checkout must fetch that object first. The frozen
predecessor render has an independently pinned SHA-256 from the original Git
source. The before runner reads the original adapter, post-edit dispatcher
and context hook with `git show`; unchanged guard and Intercom sources come
from the checkout. Run the comparison on this change before modifying those
dependencies.

The runner creates and deletes an isolated synthetic workspace, Git repository,
owner, inbox packet and hook directory. It never executes the proposed commit,
deployment or branch-switch commands. It invokes every matching configured
hook with JSON input, then performs a real local Intercom Receive and Stop
confirmation. A Node preload records successful child starts, identifying
executables and scripts without recording arguments. Every JSON row identifies
the fixture event, hook, child processes, stdout bytes and elapsed time.

Counts cover hook command roots and their process descendants. Fixture setup
and the explicitly invoked Receive CLI are outside that count. Node and Git
children are included; native Bash/PowerShell launchers and Desktop internals
are unmeasured. Commands run serially rather than through Desktop's scheduler.
Timing includes instrumentation and startup. Stdout bytes include protocol
JSON as well as context, rather than measuring model tokens.

## Results

The same fixture covers a shell lookup, an Edit, allowed/denied commits,
read-only/denied/explicitly approved deployment, allowed/denied checkout,
denied private-path access, two prompts, empty Stop, empty Intercom return,
message-bearing return, Receive and confirming Stop. The baseline was captured
before production edits; the before runner reproduces its counts.

| Event | Hook commands before / after | Node processes before / after | All counted processes before / after | Stdout bytes before / after |
| --- | ---: | ---: | ---: | ---: |
| PreToolUse | 42 / 18 | 76 / 52 | 82 / 58 | 1,692 / 1,692 |
| PostToolUse | 11 / 11 | 27 / 15 | 27 / 15 | 174 / 174 |
| UserPromptSubmit | 6 / 6 | 6 / 6 | 6 / 6 | 5,152 / 4,704 |
| Stop | 6 / 6 | 6 / 6 | 6 / 6 | 0 / 0 |
| **Total** | **65 / 41** | **115 / 79** | **121 / 85** | **7,018 / 6,570** |

This saves 24 actual hook commands (36.9%), 36 processes (29.8%) and 448
stdout bytes. The two Maestro turn reminders each save 224 bytes. All reminders
remain injected on every prompt; research and the session-bound receive recipe
are retained across compaction and restart.

Three alternating before/after pairs on Linux with Node 24.19.0 recorded
9.48–10.31 seconds before and 6.83–7.48 seconds after; medians were 9.57 and
7.05 seconds. These are instrumented serial replay times with other repository
tests running, not an isolated latency benchmark or native Desktop timing.
The earlier quieter pairs recorded medians of 8.90 and 6.70 seconds. Process
and command counts were identical in every pair; elapsed-time savings depend
on host load and native scheduling.

| Hook or invocation | Commands before / after | Processes including descendants before / after |
| --- | ---: | ---: |
| Privacy adapter and guard | 10 / 10 | 20 / 20 |
| Commit adapter and guard | 8 / 0 | 16 / 0 |
| Deploy adapter and guard | 8 / 0 | 16 / 0 |
| Checkout adapter and guard | 8 / 0 | 22 / 0 |
| Attribution command (pre and post) | 11 / 3 | 11 / 3 |
| Shell dispatcher, all three guards, pre attribution | 0 / 8 | 0 / 38 |
| Post-edit dispatcher and watchers | 4 / 4 | 20 / 8 |
| Intercom delivery hook | 8 / 8 | 8 / 8 |
| Maestro turn context | 2 / 2 | 2 / 2 |
| Research-first | 2 / 2 | 2 / 2 |
| Research-stop | 2 / 2 | 2 / 2 |
| Acceptance gate | 2 / 2 | 2 / 2 |

The guard children remain in the shell-dispatcher row. In the fixture, each
shell PreToolUse changes from five commands to two (independent privacy plus
dispatcher), saving three adapter/attribution roots. Each normalized Bash
PostToolUse still runs its three native commands, but skips four watcher
children that already reject Bash. The direct Edit still starts all watchers.

## Functional evidence

The replay asserts the same allow/deny decisions before and after. Separate
installed-command tests exercise commit and deployment guards, protected main
checkout and linked-worktree/file-checkout exceptions. Existing privacy patch
tests remain applicable because privacy wiring and normalization are retained.
Dispatcher tests prove all guards and attribution still run after a deny, the
original attribution owner is recorded, and deployment normalization strips
the transcript while retaining explicit PowerShell approval.

Missing, empty, syntactically broken, unsuccessful, signalled and timed-out
shell guards, a missing adapter, malformed input and unsupported guard output all return a native JSON
deny with exit 0. Installed integrity tests restore the guard and its imported
dependencies. Exact managed upgrades preserve custom groups and existing
trust bytes, refuse drift and never mint trusted hashes.

The Intercom replay asserts empty-return silence, a metadata-only native
PostToolUse hint, accepted state before Receive, actual body retrieval and
offered state during the same turn, and delivered state at normal Stop. The
hint works with a full autonomous-turn ledger and leaves its bytes unchanged.
The busy-ticket, delivery and autonomy suites separately cover the absence of
native queue submission and the retained budget for real continuations
(PR #385). The independent return-point consumer remains configured; its
wildcard matcher is necessary for supported native tool boundaries.

Issue #503 routes the eleven Control Plane hook runs of this fixture through the stable entry point `codex-control-plane-hook.mts`, which starts the hook as its one Node child: one extra Node process per such run (79 + 11 Node processes, 85 + 11 counted processes after the change). The hook commands and stdout are unchanged in number.

## Host acceptance

**Native Desktop measurement is untestable in this Linux cloud session.**
Source/configuration tests do not prove active native trust, event matching,
PowerShell launcher counts, concurrent scheduling, queue-card presentation or
Desktop latency. Live installation, permission changes and merge require
separate authorization.

After an authorized host update, limit acceptance to one disposable workspace
and one original-owner Desktop turn:

1. Inspect an isolated candidate and its receipt against this PR. Preserve
   operator settings and the backup. Review the changed shell definition in
   `/hooks` and restart the affected native owner; unchanged trust bytes alone
   do not activate a changed command. Since issue #507 part 4 the Atlassian
   destructive, dispatch-contract and Playwright entries changed as well and
   do not run until they are trusted there; the installer prints one line
   saying so when it replaces the managed hook block.
2. Use a synthetic Git repository under that workspace. Record starts by
   event and exact hook command for one benign shell lookup and one Edit,
   comparing the pre-change candidate with the new candidate. Expect three
   fewer PreToolUse commands per matched shell call, four fewer post watcher
   children per normalized Bash item, and all four watchers for Edit. Record
   launcher processes separately and retain unhidden Hook-Runs counters.
3. Exercise synthetic private-path, forbidden commit-trailer and protected
   main-checkout inputs, plus allowed counterparts. For deployment denial,
   use a fake `kubectl` on the disposable fixture's PATH so an unexpected
   allow cannot reach infrastructure. Verify denial at the native permission
   boundary, including the Windows command form on a Windows host.
4. At one supported tool-return boundary, first check an empty inbox, then
   admit one fresh, bounded synthetic peer packet. Observe exactly one hint
   in the running original turn, with no peer body or native queue card. Use
   the existing receive recipe to retrieve it before final; normal Stop must
   confirm delivery. Compare the autonomous-turn ledger before/after the hint;
   it must not change. Check that the original turn identity stays the same.
5. Record pass/fail/untestable results, native command/process counts and
   timings without collecting private sessions or credentials. A missing
   boundary or untrusted hook is an incomplete acceptance, not a passing run.

Stop after this sequence. A long session or a new global counter total is
outside this bounded acceptance and cannot attribute the original 846 runs.

### Denied calls of delegated workers (issue #504)

Bounded, one disposable workspace per host, results recorded on #504 and
#537, never with real private data:

1. Claude in auto mode (macOS, Windows): one `general-purpose` worker whose
   brief asks it to `Read` a synthetic path carrying a private marker term,
   which the privacy guard denies, and to hand back. Record that the journal
   has the `call` line with `<withheld>`, that the `delivered` line exists
   after the handback, that the completion notification carried the agent
   ID, that this ID is the hook payloads' `agent_id`, and that `render`
   prints `DENIED-CALLS: 1` with `status: delivered`. Then one worker with
   no denial, which must read `none`, and one whose journal directory is
   made read-only before the deny, which must read `unknown
   (capture-failed)` or `unknown (journal-missing)`, never `none`.
2. Codex Desktop: one `spawn_agent` worker with the same synthetic deny.
   Record whether the child `PreToolUse` payload carries `agent_id`, and as
   the candidate capture key the rollout thread of the child `PreToolUse`
   `transcript_path` against the `SubagentStop` `agent_transcript_path`.
3. Record pass, fail or untestable per item. Codex stays `unknown
   (journal-missing)` until item 2 yields a key.
