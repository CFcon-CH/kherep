# Changelog

All notable changes to Kherep are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.y.z`, a release that breaks a documented interface
increments the minor version; every other release increments the patch version.

## [Unreleased]

### Removed

- The stale pin `@openai/codex@0.152.1` in `bootstrap/manifest/npm-globals.txt`
  (#907). The node finds `codex` through `PATH` and its fallback directories:
  the standalone installer's `~/.local/bin/codex` on macOS, the Codex app's
  `codex.exe` on Windows. A full install no longer downgrades an existing npm
  copy to 0.152.1 and does not install or remove one. Operator action: none
  required; an npm copy that nothing uses can be removed with
  `npm uninstall -g @openai/codex` once another `codex` is on `PATH`.

### Fixed

- Regular expressions with super-linear backtracking (#906): the 49 sites
  SonarQube flags with `typescript:S8786`, among them the secret-output and
  clq-accept guards, the hook inventory, the Codex hook-integrity and
  research parsers, the Confluence brokers and the node's service probes,
  now run in linear time. Results are unchanged, pinned by new tests recorded
  from the previous code; one unobservable case changes in `capability-check`
  (a `name:` followed only by whitespace yields `""` instead of one blank).
  Inputs that took the old forms seconds, for example a 3 002-character line
  in `doctor-hooks` at 7.3 s, now take milliseconds.
- `RunLock.release()` in the integrity heartbeat returns nothing instead of
  an always-empty string, and the gap-recording `node --check` test asserts
  its run (#906).
- No object literal serves as a default parameter any more (#912): the four
  sites SonarQube flags with `typescript:S7737` in the public export walk, the
  Confluence evidence test harness, the service supervisor's runtime check
  and the Windows service stop build their object per call or take it from
  the caller. Behavior is unchanged.
- An idle Codex app thread no longer stays `reachable-probable` when the app
  writes a record that starts no turn more than 30 seconds after `Stop`, such
  as a sub-agent completion or a `thread_settings_applied` record; a queued
  message then waited in `awaiting-user-turn` until the operator typed in the
  thread. For such a late write the Codex liveness source now reads the held
  rollout's tail backwards to the boundary (at most 1 MiB, record types and
  timestamps only, nothing logged) and stays UNKNOWN for a turn start, any
  unlisted record or an unreadable tail (#911). Operator action: none.

## [0.5.0] - 2026-11-13

Messages now reach running and idle Claude Code and Codex sessions without
operator input, and `msg status` says why one waits (#706, #883). Hooks fail
closed on both runtimes and repair themselves under a lock (#507). The node
service records failures and gains `service recover` (#838). New: team model,
worker brief revisions, evidence tools. Retired: closed-session resume, the
Codex fork proxy, `kherep-twg`, the Codex plugin and `usage-watch`.

### Added

- Team model (#761). Every session on every node and runtime gets two role
  texts, `kherep-lead` and `kherep-team-lead`, with the chain of command
  operator -> lead -> team leads and one message contract (PACKAGE, REPORT,
  PACKAGE-CLOSED, QUESTION, ANSWER, HANDOVER; eight STATE values). Claude
  installs `claude/agents/kherep-*.md` through the file manifest and model
  policy; Codex projects its own `codex/agents/kherep-*.md` into
  `agents/kherep-*.toml`. Both ROUTING files gain a "Team model" section,
  and `bootstrap/team-profile-parity.test.mts` keeps the two runtimes on the
  same contract. When the operator moves the
  `kherep-lead` slot to another session, the Worker writes
  `ROLE CHANGED: lead -> team-lead` (with `NEW-LEAD:`) to the previous lead and
  `ROLE CHANGED: team-lead -> lead` (with `PREVIOUS-LEAD:`) to the new one, from
  `operator` / `control-plane`, audited once as `intercom.slot-notice`. A
  conflict, denial, replay, first assignment, the same session again and the
  runtime slots write none; a storage failure rolls the slot change back. The
  operator API refuses the Access actor `control-plane`. `msg inbox` names the
  sender `control plane (slot change)`; an older node shows a peer-style block.
  Takes effect after a Worker deploy and a node upgrade.

- `kherep-node service recover` (#810, #838). It starts the installed managed
  service again after a failed upgrade left the node off or a retained drain
  blocked it. Without `--confirm` it prints evidence only (`canRecover`, a
  fixed refusal `reason`, drain, definition, daemon, pin, plan and the last
  failure) and changes nothing. With `--confirm` it is a strict subset of
  `service upgrade` to the installed commit: no new source, no definition or
  receipt write. It refuses definition drift (use `rollback`), a recorded
  candidate, an active or unknown drain, a live or unowned daemon outside the
  stopped service and an unverifiable pin, and keeps the drain after any
  failure that follows a native effect. Nothing releases a retained drain
  automatically.

- Managed service failure records (#838). A failed Windows upgrade or rollback
  names the PowerShell call that failed in a validated `native` object (call,
  outcome `timeout|exit|spawn|output`, exit status, elapsed time, limit, reason
  code), never native output, paths, pids, task names or SIDs. Every failed
  upgrade or rollback writes the display-only `service/last-failure.json`
  (mode 0600), which the next success removes. `service status` shows it as
  `lastFailure` and reports `node: running|off|drain-blocked`; the new
  `managedService` doctor check reports the same state and names
  `service recover`. No decision path reads the record.

- Codex liveness source for the daemon (#706, #899). With
  `wake.nativeQueue: true` the daemon finds, once per listing tick, which live
  `codex` process holds a thread's rollout (macOS `ps`/`lsof`, Windows Restart
  Manager). A held, idle thread reads `idle-loaded`, so the native
  `codex queue` route admits messages again; a refusal shows
  `awaiting-user-turn`. Nodes without `nativeQueue` run no probe. The delivery
  hook also records `Interrupt` and `SessionEnd`; the installer does not yet
  add those two hook groups. On Windows, a probe with two or more candidate
  rollouts no longer fails as a whole: each path is its own literal, a failing
  Restart Manager call leaves only its thread UNKNOWN, and the daemon log names
  a probe problem once when it changes and once when it recovers. The fixed
  Windows script is not yet measured on a Windows node.

- Wake names that survive renames (#828). A name in `wake.sessions` binds to
  the session whose full id is listed with it and then follows that id through
  a rename; damaged binding history refuses the name instead of guessing.
  Bindings start without a liveness source, and Claude background sessions
  (whose `claude agents` row carries `state` instead of `status`) are listed,
  so bindings start in production. Claude prompt and tool hooks show up to
  five fixed session rename data lines per output with a byte-bounded overflow
  summary; hints never retry or wake a session.

- Module label guard (#833). `module-label-guard` (Claude and the Codex shell
  dispatcher) blocks `gh issue create` and `gh pr create` without a module
  label in a repository that commits `.github/module-labels.json`, and when
  that file is invalid; a repository without the file has no rule. `--web`,
  `--help` and a visible `KHEREP_MODULE_LABEL=none` pass. The GitHub broker
  accepts `labels` on `issue.create` and verifies them on readback; a
  `moduleLabels` entry in `policy.json` refuses a create without a listed
  label (`label-required`).

- GitHub App issue broker (#732): fixed Claude and Codex entry points, strict
  public-repository operations, local signing, scoped installation tokens and
  durable receipts for uncertain outcomes. Disabled by default; live identity
  acceptance is separate.

- Worker brief revision (#701). A brief to a code-bound worker
  (`kherep-builder`, `dc-plugin-build-runner`, or any dispatch whose brief
  declares `revision:`) carries `revision: <name>@<sha>` per repository
  (`<name>@<base>..<head>` for a review, `-dirty` for uncommitted changes) and
  `decided: <decision>` or `decided: none`. Both dispatch guards deny a missing
  marker on a code-bound role, a malformed token and an empty `decided:`
  (`WORKER_BRIEF_FORMAT`); a brief that mentions a review without `revision:`
  gets a notice (`WORKER_BRIEF_REVISION`). The guards read no git state. Codex
  refuses a code-bound dispatch when the installed lib is missing. Builder and
  DC build runner receipts gain `REVISION:`, and both ROUTING files name the
  fields and the Maestro's `Revision:` receipt line.

- Denied calls in delegated worker reports (#504, #700). The guard dispatcher
  and the hook runtime entry journal each guarded call of a delegated Claude
  worker to `<CLAUDE_HOME>/.cache/denied-calls/<agent_id>.jsonl`: tool, worker
  type, target class, and per denying guard its tag and the first violation of
  its reason, not the guard's header (#700). Paths are reduced to basenames
  and private matches to `<withheld>`. Writes are asynchronous, capped and
  never change a decision; a lost write leaves `<agent_id>.failed`, and that
  marker is now awaited until each writer's deadline so it is on disk when the
  hook exits (#612, #614). The Codex shell dispatcher flushes its output
  before it exits, so a stuck marker cannot hold a completed deny until the
  native timeout (#621). The Maestro reads a worker's list with
  `hooks/denied-calls.mts render <agent_id>`, which prints
  `DENIED-CALLS: none | <n> | unknown (<code>)` and exits 3 on `unknown`.
  Codex captures too, but documents no `agent_id` on a child's `PreToolUse`,
  so every Codex worker reads `unknown (journal-missing)` until a child key is
  measured (#537). Explore and Plan workers read `unknown (no-agent-id)`.

- Observation handback checks (#555, #571). Since Claude Code v2.1.271 an
  auto-mode subagent reports through `SubagentHandback`. The new `PostToolUse`
  hook `obs-handback-record.mts` checks a `claude-obs` report where it is
  delivered, and `obs-result-check.mts` reads that verdict first, so it no
  longer blocks a delivered report or passes a wrong one. The new `PreToolUse`
  guard `obs-handback-gate.mts` refuses a handback whose first non-empty line
  is not exactly one valid `OBS-RESULT` line, once per agent id; a second
  malformed handback is delivered and reported. Each adds one hook group; an
  existing dispatcher entry under that matcher is replaced and logged. Codex
  is unchanged.

- Fail-closed Claude hooks (#507, parts 1 and 2). The five `PreToolUse` groups
  each run one `hooks/guard-dispatch.mts` entry that starts the group's guards
  in parallel. A guard that is missing, empty, outside the hooks directory,
  killed, still running after 10 s, exiting with a code other than 0 or 2, or
  printing anything other than a decision now denies the tool call, and the
  reason names the file; before, most of these let the call through. Working
  guards combine as deny > ask > allow. Every managed Claude hook now starts
  through `kherep/hook-runtime/entry.mts`, which coordinates hook processes
  and integrity repairs through `<real hooks>/.kherep-integrity/run.sqlite`.
  A repair is recorded before its first byte is written and replayed by the
  next process when its writer died. The heartbeat
  `.cache/hook-integrity/heartbeat.json` is written only after a final
  read-only check. The dispatcher re-checks integrity when the heartbeat is
  older than 30 minutes or missing or a guard could not run, and reports the
  result as context, never as a decision. For `PreToolUse` every runtime
  failure is a deny. Operator action: a recorded repair whose target an
  outside writer replaced stays refused until the operator runs
  `kherep/hook-runtime/replay-pending.mts` (`inspect`, then `replay`). Limits:
  the entry cannot check itself; Windows DACL preservation and whether a
  session shows the notice are UNVERIFIED.

- Fail-closed Codex hooks (#507, parts 3 and 4). `codex-hook-adapter.mts`
  denies a `PreToolUse` call on the same failures (a printed `ask` included)
  and answers at least 1.5 s before its 10 s hook timeout.
  `codex-hook-integrity.mts` runs under the SQLite lock
  `<CODEX_HOME>/.cache/hook-integrity/run.lock.sqlite` and writes the
  heartbeat only after a read-only check; the adapter re-checks after its
  guards when the heartbeat is stale or a guard could not run. The three
  guards that still ran directly (`atlassian-destructive-guard`,
  `codex-dispatch-contract-guard`, `playwright-file-guard`) now run through
  the adapter, and the adapter and the shell dispatcher check each other
  against the last proven integrity run. Operator action: Codex marks these
  three hook definitions for review and skips them until they are trusted in
  `/hooks`; until then those three guards do not run. The installer prints one
  line saying so. `docs/CODEX.md` lists every Codex hook group with its
  fail-closed status. Whether Codex shows the notices is UNVERIFIED.

- Hook upgrade and integrity hardening (#507, #521, #524, #525, #620). The
  upgrade replaces raw managed commands with their entry form, unwires the old
  direct guard entries and legacy raw `~/.claude` watcher commands, and logs
  each one (`hooks: unwire ...`); `umlaut-translit-watch` becomes a managed
  hook. `drift-check.sh` reports a dispatcher entry whose guard is missing or
  retired as `DANGLING-HOOK`. The settings render prints
  `hooks: keep ... (uncoordinated, blocks live-hook-integrity)` for a kept
  command that runs `hooks/` code outside the runtime entry (#525). A
  coordination database the process cannot write now refuses writers instead
  of granting a hollow hold, failures name what happened, and the
  dispatcher's last-resort deny is a fixed text (#521). A missing hook file is
  published through a second name in the hooks directory and refused when its
  directory or staging file changed; a target on another volume is no longer
  repaired. Imports of a linked hook resolve from the real file (#524). Two
  integrity runs that start together retry a busy lock three times (#620).

- Brain drainage and the evidence verb (#517, #519, #687, #693, #695). The
  manually invoked `brain-drainage` skill is installed for Claude and Codex.
  Its scanner, `<broker> drainage --space <key> --metadata-approved`, uses GET
  only and reports candidate rows without titles or body excerpts; nothing is
  applied automatically. Both update CLIs accept `update --expected-version
  <n>` and refuse on a missing or mismatched version (#517). Both Confluence
  brokers gain the read-only `evidence` verb (`prepare`, `decide`, `verify`,
  `report`, `record`) for an operator-requested confirm path that measures an
  `evidence-assumed` page against its primary source under fixed promotion
  gates; human-assigned status is never relabelled, and measurement blocks
  never count as the page's own content (#519, with #650, #662, #666).
  `decide` accepts confirmed pages: a contradiction at a newer revision only
  supersedes, and a holding measurement is the new outcome `holds`. New
  refusals `revision-not-newer`, `superseded-needs-contradiction` and
  `page-already-decided`, which replaces `page-not-assumed` (#695). A `code`
  page without a binding can be superseded through a same-space page that
  binds the contradicting revision (`superseded-page-not-bound`,
  `superseded-page-not-current`) (#687). A Revision line may name the paths a
  finding rests on (`Revision: <name>@<sha> -- <path>`), and
  `drainage --repo-root <checkout> [--ref <ref>]` reports `revision-stale`
  pages (#693).

- Commit binding for code-bound observations (#505). A finding about
  repository code is `confirmed` only when the brief names each repository as
  `<name>@<full commit sha>` measured on a clean tree; otherwise it is filed as
  `assumed`, and the page carries a `Revision:` line. Both dispatch guards
  report a missing binding as a notice, never a deny. The Codex result check
  rejects a `confirmed` candidate without a full-SHA `Revision:` line.

- Topic-judged linking (#736). `related` and `stitch` search with the title
  plus the finding sentence (`--topic`) inside the space
  (`twg rovo search --space`, twg 1.3.8 or later). The broker no longer
  decides a link: `stitch --id --topic --out` lists candidates and writes a
  receipt, the observation agent judges each, and
  `stitch --id --candidates --decisions` writes only the approved targets. The
  Codex adapter gains the read-only `related_candidates` tool and a required
  `links` key per finding (`links-refused`). Removed: `selectRelated`, the
  title-term write path, `stitch --dry-run` and `related --parent`.

- Message diagnostics (#493). `GET /api/messages/summary?from=<node id>`,
  behind the existing Access JWT check, returns counts of one sender node's
  Registry rows by state, deletability, settlement and age; no ids, times or
  text. The daemon's round counters line lists the eight most frequent frame
  kinds from a closed list, and the `disconnected` line reads
  `disconnected (<code>, clean=<true|false>, error:<class>)`.

- Weekly usage recorder (#748). The status line hands the documented
  `rate_limits.seven_day` window to a detached recorder,
  `hooks/usage-record.mts`, which caches it under `.cache/usage-watch/` and
  shows one notification per condition per reset window: at 50 % of the
  weekly budget, or when usage runs at least 5 points ahead of the elapsed
  window after 10 % of it. Windows shows a toast, macOS a notification through
  `osascript`. `KHEREP_USAGE_TOAST=0` turns the toast off. The per-prompt
  `usage-watch` hook added with it is removed again (#774, see Removed).

- Versionless Codex role policy (#509). Astra designs, SOL builds, Terra
  handles support and research, Luna handles observations and brokers.
  Installation resolves available models into native agent TOMLs and one
  dispatch snapshot; an ordinary reinstall keeps that resolution, and
  `--refresh-models` refreshes it.

- Codex routing-only updater (#707): exact predecessor and current byte
  checks, isolated backup receipts and verified rollback without a full
  installation or model refresh.

- Pull request commit policy check (#506). The CI job `commit-policy` runs
  every commit of a pull request through the versioned `commit-msg` hook, so a
  commit made with `--no-verify` is still checked. The caller's `KHEREP_*`
  variables are dropped, which closes the `KHEREP_WORK_ITEM=none` escape
  hatch. Exit 2 (an unreadable range or hook) is never a pass.

- Documentation: `docs/HOOKS.md` lists every wired hook of both runtimes and
  the Git hooks, kept complete by `bootstrap/hooks-reference.test.mts`; the
  README hook statements are corrected (#587, #588).
  `docs/CENTRAL-BRAIN-READING.md` states the measured reading rules for the
  Central Brain (#679).

- `npm run test:route -- --base <ref>` (#832): one Windows test route that
  runs identically defined suites on the candidate and on the base and exits 0
  only when every base pass is accounted for and nothing fails only on the
  candidate; exit 1 new failures, exit 2 no verdict. `CONTRIBUTING.md` lists
  its limits.

### Changed

- Closed-session resume is retired (#889, operator decision of 2026-11-12).
  A message for a closed session is no longer resumed, handed over or started
  in an intercom session of its sender, whatever `messaging.resumeClosed`
  says. Such a message, also one for a slot whose occupant is closed, stays
  `accepted` and is refused as undeliverable by the existing listing rule. The
  key is still read without error and has no effect; `kherep-node doctor`
  reports a written key as `"resumeClosed": "retired"` without failing.
  Intercom sessions started earlier are not stopped and no stored state is
  deleted. `node/codex-app-delivery.mts` is removed.

- The Codex fork reply proxy starts no new attempts (#890, operator decision
  of 2026-11-12). Whatever `wake.codexFork` says, no `thread/fork` starts and
  no proxy answer is written or sent, also after a daemon restart. Relays made
  before the upgrade are reconciled without a send; stored attempts are kept.
  `kherep-node doctor` reports a written section, valid or not, as
  `"codexFork": "retired"` and no longer fails on a malformed one. The native
  Queue producer and CP hints are unchanged.

- Lead and team-lead profiles keep turns reachable and hand long work to
  background workers (#829). They no longer tell a team lead to work around
  the reply limit with a replacement thread: a REPORT stays in the package
  thread, and on a held or limited exchange the session stops and tells the
  operator (#888).

- Delivery diagnostics (#706, #827, #883). Nodes and the Worker negotiate
  fixed-code diagnostics in three steps: `messaging.diagnostics.v1`; `v2`,
  which names the target node's answer when owner resolution fails
  (`resolution-missing`, `-ambiguous`, `-stale`, `-invalid`, `-unreadable`,
  `resolution-clock`) instead of `resolution-unavailable`, allows 30 s of
  clock difference between Durable Objects and cuts the directory fairly
  across nodes; and `v3`, which reports `target-not-loaded` for a Claude Code
  session without a running process (for example after a restart of the
  Claude desktop app) instead of `target-not-idle`. Older peers keep their
  status shape. `msg status` renders stored diagnostics in plain words with
  observation time and stage, says when a session must be opened or resumed,
  reports `waiting/budget-exhausted` with the next free slot while a Claude
  target's wake budget is full (#827), and says a pending record has no
  control-plane confirmation. Target progress names task limits, runtime
  readiness, turn spacing, budget storage and busy tasks, and the Worker
  explains identity refusals and records upstream attempt blockers. The
  Control Plane README states the measured cross-node delivery matrix.
  Operator action: a sender sees the new texts only after the Worker deploy
  and the upgrade of the target node.

- Claude model and effort are user-overridable defaults, not pins (#737).
  `kherep/model-policy.json` assigns each agent a role and each role a default
  model; the observer default becomes `haiku` with effort `medium`. The
  operator's `kherep/model-policy.user.json` overrides any role or agent,
  survives every install and rollback and is never drift. The installer
  renders agent frontmatter from both files. `dispatch-contract-guard` drops
  `OWNED_AGENT_MODEL_MISMATCH`; `DISPATCH_MODEL_UNKNOWN` replaces
  `DISPATCH_MODEL_NONCANONICAL`, and `DISPATCH_EFFORT_UNSUPPORTED` checks a
  call's effort. A one-time migration (`bootstrap/migrate-model-policy.mts`)
  captures explicit environment values and edited frontmatter into the user
  file. Deprecated for one release: `KHEREP_ALLOWED_MODELS` and
  `KHEREP_AGENT_MODEL_POLICY` (no longer a pin).

- Control Plane hook commands name a stable entry point on both runtimes
  (#592, #503). The eight Claude control-plane commands run
  `<CLAUDE_HOME>/kherep/control-plane/claude-control-plane-hook.mts`, which
  reads the pointer `kherep/control-plane/source.json`; the six Codex
  definitions run `hooks/kherep-maestro/codex-control-plane-hook.mts` with the
  record `orchestra/control-plane-source.json`. Without a usable pointer the
  entry runs nothing, writes one stderr line and exits 1, with no fallback.
  `drift-check.sh` compares the pointer by commit (`POINTER-STALE`,
  `POINTER-INVALID` and related lines), and the doctor `hooks` check reports
  `pointer`, `stable` and `legacy`. Operator action: a host gets this after
  `bootstrap/install.sh` from the new source and a session restart; Codex asks
  once to review the rewritten commands. A revert is not self-healing; see
  "Rolling back the stable entry" in `docs/INSTALLATION.md`.

- The Codex messaging intent hook fails closed (#538). It runs through
  `codex-hook-adapter.mts` in a new `pre-intent` phase, so a missing, broken,
  silent or late `mcp-intent-hook.mts` is a deny. Operator action: Codex skips
  the changed entry until it is trusted in `/hooks`, and until then the five
  messaging tools are unavailable. Host behaviour (#537) and Windows (#534)
  remain UNKNOWN.

- Deny reasons, integrity notices and restore lines name a file by its path
  inside the hooks directory or checkout and never an absolute path; raw error
  text is replaced by a Node error code or class name (#564, #576). The
  `incidents.jsonl` restore entries gain a `checkout` key. No command
  definition, timeout, exit code or Codex trust hash changes.

- `MacServiceAdapter.write` refuses a plist write over a job launchd still has
  loaded with a different definition, after a 1 s grace, with
  `LaunchAgent is still loaded with a different definition`; an unreadable
  state refuses at once. The file stays untouched (#594, #677).

- `service status` drain hints no longer embed the commit in the source
  placeholder, and `service rollback` waits up to 180 s for the prior daemon's
  health (#582, #589, #581). On Windows a stop refused by the native script
  reports `STOP_NATIVE_REFUSED`.

- Dispatch guard: a brief for `kherep-builder` or `dc-plugin-build-runner`
  needs `test-route:` and `route-source:`, and the routing and builder
  contracts require a completed Central Brain lookup before a build. The guard
  checks the format only (#812).

- Codex: the managed `atlassian-broker` role defaults to medium reasoning
  instead of low. Operator action: an existing install needs one explicit
  `--refresh-models`, because an ordinary install refuses the changed policy
  (#786).

- Co-author trailers and AI attribution are allowed for every runtime and
  repository; other commit policies stay (#722).

- SonarQube Cloud analysis runs from GitHub Actions on validated same-run
  coverage (#772). `SonarCloud Code Analysis` is a required check on `main`;
  fork pull requests skip the scan and cannot satisfy it.

- The repository moved to the `CFcon-CH` organization; old URLs redirect.

### Removed

- The Teamwork Graph wrapper `kherep-twg` (#897): the `modules/twg/` runtime,
  the `kherep-twg` skill, their installer, drift and smoke entries and the
  `twg` module label. Teamwork Graph is used through the vendor `twg` CLI and
  its own skills, which the operator installs. An upgrade parks `kherep/twg`
  and `skills/kherep-twg` in the Claude home through `retired.txt`; the Codex
  installer removes them with their backups. Vendor skills are not touched.
  The `research-stop` hook no longer counts the wrapper as a Central Brain
  lookup; `twg rovo search` still counts, and a vendor TWG skill counts only
  when listed in `research-sources.json`.

- The Claude Code plugin `codex@openai-codex` and its managed marketplace
  (#797). Codex stays available through `codex exec` and the Control Plane
  intercom. Operator action: existing hosts need an authorized upgrade and a
  new Claude Code session; the upgrade only disables this plugin and keeps its
  registry, cache and marketplaces for recovery.

- The `usage-watch` prompt hook (#774). Installed copies are parked with the
  `usage-band` files through `retired.txt`.

### Fixed

- Control Plane node: a Claude session is woken for a message its `Stop` left
  waiting, including one the turn budget refused (`continue-budget`), instead
  of waiting for an unrelated message or a user prompt (#706). Node upgrade,
  no Worker deployment.

- Control Plane node: listeners wait across exhausted wake budgets without
  spending turns. Shipped Claude hook lifetimes are 25 hours, and Codex hints
  without Receive get one guarded recovery after 60 seconds (#706). Existing
  hook settings need an authorized upgrade.

- Control Plane node: connections have an OPEN deadline and a pong watchdog,
  so a dead socket is detected within about 80 seconds (#764). Node upgrade
  and restart, no Worker deployment.

- Control Plane node: session listings stay valid. `sessions.snapshot` stays
  within the 64 KiB frame limit; the liveness ledger sets `capped` only when a
  listed session falls off, and a listing carries at most 128 unlisted rows,
  so an idle session outside that bound is not addressable until listed again
  (#706). Resuming a listed session no longer adds a duplicate row that made
  every message reference `INVALID` (#834).

- Control Plane node: a Codex busy-hint lock left by a dead owner no longer
  blocks the busy-hint path for good; the lock records its owner and a stale
  one is reclaimed under a gate, and `kherep-node doctor` counts busy-hint
  locks under `listeners.busyHintLocks` (#877, #602).

- Windows lock contention: a lock in the delete-pending state (`EPERM`, and
  `EACCES` and `EBUSY` defensively) counts as held, not as a failure, for the
  client binding probe and every control-plane lock (#600, #602). The probe
  reclaims a lock only with a complete owner record of a dead process. A
  failed write after the exclusive create of the service owner file or launch
  permit removes the caller's own file instead of blocking every later
  `service upgrade` or `service rollback` (#644).

- Inbox records: every rewrite of a record runs under the record's lock, so a
  daemon refusal no longer loses a delivery written meanwhile (#627, #195).
  Busy records defer handover mappings and Codex intake work instead of
  failing them (#634). On Windows, `writeJsonAtomic` retries a rename blocked
  by another process for up to 1.27 s (#540).

- Claude intercom handover and session mapping: an interrupted copy handover
  recovers its pending messages (#635); a malformed adoption id is deferred
  per task and never authorizes a second session start (#638); a listed full
  session id that is not a valid session reference is never adopted or
  resumed (#639).

- Task runtime limits: a Claude task whose `claude stop` cannot be confirmed
  is measured and recorded after at most 10 rounds instead of being stopped
  every round (#541). A Codex task whose recorded pid now belongs to another
  process settles from its own outcome and never signals the foreign process
  (#544, #233).

- Daemon start maintenance runs in the background after the first
  connection, so a service upgrade, rollback or stale-drain recovery no
  longer fails its 30 s health check on a node with a large local queue
  (#581, #589, #195). A restore after a failed health check waits up to 180 s.
  Receipts for messages whose reply had already arrived no longer appear
  after a restart (#520).

- Control Plane Worker: an acknowledged legacy message row is no longer
  replayed to its sender after every authentication; the acknowledgement
  settles it in `settled_state`, and a later state is replayed again (#493).

- Control Plane Worker: reply admission survives guarded-parent retirement
  and nonterminal availability changes of the same owner, and an ordinary
  reply is no longer refused with `loop-context-changed` when its parent moves
  forward during send preparation (#765). Identity comparisons use one
  semantic projection across admission, duplicate validation and egress
  (#706, #765). Loop budgets and the reply limit of six are unchanged.

- Control Plane Worker: the first queued acceptance retry pass runs on the
  same socket within 60 seconds, with eight oldest-first lanes, and re-arms
  after a failed pass (#706).

- Doctor and node diagnostics: doctor keeps valid session observations beside
  malformed rows, counts `idle-loaded`, and reports stored turn-budget usage
  without spending turns (#769, #827). Node intake diagnostics measure lane
  age, pongs and event-loop lag (#706); they need a node upgrade and restart.

- `NESTED_RUNTIME` guidance states what `--from` needs when both
  `CLAUDE_CODE_SESSION_ID` and `CODEX_THREAD_ID` are set (#489).

- Windows process identity reads no longer block the daemon's event loop;
  `process-start` and `process-relations` run as awaited child processes
  (#473).

- Managed service stops: a Windows stop that failed before its first effect
  reports `STOP_BLOCKED_NATIVE_DESCENDANTS`, `STOP_IDENTITY_MISMATCH` or
  `STOP_NATIVE_REFUSED` and releases the drain instead of leaving a stale one
  (#838, #472, #677). A stop failure carries a fixed `stopCode` (new
  `STOP_UNLISTED_ALIVE`), and on macOS a job launchd unlisted while its
  process lives is proven stopped, or signalled by attested pid, within one
  75 s deadline (#677).

- A failed macOS upgrade recovery no longer leaves the new daemon loaded under
  the prior plist. Recovery fails closed with `RECOVERY_CANDIDATE_LOADED`,
  records `service/candidate.json`, and `service upgrade`, `service rollback`
  or a repeated `service install` finish it; `service status` reports the
  record (#582). A node that is already wedged still needs the manual reload
  in `docs/INSTALLATION.md`.

- Managed service activation binds health and settle to PID and start
  identity and keeps prepared evidence before native replacement; Windows
  offers strictly validated rollback recovery for older orphaned activations
  (#746). The Windows supervisor logs `SERVICE_DRAIN_BLOCKED` once per drain
  wait, and `service status` names the blocked start (#755).

- Claude installer: an install from another root no longer duplicates the
  control-plane hooks (#590). `drift-check.sh` reports `DUPLICATE-HOOK`, and
  the doctor `hooks` check fails on duplicates and reports
  `duplicatesUnknown` when it cannot read the template (#592). Installing
  again from the current root removes the duplicates. `capture.sh` folds the
  Windows form of the Claude home (#592).

- Upgrade of a changed managed Claude hook replaces the existing entry of the
  same event and matcher instead of running both, and prints
  `hooks: replace ...` (#568).

- Codex installer: an upgrade no longer refuses a managed block into which
  the Codex CLI wrote `[hooks.state]` and `[tui]` (#684).

- The commit policy and hook scope compare paths in one form on Windows and
  report a failed comparison instead of skipping the check (#816).

- Codex model catalog read in a fresh Codex home: cleanup is confirmed by
  observed process state within a bounded grace, not by a signal's exit code,
  and the app-server starts with `-c features.plugins=false` (#667).

- Confluence brokers: `stitch` with an empty `--id` no longer sweeps the
  whole space; an empty, blank or non-numeric id exits 1 before any request.
  On 2026-10-31 such a run wrote to 127 unrelated pages (#710).

- Confluence brokers: `related` and `stitch` build the text search from the
  title's content words, so special characters no longer cause HTTP 403 or
  500, and a failed text search is reported instead of aborting (#651). A
  result row without a readable title makes the result UNKNOWN instead of
  disappearing (#656). A line directly after a `<pre>` block is read as its
  own line (#669).

- GitHub App issue broker: installation tokens containing `.` are accepted
  (#780), and the Windows access check accepts a default `C:\` drive root
  (#788).

### Security

- Spawned tools resolve from absolute PATH directories only, excluding the
  working directory and its aliases, on Windows and POSIX. CI dependency
  installs disable lifecycle scripts. Agent and inbox message ids are rebuilt
  from fixed character sets, the deploy transcript is checked by prefix, and
  denial-journal scanning is bounded to one pass (#779).

- Control Plane Worker: `agents` 0.28.1 with `@modelcontextprotocol/server`
  and `/client` 2.3.1 and `@modelcontextprotocol/sdk` 1.32.1 clear the
  advisories GHSA-jm63-cq47-j5jp, GHSA-46jr-4wx8-v453, GHSA-6qxp-vccf-f47h,
  GHSA-22jm-h49p-29qw (high), GHSA-rvq5-wwqv-78pq and GHSA-6prh-2h8m-c8cw
  (moderate) (#591, replacing #542, #551, #553). Takes effect after a Worker
  deploy.

- The Worker's `allowScripts` pin names the workerd version its lockfile
  resolves, and `core-js-pure` and `fsevents` are denied by name;
  `bootstrap/allow-scripts-lock.test.mts` keeps pins and lockfiles equal
  (#559).

Internal (test, CI, coverage and refactor changes without user-facing
effect): #529, #533, #534 (with #535, #539), #550, #557, #565, #569, #570,
#578, #607, #611, #613, #638, #657, #670, #792, #813.

## [0.4.0] - 2026-10-18

### Added

- Codex fork refusal metadata (issue #477). A JSON-RPC error response to
  `initialize`, `thread/read`, `thread/turns/list` or `thread/fork` during a
  fork attempt is now recorded as one content-free daemon log line:
  `kherep-node: Codex fork helper refused <method> (code <code|none>, <shape>,
  sha256 <12 hex>, mentions <list|none>)`. The code appears only when it is an
  integer; the shape is `missing`, `empty`, `text` or `overlong`; the hash is
  the first 12 hex digits of the SHA-256 of the message; the mentions say
  which of the owner id, the newest turn id, the working directory, the Codex
  home and the word `kherep` the message contains. No text of the message
  enters the attempt, the audit, the log or the relay, no file holds it, and no
  persisted field is added: the attempt's reason code, `wake.jsonl`, `doctor`
  and the relay are unchanged. A throwing logger changes neither the reason,
  the close nor the service admission lease.

- Intake visibility (refs #441). `kherep-node doctor` adds the `intakeLatency`
  check: for messages stored in the last two hours, `observed`,
  `maxLatencySeconds` (control-plane accept to local store), `overThreshold`
  (over 300 seconds; any one fails the check) and `lastReceivedAt`, with no
  ids, text or sender names. It sees only messages that reached the inbox, so
  it is no proof that the control-plane queue for the node drains. The daemon
  logs a lane item over 5 seconds with its kind (`lane chain item
  command:session.start took 61.0 s`), a message stored more than 60 seconds
  after the control plane accepted it with its id and lane wait, and a
  synchronous child process over 2 seconds by name (`process-start`,
  `process-relations`, `owner-identity`, `owner-observe`); never bodies,
  session names or pids.

- Codex idle evidence (issue #408, first increment). The node's record of each
  Codex session (`codex-sessions/<id>.json`) now keeps `lastEvent` and
  `lastEventAt`, the last hook event (`SessionStart`, `UserPromptSubmit`,
  `PostToolUse` or `Stop`) and its time, and `lastStopAt`, the time of the last
  `Stop`; an input without a known event keeps them. The original owner's
  `PostToolUse` refreshes only the event of an existing record, and a
  subagent's call writes nothing. The pure `idleEvidence()` reads a record as
  idle only for a `Stop` at least 90 seconds old of a session seen within 12
  hours; a record of an older hook is never idle. Nothing acts on it yet:
  `msg sessions` prints `last event <event> at <time>` for this node's Codex
  sessions, and `kherep-node doctor` adds the `codexSessions` check with counts
  per last event and no session ids. Message delivery is unchanged.
- Codex fork reply policy, attempt store and admission (issue #408, second
  increment; nothing is wired and no process is started). The opt-in
  `wake.codexFork` policy section (`enabled`, `sessions` by full thread id
  only, `platforms` `["darwin"]` only, `idleAfterSeconds` 30 to 3600, default
  90, `maxAnswerBytes` 256 to 8192, default 4096) is off when absent; any
  malformed shape turns off only the fork reply and leaves the rest of `wake`
  as written. A new attempt store (`codex-fork-attempts/<owner>/<message>.json`)
  claims each message once with an exclusive create, moves states forward only,
  fails every read closed and turns launching or running attempts `uncertain`
  at recovery. A new admission decides the guards of the design in order with
  one reason code and spends the owner's turn budget only when every other
  guard passed; it refuses unless the Codex delivery hook is installed on
  `PostToolUse`, reads a hook payload's `permission_mode` before the recorded
  one and treats `lastSeen` as approximate. Idle evidence now fails closed on
  `Stop` continuations: the Codex `Stop` hook marks the session record with
  `lastStopEnded` after recording the `Stop`, on every exit that returns no
  blocking continuation, every hook event clears the mark, and
  `idleEvidence()` requires it, so a blocking `Stop` or a failed mark is never
  idle. The attempt store skips dotfiles such as `.DS_Store`, and
  `codexFork.sessions` ids are matched without case and kept in lowercase. `kherep-node doctor` prints a
  written `wake.codexFork` section with a count of opted-in sessions and fails a
  rejected one. New audit actions `fork`, `fork-declined`, `fork-failed`,
  `fork-uncertain`, `fork-superseded`, `fork-not-idle` and
  `fork-disabled-platform` exist for the later increments; nothing writes them yet.
- Codex fork reply producer (issue #408, third increment, darwin only, behind
  `wake.codexFork`; nothing changes while the section is absent, except that
  relays made while it was present are still withdrawn when the owner reads and
  cleaned up after 24 hours; nothing is sent, forked or audited). For a
  wake-authorized owner listed in `codexFork.sessions` with idle evidence and
  an accepted exact-addressed message, the daemon starts one short-lived
  `codex app-server` of the `codex` on `PATH` per message, one at a time on the
  node, in its own process group and with `KHEREP_CODEX_FORK=1`. It reads the
  owner without loading it (`thread/read`, the newest turn through
  `thread/turns/list`, which must be completed, and a goal check through
  `thread/goal/get` that refuses an active, paused or otherwise unfinished
  goal, and refuses `goals-disabled` when goals are off in the identity's Codex
  config), forks it ephemerally and read-only at that turn with tools, hooks,
  goals, web search, request-user-input and every discovered MCP server off,
  and asks one structured answer only after `thread/goal/get` on the fork
  answers `-32600` with exactly `ephemeral thread does not support goals:
  <fork id>` (measured on 0.160.1, 0.162.0-alpha.17.2 and 0.163.0); any other
  answer, `goal: null` included, fails the attempt with reason `fork-goal` and a
  fixed detail code. No `codex` version or hash is pinned; the feature list is
  cached per resolved path and hash. `deferGoalContinuation` is not sent: both
  measured binaries reject it with an ephemeral fork, and it copies the goal
  into a persisted fork. The feature keys are filtered through
  `codex features list` (stages `stable`, `experimental`, `under development`,
  `deprecated` and `removed`, as listed by the measured binaries; a removed key
  is not used) and the attempt is refused when that listing fails or shows any
  other line, or the MCP listing fails. Server requests are refused with `-32601` and fail the
  attempt, as do tool items, goal notifications for the fork and turns the
  helper did not start, whenever they arrive, also after `turn/completed` or
  while the helper closes; a timed-out turn or any violation, also one detected
  while the helper closes, ends with SIGKILL of the helper's process group,
  and that kill confirms the close only when the OS reports it sent or the
  group absent; a failed or throwing group kill ends the attempt
  `uncertain/close-unconfirmed` with the service admission retained.
  The validated answer is stored in the attempt file
  (`codex-fork-attempts/<owner>/<message>.json`, mode 0600) with a fixed
  `reason` code for every other outcome; nothing is relayed, and the owner's
  inbox record, progress, session record and thread stay unchanged. The fork
  spends the owner's autonomous-turn budget once per attempt and writes one
  `wake.jsonl` line; on another platform the only effect is a
  `fork-disabled-platform` line. The daemon now marks launching or running
  attempts `uncertain` at start, the Codex delivery hook does nothing inside a
  fork helper, and `kherep-node doctor` adds the `codexForkAttempts` check
  (counts per state, no ids). The JSON-RPC client of the native Queue cleanup
  moved to `codex-app-server-client.mts`; it now decodes UTF-8 split across
  output chunks exactly (a split multibyte character came back as replacement
  characters before) and refuses every server request with `-32601`.
- Codex fork reply relay (issue #408, fourth increment, darwin only, behind
  `wake.codexFork`). A completed fork answer is relayed as one labelled proxy
  answer to the original's sender: a new optional `proxyOf` on `message.send`
  and `message.deliver` names the original, never together with `inReplyTo`,
  so the original is never marked replied; the proxy is one reply hop deeper.
  The daemon's sweep writes one outbox record per completed attempt and the
  owner's local sidecar `inbox/proxied/<message>.json`; there is no stored
  release, and the exchange sends the record only when the relay guards pass
  at that send (attempt at most 24 hours old, the fresh policy with opt-in,
  enrollment, kill switch, fingerprint, platform and answer bound, the Worker
  capability `messaging.proxy.v1` from a `directory` frame of the current
  authenticated connection, the original still accepted, the owner's recorded
  session idle with its task and permission guards) and the sidecar matches
  the attempt. A relay spends no turn and starts no helper. The owner reading
  or answering first withdraws the relay before any guard is consulted,
  exactly when nothing can have left the node and as unconfirmed otherwise; a
  held record without any Worker status is removed after 24 hours and the
  outcome is then recorded as unresolved, never as not delivered. The
  withdrawal and the cleanup run in every poll for every message with a
  sidecar, whatever the owner's session state, and do not depend on the
  section; a superseded relay whose sidecar is missing or names another relay
  is cleaned up as well, and a record that is not the attempt's relay is never
  removed. The owner's
  delivery block and `msg inbox` show the relay state (prepared, queued or
  awaiting confirmation, may have reached the control plane, queued by the
  control plane, reached the peer, could not be delivered, unresolved); only a
  proxy that reached the peer says not to answer again. The audit action
  `fork-relayed` and the attempt's `relayedAt` mean the Worker answered. The
  Worker validates `proxyOf` against the live original row only (`proxy parent
  unknown` for a missing row or any address mismatch, `original already
  answered`, `original not waiting`), refuses a proxy still queued when the
  owner replies or the owner node reports the original delivered or refused,
  and re-reads the row where a proxy delivery is pushed. A proxy already
  accepted at the peer stays (documented residual, audit
  `message.proxy.late-delivery`); closing it needs a reservation.
- Stable Control Plane command (issue #436, first part). `kherep-node service
  install`, `upgrade` and `rollback` write `<configRoot>/bin/kherep-node.mjs`,
  a POSIX shim `kherep-node` and, on Windows, `kherep-node.cmd` and
  `kherep-node.ps1`. `node "<configRoot>/bin/kherep-node.mjs" <args>` reads
  the managed service receipt at every call and runs the receipt's Node
  executable with the active pin's `modules/control-plane/node/cli.mts`,
  passing the arguments, stdio and exit code through, so the command keeps
  working across upgrade and rollback without a reinstall. The files never
  name a pin and import nothing from one; they are rewritten only when their
  bytes differ, and the JSON result of the three service commands reports
  `launcher` as `written`, `unchanged` or `failed`. A missing or invalid
  receipt, a missing pin or a pin without the CLI exits 1 with a fixed message
  and no fallback. PATH is not changed, and the instructions, Codex rules and
  doctor check follow separately.
- Intercom instructions (issue #436, second part). Both installers render the
  host's command, `node "<configRoot>/bin/kherep-node.mjs"`, into the
  always-loaded instructions: `bootstrap/install.sh` into a managed
  `<!-- kherep-intercom:start -->` block of `~/.claude/CLAUDE.md` and into
  `~/.claude/teams/kherep/ROUTING.md`, `codex/install.mts` into the
  `<!-- kherep:start -->` block of `AGENTS.md` and into
  `orchestra/ROUTING.md`. The block lists `msg sessions`, `msg send
  <node>/<session> -- <text>`, `--reply-to`, `--new ... --directive`, `msg
  inbox` and `msg status` with one example, which names this node from
  `node.json` when it is enrolled. The sources carry the placeholders
  `__KHEREP_NODE__` and `__KHEREP_EXAMPLE_TARGET__`, rendered by
  `render-profile.mts intercom`; operator text outside the Codex block keeps
  its bytes, and a config directory no shell can quote stops either installer
  before it writes. The installers do not write the launcher itself, and
  `drift-check.sh` and `kherep-node doctor` do not yet compare the rendered
  files.
- Confirmed remote stop for Claude Code background tasks (issue #437, second
  part). `task stop` and `msg stop` for a Claude task the node started now stop
  the measured run and confirm it. The target re-measures the run, captures the
  session process and the descendants it has at that moment with their start
  times (by parent, not by process group), runs `claude stop <short id>`, the
  supported stop, and waits for every captured identity to end; the listing
  shows the session `stopped` without a `pid` while its process still lives, so
  the row is never the evidence. The tree is captured again from its live
  members after `claude stop` returned and before each signal, so a process a
  survivor started during the stop is ended and waited for too; a process whose
  ancestors all ended before a capture is not reached, the limit of the Codex
  stop (issues #231, #233). A process that outlives the grace period, in
  practice a shell command the stop does not end, is signalled by its own pid,
  SIGTERM then SIGKILL, only while it still has its captured start time; the
  session process is never signalled: it ends 1.7-1.8 s after `claude stop`
  returns (measured), and one that still lives after the grace period makes the
  stop `stop_failed` with `processState` `running` without a signal, because the
  supervisor's reaction to a signalled session is not measured.
  `stopConfirmed: true` only when every captured identity ended; a `claude stop`
  that fails, a survivor after SIGKILL or a tree past 256 processes is
  `stop_failed`, a session the supervisor restarted in the meantime is
  `stale_run` with the new run recorded for the next status. Status offers the stop (`stopSupported: true`) for a
  `working` or `blocked` session with a live process on macOS and Linux
  (measured on macOS). On Windows the Claude stop stays refused
  (`unsupported_runtime`, `stopSupported: false`); see issue #460 under
  **Changed**.
- Sender-visible intake per node (Refs #441). The `directory` frame gives each
  node an additive `intake` record: `oldestQueuedAt` and `queued`, its queue at
  the control plane, and `lastAcceptedAt`, the Worker's time of the node's last
  report that took one of its messages out of `queued` (new column
  `nodes.last_accepted_at`, added on the Registry's next start). A node the
  Worker did not measure has no record and reads UNKNOWN, never an empty
  queue. The frame limit is unchanged: an oversized directory drops sessions,
  then intake, then nodes from the end, and marks itself truncated; equal node
  names list in id order. `msg sessions` prints an `intake:` line under each
  node, `NOT DRAINING` once its oldest queued message is older than 5 minutes,
  and `msg status` names the target's intake while a message is queued. The
  new `queueDrain` doctor check reports this node's queue from the last
  directory, `ok: false, measured: false` whenever it was not measured. Older
  nodes accept the new frame; deploy the Worker before the nodes.

### Changed

- `wake.codexFork` stays `darwin` only (issues #464, #477), now for measured
  reasons on a Windows node: the fork helper's process tree cannot be proven
  contained, and a forced close cannot confirm a stop once the helper has
  exited, so a hand-enabled `win32` would keep the service admission lease; a
  turn timeout on a living root measured exactly that
  (`uncertain/close-unconfirmed`, lease kept). The fork itself completes on
  Windows (Codex CLI 0.160.1, an owner created by the Desktop app,
  0.163.0-alpha): the `-32600` refusal first measured in #464 came from the
  measurement probe, which passed one MCP server override that codex rejects,
  while the production fork guards drop such names. The compared v2
  app-server schema files (thread fork, read, turns list, goal) are equal on
  Windows and macOS at Codex 0.160.1. Lifting it needs an identity-confirmed
  close on Windows and a containment capture from creation on (such as a job
  object).
- Windows stays refused for the Claude confirmed stop (issue #460), now for a
  measured reason (Claude Code 2.1.289): the Bash tool runs a command through
  Git Bash (MSYS), whose intermediate process exits, so the command is not a
  descendant of the listed session process and is missing from the captured
  tree; after `claude stop` the session ended within about 2 s while the
  command and its shell chain kept running, so a confirmed stop would confirm
  too early. Lifting the refusal needs a capture independent of the parent
  chain, such as a job object or the MSYS process table. A Worker test pins
  that a confirming Claude stop result is stored like a Codex one.
- Upgrade the Worker before the nodes for the Codex fork reply relay (issue
  #408): the `directory` frame carries `worker.capabilities`, and a node
  refuses every fork before admission (`fork-relay-unsupported`) while its
  current connection has not shown `messaging.proxy.v1`.
- Codex messaging rules allowlist the stable launcher (issue #436).
  `rules/kherep-control-plane.rules` holds one `prefix_rule`, for `node` with
  `<configRoot>/bin/kherep-node.mjs` (forward slashes on Windows), whose
  examples are the exact intercom command. `renderControlPlaneRules` takes a
  list of `launcherRule()` commands.
- Task prompts and delivery hook recipes name the stable launcher (issue
  #436). On a host whose managed launcher resolves, the daemon's task and
  intercom prompts and the Claude and Codex delivery hooks' reply and receive
  commands name `node "<configRoot>/bin/kherep-node.mjs"`; elsewhere they keep
  naming the running code's `cli.mts`. The rules file no longer carries the
  rule for the installing checkout's `cli.mts`, and `cliRule()` and
  `controlPlaneCli()` are removed; `kherep-node doctor` now reports a rules file
  that is not exactly the launcher rule as `stale`. Upgrade the service to a
  pin with this change first, then run `codex/install.mts`. A Codex session on
  a host without a managed service asks for approval per `msg` command.
- Native Codex Queue pointer producer off by default (issue #429). The
  exact-owner producer that submits a fixed `codex queue` pointer for an
  authorized Codex owner now runs only with `"nativeQueue": true` in the node
  policy `wake` section; the key grants nothing by itself, and any non-boolean
  value rejects the section. Neither the built-in default nor onboarding writes
  it, and no upgrade step rewrites `policy.json`, so an existing node stops
  producing native Queue cards at the first daemon round after the upgrade. CP
  hints are unchanged, and pointers already submitted are still retired at
  confirming Stop and on poll rounds. `kherep-node doctor` shows the flag as
  `checks.policy.wake.nativeQueue`; it never fails the policy check.
- Owner task status measures Claude Code background tasks (issue #437, first
  part). `task status` for a Claude task no longer answers process state
  `unknown`: the target reads the `pid` that `claude agents --json --all` lists
  for the task's own background session while its process is alive, binds a
  run version to that pid and its start time, and records both on the task
  (at launch, and again when the supervisor restarted the process). A live
  `working` or `blocked` session is `running`; a session without a live
  process, or a finished one whose process still runs, is `idle` or `closed`;
  a failed listing or a row that is not the task's own background session is
  `identity_unknown`. The stop followed in the second part (see Added).

### Fixed

- Listener state files of ended sessions are now pruned (issue #474). The
  daemon's hourly listener sweep also removes `listeners/<id>.mode.json`,
  `.turns.json`, `.scope.json`, `.stuck.json`, `.woke.json`, `.queued.json`,
  `.busy-hint.json` and `.busy-admission.json` of a session that a fresh,
  complete listing does not show, that `known-sessions.json` no longer holds (7
  days after its last listing), that has no lock or in-flight lock and no active
  task record, once every one of its files is older than 7 days; at most 200
  files per pass, each removed only while its bytes are unchanged, otherwise put
  back, and nothing is removed while the listing is stale or any state file is
  unreadable. `.queued.json` has had no writer or reader since 2026-10-11 and
  goes with the rest. `kherep-node doctor` reports the count as
  `listeners.orphaned`. A session resumed after more than 7 days without a
  listing arms its `SessionStart` listener from the transcript and launch check,
  as a session without a remembered mode always did. Locks and their scopes were
  already swept hourly; this changes neither that nor any guard, permission or
  wake budget.
- Control Plane: an idle exchange round no longer re-reads the whole inbox
  (issue #487). On a Windows node with about 1000 settled messages a round read
  every record, receipt and progress file several times, about 2.6 s against
  the 2-second cadence, and one waiting message for an ended Codex task added
  one full inbox read per ended Codex task (23 of them, about 11 s). The daemon
  now keeps an in-process inbox index (`node/inbox-index.mts`), validated each
  round by one directory listing and one stat per record; only new or changed
  record files are read, the round's consumers share that read, and the Codex
  task resume reads the inbox once per round. Hooks and the CLI read and write
  the files as before and their writes are picked up by the next round. A
  failed directory listing still fails the round, never reads as empty; the
  index is rebuilt from the files every 10 minutes. Lane items now record their
  enqueue time: an item that waited over 5 seconds logs `lane <lane> item
  <kind> waited <s> s, took <s> s`, the existing `took` line gains `, waited
  <s> s` when both were slow, and a round that sent or handled more than 32
  frames logs `round sent <n> status/<m> outbox frames, handled <k> inbound
  items`. Guards, policy, receipts, progress codes, audit lines and the wire
  protocol are unchanged.

- Control Plane: the sender of `msg send`, `msg send --new`, `msg send --reply-to`,
  `msg inbox`, `msg sessions` and `task new` is the runtime that runs the command
  (issue #471). A Codex process started from a Claude Code tool inherits
  `CLAUDE_CODE_SESSION_ID`; the CLI used to prefer that variable and spoke for the
  Claude session. It now decides the runtime first: `CODEX_THREAD_ID`, which Codex
  sets for its shell commands, names a Codex thread; `CLAUDE_CODE_SESSION_ID` names a
  Claude session only when no Codex thread variable is present or the Claude
  Code process (`CLAUDE_PID`) sits between the command and a recognised `codex`
  program in the process ancestry; `KHEREP_SESSION_ID`
  keeps naming the node's own Codex runs and is checked against the task's thread.
  When both runtimes are in the environment and the process ancestry cannot order
  them, the command refuses with a fixed reason and writes nothing instead of
  falling back. `--from` behaves as before. Measured on macOS with Codex 0.160.1;
  Windows unmeasured.
- Confluence semantic search without `~/.local/bin` on `PATH` (fixes #478).
  The search behind `search`, `related` and `stitch` spawned `twg` by bare
  name, so a macOS background job, whose `PATH` lacks `~/.local/bin`, failed
  every search with `spawn twg ENOENT`. `confluence-semantic.mts` now resolves
  the executable itself, without a shell: `KHEREP_TWG_BIN`, then `PATH`, then
  `~/.local/bin/twg`, `/opt/homebrew/bin/twg` and `/usr/local/bin/twg`; on
  Windows `twg.exe` on `PATH`, then the `%LOCALAPPDATA%` and `%ProgramFiles%`
  install locations. The order mirrors `modules/twg/runtime/resolve-binary.mts`.
  A set but unusable `KHEREP_TWG_BIN` and a CLI found nowhere both end as a
  search that did not run (UNKNOWN), as before.
- `stitch` idempotence (fixes #479). A second `stitch --space <key> --id <id>`
  on the same orphan could write the same link again on every run: whether a
  neighbour was already linked was decided by comparing the regenerated body
  with the stored one byte for byte, so a `Related pages` block that came back
  in a different serialization never compared equal. The check now compares the
  page ids the block links with the ids the run would write, and a neighbour
  that already links all of them is `unchanged`. The sibling flag was not the
  cause: it only annotates the `link` trace line. The block format is
  unchanged; a renamed title of an already linked page is no longer refreshed
  on its own, only when the block is rewritten for another reason.
- Managed service rollback (fixes #472). A rollback now starts the restored
  service whenever the current or the backed-up service was running, so a
  backup taken from a stopped service no longer leaves a running node unloaded
  after `ok: true`. Upgrade and rollback report success only after the native
  service reads back with the expected bytes and, when it should run, as running
  with the healthy daemon still recorded. The stop proof waits up to 75 seconds
  instead of 30, beyond the launchd `ExitTimeOut`. A macOS stop refused before
  `launchctl bootout` runs leaves the live service untouched and reports
  `restored`; any other stop failure is treated as possibly effective and is
  never reported `restored` without proof. An `unknown` recovery releases the
  drain marker only when no definition write was attempted and the daemon told
  to stop is gone. Failures add a fixed `stage` and, for an `unknown` recovery,
  a fixed `blocker`; the error message is still never printed. `service status`
  reports `drain` (`none`, `active`, `stale` or `unknown`) and fails on a stale
  or unverifiable drain. It names the recovery `service upgrade --source <clean
  checkout at <commit>>` for a stale drain and for a stopped service with a dead
  recorded daemon, which `upgrade` now accepts instead of refusing the stale
  record, and asks to inspect the drain owner file when its owner cannot be
  verified. Status prints no local path or pid.

- Message intake no longer waits for runtime work (refs #441; the
  sender-visible signal for a node that does not drain is a follow-up). A
  `message.deliver` frame of an authenticated connection is stored on an
  intake lane of its own instead of behind the daemon's frame lane, which
  awaits CLI stops and starts, task control and listings of up to 60 seconds
  each. Policy acceptance, the store, the refusal and the no-answer-on-store-
  failure rule are unchanged; a delivery before its connection's `auth.ok` was
  handled still waits behind it. A command ack is now allocated, and the
  command counted as processed in the `ack` field of node frames, only after
  its handler: a status sent meanwhile can neither make the Worker drop the
  ack nor ack the command early, which would drop its resend after a daemon
  crash. The wire seq and ack are now stamped at the daemon's single send
  step instead of when a frame is built, so a frame of one lane sent after a
  higher-numbered frame of the other is no longer dropped by the Worker (a
  lost command result); the MCP inbox response keeps 32 bytes of margin for
  the stamp, and a Worker error frame naming no message is logged. A
  synchronous child process still blocks the event loop: one
  `watchCodexTasks` pass can run several in a row, so a delivery can still
  wait for their sum, each bounded by 10 seconds.

- Node policy applied without a restart (issue #463). The daemon handed the
  Codex task wake, closed-session delivery, task requests
  (`sessions.delegate.request`) and the `session.*` commands the policy it
  loaded at start; they now use the exchange round's policy, a fresh read per
  session check, and a fresh read per command, so every section takes effect
  within one exchange round, one session check or at the next command.
  Tightened `sessions` fields apply to the next command.
- Retained admission recovery for direct native Codex Queue reconciliation
  (Refs #442). After an unconfirmed shutdown, the same helper's later `exit` and
  `close` can release its lease once the operation and every held helper have
  finished. Unknown, rejected and permanent holds stay blocked. Late shutdown
  evidence does not certify Queue cleanup. All disk leases keep the same PID,
  process start time and owner fields, without helper identity. This release
  requires the creating daemon to retain the admission and proof from that exact
  child in memory. Lost evidence cannot be reconstructed from disk; existing
  positive stale-owner recovery stays unchanged.

- Claude task status no longer answers `closed` while the recorded process
  lives (issue #454). When the `claude agents --json --all` row lists no `pid`,
  as it does right after `claude stop` while the session process still runs
  (measured), or when the row is missing, the target now reads the start time
  of the pid recorded on the task: equal, the process lives and the status
  answers `idle` for an ended session (`running` for a `working` or `blocked`
  row; a missing row answers from the task state, `idle` for an ended task and
  otherwise `unknown`) with its run version; null or changed, the process ended and the answer
  stays `closed` or `idle` as before; unreadable, it is `identity_unknown`. A
  stop that ended `stop_failed` with the session process alive is followed by
  `idle`, then `closed` once the process ended, and a stop meanwhile is
  `stale_run`. The confirmed stop is unchanged: every captured identity has
  ended before its post-stop check, which still detects a restart only by a
  newly listed pid.
- Windows stale service-owner recovery (issue #442): valid process creation time
  can prove PID reuse when the SID is unreadable, using the existing two-second
  tolerance. Active or uncertain owners still block recovery. Admission waits
  identify the first blocker by opaque lease fingerprint, PID and process start.
- Codex fork reply gate and refusal audit (issue #444). The daemon's regular
  exchange round handed the Codex queue the policy loaded at start, so a
  `wake.codexFork` opt-in or opt-out, or a `wake.sessions` change, written
  after the daemon started took effect only after a restart; the round now
  passes the policy it read for that round, as the intake-window path already
  did, and nothing changes while the section is absent. Every refusal of the
  fork producer before the claim is now one `wake.jsonl` line per owner,
  message and code: the admission code with the prefix `fork-` (`fork-cwd-refused`,
  `fork-permission-mode`, `fork-budget-spacing`, ...) and the producer's own
  `fork-producer`, `fork-mcp-unknown`, `fork-features-unknown` and
  `fork-relay-unsupported`; `fork-not-idle` and `fork-disabled-platform` are
  unchanged. A line carries ids and the code only. A line whose append
  failed is not marked as noted, so the next poll that meets the same
  refusal writes it again once the audit file is writable. Documentation
  states that a fork owner's recorded working directory must lie inside the
  workspace roots and that a `codex exec` session reports `bypassPermissions`
  and is therefore refused as a fork owner (measured 2026-10-16 with
  codex-cli 0.160.1). The exchange's proxy send gate was still built once at
  start from the startup policy, so a `wake.codexFork` opt-in written later
  left every completed proxy answer in the outbox silently (measured
  2026-10-17); the gate is now built per exchange round from the round's
  policy, and a record held by a relay guard is logged once per relay and code
  as `Codex fork relay send held: <code>`; nothing is audited and nothing
  changes while the section is absent.
- Service owner probe in unit tests (issue #423): the runner deps carry the
  owner probe of a service admission (`serviceOwner`), and task starts,
  continues, closed-session resumes, Codex runs and Codex queue runs use it.
  The task test fixture injects a probe that starts no process, so these
  tests no longer depend on a PowerShell identity lookup that can time out
  on a loaded Windows runner. The daemon keeps the default probe.
- Windows service identity lookup (issue #427): a PowerShell identity lookup
  or owner observation that hits its 10 s timeout runs once more; every other
  failure is still final at once. A first service admission after a boot or
  a service restart no longer fails, and the start-up readiness probe no
  longer reports a runtime as not ready for two minutes, when only the first
  PowerShell start was slow. Two timeouts in a row fail admission with
  `service controller identity lookup timed out` instead of `service
  controller identity cannot be verified`. `createServiceOwnerProbe` lets
  tests replace the platform, the spawn function and the timeout.
- Daemon stop during a Claude probe (issue #420): a daemon stopped by
  SIGINT, SIGTERM or now SIGHUP starts no new readiness probe and waits for
  the one in flight, so a stop no longer cuts a login renewal short. A probe
  still waiting for a service drain is given up instead. A timed-out probe on
  macOS and Linux gets SIGTERM and SIGKILL only after 5 seconds; Windows keeps
  `taskkill /T /F`. The macOS LaunchAgent gets `ExitTimeOut` 60 on a fresh
  installation and on an upgrade of a definition without it. A restarted
  daemon reuses the previous daemon's ready verdict when it is younger than
  10 minutes instead of probing at once, so a restart no longer starts a
  Claude call exactly when daemons are killed. A Claude probe a killed daemon
  left behind is logged at the next start, forces the probe, is recorded in
  `daemon.json` and is shown by `kherep-node doctor` as
  `runtimes.claude.lastStopInterruptedProbeAt` until the next ready verdict.
  Every daemon log line, in the managed service log and from `kherep-node
  daemon`, starts with an ISO 8601 timestamp. A Windows kill such as
  `taskkill /F` still cannot be caught; Claude probes stay attached to the
  daemon there.
- Doctor hook check from a source pin (issue #445): `kherep-node doctor` run
  through the stable launcher runs from the active service pin, so the Claude
  `deliver-hook.mts` and `wake-hook.mts` entries that `install.sh` wrote from a
  checkout counted as another checkout even at the same commit. A hook in a
  checkout whose source identity (commit and tree, no tracked changes) matches
  the pin the doctor runs from now counts as this checkout and is listed under
  `checkouts`, symmetric to the existing `pinned` rule; the identity of each
  root is read once per run. A checkout at another commit or with tracked
  changes is still another checkout, and `detail` now names the reason
  (`commit differs`, `source tree differs`, which side has tracked changes, or
  `no verified source identity`).

## [0.3.0] - 2026-10-15

### Added

- Closed-session cwd refusal code (issue #396): a closed-session delivery that
  the recorded working directory refuses (not absolute, missing, or outside
  the workspace roots) now waits with `waiting/cwd-refused` instead of
  `waiting/wake-not-authorized`, and `msg status` on the sender says so. Nodes
  advertise `messaging.progress.v2`; the Worker sends `wake-not-authorized`
  to a sender without it. Upgrade the Worker before the nodes: an older
  Worker rejects the new code, and the target node retries the report.
- Offer provenance (issue #417): an inbox record carries `offeredBy`
  (`wake`, `prompt`, `stop`, `tool`, `codex-prompt`, `receive`, `codex-wake`,
  `intercom`, `mcp`) with `offeredAt`; the wake listener leaves
  `listeners/<session_id>.woke.json`, which the woken turn's
  `UserPromptSubmit` claims within 30 s; `msg status` and `msg inbox` show
  `offered by`; `msg status <id>` now answers for a message in this node's
  inbox (exit 0 instead of 1).
- Managed node daemon service (issue #404): `kherep-node service install`,
  `upgrade`, `status` and `rollback` manage a per-user macOS LaunchAgent or
  Windows Scheduled Task from a verified immutable source pin. Upgrade and
  rollback retain exact native definition and security backups, verify daemon
  ownership, authenticated reconnection and loaded source identity, and refuse
  service drift, unsafe adoption, uncertain process identity and active
  descendants before stopping a service. The Windows task uses a fixed Node
  supervisor that preserves the selected log, verifies the source before every
  child start and restarts an exited daemon after 30 seconds. A generation-bound
  one-use permit admits only the transaction's candidate while task admissions
  are drained, and stop retains and terminates the selected supervisor before
  its exact daemon child. Doctor now compares the daemon's
  recorded startup source and verified hook pins with the invoking checkout.
- Sender receipts (issue #402): when a message reaches `delivered` (the target
  session's turn that carried it completed), the sending session's next
  delivery hook event shows one line, `Your message <id> to <node>/<session>
  was received (confirmed <updatedAt>).`, once per message (`noticedAt`), for
  Claude Code and Codex senders. The time is when the sender's node recorded
  `delivered`. A receipt matches the sender by session id (`fromSessionId`),
  and by `fromSession` only for a record without it (an older sender), so a
  renamed session still gets it and a later session reusing the name does not.
  No receipt before `delivered`, nor when the message is `replied` or its reply
  already arrived.
  A receipt never wakes a session or continues a turn: `Stop` shows it only
  beside messages or failure notices, and no wake entry or turn budget is used.
  Receipts never cost a peer message slot or block: they take only the room
  left after the messages and wait otherwise; more than 5 are
  counted in one line. The intro names receipts, failures or both. Failure
  notices are unchanged. Selection lives in
  `modules/control-plane/node/sent-notices.mts`.
- Observation result check: a new `SubagentStop` hook, `obs-result-check.mts`,
  wired with matcher `claude-obs`, checks the agent's `OBS-RESULT` status line
  through `claude/hooks/lib/obs-result-policy.mts`. The first non-empty line is
  the only `OBS-RESULT` line; `wrote <n> <ids>` needs n positive and exactly n
  numeric ids; `empty` and `failed` need a reason whose first word is no status
  word, which catches `failed wrote 4 pages: ...`. A malformed line is sent
  back to the agent once with a fixed instruction (`decision: "block"`); on the
  continuation, and for a valid `failed`, the operator gets a `systemMessage`
  instead. The message comes from `last_assistant_message`, else the agent
  transcript. No message text reaches stdout, and any error is one
  `systemMessage` with exit 0.
- Codex observation candidate check: a new Codex `SubagentStop` hook,
  `codex-obs-result-check.mts`, wired with matcher `codex-obs` in the last hook
  group of the managed block, checks the worker's candidate through
  `codex/hooks/obs-candidate-policy.mts`: exactly one strict JSON document whose
  only key is an `observations` array, each candidate with exactly `title`,
  `bodyStorage`, `evidence`, `labels` and `placement`. A fenced or otherwise
  malformed candidate is sent back to the worker once (`decision: "block"`); on
  the continuation the operator gets a `systemMessage` and the Maestro publishes
  nothing. The message comes from `last_assistant_message`, else the subagent
  rollout; when neither is visible the hook says so. It prints one JSON document
  or nothing, never message text. An upgrade appends only this group, so every
  existing positional trust key stays (issue #326).
- Attribution log: a new git `pre-push` hook beside `commit-msg` records one
  line per pushed ref in the node's local
  `<config root>/control-plane/attribution.jsonl` (mode `0600`) for
  repositories under the workspace, and always exits 0. The session is
  `CLAUDE_CODE_SESSION_ID`, else `KHEREP_SESSION_ID`, else a marker the Codex
  `PreToolUse` phase leaves for that repository within 120 seconds, else
  `unknown`. `gh pr create` never reaches git, so
  `modules/control-plane/node/attribution-hook.mts` records it at
  `PostToolUse`, from the checkout, in Claude for Bash and PowerShell and in
  Codex for the shell tools; the PR number comes from the tool output, else
  `gh pr view`, else it stays `null`. A record holds ids, owner/name, the
  toplevel, branch, remote ref, SHA and PR number, never commit subjects, PR
  text, tokens or the environment; every append drops records older than 90
  days. `kherep-node attribution [--branch] [--pr] [--repo] [--since <hours>]
  [--json]` reads it. The token walk of the main-checkout guard moved to
  `claude/hooks/lib/command-walk.mts` and serves both hooks.
- Main-checkout guard: a new `PreToolUse` hook, `main-checkout-guard.mts`,
  keeps the main checkout of a workspace repository (git-dir equals
  common-dir) on its default branch, because sessions share it. It blocks
  `git checkout <ref>` without `--` (a SHA included), `checkout -b`, `-B`,
  `--orphan`, `--detach`, and `git switch` to any branch other than the
  default, including `-c`, `-C` and `--detach`, with exit 2 and a pointer to
  `git worktree add <path> -b <branch>`. File checkouts, `restore`,
  `worktree add`, `pull`, `fetch`, `merge`, `rebase`, linked worktrees and
  repositories outside the workspace pass. The default branch is
  `origin/HEAD`, else a local `main` or `master`; without one it warns and
  exits 0. The inline `KHEREP_MAIN_CHECKOUT=switch` prefix, or
  `$env:KHEREP_MAIN_CHECKOUT='switch';` in PowerShell, lets one approved
  command through; a persistent variable is ignored. Claude runs it for Bash
  and PowerShell in a new `Bash|PowerShell` group; Codex runs it through the
  hook adapter as the last entry of the shell group, so a block arrives as a
  JSON deny. A new git `post-checkout` hook beside `commit-msg` warns, and
  always exits 0, when a branch checkout leaves such a main checkout off its
  default branch; it is silent in linked worktrees, after `worktree add`,
  during a rebase and with the marker. `critical-file-integrity.mts` guards it
  like `commit-msg` (issue #325).
- Confluence brokers: new read-only verb `list --space <key>
  [--title-contains <text>] [--label <name>] [--limit <n>]`. It reads every
  page of the space through the paginated v2 pages endpoint, filters titles by
  case-insensitive substring in the broker, and filters by label through one
  v1 CQL query that follows `_links.next`. It prints one `page` row per match,
  then `total:`, `shown:` and `truncated:`. The total is counted by reading
  every result page, never taken from `totalSize`; only `--limit` truncates.
  Exit 0 for any completed read, including `total: 0`, and exit 1 for a
  Confluence or argument error, which prints no `total:`. The space index now
  stops on a cursor that adds no new page, not only on an empty page
  (issue #315).
- Confluence brokers: `labels --id <page> --keep-runtime <runtime-label>`
  repairs a page that carries two runtime labels. It deletes the other one,
  reads the labels back and prints `runtime: kept`, `runtime: removed` and
  `labels:`; it exits 1 when the removed label is still there. It cannot be
  combined with `--labels` or `--remove`, and it refuses without writing when
  the value is not a `runtime-` label, when the page carries one, none or more
  than two runtime labels, or when the named label is not among them. The
  `labels` verb now lives in the shared `confluence-label-cli.mts`, which the
  installers, drift checks and smoke test project beside the brokers
  (issue #318).
- Atlassian destructive guard: a new `PreToolUse` hook,
  `atlassian-destructive-guard.mts`, stops every `mcp__<server>__executeDestructive`
  call, under any server name, the managed `atlassian` server, a plugin
  namespace and a claude.ai connector named by a UUID included. Claude asks the
  operator to confirm the call (`permissionDecision: "ask"`), wired with
  matcher `mcp__.*__executeDestructive`. Codex hooks cannot ask, so Codex denies
  it with `--runtime codex`; the guard is the last entry of the existing
  Agent, web and MCP `PreToolUse` group, because a new group would move the
  positional trust key of every operator `PreToolUse` group after the managed
  block. The installer recognises the exact block from immediately before the
  guard and replaces it; Codex asks to review that one entry. Read and write
  calls pass (issue #376).
- Claude mid-turn delivery: the control-plane delivery hook also runs at
  `PostToolUse`, as the last entry of the all-tools group, so a Claude Code
  session in a running turn receives accepted peer messages next to the result
  of its next successful tool call instead of only at the turn's end
  (`node/deliver-midturn.mts`). The call marks them `offered`; only the turn's
  `Stop` confirms them `delivered` (issue #308 rule), and that `Stop` and a later
  `UserPromptSubmit` inject them no second time. Calls from a subagent or
  in-process teammate (`agent_id`) and calls in permission mode
  `bypassPermissions` inject nothing. A per-session lock file keeps the
  concurrent hooks of parallel tool calls from offering a message twice. The
  call starts no turn and neither checks nor spends the autonomous-turn budget.
  `kherep-node doctor` counts the new entry with the other delivery hooks
  (issue #388).

### Changed

- Control Plane wake is on by default (operator decision of 2026-10-12). A
  node `policy.json` without a `wake` section now acts as
  `{ "enabled": true, "sessions": ["*"], "codexApp": true, "replies": true }`,
  so an existing node that accepts messages wakes its idle sessions for them
  after the upgrade; `"wake": { "enabled": false }` opts out, and a malformed
  section still fails closed. Messaging admission keeps failing closed: a file
  without a `messaging` section still accepts nothing. The rule for every
  sender, `{ "accept": [{ "session": "*", "from": ["*"] }] }`, is written
  explicitly by `onboard` into a new `policy.json` together with the default
  `wake` section (an existing file is never rewritten), and a missing file
  reads as that default policy. The default autonomous-turn budget rises from
  6 per hour and 20 per day to 20 per hour and 100 per day (30 s spacing
  unchanged), and a `wake.budget` with `perDay` alone is no longer compared
  with the default hour. `kherep-node doctor` reports `wakeSource` (`file` or
  `default`) and `messagingSource` (`file`, `absent` for a file without the
  section, `default` for a missing file), and no longer reports
  `"enabled": false` as a rejected wake section (issue #390).

- Codex hooks: one shell dispatcher retains commit, deploy and checkout checks
  and pre-tool attribution while removing redundant adapter starts. Post-edit
  dispatch skips four watcher children for normalized Bash inputs, which all
  four watchers already reject. Per-turn reminders retain their rules with
  less text. The synthetic fixture runs 41 rather than 65 hook commands and
  85 rather than 121 processes; native Desktop counts remain unmeasured.
  Exact upgrades preserve operator state and require review of the new hook
  definition (issue #386).

- Atlassian MCP: with the optional Atlassian tool set, both runtimes reach the
  v2 Atlassian remote MCP server (`https://mcp.atlassian.com/v2/mcp`) as their
  own Atlassian service account instead of the operator's personal OAuth login.
  The service account's API key lives in a private file, read only by the
  secret-file wrapper `supergateway-secret-wrapper.mts`, which sends it as
  `Authorization: Bearer`. The file is `KHEREP_ATL_MCP_TOKEN_FILE_CLAUDE` or
  `KHEREP_ATL_MCP_TOKEN_FILE_CODEX`, by default
  `<runtime home>/kherep/atl-mcp-credential-<runtime>.txt`. A file that is also
  the other runtime's key file or a broker credential file is refused, and so is
  one that is not absolute, regular, private and owned by the installing user.
  Codex: the managed `atlassian` table runs the wrapper and sets
  `approval_mode = "prompt"` for `executeDestructive`; a block with the
  previous native url table, or with a table for another key file, is
  recognised and replaced, and the receipt reports `atlassianMcp` with its
  status and `tokenSource`, never the path or the key. Claude: the installer
  registers the user-scope stdio server `atlassian` through `claude mcp
  add-json`, reads it back from `~/.claude.json`, and only then disables
  `atlassian@claude-plugins-official`, whose server ran as the personal login;
  the plugin's five skills go with it. The plugin manifest no longer enables
  it. An `atlassian` entry the installer did not write stays, and so does the
  plugin. Without a usable key file no Atlassian server is written on either
  runtime, nothing falls back to OAuth, the rest of the installation stands and
  the installer exits 1 with a warning. The Claude step has the skip rules of
  the credential step: `KHEREP_INSTALL_SKIP_ATL_MCP=1`,
  `KHEREP_INSTALL_PREVIEW=1`, and a non-default `CLAUDE_HOME` without
  `KHEREP_INSTALL_ALLOW_ATL_MCP=1` (issue #376).
- Research evidence: a v2 `executeRead` whose operation is `searchConfluence`
  or `searchConfluenceUsingCql` counts as a Central Brain lookup on both
  runtimes (issue #376).
- The secret-file wrapper reports a failure as `MCP secret wrapper failed
  safely` instead of naming n8n, since it now also carries the Atlassian
  server (issue #376).
- Control plane Worker: a message is deleted once its sender acknowledged the
  final status (`message.status.ack`, `delivered`, `replied`, `refused` or
  `expired`). The acknowledgement must come from the sending node and name the
  stored final state; a repeat is a no-op. Messages from the operator API and
  from senders without `messaging.ack.v1` are deleted 24 hours after their
  final state, and a revoked node's final messages at once; `queued` and
  `accepted` messages are never deleted. A 24-hour tombstone (ids, nodes,
  final state, reason, reply depth, reply id; no text, no sessions) answers a
  late resend, a late target report, MCP `status` and task-control
  provenance. The Worker now stores every message's reply depth and refuses a
  reply beyond `MAX_REPLY_DEPTH` with `reply depth exceeded`. An MCP `reply`
  to a deleted message reads that one item from the replying node's inbox
  (`mcp.inbox.request` with `messageId` and `reply`; the node marks it
  answered); an older node fails it closed. Messages stored before this
  deploy are never deleted, whatever acknowledgements, replays or revocations
  reach them. `GET /api/messages` no longer lists acknowledged messages; the
  audit keeps their history without text. All new queries are index-backed
  and covered by the read-budget test (issue #308, PR 4 of 4).
- Atlassian MCP: Kherep targets the v2 Atlassian remote MCP server. The Claude
  capability check no longer expects a `rovo` server. With the optional
  Atlassian tool set the Codex installer writes the managed MCP server
  `atlassian` (`https://mcp.atlassian.com/v2/mcp`) instead of registering the
  legacy `atlassian-rovo@openai-curated` plugin, retires the v1 `rovo` table,
  and recognises a managed block an earlier installer wrote with or without
  that `rovo` table; tables outside the block stay untouched. The install
  receipt drops `nativePlugins`. The research-evidence matchers count the v2
  `searchConfluence` tool under any server name, including a claude.ai
  connector named by a UUID (issue #304).
- Codex delivery hook: the reason of a blocked `Stop` now starts with
  `Kherep message delivery (not an error):` (`CODEX_STOP_MARKER`), because the
  Codex desktop app shows the block as "Blocked · Stop · User · Feedback" with
  the reason beneath it. The retrieval command, the escalation note, the
  continuation budget and the 6 KiB limit are unchanged; the Claude `Stop`
  path is untouched (issue #359).

### Fixed

- Claude sign-in around `install.sh` (issue #403): from the start of the
  dependency phase to the end-of-install readiness check, the installer keeps
  `install.lock` in an enrolled node's `control-plane` directory. While that
  file is younger than 30 minutes the daemon starts no new Claude readiness
  probe and logs `probe deferred: install in progress` once; a probe already
  running is marked in flight and the installer waits for it, at most 60
  seconds. When the file is gone the daemon probes Claude once more, also after
  a ready verdict, so a sign-out during the installation is not advertised as
  ready. The installer removes the file after the check and in its exit trap;
  it still does not restart the daemon. After writing the file, a
  `claude auth status --json` pre-check warns when Claude already reports no
  sign-in and never blocks the installation. At the end,
  `bootstrap/claude-readiness-check.mts` runs the daemon's own probe once and
  prints `install: claude ready`, `install: WARNING claude SIGN-IN LOST (...)
  - run 'claude auth login'` (the installation exits 1 with its own
  `DONE WITH ERRORS (Claude sign-in lost ...)` verdict), or `install: claude
  probe inconclusive (...)` (a warning, also for a login renewal another Claude
  process holds). `KHEREP_INSTALL_PREVIEW=1`,
  `KHEREP_INSTALL_SKIP_CLAUDE_READINESS=1` and a candidate `CLAUDE_HOME` skip
  the pre-check and the probe. The installation guide now advises against
  killing the daemon's process tree.
- Codex headless broker research (issue #405): the research reminder explains
  command-scoped approval when sandbox networking blocks a read-only search.
  The documented `codex exec --approve-for-me` invocation retains the
  workspace-write sandbox and makes the escalation reviewable. An unavailable
  lookup remains UNKNOWN; no sandbox defaults or privacy guards are changed.
- Codex research Stop hook: a Central Brain broker search run through the Codex
  Desktop code-mode wrapper counts as a research attempt. Codex Desktop
  records that wrapper as a `custom_tool_call` named `exec` without a
  `namespace` field, which the parser accepted only as `functions.exec` or with
  `namespace: "functions"`, so a substantial turn got the "missing a Central
  Brain research attempt" continuation after a lookup it had run. The
  unnamespaced form is accepted only as a `custom_tool_call`; a bare `exec`
  `function_call` and other namespaces still do not count. The nested
  `tools.exec_command(...)` call counts as before, also inside
  `Promise.allSettled`, with its output collected through `write_stdin`. Text in
  comments, strings, user messages, tool output and `item_completed` records
  still does not count (issue #398).
- Codex upgrade (issue #397): a managed block that the Codex app split around
  its trust tables and that names an earlier checkout or source pin before the
  control-plane `deliver-hook.mts` and `attribution-hook.mts` is upgraded
  instead of refused, also with an earlier Node executable; any other
  difference in the block is still refused. An upgrade keeps a managed
  `atlassian` table: without `KHEREP_INSTALL_ATLASSIAN_TOOLS` the tool set is
  installed again with the key file the installed table names (receipt
  `tokenSource` `installed`), an unusable key file stops the install before
  it writes, and an explicit opt-out records `atlassianMcp.status` `removed`.
  `kherep-node doctor` counts a hook in a source pin of the checked-out commit
  as this checkout and lists it under `pinned`; a pin of another commit is
  still reported as another checkout.
- Control plane messaging: closed-session delivery (`messaging.resumeClosed`)
  no longer takes a session for closed because one session listing did not
  show it. It readdressed every waiting message for such a session to an
  intercom session of its sender, so a reply (`--reply-to`) to a message that
  session S sent could land in the replying peer's background intercom session
  on S's node while S was still open and never saw it. A target now counts as
  closed only after 3 consecutive successful listings without it, the first at
  least 90 seconds before the last (about 2 minutes at the 60-second listing
  interval). A listing that shows the session resets the count; a failed
  listing, and a partial one for the runtimes it could not see (no `claude` on
  `PATH`, a listing at its 512-session cap), counts no miss. The count is kept
  in `known-sessions.json`, survives a daemon restart and is pruned with the
  session's entry; a target the node never listed is counted from its first
  waiting message on. Until then every message, a reply or not, stays
  addressed to S and waits with `waiting/awaiting-user-turn`, and is refused
  with `target session not running` when S does not return within 60 minutes.
  Once S is closed, a reply reaches an intercom session of its sender like any
  other message (issues #102, #105). `msg status` on the original sender lists,
  under each reply that a node handed over, the session it was forwarded to and
  its delivery task and session (issue #389).
- Atlassian MCP: the Claude step reports every local-scope `atlassian` entry in
  `~/.claude.json` that takes precedence over the managed service-account server
  in its directory, with the removal command, leaves it as it is and exits 1.
  Before, it reported the installation as configured while sessions in that
  directory reached a personal OAuth connection. The installation guide lists
  the agent-interface scopes the v2 server requires per tool group; keys with
  only the classic product scopes authenticate but every tool call answers 403
  (issue #382).
- Atlassian credential step: a host without `KHEREP_ATL_PROJECT_KEY` in the
  installing shell could not prove a working broker credential. Both Jira
  brokers validated the full project seed before `selftest`, although the check
  proves only the OAuth client and the site; `selftest` now needs
  `KHEREP_ATL_SITE` and nothing else. When a broker still stops on a
  `KHEREP_ATL_*` configuration error, `bootstrap/atl-credential.mts` names that
  variable, leaves the credential file untouched and asks nothing, instead of
  reading the missing verdict as inconclusive and offering to replace a working
  credential. A missing verdict now reads `NO-VERDICT`, no longer the word the
  Codex broker uses for a check that ran and could not decide (issue #379).
- atlassian-broker: the Claude agent wrote Confluence pages through
  `twg confluence content ...`, which runs as the operator's personal TWG
  login, against the rule that every Atlassian write runs as a service account.
  It now uses the Claude Confluence broker `atl-confluence-ccoder.mts`. The
  Codex agent was rendered from the Claude definition and named the Claude Jira
  broker; it has its own definition, `codex/agents/atlassian-broker.md`, with
  the Codex brokers `atl-jira.mts` and `atl-confluence.mts` (issue #376).
- claude-obs reads its host configuration `<Claude home>/kherep/confluence.json`
  with the Read tool instead of `cat`, which the auto-mode classifier denied.
  The user settings allow exactly that one file with a new rule,
  `Read(//__KHEREP_CLAUDE_HOME__/kherep/confluence.json)`. The renderer writes
  it in the absolute POSIX form Claude Code matches on every platform:
  `Read(//c/Users/<user>/.claude/kherep/confluence.json)` on Windows,
  `Read(//Users/<user>/.claude/kherep/confluence.json)` on macOS (issue #363).
- main-checkout-guard and the attribution hook: a repository counts as
  inside the workspace when its path matches the workspace as written or
  after both sides are resolved on the file system. A workspace or checkout
  given as a Windows 8.3 short name, or reached through a junction or
  symbolic link, is now guarded instead of passing unchecked. Both use the
  shared `isWithinWorkspace()` in `real-path-policy.mts` (issue #346).
- Privacy boundary guard: a path given as a Windows 8.3 short name on one
  side and as the long name on the other now meets. Before, a credentials or
  local-inference root set long and a Read, Bash or Agent payload naming it
  short, or the other way round, was allowed. Roots and candidate paths are
  now compared in both canonical forms, the JS realpath that keeps short
  names and the native one that expands them, through the new
  `canonicalPathForms()` in `real-path-policy.mts` (issue #348). The check is
  additive: nothing denied before is allowed now. The PowerShell tool is
  covered as well since issue #358.
- Privacy boundary guard: the PowerShell tool is classified like Bash. Before,
  every PowerShell call passed unchecked, so `Get-Content`, `gc`, `Copy-Item`,
  `-LiteralPath`, `pwsh -Command`, `$env:` expansion of a protected root and
  direct HTTP to the local inference ports were allowed, and an empty command
  did not fail closed. The shell walk in `private-path-policy.mts`, which Bash
  and Codex use too, now follows `sl`, reads a colon-attached parameter value
  (`-LiteralPath:<path>`), and walks the script of `bash -c`, `pwsh -Command`
  and the other shells in `command-walk.mts` in the current directory. A
  protected path split across a directory change and a relative path inside
  such a script is now denied for both tools. The check is additive and the
  deny texts are unchanged. Not covered: relative .NET paths, `Join-Path`,
  string concatenation and backtick-escaped spaces (issue #358).
- Deploy guard: the Forge rules only count a flag in the arguments of the
  same `forge deploy` or `forge install`. Before, they matched `forge deploy`
  and `-e production`, or `forge install` and `-s`, anywhere in the command,
  so `forge deploy -e development && grep -e production log.txt`, a dev
  deploy followed by `forge install -e production`, and an install followed
  by `rsync -s a b` were blocked. They now also block what they let through:
  `-e "production"`, `--environment 'production'`, `-eproduction`,
  `-e prod`, `--site "<site>"`, `forge.cmd`, `forge.exe` and
  `npx @forge/cli`. A `production*` value still blocks, `forge install list`
  is read-only, and an install without a site stays allowed. The new
  `hooks/lib/forge-match.mts` reuses the segment scan of
  `hooks/lib/git-push-match.mts`, now exported as `segmentVerdict`, so
  quoted words are still scanned again as shell and quoted text that spells
  a complete forge command stays blocked. When the command cannot be parsed
  the old regexes decide, so both rules still fail closed. `forge tunnel`
  keeps its whole-string rule (issue #328).
- Deploy guard: rule 4 now blocks `forge tunnel` only when `tunnel` is the
  verb of a forge invocation, read with the segment scan of rules 1 and 2.
  It now also blocks `forge.cmd`, `forge.exe`, a Windows path to
  `forge.cmd`, `npx @forge/cli` with or without a version, and a flag before
  the verb. A mention with punctuation on the verb, a backticked mention in a
  heredoc body and JSON text pass. Quoted text that spells the complete
  command, such as `echo "forge tunnel"`, stays blocked (#327 decision 2).
  `forge TUNNEL` passes, because the verb is case-sensitive. When the command
  cannot be parsed the old regex decides, so the rule fails closed. The
  deploy-auth token still never unblocks rule 4, and the guard footer now says
  so instead of offering it (issue #347).
- Control Plane worker: an npm override raises `sharp` from 0.35.4 to
  0.35.5 (CVE-2026-96889, Dependabot alert #12). `miniflare` pins
  `sharp` to exactly 0.35.4, also in its latest release, so Dependabot could
  not raise it on its own. The override can go once `miniflare` requires a
  patched `sharp`. `sharp` is a development dependency only and is not part
  of the deployed Worker. `@cloudflare/workers-types` moves to
  5.20261008.1, the peer range `wrangler` 4.148.0 asks for; without it the
  lockfile could not be regenerated (issue #343).
- Plugin reconciliation: `claude plugin list --json` now also reports rows
  with `"scope": "synced"`, plugins synced from claude.ai, and one such row
  made `reconcile-plugins` fail with `Claude plugin list contains a malformed
  entry`, so the install ended with errors and no plugin was reconciled.
  `synced` is now a known scope: the row is read for duplicate detection and
  never installed, enabled or removed, like `project` and `local`. A
  well-formed row with a scope the installer does not know is skipped with
  one line per scope naming the plugin ids, so a future scope does not break
  the install either. A row that is malformed in shape, including a
  non-string scope, stays fatal. A declared plugin that is present only as a
  synced row still gets its own user-scope install; the synced row is left
  untouched (issue #338).
- Deploy guard: the force-push rule only counts a force flag in the
  arguments of the same `git push`. Before, it matched `git push` and a force
  flag anywhere in the command, so `gh api … -f body=x && git push origin
  feat`, `git push origin main && npm cache clean --force`, `grep -f … && echo
  'see git push docs'` and a broker call whose quoted page text mentioned
  `git push` next to its own `-f` were blocked. It now also blocks force
  pushes it let through: `git -C <dir> push -f`, `git -c k=v push -f`,
  `git --git-dir … push -f`, `git push -fu`, `git push origin +main`,
  `+HEAD:main` and `--force-with-lease=` with an empty value.
  `--force-if-includes` alone and `-f` after `--` stay allowed. The new
  `hooks/lib/git-push-match.mts` splits the command into simple commands in
  one linear pass, scans quoted words again as shell down to depth 3, reads
  heredoc body lines word by word, and when it cannot parse the command it
  falls back to the old
  regexes, so the rule still fails closed. The installer manifest lists the
  new module (issue #327).
- Confluence brokers: `labels --id <page>` without `--labels` or `--remove`
  is read-only. It sends one GET and prints `labels: a, b` or `labels: none`.
  Before, it posted the computed runtime label, so reading a page from a
  second host gave it a second runtime label. `labels --labels` reads the page
  first: an existing runtime label is kept (`runtime: kept <label>`) and only a
  page without one gets the computed label (`runtime: added <label>`); when
  nothing but a runtime label would be added to such a page, it refuses with
  exit 1 and writes nothing. `create` gives every new page the computed
  runtime label, also without `--labels`; before, a page created without
  `--labels` carried none. When that label write fails, `create` exits 1 and
  names the page that now exists without a runtime label (issue #318).
- Confluence brokers: `search` passes `--limit` to the semantic search as
  `min(max(limit, 25), 100)`, where 100 is the `twg rovo search` maximum.
  Before, the limit never reached it and every search asked for the default
  25 proposals. After the hits it prints `truncated: true|false`; true means
  `--limit` cut off a further matching page, the proposals filled the request,
  or `--limit` was above 100. Exit codes are unchanged (issue #315).
- Control plane node: `delivered` is a read receipt on every path. The
  messages a new Claude intercom session carries in its task text are offered
  to it and become `delivered` only once its turn completed (the session
  `done` in the watch round, or its own `Stop`); before, a session still
  `working` 30 seconds after its start already counted. A failed or stopped
  turn offers them again. The records an MCP `inbox` read returns are offered,
  so a reply or the session's `Stop` confirms them; a read that does not fit
  the transport offers nothing, and `StopFailure` stays no receipt. The node
  answers every final `message.status` it recorded (`delivered`, `replied`,
  `refused`, `expired`), also for a message without a local `sent/` record,
  with the event `message.status.ack`, and advertises `messaging.ack.v1`. An
  older Worker ignores the event (issue #308, PR 3 of 4).
- Control plane node: outbox resends and inbox status re-reports back off on a
  live connection. The first resend still comes exactly 30 seconds after the
  first send, later ones wait with equal jitter up to 10 minutes; a status is
  reported at once for each new state or progress and then on the same
  schedule. The schedule starts over after the Worker answers and on every new
  connection. `directory.request` bursts from the `msg` CLI are coalesced to
  at most one directory request per 10 seconds per connection. Before, every
  unanswered status was re-sent on each 2-second exchange round (issue #308,
  PR 2 of 4).
- Control plane Worker: a message send, a status report and a sender's
  reconnect replay no longer scan the whole `messages` table, which keeps every
  final-state row. Two additive indexes (`messages_queued_expiry`,
  `messages_from_node`) serve the hot queries, which name them with
  `INDEXED BY`; a third, `messages_state_updated`, is created for a later
  sweep of final-state rows and is not read yet. With 2,000 final-state
  messages a send now reads 4 rows instead of 4,009, a status report 5 instead
  of 2,008, and the cost no longer grows with the table. The Registry caches the directory rows until a
  write to nodes, runtimes or sessions. A new SQL meter logs one
  `registry.sql` line with `path`, `rowsRead` and `rowsWritten` per Registry
  request, without message text, and the committed `wrangler.jsonc` and the
  README override example turn on Workers Logs; it takes effect with the
  operator's next deploy (issue #308, PR 1 of 4).
- Bootstrap: `drift-check.sh` compares the optional Jira helpers in
  `<workspace>/tools/` when `KHEREP_INSTALL_ATLASSIAN_TOOLS=1` is set or when
  any of the twelve exact file names is present. Before, it compared them only
  with the switch, so a stale `atl-jira.mts` from an earlier installation with
  the switch passed as clean. A stale file is now `DRIFT` and the absent members
  of an incomplete set are `MISSING-LIVE`. Without the switch and without any of
  these files the check still passes and prints one informational
  `NOT-INSTALLED project/tools/<Jira set>` line. Look-alikes such as
  `atl-jira.mjs`, `*.bak-*` copies and `_deprecated/` never count as present
  (issue #302).
- Session observations: the brief marks each finding `measured:`, with the
  command and the deciding output excerpt, when the dispatching session ran it
  in this turn, and `relayed:`, with its source, otherwise. `claude-obs` and
  `codex-obs` label a `measured:` finding with that evidence `confirmed` and
  put the command and excerpt in the page body; a `relayed:` finding, a
  `measured:` one without evidence, or an unmarked one stays `assumed`. The
  origin line names the actual reporter, a title says "(operator-reported)"
  only when the operator is the source, and the dispatching session is never
  called the operator. Before, findings the dispatching session had measured
  in the same turn were filed as assumed and operator-reported. Both
  `ROUTING.md` files and the three observation hook reasons state the brief
  contract (issue #309).
- Session observations: both dispatch guards check the brief format before
  the observation agent starts. A `claude-obs` prompt or a `codex-obs`
  message is denied when it marks no finding, when a `measured:` finding has
  no command in an inline code span or no `->` with an excerpt after it, or
  when a `relayed:` finding is empty; the Claude rule id is `OBS_BRIEF_FORMAT`.
  The reason names the finding by position and states the exact format, so
  the session can resend in the same turn. The Claude guard reads the Agent
  prompt only, never the description. The check lives in the new
  `claude/hooks/lib/obs-brief-policy.mts`, which the Claude manifest installs
  and the Codex guard loads from its installed `lib` sibling; Codex hook
  integrity checks and restores it. The three observation hook reasons and
  both `ROUTING.md` files now state the exact syntax. Before, only the Stop
  hooks described the format, so a session that dispatched the agent on its
  own never saw it (issue #331).

## [0.2.0] - 2026-10-07

### Added

- Control Plane: with `wake.replies: true` the messages of a task an idle
  Claude Code session requested with `msg send <node> --new` also wake it
  without a listing, so the task's plain `msg send` answer, which carries the
  task id and no `inReplyTo`, is not left waiting for the next user turn. The
  grant needs the request to be dispatched, the message to come from the node
  the task was dispatched to, the request to be at most 24 hours old, and the
  requesting session's id, which `msg send --new` and `task new` now keep locally as
  `requestedBySessionId` and never sends to the Worker, to match (a request
  without it matches by `requestedBy`). It covers every message of the task,
  bounded by the turn budget. Audit lines name `"grant": "task"`, delivery
  progress reports such messages like replies, and Codex requesters are out
  of scope (issue #264).
- Control Plane: the optional node policy object `wake.budget`
  (`perHour`, `perDay`, `spacingSeconds`) sets the per-session budget of
  autonomous turns, which stays 6 per rolling hour, 20 per rolling day and
  30 s apart without it or for a missing field. Values must be integers within
  hard bounds (`perHour` 1 to 60, `perDay` 1 to 500, `spacingSeconds` 5 to
  3600), an explicit `perDay` at least `perHour` (without it the day allows at least `perHour` turns); anything else, or an unknown key,
  rejects the whole `wake` section. The Claude Code wake listener, the Claude
  and Codex `Stop` continuations, the Codex task resume, `codex queue` and
  closed-session delivery use the same effective budget, and `doctor` shows it
  as `wakeBudget` (issue #259).
- Control Plane: the opt-in node policy switch `wake.replies: true` lets a
  reply wake the idle Claude Code session that sent the original message,
  without listing the session; `sessions` may then be empty. The grant needs
  the reply to come from the node the original was sent to, the original to
  be at most 24 hours old and not refused, expired or error, and the sending
  session's id, which `msg send` now keeps locally as `fromSessionId` and never
  sends to the Worker, to match (a sent record without it matches by name).
  Every other wake guard still applies; audit lines name `"grant": "reply"`,
  delivery progress reports such replies, and `doctor` shows the switch. A
  non-boolean value turns waking off. Codex wake paths are unchanged
  (issue #253).
- Control Plane: `GET /health` also returns the bundled product `version`,
  an optional deploy-time source `commit` (`--define KHEREP_BUILD_COMMIT`) and
  `remoteMcp`, still without authentication or configuration values. Existing
  fields are unchanged (issue #215).
- Control Plane: `kherep-node doctor` prints a JSON report on enrollment and
  key, daemon liveness, Worker reachability and version, policy and wake
  summary, installed runtimes and versions, hook paths against this checkout
  and live wake listeners, and exits 1 when a check fails. The daemon now
  writes `daemon.json` (pid, start, last authenticated connection and lost
  connection time) for it (issue #215).
- Control Plane: `kherep-node doctor` reports each runtime's `ready` from the
  daemon's last readiness probe instead of `"not available"`: `true`, or
  `false` with the fixed `cause` (`sign-in`, `timeout`, `error`), each with
  `probedAt` and `aged` (older than the daemon's 10 or 2 minute revalidation
  bound), or `"unknown"` when the daemon is not running or has not probed that
  runtime. Doctor never probes. A runtime the sessions policy names whose last
  probe needs a sign-in fails the `runtimes` check. The daemon records each
  completed probe in `daemon.json` as `readiness.<runtime>`, without the
  probe's output (issue #222).
- Control Plane: a runtime readiness probe (issue #197). `claude auth status`
  reported `loggedIn: true` for an expired login, so the node checks each
  enabled runtime with a real minimal call: `claude -p --safe-mode
  --no-session-persistence --tools ""` with a one-line system prompt, and
  `codex -c features.hooks=false exec --ephemeral --sandbox read-only` with the
  user's config, no hooks and its MCP servers disabled as for intercom runs. It probes once at daemon start;
  afterwards a verdict is used stale while it revalidates in the background
  (ready after 10 minutes, not ready after 2, also from the session round; 45
  second timeout), and no probe runs on the daemon's frame lane. A ready
  runtime is advertised as `runtime.claude.ready.v1` or
  `runtime.codex.ready.v1`. For a runtime that is not signed in, a task start
  or continue fails with `target runtime <runtime> not ready (sign-in
  required)` and starts nothing, and a message that a closed-session delivery
  or a Codex message resume would carry is `refused` with that reason instead
  of `delivered`. A probe that timed out or failed otherwise blocks no task;
  messages wait with `retry-pending`.
- Control Plane: a task or intercom run without first turn progress 10
  minutes after its start is stopped and reported `failed` with `no progress
  after start` (issue #197). The messages a Claude intercom run carried are
  refused with `target run made no progress after start`; those of a Codex run
  get the `wake-failed` progress and are offered again within the offer limit.
- Control Plane: `msg status` and `msg send --wait` show the sender states
  `running` and `stopped`, derived from the existing accepted progress codes
  without a new wire state, and an accepted message without progress for 5
  minutes gets a fixed actionable reason (issue #197). Messages for Codex task
  sessions now carry a progress code while the task is busy, stopped by its
  operator, held by a wake guard, failing to resume or running.
- Control Plane: the MCP `status` tool also returns `senderState` (`running`,
  `stopped` or the canonical state, from the same `senderState` function as
  `msg status`) and, for an accepted message without progress for 5 minutes,
  a fixed `hint` (issue #197). The `state` field is unchanged.
- Control Plane: a Codex intercom run the node started on its own is listed
  with `kind` `codex-intercom` instead of `codex-task`, so the MCP `sessions`
  tool tells it apart from a requested task; `msg sessions` marks both as
  `[background task]` (issue #198).
- Control Plane: an idle Claude Code session wakes after a restart without any
  user input (issue #101). A `SessionStart` input without `permission_mode`
  and without a stored mode now takes the mode of the last user entry in the
  session transcript (`transcript_path`, the last 2 MiB, only the
  `permissionMode` field, a regular file under `projects/` of the Claude
  config directory; `node/transcript-mode.mts`) and stores it. A missing,
  foreign or unreadable transcript, or `bypassPermissions` there, still
  refuses; the listing, settings and launch flag checks run as before. The
  listener armed there also wakes once, after 8 s, for messages that arrived
  while no listener ran (audit `backlog`), each at most once and under the
  same guards and budget; a prompt within those 8 s supersedes it.
- Control Plane: a message for a session of this node that is no longer
  running is still handled when the node policy sets
  `messaging.resumeClosed: true` (issue #102, default off). The daemon
  resumes the known session in the background in its recorded `auto` or
  `default` mode (Claude Code `claude --resume <id> --bg`, Codex
  `codex exec resume <thread>`) with the fixed wake text, so the message
  arrives as framed peer content, or otherwise starts an intercom session
  with the closed session's runtime and working directory and a directive
  that names the automatic fallback. The guards of `--new` and the wake apply
  fail closed (kill switch, sessions and runtime, `delegate.accept` and the
  accept rules, reply depth, never `bypassPermissions`, `maxConcurrent`,
  workspace roots, the session's turn budget), a message causes one attempt
  at most, and every outcome is audited in `wake.jsonl` as `closed-session`
  `resumed`, `new` or `refused` with the reason. Every successful listing is
  kept for 7 days in `known-sessions.json`.
- Control Plane: a message for a closed session goes to one intercom session
  per sender session instead of resuming the closed session, whose whole
  conversation a resume would reload (issue #105). The newest intercom session
  the node started itself for the same sender (`requestedBy`
  `<node id>/<session>`) gets it: a running one through its delivery hook and
  wake, the message readdressed to it (`closedTo` keeps the closed session)
  and its task grant extended to the messages of that sender; an ended one is
  resumed in the background (`claude --resume`, `codex exec resume`). Only
  without such a session, or when its resume fails, a new one starts. The
  closed session itself is no longer resumed. Every message now carries its
  threaded reply command: a new intercom session gets the messages framed as
  the delivery hook frames them, each with
  `<cli> msg send --reply-to <message id> -- <reply text>`, and is told to
  answer with it, as the hook and the Codex resume already frame it. The
  guards stay fail closed; the audit outcome `resumed` is replaced by
  `reused` (with the intercom session's `taskId`), next to `new` and
  `refused`.

- Control Plane: the Claude Code wake listener is armed at `SessionStart` too
  (issue #97), so an idle session is wakeable again after its process
  restarts (app restart, `--resume`, `--continue`, `/clear`, fork) without
  waiting for the user to type. The installer adds the entry last to the
  `SessionStart` hooks with the same `asyncRewake` and timeout. A following
  prompt supersedes that listener as before. After `compact` the session
  counts as busy, because auto-compaction runs inside a turn. A `SessionStart`
  input carries no `permission_mode`, so the listener arms there only when,
  fail closed, the mode the session's last prompt or `Stop` reported
  (`listeners/<id>.mode.json`) exists and is not `bypassPermissions`, the
  session is listed by id or name, no readable settings layer sets
  `defaultMode` `bypassPermissions`, and no launch flag of the owning Claude
  process points to bypass (`node/launch-mode.mts`). Anything it cannot read
  refuses with the audit `permission-mode-unknown`.

- Control Plane: `kherep-node attach <node>/<session>` resolves a session
  through the directory like `msg send` and prints the command to open it on
  its host (issue #81): `claude attach` and `claude logs` with the 8-character
  short id for a Claude Code background session, a note for an interactive
  one, and the thread title with `codex resume <thread id>` for Codex. An
  optional operator-written `attach.json` in the node's `control-plane`
  directory maps a node to an SSH target, which prefixes each command with
  `ssh -t <target>`; a session on this node gets no prefix. The command only
  prints; it runs nothing, opens no connection, and no session content
  travels through the Worker.

- Control Plane: `msg sessions` shows the Codex thread title the Codex app
  shows next to the session name, quoted, on the listing node and on peer
  nodes (issue #88). The daemon reads it from `session_index.jsonl` in the
  Codex home with a bounded, fail-soft read and publishes it as the optional
  session field `title`; the Worker stores it in a new nullable column.
  Titles are display only and never an address. Titles appear in the
  directory only after the Worker is deployed; older nodes and Workers
  ignore the field.

- Control Plane: the daemon wakes an idle interactive Codex session (TUI or
  app) for peer messages with `codex queue --thread <id> --message <pointer>`,
  a fixed text with the message count only; the woken turn's delivery hook
  offers the messages. The Claude wake's guards apply (kill switch, wake
  allowlist, no `bypassPermissions`, reply depth, shared budget), one queue per
  message, no second queue while one is unconfirmed, and never a flag that
  changes the sandbox or approvals. The Codex delivery hook records the
  session's permission mode; a session without one is woken only when the
  allowlist names it by its full id. `codex queue` runs on its own lane and is
  killed with its process tree after 30 seconds. Codex session names now use
  the random tail of the thread id (`codex-<last 8>`); the old prefix name is
  accepted only where it is unambiguous, and wake authorization uses the full
  id only. The Codex Stop continuation is budgeted and never runs in
  `bypassPermissions`.

- Control Plane Codex tasks: `POST /api/tasks` with `requirements.runtime`
  `codex` goes to a node that lists `codex` as a CLI runtime, and that node
  runs `codex exec --json` detached, with stdin from the null device, only
  when its `sessions.runtimes` lists `codex` (the default stays `claude`).
  Permission modes map to Codex sandboxes (`auto` and `acceptEdits` to
  `workspace-write`, `default` to `read-only`); the bypass flags are never
  passed. The task's session id is the `thread_id`; the node reports
  `started`, then `done` with the last message as summary or `failed`,
  continues with `codex exec resume`, and stops the process group by pid
  after checking its start time. Claude and Codex tasks share the limits.
  The Worker accepts runtime `codex` once redeployed. Codex task sessions are
  listed in the node's session snapshot from the task records (thread id,
  task name, runtime `codex`). A peer message for an ended Codex task resumes
  it with the message framed as the delivery hook frames it, under the Claude
  wake's guards (kill switch, allowlist or task grant, reply depth, budget),
  one run per task, and is confirmed when that run completes. The process can
  write the node's outbox (its only extra writable root) and gets
  `KHEREP_CONFIG_DIR` and `KHEREP_SESSION_ID`, so `msg send` works from the
  sandbox; the msg CLI honours `KHEREP_SESSION_ID` when
  `CLAUDE_CODE_SESSION_ID` is not set. The prompt goes to Codex on stdin, never as a
  process argument. A Codex task whose process cannot be identified after a
  daemon restart is reported failed (`process identity unknown`).

- Control Plane tasks: the operator creates a task with `POST /api/tasks`
  (behind Access), and the Worker dispatches `session.start` to an online node
  that advertises `sessions.v1` and matches the runtime, os and capabilities,
  the one with the fewest active tasks (409 with the reason when none fits).
  The node runs `claude --bg --name task-<id> --permission-mode <mode>` in a
  working directory inside its workspace roots, maps the session id from
  `claude agents --json --all`, reports state changes with `task.report`, and
  stops a session after its max runtime. `POST /api/tasks/{id}/stop` and
  `/continue` stop or resume it. Off unless the node's `policy.json` enables a
  `sessions` section; per node at most 3 running task sessions, 10 starts per
  rolling day and 120 minutes per run, permission mode `auto` by default,
  never `bypassPermissions`, Claude first (Codex: see the entry above). Sessions report
  with `kherep-node task done`, `msg send` tags messages with the task, and the
  wake listener wakes a task's session for messages of its task beyond the
  allowlist, within the budget. A session may request a task with `task new`
  only on the operator's directive and only when both nodes opt in
  (`sessions.delegate.request` and `.accept`); a session started for a task
  cannot request one. The audit records task actions, the requesting session
  and the directive, never the task text.

- Control Plane: an idle Claude Code session wakes when a peer message
  arrives, if the node's `policy.json` opts in with a `wake` section that
  lists the session (by id or name, or an explicit `"*"`); without it nothing
  is woken. A listener (`modules/control-plane/node/wake-hook.mts`) runs with
  `asyncRewake` after the delivery hook on `UserPromptSubmit` and `Stop`, one
  per session, and takes its re-arm deadline from the `--timeout` its entry
  carries. Wakes and `Stop` continuations share a budget of 6 per rolling
  hour, 20 per rolling day and 30 s spacing per session; a session in
  `bypassPermissions` is neither woken nor continued. It does not wake at reply
  depth 6 or deeper, wakes once for an offer left by a turn without `Stop`,
  ends when its Claude Code process is gone, re-arms itself before its timeout,
  and can be switched off with a `wake.disabled` file in the node directory;
  every decision is logged to `wake.jsonl` without message text. A prompt typed
  while a turn is still running no longer re-offers that turn's messages; they
  are re-offered after `StopFailure` (now wired) or after 10 minutes. `msg
  send` addresses sessions by id, policy rules match the id or the session's
  current name, and the peer framing follows the new peer-coordination rule.
- Control Plane, Phase 1 (`modules/control-plane/`). A Cloudflare Worker
  `kherep-control` with two SQLite-backed Durable Objects: `NodeSession`
  holds each node's hibernatable WebSocket, the Ed25519 challenge handshake,
  a seq/ack pending-command log resent after reconnect and alarm-based
  offline detection (5-minute interval, offline after 3 missed intervals);
  `Registry` keeps nodes, runtimes, sessions, one-time enrollment codes and
  an audit trail. `/node/*` is gated only by the signed challenge; `/api/*`
  requires a Cloudflare Access JWT and fails closed without the team domain
  and AUD. Only `node.status`, `runtime.list` and `session.list` can be
  dispatched. The `kherep-node` CLI and daemon (`node onboard|status|unenroll`,
  `daemon`) generate and keep the node key locally, discover `claude`,
  `codex` and loopback LM Studio/Ollama, reconnect with jittered backoff up to
  60 s and enforce a local allowlist. The committed `wrangler.jsonc` holds
  placeholders only; deployment uses an operator-local override config.
  `npm run test:control-plane` runs the node tests; the Worker has its own
  package and test suite.
- `get --id <page> --body-only [--format storage|adf]` on both Confluence
  brokers prints only the page body to stdout, without metadata and without
  an added newline, so `> file` yields exactly the body. One request with
  the v2 `body-format` parameter; an unmapped or empty `--format`, `--format`
  without `--body-only`, and an answer without the requested representation
  fail on stderr with a non-zero exit. The brokers still write no file. Plain
  `get` is unchanged.
- A per-repository opt-out from the work-item key. The `commit-msg` hook skips
  the key check when the repository-local Git config
  `kherep.workItemRequired` is a Git boolean false (`false`, `no`, `off`,
  `0`). A non-empty `KHEREP_WORK_ITEM_REQUIRED` at commit time still wins,
  then the repository value, then the policy file. Global and system values
  do not opt out; an absent, unreadable or invalid value keeps the rule. AI
  attribution trailers are still rejected in an opted-out repository.
- The Claude installer wires the control-plane delivery hook
  (`modules/control-plane/node/deliver-hook.mts`) into the `UserPromptSubmit`
  and `Stop` hooks of the user `settings.json`. It runs from the Kherep
  checkout through the new `__KHEREP_REPO__` placeholder, rendered with
  forward slashes and quoted like the other hook paths; `drift-check.sh`
  renders the same path and `capture.sh` maps it back. Without an enrolled
  node the hook finds no inbox and exits 0 without output.
- Control Plane Codex sessions (issue #31, step 4). The delivery hook takes
  `--runtime codex` and then serves Codex `SessionStart`, `UserPromptSubmit`
  and `Stop`: it records each session in `codex-sessions/`, tells the session
  its id at start, offers messages as developer context with a `--from` reply
  command, and at `Stop` continues the turn with a fixed text, never peer
  content, when new messages wait. The daemon lists Codex sessions seen within
  12 hours, `msg send --from <codex id>` sends as the session's name, and the
  Codex installer adds the three hooks to its managed block. The hooks must be
  trusted in Codex before they run.

### Changed

- Control Plane: Claude delivery progress builds the task request index once
  per observation instead of once per session; behaviour is unchanged
  (issue #266).
- Claude hooks: the six blocking guards move from JavaScript to TypeScript
  (`.mts`, ESM, Node type stripping), with their tests and
  `portable-scope-hooks.test`: `commit-guard`, `deploy-guard`,
  `dispatch-contract-guard`, `playwright-file-guard`, `privacy-boundary-guard`
  and `secret-output-guard`. Behaviour is unchanged; every existing guard test
  passes with the same count. `claude/hooks` holds no `.js` file any more and
  `legacy-javascript.txt` is empty. The settings template wires the `.mts`
  files, and `retired.txt` lists every old `.js`, so an install parks them in
  `hooks/_deprecated` and unwires every command that still runs one, including
  the legacy groups hosts carry under their own matchers. The Codex installer
  copies and wires the `.mts` names of `commit-guard`, `deploy-guard` and
  `playwright-file-guard`, removes their old `.js` copies (kept in the install
  backup) and recognises the block an earlier installer wrote with the `.js`
  names, so an upgrade replaces it instead of refusing. New tests run each of
  the six guards through its wired Claude command, and the three shared ones
  through their wired Codex command after an install, show that a 0-byte or
  missing guard fails those checks, and prove that each template matcher covers
  every tool a legacy matcher covered. Closes issue #237.
- Claude hooks: nine hooks move from JavaScript to TypeScript (`.mts`, ESM,
  run by Node's type stripping like the other `.mts` hooks), with their tests
  and `lib/semver-compare`: `clq-accept-gate`, `critical-file-integrity`,
  `drift-check-nudge`, `live-hook-integrity`, `maestro-banner-gate`,
  `maestro-discipline`, `orchestra-default`, `runtime-capability-snapshot` and
  `smoke-test-nudge`. Behaviour is unchanged. The settings template wires the
  `.mts` files; an install over an existing installation parks the old `.js`
  files in `hooks/_deprecated` through the install transaction
  (`retired.txt`), and the rendered settings keep only the `.mts` wiring. New
  tests run the two converted hooks that block, `clq-accept-gate` and
  `maestro-banner-gate`, through their wired settings command, and cover
  `critical-file-integrity`, which had no test. Part of issue #237; the
  remaining guards follow in a second batch.
- Control Plane: a message that a new Claude intercom session carries in its
  task text is `delivered` once the watch round sees that session's turn
  progress, no longer when `claude --bg` returns; until then it stays
  `accepted` with `fallback-running` (issue #197).
- **BREAKING** Control Plane: `msg send`, `msg send --new`, `msg inbox --from`
  and `msg sessions --from` no longer take `--from` as typed (issue #200).
  `--from` must name the session of `CLAUDE_CODE_SESSION_ID` or
  `KHEREP_SESSION_ID` by id or name, or be the full id of a Codex session a
  Kherep hook recorded within the last 12 hours, with no conflicting
  `KHEREP_SESSION_ID`. Refused with `is not a verified sender`, and nothing is
  written: an arbitrary name such as `--from ops`, a short `codex-<8>` alias, an
  id no hook recorded, and a record older than 12 hours. Call it correctly by
  omitting `--from` in Claude Code sessions and node-started Codex runs, or, in
  Codex, by passing the full session id the `SessionStart` hook context names
  (`msg send --from <session_id>`). A Claude Code variable that a Codex process
  inherited does not block its hook-recorded id. Missing-session errors now
  name both variables.
- Control Plane: `msg sessions` and the `msg send --new` result mark
  node-started background tasks and name the commands for their status and
  transcript (issue #198); `msg status` lists threaded replies (issue #200);
  new `msg stop` stops one task through owner task control and reports
  `stopped` only for a confirmed process-tree exit of the measured run
  (issue #199).
- The Claude user settings now set `attribution` with an empty `commit`, an
  empty `pr` and `sessionUrl: false`, so Claude Code no longer instructs a
  `Co-Authored-By` trailer in commit messages or an attribution line in pull
  request descriptions. The object form is used because the shorthand
  `attribution: false` needs Claude Code 2.1.281 or later, and older versions
  discard the whole settings file. The existing commit guards are unchanged.
  Reinstall to apply.
- `engines` in `package.json` is now `^22.18.0 || >=23.6.0`. Node 23.0 to 23.5
  cannot run the TypeScript sources without a flag; unflagged type stripping
  arrived in Node 23.6.0.
- The retirement manifest `bootstrap/manifest/retired.txt` can now name
  workspace files with the `project/` prefix that the installer and
  drift-check already use. Such an entry lists the SHA-256 of every version
  the installer placed there, hashed with CRLF folded to LF
  (`project/<path> sha256:<hex>[,<hex>...]`), and an entry without hashes is
  rejected when the manifest is read. The installer parks the file in a
  `_deprecated/` sibling inside the workspace only while its content matches
  one of those hashes, with its previous version in the installation backup
  under `retired/project/`, and a rollback puts it back. Other content is
  kept in place and reported as
  `retire: KEEP <entry> (content not placed by the installer)`, without a
  backup or journal entry, and the installation continues (#45). An entry that
  is absent on the host is skipped. A `_deprecated/` directory the pass
  creates is journalled, and a rollback removes it again while it is empty.
  drift-check reports a declared retired path that is still present, in the
  Claude home or in the workspace, as `RETIRED-LIVE`. The line is information:
  it does not change a PASS or the exit code, and the session-start drift
  nudge does not count it (#45). With `DRIFT_SCOPE=project` only the workspace
  entries are checked.
- The Codex installer retires workspace files through the same
  `bootstrap/manifest/retired.txt` and the same rules as the Claude installer
  (#44). It reads the `project/` entries, ignores the Claude-home entries,
  refuses the whole manifest before anything moves when an entry is invalid,
  and parks a file in a `_deprecated/` sibling only while its content matches
  one of the listed hashes; other content is kept and reported as
  `retire: KEEP <entry> (content not placed by the installer)`. A parked file
  has its previous version in the installation backup under `workspace/`, an
  occupied destination gets a dated suffix, and a rollback puts the file back
  and removes a `_deprecated/` it created while that is empty. Retirement now
  runs on every Codex install, also without `KHEREP_INSTALL_ATLASSIAN_TOOLS=1`.
  The installer no longer deletes the old `tools/*.mjs` Jira brokers from its
  own hardcoded list: six of them are now declared in `retired.txt` with the
  hashes of the versions the installer placed, so both installers park them.
  `tools/jira-config.mjs` has no known placed version and is no longer
  retired automatically.
- The Claude installer writes the system-wide `core.hooksPath`, which binds
  every account on the host, only with `KHEREP_INSTALL_SYSTEM_HOOKSPATH=1`.
  Without it the installer reads the value and, when it differs from Kherep's
  hook directory or is unset, prints both values and changes nothing, even when
  the system file is writable without elevation, as it can be with Git for
  Windows. With it the installer reports the value it replaced, and a failed
  write fails the install. The global and repository-local bindings are
  unchanged.
- Atlassian brokers: all four brokers parse arguments strictly from a per-verb
  flag table in the new shared module `atlassian-cli-args.mts`, which installs
  with the default Confluence set. A positional argument, an unknown flag, a
  flag without a value, a repeated flag or a missing required flag is refused
  before any configuration, credential or network access, and the message
  names the verb's full syntax and, for a positional, the call it probably
  meant (`Did you mean: get --id 275907063`). Before, the Claude Jira and both
  Confluence brokers skipped positionals and unknown flags silently and kept
  the last of a repeated flag. `help`, `--help` and `-h` list every verb with
  its flags and exit 0; the Codex Jira broker returns the list as JSON.
  `selftest` with arguments is now an error, a caller-supplied `--version` on
  Confluence `update` is refused instead of ignored, and a refused `search`
  call stays `status: unavailable` with exit 2. `stitch --dry-run --id <id>`
  keeps the id instead of reading `--id` as the value of `--dry-run`, and the
  routing documents name `stitch --space <key> --id <id>` (issue #299).

### Removed

- The MPAC tools (`modules/mpac-tools/`, Atlassian Marketplace vendor
  reporting). They are not part of Kherep's purpose. The installer no longer
  places `<workspace>/tools/mpac/` and drift-check no longer compares it;
  `KHEREP_INSTALL_ATLASSIAN_TOOLS` now gates only the Jira helpers. On hosts
  that installed them earlier, an upgrade parks `<workspace>/tools/mpac/mpac.ps1`
  and `README.md` in `<workspace>/tools/mpac/_deprecated/` through the
  retirement manifest.

### Fixed

- Claude hooks: `live-hook-integrity` and
  `bootstrap/wired-blocking-guards.test.mts` no longer use `node --check` for
  `.mts` files. `node --check` never type-strips a `.mts`: it compiles the raw
  source as CommonJS with module detection, exits 0 for any file that contains
  `import` or `export`, so `export const x = ;` passed as healthy, and rejects
  valid type annotations in a file without them, so a healthy hook such as
  `const x: number = 1;` was reported as broken and overwritten (measured on
  Node 26.10.0; the same code is in 22.18.0 and 24.1.0 by source). The new
  `hooks/lib/hook-syntax.mts` runs the two parsers Node runs at load time,
  in-process and without executing the hook: `module.stripTypeScriptTypes`,
  then a V8 module parse of the stripped source through a `data:` import whose
  link is made to fail, so top-level code never runs; about 1 ms per file
  instead of a child process. A report line for such a file reads "rejected by
  Node's parser". The `.js` path (`vm.Script`, confirmed by `node --check`) is
  unchanged. Only the stripper's own ExperimentalWarning is filtered in the
  hook's process; every other warning, Node's type-stripping warning included,
  still prints. Known limits: link-time SyntaxErrors such as
  `import { nope } from "node:fs"` are not detected, as `node --check` never
  detected them; a Node build without `module.stripTypeScriptTypes` gives
  UNGEPRUEFT, never OK; and the new library joins the integrity hook's own
  imports, which it cannot heal for itself (issue #279). Tests cover the ESM
  error shapes, TypeScript-only and V8-only errors, valid typed code without
  imports, non-execution, BOM and CRLF, the warning filter and the
  command-line entry `node hooks/lib/hook-syntax.mts <file>`.
  `bootstrap/smoke-test.sh` follows separately (issue #278).
- Claude hooks: `live-hook-integrity` now also measures the files a wired hook
  imports, the transitive closure of its relative static imports under
  `hooks/` (including `hooks/lib`), classifies each as missing, 0 bytes or
  rejected by `node --check`, and restores it from the checkout with the same
  SHA-256 proof as a wired file. `node --check` does not resolve imports, so a
  hook whose library was missing or empty passed it and then failed at import
  with exit 1, which Claude Code treats as non-blocking: a blocking guard
  failed open without notice. A report line names the importing hooks, and the
  journal entry records `kind` and `importedBy`. A restore now refuses to write
  through a symbolic link or into a directory that resolves outside the hooks
  directory. The inventory lives in the new `hooks/lib/hook-inventory.mts`,
  which the installer manifest lists, and
  `bootstrap/hook-require-resolution.test.mts` now fails when a file of that
  closure is missing from the manifest. New tests cover a missing, empty and
  syntax-broken library, a transitive and a sibling import, type-only imports,
  comments, imports outside `hooks/`, symlinks and the report-only case
  without a checkout. Known limits: an ESM-shaped syntax error in a `.mts`
  file, such as `export const x = ;`, is not detected, because `node --check`
  exits 0 for it on Node 26.10 (follow-up issue #278); the syntax-broken test
  uses a shape that `node --check` rejects. The integrity hook cannot heal its
  own three library imports (`lib/workspace-scope.mts`,
  `lib/orchestra-checkout.mts`, `lib/hook-inventory.mts`): if one of them is
  broken the hook itself fails at import, and only `drift-check` and the smoke
  test cover them (issue #273).
- `commit-guard.mts` no longer backtracks exponentially while it looks for
  `git ... commit` (issue #271, CodeQL `js/redos` alerts #16 and #17). Its
  regex read `-C` both as a flag and as a flag with a value, and `--long` both
  as `--` + `long` and `-` + `-long`; `git ` followed by 26 `-C -- ` pairs took
  2.3 s, and the time about doubled with each further pair, so a hook timeout let the call
  through. The new `hooks/lib/git-commit-match.mts` splits the command into
  tokens once and tracks the reachable tokens in one linear pass. It accepts
  exactly the strings the regex accepted: a seeded differential test of
  20,000 short token sequences finds no difference, and the guard's other
  checks are unchanged. The installer manifest lists the new module.
- Control Plane: on Windows the wake hook's kept run mode now hits (issue
  #248). Claude Code starts each hook through Git Bash, so the key
  `run-modes/<session_id>.<parent pid>.json` was new for every hook: each
  hook paid the full process listing (348 to 362 ms, measured 2026-10-06) and
  wrote an entry nobody read. A `claude -p` took a median of 8.1 s with the
  hooks against 5.6 s without them; this removes the listing from that
  difference after the first hook. The entry is now keyed on `CLAUDE_PID`,
  Claude Code's own pid, which survives the shell and which a nested
  `claude -p` sets anew, when it is a plain pid above 1; otherwise the parent
  pid stays the key, and when that parent is a shell nothing is written or
  pruned. Only a positive signal is headless, and an entry still answers only
  for what a full check of the same Claude Code process found, with the same
  entrypoint and within one hour.
- Control Plane: an interactive Codex TUI whose rollout starts like a Desktop
  chat (Codex 0.160) is woken with `codex queue` again instead of waiting with
  `awaiting-user-turn` (issue #268). New `codex-daemon.mts` asks the shared
  app-server daemon for `thread/loaded/list` over its control socket, a
  WebSocket over a unix socket, with a 2 s timeout and a 10 s cache. Only a
  thread the daemon lists that also has the marker
  `<codex home>/tui-thread-reference-capabilities/<id>` takes the TUI queue
  path, audited as `tui-reachable`; any probe failure, a missing marker, a
  thread missing from the list, and Windows, where the probe does not
  connect, keep the Desktop behaviour. `wake.codexApp` skips a reachable TUI,
  which needs its full id in `wake.sessions`.
- Codex hooks: `commit-guard` and `deploy-guard` now block under Codex on
  Windows (issue #258). Codex runs the Windows hook form under pwsh, which
  reports the guard's exit 2 as 1, and Codex treats that as a failed,
  non-blocking hook, so the tool call went ahead. `codex-hook-adapter.mts` now
  answers a guard's exit 2 in the PreToolUse phases with the documented JSON
  deny on stdout (`hookSpecificOutput.permissionDecision: "deny"`, the guard's
  stderr as `permissionDecisionReason`, or a fixed reason naming the guard when
  stderr is empty) and exits 0, on every platform. In a multi-command payload
  the first block answers alone and nothing after it runs. A guard's own JSON
  decision, a silent exit 0, any other exit code and the PostToolUse phase
  behave as before. The Claude Code wiring, which runs the guards directly, is
  unchanged.
- Bootstrap: `install.sh` with a `CLAUDE_HOME` other than `<HOME>/.claude`
  no longer changes global or system `core.hooksPath` and no longer runs the
  credential step, which read the file named by an inherited
  `KHEREP_ATL_CRED_FILE_CLAUDE` (issue #256). A candidate run that forgot one
  skip switch had pointed the account's Git hooks at a temporary directory. A
  non-default home that is the real Claude home opts in per step with
  `KHEREP_INSTALL_ALLOW_GITCONFIG=1` and `KHEREP_INSTALL_ALLOW_ATL_CREDENTIAL=1`.
  The new `KHEREP_INSTALL_PREVIEW=1` implies the Git configuration, runtime
  agent, credential and knowledge-space skips for any home, and the documented
  preview uses it. Each skipped step names its reason. The default-home install
  is unchanged.
- Bootstrap: an upgrade now unwires every `settings.json` hook command that
  runs a script listed in `bootstrap/manifest/retired.txt` (issue #252). A host
  could carry a second, legacy wiring such as `node ~/.claude/hooks/<name>.js`
  in groups of its own; the installer parked the file but left the command,
  which then failed with `Cannot find module` on every event. The settings
  render removes such a command from any event and group, whatever the spelling
  of the Claude home (the absolute path in drive or Git Bash form, quoted or
  not, and `~/.claude`, `$HOME/.claude` or `${HOME}/.claude` while
  `CLAUDE_HOME` is the default one; only `node <script>` commands are
  recognised), drops a group left
  without hooks, and prints one `retire: unwire <event> <command>` line per
  removal. Commands for scripts that are not retired, and commands that only
  name a retired file as an argument, stay. The new settings are written inside
  the install transaction, so a rollback restores the previous file.
  `drift-check.sh` now reports `DANGLING-HOOK <event> <command>` as drift for a
  wired command whose Claude-home script is missing or retired, under every
  `DRIFT_SCOPE`.
- Claude hooks: `clq-accept-gate.mts` is wired under `Stop` instead of
  `PreToolUse` `Bash`. It reads the Stop payload, and the only Stop wiring on
  existing hosts was the legacy `clq-accept-gate.js` entry that the upgrade
  above unwires. The settings render now also removes an entry the installer
  wrote for a managed hook (the hook under the absolute Claude home) at an event
  the template no longer wires that hook at, and prints
  `hooks: unwire <event> <command> (managed under <events>)`. Hand-written
  `~/.claude` entries and hooks the template does not manage stay.
- Control Plane: `kherep-node msg stop <messageId>` for a message delivered
  into an existing session no longer ends at the bare `not stopped: fresh
  status does not identify a stoppable run (denied, source_not_found)` (issue
  #241). Such a delivery starts no task, so the Worker holds no grant for the
  message. When the directory lists the message's target session under the
  task name of exactly one task this node requested on that node, `msg stop`
  stops that task through the existing fresh status and run-bound stop and says
  so; otherwise it names the target `<node>/<session>` and the message's
  progress and says the session matches no task the sender owns. No Worker or
  protocol change.
- Control Plane: the wake hook keeps its run mode per Claude Code process
  (issue #245), in `run-modes/<session_id>.<parent pid>.json` of the node
  directory for at most one hour and only for the same
  `CLAUDE_CODE_ENTRYPOINT`, so only the first hook of a process lists
  processes; read or write errors fall back to the full check. On macOS a kept
  decision took 0.02 to 0.03 ms instead of a median of 38 to 43 ms. Where a
  shell stays between Claude Code and the hook (Git Bash on Windows), every
  hook still checks in full. On macOS and Linux a `claude "daemon foo" -p`
  run, or a `claude -p` started by a session whose prompt begins with
  `daemon` but not `daemon run`, is no longer taken for the `--bg` daemon: its subcommands count
  only without `-p` or `--print` among the process's own options, and
  `daemon` only as `daemon run`. A `claude -p --resume` of an idle interactive
  session stays headless; the interactive session listens again from its next
  own prompt.
- Control Plane: a delegated task start the target refuses is no longer lost
  silently (issue #240). A Git Bash `msg send <mac> --new codex --cwd
  /Users/...` stored `C:/Program Files/Git/Users/...`; the Mac refused the
  start during admission without a log line or task record, and the sender
  saw `task_unknown` under a `dispatched` that never changed. Now the node
  logs every refused start (`task <taskId> refused: <reason>`) and every
  failed command result with its task id and reason, never the prompt. A start
  refused before a task record existed leaves a bounded record in
  `task-refusals/` (at most 256, 7 days) that only owner task control reads,
  so `task status` answers `taskState` `failed` with `processState` `closed`.
  A requesting node with owner task control advertises
  `sessions.own-task-control.report.v1`, and the Worker adds the state and
  reason of the target's last `task.report` as `reportedState` and
  `reportedReason`; older nodes and Workers never see them. `task show` says
  that `dispatched` means queued by the Worker, not acknowledged by the target,
  and shows the last status answer. `msg send <node> --new ... --cwd <dir>`
  refuses, before writing anything, a directory rewritten by Git Bash path
  conversion and, when the target's path style is known from its sessions in
  the directory, a Windows drive path for a POSIX node or the reverse; the
  error points to PowerShell or `MSYS_NO_PATHCONV=1`. The reported reason
  reaches the requester only after the Worker is deployed.
- Control Plane: a headless `claude -p` run no longer hangs until the wake
  hook's 24-hour timeout (issue #235). On Windows with Claude Code 2.1.289 the
  run waited for the wake listener, its only child process, and sent no API
  request. The listener still arms as before, so the arming order of a
  session's listeners is unchanged, but before its first poll it decides the
  run mode from one process listing. For a headless run it removes its own
  lock and scope (and the mode file this arming created), audits `headless`
  and exits 0. A process of the `--bg` machinery (`--bg-pty-host`, or the
  `daemon`, `bg-pty-host` and `bg-spare` subcommands on macOS) or its child,
  which includes the daemon's task and intercom sessions, is interactive; otherwise
  a run is headless when `CLAUDE_CODE_ENTRYPOINT` is `sdk-cli` or when the
  first Claude Code process above the hook has the option `-p` or `--print`.
  Windows command lines are split with their quoting, so a `-p` in a quoted
  prompt does not count. Anything undecided keeps listening. Task sessions no
  longer inherit the daemon's `CLAUDE_CODE_ENTRYPOINT` and `CLAUDECODE`. On
  macOS and Linux, where `ps` loses the quoting, a session outside the `--bg`
  machinery whose prompt holds a separate `-p` is taken for headless.
- Control Plane: `msg status` no longer calls a policy refusal of
  closed-session delivery a failed delivery session (issue #230). A message
  for a closed session whose working directory lay outside the node's
  workspace roots read `the local delivery session failed; delivery is not
  confirmed [failed/fallback-failed]`, because the node guessed the progress
  code from the refusal text and fell back to `fallback-failed`. Each refusal
  now names its code: the working-directory checks, `delegate.accept` and an
  operator sender wait with `wake-not-authorized`, `maxConcurrent` and
  `maxStartsPerDay` before an attempt with `retry-pending`, and the start
  checks a new intercom session needs (its runtime and permission mode) are
  made before the attempt with their own codes. `fallback-failed` remains for
  a start or resume that failed, including a new start the policy refuses
  after a failed resume, since that message is not tried again; its reason
  names the policy (`new start refused: ...`). The
  `wake-not-authorized` text now reads `the target node's policy did not
  authorize automatic delivery`. No new progress code: older Workers accept
  every frame.
- Control Plane: a message for an ended Codex task whose working directory
  the node's policy refuses (not absolute, missing, or outside the workspace
  roots) no longer reads as a failed wake (issue #239). The exchange round's
  resume reported that refusal as `failed/wake-failed`; it now waits with
  `waiting/wake-not-authorized`, the code closed-session delivery uses for the
  same check since issue #230, and the next round tries again. `wake-failed`
  remains for a resume that did not start. No new progress code: older
  Workers accept every frame.
- Control Plane: a message for an ended Codex task no longer stays
  `accepted` without a progress code while the node's policy has sessions not
  enabled or `codex` missing from `sessions.runtimes` (issue #244). The
  exchange round now labels it `waiting/wake-disabled` and audits `disabled`
  once per message, as under the kill switch; nothing starts. A refused
  working directory keeps `waiting/wake-not-authorized`, audits the new
  action `cwd-refused`, and logs `not resuming task <taskId> for messages:
  <reason>` once per message instead of on every 2-second round. No new
  progress code: older Workers accept every frame.
- Control Plane: a Codex run whose `codex exec` process dies abruptly no
  longer leaves its shell commands running (issue #233). On macOS a
  `sleep 901` outlived a SIGKILLed Codex intercom run in its own process
  group, re-parented to init; the run settled `failed` and `msg stop` found no
  running process. The watch round now records a live run's descendant
  processes with their start identities in the task record (at most 32, a
  start read only for a pid not recorded yet), and when the run settles
  `failed` after its root ended, or a stop finds the root already ended, it
  ends each recorded descendant that still has its recorded start identity by
  its own pid, SIGTERM and then SIGKILL, off the frame lane, and logs the pids.
  A reused pid is never signalled; a run that settles `done` keeps what it
  started.
- Control Plane: a task stop no longer leaves a Codex shell command running
  when it is outside the root's process group (issue #231). On macOS a
  `sleep 900` started by Codex missed the SIGTERM to the root's group, Codex
  exited, and the stop failed with "root process ended before SIGKILL while
  captured descendants still run" without ever signalling the child, which
  then ran on as an orphan. After each group signal, SIGTERM and then SIGKILL,
  the stop now signals every captured descendant that still has its captured
  start identity by its own pid (`taskkill /PID <pid>`, `/F` for SIGKILL, on
  Windows, where `taskkill /T` cannot reach a descendant whose root ended),
  also when the root has already ended. A reused pid is never signalled, the
  group is signalled only while the root is the captured process, and the
  stop is still confirmed only after every captured identity ended; otherwise
  it fails and names the ended or reused root and any failed SIGKILL send. A
  failed SIGTERM send no longer ends the stop before SIGKILL.
- Control Plane: the daemon removes the locks of wake listeners whose process
  is gone, at its start and then hourly, so doctor's `stale` listener count
  falls (issue #225). It never deletes by path: it renames a lock to a
  tombstone, deletes it only when its bytes still equal what it judged, and
  otherwise links it back without overwriting; if a file took the place
  meanwhile, the later-armed lock keeps it, by a clock-independent arming
  `order` (one more than the lock and scope in place at least; `startedAt`
  stays real time). A listener never yields
  to an older one: it puts its lock back when it is gone and the scope file
  names it or an older listener (the scope now records `order`), and
  writes it back over an older listener's lock. The scope file goes with its
  lock only while it carries that lock's token; the session's mode, budget,
  woken and queued files stay. Sweep failures are logged with their error codes,
  and a lock or scope read that fails is never taken for a missing file.
- Control Plane: a task stop no longer leaves the process tree running when a
  helper times out (issue #221). On a `windows-latest` runner the Toolhelp32
  process-tree query (`powershell.exe` with an `Add-Type` compile) hit its
  10 s limit, the stop threw before any signal, and the deadline test waited
  in vain for the tree to end. A query that timed out now runs once more.
  When a `ps` or PowerShell helper of the stop still times out, the stop
  forces the tree of the root if the root still has its recorded start
  identity (SIGKILL, `taskkill /T /F` on Windows) and still fails with the
  timeout, so the failure is logged and no unconfirmed stop is reported; a
  later watch round settles the task as an ended run. Any other failure is
  unchanged.
- Control Plane: on Windows a credential write or ACL check whose
  `powershell.exe` run hits its 5 s limit runs once more instead of failing
  with `remote_mcp_credential_unreadable` (issue #219). On loaded
  `windows-latest` runners the first start in a test exceeded the limit in
  three runs on 2026-10-04, while the write, its check and one bridge check
  took 0.9 to 3.3 s together in 14 passing runs. The writer removes the
  timed-out attempt's temporary file first; any other failure and a second
  timeout still fail closed.
- Control Plane: an outbox message the Worker did not answer is sent again on
  the live connection after 30 seconds instead of waiting for a reconnect, and
  inbox retention refuses a waiting message instead of deleting it unreported
  (issue #195). Regression tests cover a lost answer, a repeated send and a
  crash of either daemon in the middle of an exchange.
- Control Plane: operator Codex tasks (start and continue) no longer open
  visible console windows on Windows and still survive a daemon restart
  (issue #124). The daemon starts them detached through a small wrapper,
  `node/codex-windowless.mts`, run with its own Node: codex runs as the
  wrapper's attached child with all stdio piped, so Node starts it with
  `CREATE_NO_WINDOW` and its shells and MCP servers share a console without
  a window. The wrapper forwards the prompt, the events, stderr and codex's
  exit code; the pid, start time and `exit.json` the daemon records are the
  wrapper's, and `taskkill /T` on it ends codex and its children. Intercom
  runs and macOS and Linux are unchanged. `conhost.exe --headless` was
  measured and rejected: codex's stdout arrives as terminal escape sequences,
  the console host ends when its input closes and exits 0 whatever the exit
  code of codex.
- Control Plane: finished Codex tasks settle on Windows (issue #121). The
  start-time query exited 1 for a pid that had ended, so the watch took an
  ended process for a failed read: the task stayed `started`, the messages
  its run carried stayed `offered`, and `could not stop task ...` repeated in
  the daemon log. The query now returns no output and exit 0 only for "no
  such process" and still fails for any other error. A run whose `exit.json`
  the daemon recorded counts as ended without a start-time read, also past
  its deadline, and is not signalled on stop; tasks already stuck `started`
  with an `exit.json` settle on the first watch round after the upgrade.
- Control Plane: daemon-started Codex intercom runs no longer open visible
  console windows on Windows (part of issue #119). They start without
  `detached` there and share the daemon's hidden console; operator Codex
  tasks and other platforms stay detached. Such a run ends with the daemon,
  so the messages of a new Codex intercom session now wait for it `offered`
  and count as `delivered` only when its run completes the turn; a run a
  daemon restart ended offers them again and the next exchange round resumes
  the session for them.
- Control Plane: daemon-started Codex intercom runs no longer start the MCP
  servers of the user's Codex config (issue #119, `node/codex-mcp.mts`). The
  run still loads that config, so its hooks and guards keep working, but gets
  one `-c mcp_servers.<name>.enabled=false` per enabled server the config
  defines, before `exec` (also for `exec resume`). The names come from
  `codex mcp list --json`, run by the daemon without a shell; only bare key
  names are used, and the overrides are checked once with
  `codex <overrides> mcp list --json`, dropping each server codex rejects
  (servers the desktop app or a plugin provides, which make codex fail at
  startup when overridden). The result is cached per codex binary for
  5 minutes. When the list cannot be determined the run starts as before and
  the daemon log names the reason. Operator Codex tasks are unchanged.
  Measured on Windows with Codex CLI 0.157.1: 10 of 11 enabled servers
  disabled, local descendant processes of a probe run 22 before, 10 after,
  with the app-provided `cua_repl` the only MCP server left.
- Adopting a resumed intercom session as a copy no longer leaves the previous
  copy running (issue #111). The intercom task record notes the session it
  held before the resume (`retire`); once the new copy is adopted, right after
  the resume or in a later watch round, the node stops the previous one with
  `claude stop <short id>`, but only while `claude agents --json --all` lists
  it under that short id with the recorded session id and `status` `idle`. A
  `busy` or `waiting` one is tried again in each watch round, up to 30 rounds;
  one that is not listed, holds another session id or has no live process is
  left alone. Only sessions a node-started intercom record held are stopped,
  never the closed session the messages were sent to. `wake.jsonl` records
  each stop with the action `closed-session` and the outcome `retired-copy`,
  and a give-up with `copy-kept`.
- A message for a closed session that its intercom session answered is no
  longer refused as `target session not running` (issue #111). The copy's
  first turn could start before the node readdressed the message to it, so no
  turn offered it; the session read it with `msg inbox`, answered with
  `msg send --reply-to`, and the record stayed `accepted` until the copy
  ended and the 60-minute sweep refused it. A reply now marks the waiting
  message it answers as `delivered`. The sweep also judges a message handed to
  an intercom session (`closedTo` set) by its current `toSession` from the
  time of the handover (`closedAttempt`), not from its arrival.
- A node-started Claude Code session whose wake listener armed before the node
  recorded its session id is woken again (issue #109). This happens after a
  resume that Claude Code continued as a copy under a new id. The node now
  writes the task record before `claude --bg` or `claude --resume --bg` with
  `mappingPendingSince`, maps the session through `claude agents --json`
  right after the run, and clears the field once the id is listed. A resumed
  intercom session that became a copy is adopted: the same task record takes
  the new id and its waiting messages are readdressed to it, instead of
  stopping the copy and starting a new intercom session. A wake listener
  without grant or allowlist entry keeps polling while an active task record
  in its working directory has had a pending mapping for at most 2 minutes,
  and wakes once the node records its id. The grant still comes only from
  that recorded id. Otherwise the listener exits at once with
  `not-allowlisted` as before, audited once.

- `msg send <node>/<full session id>` reaches a closed session (issue #107).
  A full session id (a UUID, as Claude Code and Codex use) on a node the
  directory lists as `online` is now sent even when the directory no longer
  lists that session, with the note `session not listed on <node>; the node
  decides whether it can deliver` on stderr. The target node decides as for
  any message: its accept rules, then delivery, the closed-session fallback
  (`messaging.resumeClosed`), or the refusal after 60 minutes. Names, labels,
  `codex-<8>` and titles still need a listed session, an unknown node or a
  node that is not online still fails, and `attach` is unchanged.
- Windows installation with Claude Code installed through npm (issue #99): the
  plugin reconciliation no longer fails with `Claude marketplace list failed`
  when only the npm `claude`/`claude.cmd` shims are on `PATH`. Without
  `KHEREP_CLAUDE_BIN` it runs the first `claude.exe` on `PATH` or the native
  `bin/claude.exe` next to an npm shim, still without a shell, and fails naming
  `KHEREP_CLAUDE_BIN` when neither exists. The installer no longer warns that
  the global `core.hooksPath` is being replaced when the old value names the
  same directory in another Windows spelling, and the repository-local binding
  skips repositories under `_deprecated`.
- Codex sessions send and reply over the Control Plane on the first try
  (issue #72): the Codex installer makes the node outbox, and only the outbox,
  a writable root of the `workspace-write` sandbox
  (`sandbox_workspace_write.writable_roots`). Without a table of the operator's
  the managed block carries it; an operator table or dotted keys get the
  outbox merged into their `writable_roots`, never a second table and never a
  removed entry; an inline table or `default_permissions` is left alone. The
  receipt reports the outcome. `node onboard` and the daemon create the outbox,
  because a sandboxed session can write into it but not create it.
- Control Plane Codex tasks run in a workspace root that is not a Git
  repository: `codex exec` and `codex exec resume` get `--skip-git-repo-check`
  (the sandbox is unchanged). A failed run reports codex's last stderr line
  after the exit code, with API keys redacted. On Windows a `codex.cmd` npm
  shim is no longer refused: the node runs the package's launcher
  `bin/codex.js` with its own Node and without a shell, and a stop ends the
  whole process tree. A continue or message resume checks the task's working
  directory against the workspace roots again, a thread id must be a plain id,
  and failure reasons also redact bearer tokens, JWTs, URL user info and query
  strings. Codex on Windows stays unmeasured: its sandbox must be checked before
  a Windows node lists `codex`.

- Two Codex installer failures (#55). The installer parses only the standard
  output of `codex plugin marketplace list --json`; the warning Codex prints on
  standard error when `CODEX_HOME` lies under a temporary directory made the
  joined output invalid JSON and stopped the install with `Unexpected Codex
  marketplace list schema`. And after `brew upgrade node` on macOS, a managed
  block whose hook commands name the removed versioned Node keg is recognised
  again: the known managed fragments are also matched as rendered with each
  Node path the live block names, still exactly, and a `notify` entry with that
  path is removed as before. Any other difference is still refused. New
  renders name the Homebrew link `<prefix>/bin/node` instead of the keg under
  `<prefix>/Cellar/node/<version>` when the link resolves to the running
  executable, so the next upgrade does not invalidate the block. An explicit
  `nodePath` still wins. Reinstall to apply.
- The session-start drift nudge lists drift-check findings labelled
  `MISSING-BLOCK`, `BLOCK-INVALID` and `NORMALIZE-FAIL`. It counted only
  `DRIFT`, `MISSING-REPO`, `MISSING-LIVE` and `EXTRA-LIVE`, so a report whose
  only problem carried one of the other labels ended in `FOUND DRIFT` but
  showed no findings at session start.
- `bootstrap/install-transaction.test.sh` can no longer change the host's Git
  configuration. Whatever the caller's environment, it redirects the system
  and global scopes to throwaway files, drops every inherited `KHEREP_*`
  variable, and fails when the host's system or global `core.hooksPath`
  differs after the run.
- The Claude hooks `cbm-code-discovery-gate`, `cbm-session-reminder` and
  `cbm-subagent-reminder` are executable again. They were tracked without the
  executable bit since 0.1.0, and because the settings invoke them directly,
  every installed host failed them with `permission denied` and the
  code-discovery gate and both reminders never ran. Reinstall to apply.
- The smoke test's project-drift assertion follows the managed-block rule from
  0.1.1: operator text outside the Kherep block in the workspace `CLAUDE.md`
  must not be reported as drift, and a change inside the block must be.
- The CLIs `bootstrap/confluence-space.mts`, `modules/twg/install.mts`,
  `modules/twg/runtime/cli.mts` and `modules/control-plane/node/cli.mts` run
  again when their path contains a symlink, such as the default macOS temporary
  directory under `/var`, which links to `/private/var`. They compared
  `import.meta.url` with the unresolved script argument, while Node loads the
  main module from its real path, so through a symlink they did nothing and
  exited 0. They now compare against the real path of the script argument.
  This does not rely on `import.meta.main`, which the Node 23 and early Node 24
  releases admitted by the engines range do not provide. The local-inference
  keepalive and runner tests now resolve their fixture directories to their
  real paths, and the runner test still removes its fixture afterwards. The
  local-inference check that rejects a symlinked output root is unchanged.
- The remaining entry points and hooks no longer rely on `import.meta.main`
  to detect a direct start. Node 23.6 and later 23 releases and Node 24.0 to
  24.1 run the TypeScript sources but lack it, although the engines range
  admitted them, so there eight Claude hooks, ten Codex hooks, including the
  privacy-boundary and dispatch-contract guards, and the bootstrap, Codex
  installer, plugin-snapshot, broker, local-inference and MCP-wrapper CLIs did
  nothing and exited 0. Node 23.0 to 23.5 failed loudly instead, because they
  cannot load the sources without a flag. Every entry point, the four CLIs
  above included, now compares `import.meta.url` with its script argument both
  as given and resolved to its real path, so it also runs under
  `--preserve-symlinks-main`, which keeps the symlinked path. A test fails when
  a tracked source file reads `import.meta.main` again, compares against the
  script argument in one form only, or defines the check without both forms,
  and CI runs the unit, Codex, module, broker and Control Plane node suites on
  Node 22.18.0 and 24.1.0.
- Codex installer: a managed block that the Codex app split while storing hook
  trust is installed again instead of refused (issue #274). On a Windows host
  the app had written its `[hooks.state]` trust tables inside the block, moved
  the managed tail (the Control Plane deliver hooks and
  `[mcp_servers.kherep_messaging]`) verbatim behind the end marker, and left
  one trust table's `enabled = false` after the marker. The TOML was unchanged,
  but no known fragment matched, so the installer refused and a shared-guard
  fix could not reach Codex. The installer now puts the tail back into the
  block and the trust tables, with their keys, behind the end marker, then runs
  the unchanged exact match. It does so only when the block without its trust
  tables is the exact start of a known fragment and the exact rest follows the
  marker with nothing but trust tables in between, and moves a key after the
  marker only together with a trust table that ends the block. Anything else,
  such as a changed managed line, an unknown table, unknown content in the
  block or CRLF line endings, is still refused. The hooks arrays and the trust
  state are kept, so no hook needs to be trusted again.
- Bootstrap: on Windows `smoke-test.sh` looked hung in
  `install-transaction.test.sh` and was killed after six minutes, which also
  withheld every result it had buffered (issue #276). The sub-test was not
  hung: under Git Bash it takes about 12 minutes and printed nothing after
  `test_lock`, and the Windows process list showed its bash idle without
  children because MSYS fork and exec do not keep Windows parent links. The
  transaction test now names each test on stderr as it starts, and
  `smoke-test.sh` runs it under `timeout` with a 30-minute bound, set with
  `SMOKE_SUBTEST_TIMEOUT`, so a real hang becomes a finding and the report is
  still printed. Without GNU `timeout` or `gtimeout`, as on a stock Mac, it
  runs unbounded as before.
- Observation agent: on Windows `claude-obs` left its page bodies in the
  calling session's working directory as untracked files named like
  `C<U+F03A>Users...finding1_body.txt` (issue #280). The agent had no rule for
  creating its `--body-file` and wrote to the backslash scratchpad path from
  Bash, where the backslashes vanished and MSYS mapped the drive colon to
  U+F03A, so the path became a relative file name. The agent now creates the
  file with `f="$(mktemp)"`, passes `--body-file "$f"`, removes it after the
  broker call and never uses a Windows backslash path in Bash; the contract
  test pins that. `codex-obs` writes no files and is unchanged. The
  observation Stop hook also reads the top level of the working directory and
  its git root and, when names starting with `C` and U+F03A are there, shows
  their count and one shortened example as a warning. It never moves or
  deletes them.
- Bootstrap: `smoke-test.sh` no longer uses `node --check` for the wired
  hooks' `HOOK SYNTAX` and `LIVE HOOK SYNTAX` checks, so a `.mts` hook with an
  ESM syntax error such as `export const x = ;` is a finding instead of a pass
  (issue #278). A `hook_syntax()` helper calls `hooks/lib/hook-syntax.mts`: the
  repo copy for the repo source, and for the live hook the copy installed next
  to it, without falling back to the repo copy, so a missing installed library
  is a finding too. Only a proven OK passes. UNGEPRUEFT, a missing checker and
  any other exit are findings marked `UNCHECKED`, never a silent pass; such a
  finding names the first `Error` line of a failing checker, and a trailing CR
  on the checker's output is ignored. `.js`
  hooks keep their check through the library's dispatch.
  `hooks/lib/hook-syntax.mts` is now in the smoke test's list of installed
  files. The comments in `commit-guard`, `playwright-file-guard` and
  `secret-output-guard` no longer claim that their `node:process` import marks
  the file as ESM for `node --check`; nothing needs that import any more.
- Claude hooks: the observation Stop hook's stray-file warning now matches any
  drive letter followed by U+F03A, not only `C`. A body written from Bash to a
  `D:\...` path, where a workspace can sit, became a `D`+U+F03A file in the
  working directory and was not reported. A name that only contains U+F03A
  further in is still ignored.
- Claude hooks: `live-hook-integrity` no longer writes a restore through a link
  planted after its check (issue #279). The restore checked the target with
  `lstat` and then wrote with `copyFileSync`, which follows a link at the
  destination on every platform. The new `hooks/lib/restore-write.mts` opens
  the file without `O_TRUNC`, with `O_NOFOLLOW` where the platform has it, and
  writes only when the opened file has the `(dev, ino)` the path had; on Windows
  a volume without file ids is refused. A swapped-in file is left
  byte-identical. A linked `<CLAUDE_HOME>/hooks` is still restored at its
  target on purpose, and a test pins that; a link at the file or at a
  subdirectory that leads elsewhere is still refused. The hook now loads its
  own libs with dynamic `import()` and checks the functions it uses, so a
  missing, 0-byte or broken lib no longer makes it exit 1 unreported: it
  reports one line, journals it as kind `self`, exits 0 and restores the lib
  when `workspace-scope`, `orchestra-checkout` and `restore-write` loaded.
  `hooks/lib/hook-inventory.mts` and the install manifest test also follow a
  string-literal `import("./x.mts")`, not `typeof import()`, and the inventory
  scan ignores a leading byte order mark. `hooks/lib/restore-write.mts` is in
  the install manifest, the required hooks and the smoke test's list of
  installed files.
- Claude hooks: `hooks/lib/hook-syntax.mts` follow-ups from the review of PR
  #283. The stripper's ExperimentalWarning is now dropped by swapping
  `process.emitWarning` only for the duration of the
  `module.stripTypeScriptTypes` call instead of re-registering the process's
  warning listeners, which had made a `once` listener fire more than once and
  still delivered the warning to listeners attached later; every other
  warning, Node's own type-stripping warning included, still prints, and
  `quietStripWarning()` stays exported as a no-op for its callers. For `.js`
  and `.cjs`, a `node --check` child that did not run or did not finish
  (ENOENT, ETIMEDOUT after 15 s, a signal, exit 9 for a bad `NODE_OPTIONS`, a
  `SyntaxError` from a preload rather than the checked file) is UNGEPRUEFT
  "vm.Script rejected it and node --check could not confirm (...)" instead of
  DEFEKT; only a child that exited non-zero on its own and printed a
  `SyntaxError` for the checked file is a rejection. The probe import that
  keeps a checked module from linking now carries an import attribute that
  Node's load step rejects, so a `--import`/`--require` customization hook that
  resolves the probe specifier is stopped by Node's load step before anything
  is instantiated (UNGEPRUEFT, never OK); before, the checked file's top-level
  code ran first. Residual risk: a hook that also overrides the import
  attributes, short-circuits `load`, or returns a format whose attributes Node
  does not validate (`module-typescript`, `commonjs-typescript`) can still
  bypass the probe and run the checked file; the verdict then stays
  UNGEPRUEFT, never OK. Such a hook owns the process and is outside this check.
  Measured on Node 26.10.0; same source paths in 22.18.0 and 24.1.0.
- Research Stop hooks: Claude and Codex now recognise the same opt-out marker.
  Codex accepted only an ASCII hyphen after `none` and rejected the marker
  with an en dash (U+2013) or em dash (U+2014), which models write in
  practice, so such a turn was sent back once for research it had declared
  irrelevant; Claude accepted anything after `none`, including
  `[research: none]` without a reason, although ROUTING.md and both hook texts
  require one. Both runtimes now use one pattern: a hyphen, en dash or em dash
  followed by a nonempty one-line reason without `[` inside the brackets,
  matched anywhere in the final assistant text of the ending turn. Excluding
  `[` keeps a line of unterminated markers linear: 8000 of them took 1.8 s
  with a reason that could span them and under a millisecond now. A bare `[research: none]` in
  Claude now gets one continuation instead of opting out. The documented form
  stays `[research: none - <reason>]`. A shared contract test runs the same
  cases against both patterns and fails when they drift (issue #293).
- Codex hooks: a hook-integrity check now runs in every Codex session
  (#275). Before, only the Claude `live-hook-integrity` hook checked hook
  files, and only when a Claude session started, so a missing or 0-byte shared
  guard under `<CODEX_HOME>/hooks` failed open on a day with only Codex
  sessions. `codex/hooks/hook-integrity.mts` is installed as
  `hooks/kherep-maestro/codex-hook-integrity.mts` and appended as the last
  entry of the Maestro `SessionStart` group (`timeout = 30`), after the
  optional native hook, so every existing entry keeps its positional trust
  key. It checks every `.mts`/`.js` hook file that `config.toml` wires under
  `<CODEX_HOME>/hooks`, their import closure and the libs the privacy guard
  loads through a computed `require`. A broken file is restored from the
  checkout named by the deliver-hook command, else from the Claude-side
  checkout chain, and counts as restored only when a re-read matches the
  checkout's SHA-256. The two installer-rendered observation hooks are
  reported only, and without a checkout nothing is written. Findings go to
  `<CODEX_HOME>/.cache/hook-integrity/incidents.jsonl`; the hook is silent
  when everything is OK and always exits 0. A failing own lib is reported as
  kind `self`. The installer recognizes the previous managed block and
  upgrades it; Codex then asks to review exactly the one new hook.
- Claude hooks: `hooks/lib/hook-syntax.mts` no longer lets a `NODE_OPTIONS`
  preload decide the `node --check` confirmation of a `.js` or `.cjs` file
  (issue #292). A preload that printed one stderr line turned a real
  rejection into UNGEPRUEFT, and a preload calling `process.exit(0)` made a
  broken file OK, a false OK. The check child now runs without
  `NODE_OPTIONS` (matched case-insensitively on Windows), so no preload can
  print, exit early or forge a rejection; this is the policy the `.mts` path
  has had since #284, only Node's default loader is trusted. An operator's
  `--no-experimental-detect-module` is therefore not applied either. The
  rejection is read from the block Node prints (`<path>:<line>`, source line,
  caret, blank line, `SyntaxError: ...`): a `SyntaxError` line counts only
  when a line within the four above it names the checked file, wherever the
  block sits in stderr, so lines printed before it (`NODE_DEBUG`, a loader
  warning) no longer hide a rejection. The `node --check` tests move to
  `hooks/lib/hook-syntax-check.test.mts`. The ExperimentalWarning control in
  `hook-syntax.test.mts` records whether this Node still warns for
  `module.stripTypeScriptTypes` (`MEASURED |`) and asserts the filter only
  while it does. Measured on Node 26.10.0; Node 22.18.0, 24.1.0 and the
  Windows path format are read from Node's source.
- Claude hooks: `hooks/lib/hook-syntax.mts` now reports a `.js` or `.cjs` file
  DEFEKT when `node --check` rejected it under another name (issue #298).
  Node prints the realpath of a file or directory symbolic link and honours a
  `//# sourceURL=` comment, so a broken hook reached through a renamed link,
  or one carrying such a comment, was UNGEPRUEFT instead of DEFEKT (never OK).
  Since #292 the check child runs without `NODE_OPTIONS` and parses only the
  checked file, so the rejection block (`<location>:<line>`, source line,
  caret, blank line, `SyntaxError: ...`) now counts whatever its location
  names, as long as it is not a `node:` internal frame and the child exited
  non-zero on its own; Node's own failures (a missing file, an invalid
  `package.json`) stay UNGEPRUEFT. When the name differs from the file's, the
  reason says so. Measured on Node 26.10.0 on macOS and, for a directory
  junction, on Windows 11; Windows file links are read from Node's source.

## [0.1.2] - 2026-09-24

### Added

- A `search` verb for the Confluence brokers. It runs a read-only semantic
  search filtered to the configured space and reports a hit, no match or an
  unavailable search as distinct exit codes (0, 1, 2).
- An evidence-first gate for Claude. A `UserPromptSubmit` hook asks for
  research on relevant prompts, naming the knowledge space and, inside a Git
  repository, the code graph. A `Stop` hook sends a substantial turn back once
  when it shows neither a lookup nor the visible classification
  `[research: none - <reason>]`. Trivial turns are not gated, a continuation
  is never blocked twice, and an unreadable transcript fails open. Skills
  listed in the optional operator file `<claude-home>/kherep/research-sources.json`
  count as lookups.

### Changed

- Codex observations no longer surface as a visible Stop continuation after a
  reinstall. Both hosts project an acceptance-only `Stop` group; the
  `UserPromptSubmit` Maestro context hook reminds the Maestro quietly to
  dispatch `codex-obs` once per main turn. Earlier managed Stop groups with an
  observation step are upgraded in place.

## [0.1.1] - 2026-09-24

### Added

- A commit policy file next to the `commit-msg` hook. The work-item rule now
  applies to every runtime that runs Git, not only to a process that carries
  the `KHEREP_*` variables. `KHEREP_WORK_ITEM_REQUIRED` and
  `KHEREP_WORK_ITEM_PATTERN` given at install time are persisted; a variable
  set at commit time still overrides the file.
- `labels --remove` for the Confluence brokers, with a read-back of the labels
  that remain on the page.

### Changed

- The installer manages only a marked reference block in the workspace
  `CLAUDE.md` and `AGENTS.md`. Text outside the block stays byte-identical;
  unedited copies of the previous full template are replaced by the block. The
  block points to the user-level rules instead of repeating them.
- The Confluence brokers and the modules they import are installed together
  with the observation agent. `KHEREP_INSTALL_ATLASSIAN_TOOLS` now only adds
  the Jira and MPAC helpers.
- The Claude observation agent has its own definition: it files through the
  Claude broker only, starts every result with an `OBS-RESULT` status line,
  keeps findings under a hierarchy node named in the brief and takes the
  session label from the brief. The Codex worker contract moved to
  `codex/agents/codex-obs.md`.
- The drift check compares only the managed block of the workspace rule files
  and includes the commit policy file.

## [0.1.0] - 2026-09-24

First public release.

### Added

- Maestro agent orchestration: plan work, delegate focused tasks and verify the
  combined result against code, tests and the requested outcome.
- Claude Code adapter with an installer that backs up and can roll back the
  managed configuration, an isolated preview mode and a read-only drift check.
- Codex adapter with its own installer, an installation receipt and the
  `kherep-maestro` plugin.
- Shared rules, hooks, skills and agents for implementation, review, debugging
  and delivery.
- Model and tool routing through operator-configured policies.
- MCP integration through transport and authentication adapters for explicitly
  configured services.
- Local inference through configured local processing routes, including a
  separate path for private inputs.
- Central Brain, a shared knowledge base in a dedicated Confluence space. The
  Claude and Codex observation agents file durable findings from completed
  turns as pages through the service-account brokers.
- Turn-completion observations for Claude and Codex through the service-account
  Confluence path.

[Unreleased]: https://github.com/CFcon-CH/kherep/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/CFcon-CH/kherep/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/CFcon-CH/kherep/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/CFcon-CH/kherep/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/CFcon-CH/kherep/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/CFcon-CH/kherep/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/CFcon-CH/kherep/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/CFcon-CH/kherep/releases/tag/v0.1.0
