# Changelog

All notable changes to Kherep are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.y.z`, a release that breaks a documented interface
increments the minor version; every other release increments the patch version.

## [Unreleased]

### Fixed

- Managed service activation (#746) binds health/settle to PID and start identity,
  retains prepared/attested evidence before native replacement/start, and preserves
  prior pending records during recovery. Windows consumes generation-bound stop
  evidence and offers explicit, strictly validated rollback recovery for older
  orphaned activations. Live host acceptance remains separate.

### Removed

- The `usage-watch` prompt hook (issue #774). Installed copies are parked with the
  `usage-band` files through `retired.txt`.

### Added

- The weekly usage recorder shows its notification on macOS through `osascript`.
- Team model profiles (issue #761, first part): every session on every node and
  runtime gets two role texts, `kherep-lead` and `kherep-team-lead`, with the chain
  of command operator -> lead -> team leads and one message contract (PACKAGE,
  REPORT, PACKAGE-CLOSED, QUESTION, ANSWER, HANDOVER; eight STATE values). Claude
  installs `claude/agents/kherep-*.md` through the file manifest and model policy
  (role `root`, native inherit) and drift-check compares them; Codex projects its own
  `codex/agents/kherep-*.md` into `agents/kherep-*.toml` with the root defaults. Both
  ROUTING files gain a "Team model" section and the user rules a pointer to it.
  `bootstrap/team-profile-parity.test.mts` keeps the two runtimes' texts on the same
  contract. For now the operator names the lead in chat; the Worker team record, the
  per-turn role line and the send-time contract check follow in a later change.
- Weekly usage watcher (issue #748): the status line hands the documented
  `rate_limits.seven_day` window to a detached recorder, `hooks/usage-record.mts`,
  which caches it under `.cache/usage-watch/` and shows one Windows toast per
  condition per reset window, when 50 % of the weekly plan budget is used or usage
  runs at least 5 points ahead of the elapsed window after 10 % of it. The new
  `UserPromptSubmit` hook `usage-watch` adds a short notice to every prompt while a
  condition holds. `KHEREP_USAGE_TOAST=0` turns the toast off; no toast outside
  Windows.

- Topic-judged linking (issue #736): `related` and `stitch` search with the title plus
  the finding sentence (`--topic`) inside the space (`twg rovo search --space`, twg
  1.3.8 or later) and print area, a shared-words hint and a snippet per candidate. The
  broker no longer decides a link: `stitch --id --topic --out` lists candidates and
  writes a receipt, the observation agent judges each one, and `stitch --id --candidates
  --decisions` writes only the approved targets, each with a reason in the trace and
  the version message, and refuses ids outside a fresh receipt for that page. The
  full-space sweep only lists. The Codex adapter gains the read-only
  `related_candidates` tool and a required `links` key per finding; it links only the
  ids codex-obs approved and fails `links-refused` before creating anything otherwise.
  `selectRelated`, the title-term write path and `stitch --dry-run`/`related --parent`
  are removed.

- GitHub App issue broker source (Refs #732): fixed Claude/Codex entrypoints, strict public-repository operations, real local signing, scoped installation tokens, durable uncertain-outcome receipts and shared transactional packaging. Default disabled; native/live identity acceptance remains separate.

- Codex routing-only updater (issue #707): exact predecessor/current byte checks,
  explicit public Intercom rendering, isolated backup receipts and verified
  rollback without full installation or model refresh. Routing assigns SOL
  coordination and implementation, managed Astra design, and stops on ambiguous
  managed worker identity. These instructions add no runtime guard.
- Confirmed pages in the evidence verb (issue #695): `evidence --mode decide`
  now accepts an `evidence-confirmed` page. A contradicting measurement at a
  bound revision proposes `refuted`; at a newer revision (a strict descendant
  of a bound commit, checked with read-only `git merge-base` in
  `--repo-root`) it only supersedes, through a same-space page that binds the
  measured revision. A holding measurement is the new outcome `holds` (exit 0,
  no body, no label change), counted and printed by `report`. New refusals:
  `revision-not-newer`, `superseded-needs-contradiction`, and
  `page-already-decided` for refuted or superseded pages (replacing
  `page-not-assumed`). The brain-drainage recheck path for `revision-stale`
  candidates now uses the evidence verb instead of a manual relabel.
- Revision staleness (issue #693): a Revision line may name the repo-relative
  paths a code finding rests on (`Revision: <name>@<sha> -- <path> <path>`),
  and `drainage --repo-root <checkout> [--ref <ref>]` compares those paths
  between the bound commit and the compared ref with read-only git. The report
  gains a `revisionStaleness` section (`stale`, `current`, `unscoped`,
  `unknown` with a reason, coverage and unread pages) and one
  `revision-stale` / `recheck-evidence` candidate per stale page; no label or
  page changes. Observation briefs may give `-- <paths>` after each
  `<name>@<sha>`; the dispatch guards report a binding without paths or a
  malformed list as a notice, and the Codex candidate check accepts the
  scoped line under the same grammar. The brain-drainage skill documents the
  manual recheck and relabel path for a stale page.
- Worker brief revision (issue #701): a brief to a code-bound worker marks
  `revision: <name>@<sha>` per repository (a review `<name>@<base>..<head>`,
  `-dirty` for uncommitted changes) and `decided: <decision>` or
  `decided: none` at the start of a line. `kherep-builder` and
  `dc-plugin-build-runner` are code-bound by role (`CODE_BOUND_AGENTS` in
  `hooks/lib/dispatch-policy.mts`, `"codeBound": true` in
  `codex/parity/capabilities.json`, no environment override); any other
  dispatch is checked when its brief declares `revision:`. Both dispatch guards
  deny a missing marker on a code-bound role and a malformed token, a
  `revision:` without a token or an empty `decided:` on any checked dispatch
  (Claude rule `WORKER_BRIEF_FORMAT`), through the new pure lib
  `hooks/lib/worker-brief-policy.mts`; a brief that mentions a review without
  `revision:` gets a notice only (`WORKER_BRIEF_REVISION`). The guards read no
  git state and judge no completeness. `codex:codex-rescue`, `codex exec` from
  a shell and Control Plane directives stay rule-only. Codex refuses a
  code-bound dispatch when the installed lib is missing and checks no other;
  hook integrity checks and restores the lib, and the observation-only updater
  accepts the `764200b` bytes of `hook-integrity-sources.mts` through
  `codex/parity/observation-worker-brief-predecessor.json`. The builder and DC
  build runner receipts gain `REVISION:` (`<name>@<base>..<head>` after an
  authorized commit). Both `ROUTING.md` files name the fields, the review
  receipt lines `REVISION:` and `ASSUMED:` with the reviewer rule quoted
  verbatim in Dispatch, and the Maestro's `Revision: bound | mismatch |
  unknown` receipt line, which compares the base SHA, in Verification.
  Observation briefs are unchanged.
- Observation handback gate (issue #571): the Claude `PreToolUse` guard
  `hooks/obs-handback-gate.mts` refuses a `claude-obs` handback through
  SubagentHandback whose first non-empty line is not exactly one valid
  `OBS-RESULT` status line, once per agent id for a gate that ran, with a reason
  naming the fixed problem. It uses the recorder's parser and keeps the marker
  `<CLAUDE_HOME>/.cache/obs-result-check/<agent_id>.refused`, which is retained
  and removed by no hook. A second malformed handback of the same id is
  delivered and reported by `obs-handback-record` as before. The template gains
  one new `PreToolUse` group with matcher `SubagentHandback` and changes no
  existing entry; on a host, an existing dispatcher entry under that matcher is
  replaced and logged by the #568 rule. Measured on Claude Code 2.1.309, one
  refusal led to a corrected handback about 4 seconds later. Codex is unchanged.
- Reading guide for the Central Brain (issue #679): `docs/CENTRAL-BRAIN-READING.md`
  maps who does what (Confluence, the Atlassian MCP v2 server, the brokers,
  the observation and lifecycle workflows) and states the measured reading
  rules for any client. The MCP read payload carries no labels, so evidence
  status comes from the broker `labels` verb or a CQL `label =` filter. An MCP
  search with an unknown space key returns zero results like an empty match
  (real denied access is untested), and a 404 does not separate missing from
  not permitted. Truncation
  shows as `totalSize`/`next` or `truncated: true`. A raw body hash does not
  identify a page version, and reading never upgrades evidence. Documentation
  only; no new service.
- Brain drainage confirm path (issue #519). The `brain-drainage` skill
  gains an operator-requested path that measures an `evidence-assumed` page
  against its primary source: the repository at a Revision bound on the
  page, a real tracker read, a raw official document, or a fresh measurement
  on the target. It proposes `evidence-confirmed`, `evidence-refuted` or
  `evidence-superseded`, or leaves the page `assumed` with a named reason.
  Both Confluence brokers gain the read-only `evidence` verb (`prepare`,
  `decide`, `verify`, `report`, `record`). It classifies the claim and
  applies the promotion gates: a dated measurement at most two days old with
  command and excerpt, a revision bound on the page and present in the named
  repository, a measurement that touches the claim (every tracker key the
  page states, matched as a whole key; once a page names one GitHub key
  (`GitHub issue #N`, `/issues/N` or `/pull/N`), every `#N` it states is a
  key, matched only as a whole token `#N` in the excerpt (`#10.` and `#10,`
  count, `#10-other` and `#10.5` do not) or as the number a command that is
  one `gh issue view N` or `gh pr view N` reads: its first segment begins
  with exactly those four words, and no other `gh` runs in it; any one code
  file name), no forbidden
  source, and no credential-shaped or control-character content. A `--kind`
  override never makes a historical claim repeatable. It renders the dated
  measurement block before the `Related pages` footer in a form that storage
  normalisation keeps byte-identical (LF-only; `&`, `<`, `>` and `"` escaped,
  `"` as `&quot;` because that is the form Confluence returns), and re-reads the page after the operator's
  `update --expected-version` and two-step `labels` calls, asserting the
  reviewed label set with exactly one evidence label. Record and body files
  lie outside every git work tree (checked on, and written to, the resolved
  directory), are never overwritten by `prepare` or `record`, not even when
  created while they run, and are replaced atomically by `decide`. A format
  repair still never promotes. Human-assigned status is
  reported, never relabelled. `status-author-*`, `currency-*` and
  `origin-wiki` are never changed, and a `runtime-*` label is never removed
  or changed. Private pages stay excluded or UNKNOWN. The scanner and the
  confirm path classify a page on its body without the measurement blocks
  the broker wrote, so a tool or file name inside a measurement command
  never makes a tracker page code-bound (issues #650, #662). Only the run of
  blocks directly before the footer counts; a block-shaped span elsewhere is
  content (#666). A Revision line inside any complete block, even a
  superseded block that lost its link or a line in that link's title, never
  counts as the page's own Revision; an incomplete block-like span stays
  author text.
- Denied calls in delegated worker reports (issue #504). The guard
  dispatcher, and the hook runtime entry for its own denies, journal each
  guarded call of a delegated Claude worker (a payload with a valid
  `agent_id`, the handback excluded) to
  `<CLAUDE_HOME>/.cache/denied-calls/<agent_id>.jsonl`: tool, worker type,
  a target class and per denying guard its tag and one line of its
  reason (a guard's header skipped for its first violation, #700),
  absolute paths reduced to their basename, privacy denials and
  marker matches `<withheld>`. Every write is asynchronous, capped (1.5 s,
  0.5 s in the entry) and never changes or delays a decision past its cap;
  a lost write leaves `<agent_id>.failed`, a marker line or the journal
  renamed to it. A second entry of the `PostToolUse` group on
  `SubagentHandback` (`hooks/denied-calls-delivered.mts`, `timeout` 10)
  records the delivery after the handback ran and cannot block it; the
  group's first entry and every other entry are unchanged.
  The Maestro reads a worker's list with `hooks/denied-calls.mts render
  <agent_id>`, which prints `DENIED-CALLS: none | <n> | unknown (<code>)`,
  `none` only on positive evidence, and exits 3 on `unknown`; both
  ROUTING.md files carry the reading rule and the `Denied:` receipt line.
  Acceptance 2 of the issue is met through that read for Claude workers,
  not inside the worker's own text, and nothing enforces it yet. Codex:
  the adapter and the shell dispatcher capture too, but Codex documents no
  `agent_id` on a child's `PreToolUse`, so capture is inert until a child
  key is measured (#537) and every Codex worker reads `unknown
  (journal-missing)`; no Codex hook group is added and the renderer is
  installed as `hooks/kherep-maestro/denied-calls.mts`. Limits: append
  and rename both failing loses the line; a call the hook entry denies
  whose payload is over 1 MiB leaves no line and no marker; an absolute
  path with a space keeps the part after the space; a deny with several
  violations records only the first; Explore and Plan workers return no agent ID and
  read `unknown (no-agent-id)`; that the returned agent ID equals the
  hooks' `agent_id` is UNVERIFIED until the host measurement in
  `docs/CODEX-HOOK-RUNS.md`. `hooks/lib/denial-journal.mts` holds a fourth
  copy of the private marker pattern, held equal to the three guard copies
  by a bootstrap test.

- Hook integrity heartbeat, re-check and hook runtime (issue #507, part 2 of
  4). Every managed Claude hook command now starts through
  `kherep/hook-runtime/entry.mts`, which admits the hook process to the
  installation's hooks directory, also for a hook in a subdirectory of it
  (`<real hooks>/.kherep-integrity/run.sqlite`, `node:sqlite`,
  rollback journal `DELETE`) before Node loads the hook or its imports: hooks
  hold a read transaction, `live-hook-integrity.mts` an `EXCLUSIVE` one. A
  repair is recorded with its complete bytes before the first byte is
  written, written in the same inode (owner, mode and ACLs stay) or published
  complete through a hard link, and replayed by the next admitted process when
  its writer died; the integrity run repairs nothing outside that hold, on
  another hooks directory, or next to a wired command that bypasses the
  entry. The heartbeat `<CLAUDE_HOME>/.cache/hook-integrity/heartbeat.json`
  is removed before the first repair and written only after a final
  read-only check of the live import closure (walked again after restores, at
  most three passes) within one hold. The guard dispatcher re-checks after
  its guards when the heartbeat is older than 30 minutes or missing or a
  guard could not run, within one deadline 25 s after it starts (stdin
  included), reports it as `additionalContext` and on stderr, never as a
  decision, and exits once stdout and stderr are flushed. For `PreToolUse`
  the entry turns every runtime failure, a missing, empty or broken
  dispatcher included, into a deny and starts one repair for the next call.
  `live-hook-integrity.mts` gains a `--trigger <source>` mode that prints
  plain lines, and journal entries name their `trigger`; `classify`,
  `restore` and `journal` moved to `hooks/lib/integrity-verdict.mts`. The
  upgrade replaces each raw managed command with its entry form and removes
  an entry command at an event the template no longer uses. A recorded
  repair whose target an outside writer replaced stays refused until an
  operator runs `kherep/hook-runtime/replay-pending.mts`: `inspect` shows the
  intent and the current file, `replay` with exactly those values binds the
  intent to that file and writes the recorded bytes into it in place.
  Limits: the entry itself cannot be checked; writers and readers outside
  the runtime are not covered; a persistently failing recorded repair keeps
  that hooks directory's hooks out; a timed-out re-check reports its outcome
  as UNKNOWN; no timer, so an idle session is not
  re-checked; whether the session shows a `PreToolUse` `additionalContext`
  is UNVERIFIED; Windows DACL preservation is UNVERIFIED.
- Fail-closed Claude guard dispatcher (issue #507, part 1 of 4). The five
  `PreToolUse` groups of `claude/settings.user.json` each run one
  `hooks/guard-dispatch.mts` entry that starts the group's guards in parallel.
  A guard that is missing, empty, not a regular file, outside the hooks
  directory (a symlink counts where it points), killed by a signal, still running after 10 s, exiting with a code
  other than 0 or 2, or printing anything other than a `PreToolUse` decision
  now denies the tool call, and the reason names the file; before, most of
  these let the tool call through. Stdin that is not a JSON object is denied too.
  Working guards keep their verdicts, combined as deny > ask > allow. A guard
  notice (`additionalContext` without a decision) passes through unchanged;
  any output field beyond decision, reason and `additionalContext` denies and
  names the field. The upgrade unwires the old direct guard entries and logs
  each removal, and `drift-check.sh` reports a dispatcher entry whose guard
  argument is missing or retired as `DANGLING-HOOK`. Limits: the dispatcher
  cannot check itself, so an empty `guard-dispatch.mts` fails open until the
  next session start (part 2 moves this boundary to the hook runtime entry);
  a hook cancelled at its 30 s `timeout` loses its output,
  so each guard is capped at 10 s, within one deadline 25 s after the
  dispatcher starts (part 2); `onFailure` is not set, because no minimum
  Claude Code version is declared.
- Pull request commit policy check (issue #506). The CI job `commit-policy`
  runs on pull requests and passes every commit in
  `merge-base(base, head)..head`, merge commits included, through the
  versioned `commit-msg` hook via `bootstrap/pr-commit-policy.mts`, so a
  commit made with `--no-verify` is still checked. The caller's `KHEREP_*`
  variables are dropped, which closes the `KHEREP_WORK_ITEM=none` escape
  hatch, and the hook must first reject a canary message with an attribution
  trailer. Exit `0` means every commit passed, `1` a policy violation, and `2`
  a range or hook that could not be read, such as a missing commit, a shallow
  clone or an emptied hook; a failed read is never a pass.
- Commit binding for code-bound observations (issue #505). A finding about
  repository code, tests or a build is `confirmed` only when the brief names
  each repository as `<name>@<full commit sha>` measured on a clean tree, as
  `` measured: code <name>@<sha> `<command>` -> <excerpt> ``; without a
  repository, without a full SHA or on a dirty tree it is filed as `assumed`
  with a fixed "no exact binding" line, and the page body carries a
  `Revision:` line. Both dispatch guards report a missing or incomplete
  binding as a notice that names positions only, never as a deny; every
  existing deny is unchanged. The Codex result check rejects a `confirmed`
  candidate whose `Revision:` line is not `<repo>@<full commit sha>`. That a
  filed page carries the line is contract-enforced and not proven at the
  target.
- Versionless Codex role policy (issue #509). Astra designs, SOL builds,
  Terra handles support and research, and Luna handles observations and brokers.
  Installation resolves available models into native agent TOMLs and one
  dispatch snapshot; ordinary reinstall retains that resolution, while
  `--refresh-models` explicitly refreshes it.
- Reconnect burst measurement (issue #493). The daemon's round counters line
  `round sent <n> status/<m> outbox frames, handled <k> inbound items` keeps
  its text and, when the round handled frames, goes on with
  `: <kind> <n>, ...`: the eight most frequent frame kinds by count, then
  `other <n>`. Kinds come from a closed list of 43 labels built from the
  protocol's message types, node commands, message states and task-control
  actions, with fixed buckets such as `command:unknown`, `frame:invalid` and
  `unknown`; a received string never becomes a label. Each frame counts once,
  on the lane that finally handles it, and the tally resets every round. The
  line still appears only above 32 frames. The `disconnected` line now reads
  `disconnected (<code>, clean=<true|false>, error:<class>)`, where the class
  is a listed socket error code, `unknown`, `missing` or `none`; no error
  message, close reason or URL is logged.
- Message summary diagnostic (issue #493). `GET /api/messages/summary?from=<node id>`,
  behind the existing Access JWT check, groups the Registry rows of one sender
  node by `state` (a known state or `other`), `deletable` (`1`, `null` or
  `other`) and `settled` (`settled` or `unsettled`), each with `count`,
  `withDeadline` and the age buckets `ageUnder24h`, `age1to7d` and
  `ageOver7d`, and adds `fetchedAt`, the Worker
  `version` and `commit`, and `rowsRead`. Counts only; no node id, message
  id, timestamp, session, reason or text. Each call reads the sender's whole
  history through its index and is logged as `registry.sql` path
  `messageSummary`. Read-only: replay, acknowledgement, retention and the
  protocol are unchanged.
- Brain drainage (issue #517). The manually invoked `brain-drainage` skill is
  installed for Claude and Codex. Its scanner, `<broker> drainage --space
  <key> --metadata-approved` (optionally with `--ids` and `--exclude-ids`),
  uses GET only and reports candidate rows with page ID, read version,
  problem, proposed action class, bounded structural evidence and uncertainty,
  without titles or body excerpts. Inventory status is `complete`, `partial`
  or `failed`, and semantic review stays UNKNOWN. Nothing is applied
  automatically: a repair needs explicit authority and goes through `update
  --expected-version <n>`, which both update CLIs now accept and which refuses
  to write on a missing, invalid or mismatched version. No daemon, database,
  scheduler, scope or credential is added. See
  `modules/atl-jira-brokers/README.md`.
- The settings render prints `hooks: keep <event> [<matcher>]
  <claude-home>/hooks/<file>[, ...] (uncoordinated, blocks
  live-hook-integrity)` for every kept hook command that runs `hooks/` code
  outside `kherep/hook-runtime/entry.mts`, judged by the rule
  `live-hook-integrity.mts` itself applies and naming the files it counts
  (`hooks/lib/hook-inventory.mts`), so the install output says why no
  heartbeat will be written. The command itself is not printed, so no path of
  the host appears, and an event that is not a plain name is shown as
  `<event>`. Nothing is printed when every command is coordinated, the stored
  command is unchanged, and `drift-check.sh` discards the lines as before
  (issue #525).
- Windows CI runs the Codex suites (issue #534). The `unit-windows` matrix
  gains a `codex` shard that runs the whole `npm run test:codex` file set on
  `windows-latest`, gated by the required check `unit (windows-latest)` like
  the bootstrap shards, with a 40-minute step timeout so a hang fails instead
  of running to the job default. `bootstrap/ci-shard.test.mts` names the new
  shard. Before this, only the ubuntu `typescript` and `unit-engines-floor`
  jobs ran `codex/`, so the three Windows-only failures fixed in #535 and
  #539 were first seen on a host.
- Codex run guard (issue #550). The three CI jobs that run the Codex suites
  (`unit-windows (codex)`, `typescript`, `unit-engines-floor`) start them
  through `codex/scripts/codex-run-guard.mts run`, which reads the patterns
  from the `test:codex` script and fails the step when a pattern selects no
  file, the run has fewer than 600 tests, a test is `todo`, fails or is
  cancelled, a suite is skipped, or the skipped tests differ from the
  accepted list for the platform in `codex/scripts/codex-run-expected.json`.
  Before this a run that selected nothing or skipped more than before was
  green. `npm run test:codex` stays the local command.
- Hook reference (issues #587 and #588). `docs/HOOKS.md` lists every wired
  hook in one table: runtime, event and matcher, kind and what it does, 52
  rows for the Claude templates, the Codex render and the Git hooks.
  `bootstrap/hooks-reference.test.mts` reads those sources in-process and
  fails when a wired hook has no row or more than one, when a row names a
  hook nothing wires, when a row breaks the cell vocabulary, or when
  `README.md` does not link the reference from its Documentation table and
  its Security model section; it runs in `test:bootstrap` and in the Windows
  `bootstrap-rest` shard. The README no longer calls the Codex messaging
  intent hook an exception to the fail-closed adapter (wrong since #538),
  says that only the hooks under `hooks/` start through the hook runtime
  entry, describes the Playwright and Atlassian destructive guards, the
  deploy guard's scope and the research Stop hook, and gains a hook runtime
  component row.
  `codex/ARCHITECTURE.md` lists `pre-intent` among the PreToolUse phases.
  No hook, wiring, settings template or installer changes.

### Changed

- The repository moved to the `CFcon-CH` organization; README, docs, templates,
  illustrations and test fixtures now name `CFcon-CH/kherep`. Old URLs redirect.
- Claude model and effort are user-overridable defaults, not pins (issue #737). The
  shipped `kherep/model-policy.json` assigns each agent a role and each role a default
  model; the observer default becomes `haiku` with effort `medium`. The operator's
  `kherep/model-policy.user.json` overrides any role or agent per field, survives every
  install and rollback byte for byte, and is never drift. `hooks/lib/model-policy.mts`
  resolves both for the dispatch guard, the hook texts and the installer, which renders
  agent frontmatter from `model: __KHEREP_MODEL__` / `effort: __KHEREP_EFFORT__` and
  compares it rendered in `drift-check.sh`; `capture.sh` restores the placeholders.
  `dispatch-contract-guard` drops `OWNED_AGENT_MODEL_MISMATCH`: any dispatchable model
  is allowed, `DISPATCH_MODEL_UNKNOWN` replaces `DISPATCH_MODEL_NONCANONICAL`, and
  `DISPATCH_EFFORT_UNSUPPORTED` checks a call's effort when present. A one-time migration
  (`bootstrap/migrate-model-policy.mts`) captures explicit environment values and edited
  frontmatter into the user file. `KHEREP_ALLOWED_MODELS` (still the complete list,
  migrated as `dispatchable: false` for omitted aliases) and `KHEREP_AGENT_MODEL_POLICY`
  (no longer a pin) are deprecated for one release; they affect dispatch and the hook
  texts, while the installer and `drift-check.sh` render frontmatter from the two
  policy files only. Claude adapter limitation: no queryable model catalog, so a
  per-model effort list only warns.

- Allow co-author trailers and AI attribution for every runtime and repository; preserve other commit policies and verify the CI hook with an isolated work-item canary (#722).

- CI runs its Ubuntu jobs on `ubuntu-26.04` explicitly instead of
  `ubuntu-latest`, which GitHub moves from 24.04 to 26.04 between
  2026-10-19 and 2026-11-19 (actions/runner-images#14748). A mixed image
  pool would add noise to repeat-gate evidence. The matrix keys and check
  names stay `ubuntu-latest`, because the main ruleset requires them by
  name (issue #670).

- `MacServiceAdapter.write` refuses a plist write over a job launchd still
  has loaded with a different definition (issue #594). After the temp file
  is written and before the rename, the adapter reads `launchctl print`: a
  job reported not found (rc 113, `Could not find service`, readable domain)
  lets the write through; a listed job lets it through only when the bytes
  equal the file's and the loaded identity attests against them (the same
  predicate `read` uses). Otherwise it retries every 100 ms within a 1 s
  grace on a monotonic clock. The grace limits when a new probe may start
  (at the latest at its end, rechecked after every sleep), not the total
  duration: each `launchctl` and `plutil` call keeps its own
  15 s timeout, and a probe that started inside the grace is honoured even
  when it ends after it. In the issue's measurements the slowest first
  `launchctl print` after the pid was gone took 145 ms and already reported
  not found; no stale listing was observed, so the grace is a heuristic,
  not a measured bound (issue #677). A job
  still loaded with another definition after the grace refuses with
  `LaunchAgent is still loaded with a different definition`. Any other
  `print` result refuses at once with `LaunchAgent loaded state could not
  be read before write`; a read error never counts as absent. Both leave
  the file untouched. A foreign `bootstrap` between the last probe and the
  rename, a gap that includes the `plutil` call on the listed path, is not
  caught at the write; the next `read` attests it. Not found is not a stop
  proof: a job launchd no longer lists may still have a live process
  (issue #677).

- The Claude control-plane hooks run through a stable entry point (issue
  #592). The eight control-plane commands of `settings.json` now read
  `node "<CLAUDE_HOME>/kherep/control-plane/claude-control-plane-hook.mts"
  deliver` (`wake --timeout 86400` with `asyncRewake` and `timeout` 86400,
  `attribution`) and name no checkout, so they stay the same across upgrades
  and across the roots an install runs from. The entry, a manifest file,
  reads `<CLAUDE_HOME>/kherep/control-plane/source.json`, the Codex pointer
  record naming the source `install.sh` last ran from, and imports that
  source's hook into its own process: no second process, and the hook's
  parent, stdin, environment, working directory and exit code are a direct
  call's. Without a usable pointer, hook name or hook file it runs nothing,
  writes `kherep control-plane-hook: <reason>; pointer <file>; run
  bootstrap/install.sh` to stderr and exits 1, never 2, with no fallback.
  `install.sh` renders the pointer in preflight and installs it in the same
  transaction as `settings.json`. An install replaces path-form entries of
  any root with the stable set. `drift-check.sh` compares the pointer by
  commit, not root: `ok kherep/control-plane/source.json (<kind>
  <commit7>|unverified)`, `MISSING-LIVE`, `POINTER-INVALID`,
  `POINTER-UNRESOLVED (<reason>: ...)`, `POINTER-STALE (commit <a> != <b>)`.
  The `hooks` check of `kherep-node doctor` resolves stable Claude deliver
  and wake commands through the pointer and reports `pointer`, `stable`,
  `legacy` and `entry` for Claude as for Codex; a path-form command is
  `legacy` with a note. A revert is not self-healing: `docs/INSTALLATION.md`
  ("Rolling back the stable entry") lists the five steps per host. Merging
  delivers nothing: a host has it after `bootstrap/install.sh` from the new
  source and a session restart.
- `service status` drain hints no longer embed the commit in the source
  placeholder (issue #582): a stale drain reads `kherep-node service upgrade
  --source <clean checkout> reclaims the stale drain (installed source
  <commit>)`, a stopped service `kherep-node service upgrade --source <clean
  checkout> (installed source <commit>)`. `service rollback` now waits up to
  180 seconds (`ROLLBACK_HEALTH_TIMEOUT_MS`) for the prior daemon's health,
  as `restorePrior` already did, because the prior source may predate #581
  (issue #589 item 4, the rollback half; the forward upgrade, also one that
  reclaims a stale drain, keeps 30 seconds). On Windows a stop refused by the
  native script is reported as `STOP_NATIVE_REFUSED`;
  `STOP_BLOCKED_NATIVE_DESCENDANTS` is reported for the read-only descendant
  wait and on macOS. `rollbackManagedService` moves to
  `node/service-rollback.mts` and the status report to
  `node/service-status.mts` for the 250-line budget; `service-transaction.mts`
  re-exports `rollbackManagedService`.

- Codex hook adapter and hook-integrity hook split into modules below the
  250-line budget (issue #533). `codex/hooks/hook-adapter.mts` keeps the
  clock, the re-check and the process I/O and imports
  `hook-adapter-payload.mts`, `hook-adapter-verdict.mts` and
  `hook-adapter-run.mts`; its re-exports keep every importer's path.
  `codex/hooks/hook-integrity.mts` keeps the run under `run.lock` and loads
  `hook-integrity-repair.mts` and then `hook-integrity-sources.mts` as own
  steps after the four restore libs, into a namespace of their own; a
  broken sources module is restored as kind `self`, a broken repair module
  is reported and needs a reinstall, like the four restore libs. That
  widens the reinstall-only set by one file whose code moved out of the
  already reinstall-only `hook-integrity.mts`. The installer copies the
  five modules under their own names into `hooks/kherep-maestro`; every
  command definition, deny and notice text, timeout, exit code and the lock
  sequence is unchanged, and no trust hash moves. A broken adapter module
  is caught by the shell dispatcher's import and restored by its re-check;
  for the adapter's own groups it fails open until then, as a broken
  `codex-hook-adapter.mts` does today. Both adapter copies share the
  modules, so a broken module disables both at once.

- Codex messaging intent hook fails closed (issue #538). The optional
  `PreToolUse` messaging intent entry runs through `codex-hook-adapter.mts`
  in a new `pre-intent` phase: a missing, empty, broken, silent or late
  `mcp-intent-hook.mts` is a deny that names the file by its basename and the
  installer, without the guard's stderr; the hook's `allow` with
  `updatedInput` passes through only as the call's `tool_input` plus a UUID
  `requestId`, and every other shape is a deny. The entry's `timeout` is 15 s
  and the guard cap 12 s, so the 8 s acknowledgement wait is kept. Integrity
  re-check notices of this entry go to stderr only, so the documents Codex
  reads are the hook's own. Exactly this one definition changes (`command`,
  `commandWindows`, `timeout`), no entry index moves, the exact previous
  block is recognised and replaced, and Codex skips the entry until it is
  trusted in `/hooks`; until then the five messaging tools are unavailable,
  because the Worker rejects a call without the hook's `requestId`. The file
  stays outside `hooks/` and is not restored by hook integrity. Host
  behaviour (#537) and Windows (#534) remain UNKNOWN.
- The unused internal `readdress` and `updateDeliverySession` exports move
  from the active inbox and identity modules to
  `node/_deprecated/session-handover.mts`. Their legacy tests retain the
  previous behavior; active handover uses the shared task-owned helper
  (issue #638).
- Codex run guard: the regeneration hint for
  `codex/scripts/codex-run-expected.json` is printed only when the skipped
  tests differ from the list (C3), names the CI-log route first and states
  that a local run matches CI only on a host that matches the CI image. The
  observed skips are still printed after any skip check failure (C3, C4,
  C7). A local `run` without `--tap` writes a per-process TAP file, and the
  expected file is read once, before the tests run (issue #570).
- Codex run guard: `check` reconciles the TAP summary with the records it
  parsed, under Node's counting: test records at any depth count in
  `# tests`, suite records only in `# suites`, a SKIP or TODO directive
  decides the bucket even on a `not ok` record, and the plan `1..N` counts
  the top-level records. It fails closed with a `C8` line, without the
  observed skips or the regeneration hint, when `# tests`, `# suites`,
  `# pass`, `# fail + # cancelled`, `# todo` or the plan disagrees;
  `# skipped` stays C4. Two hand-written fixtures were made self-consistent
  (issue #578).
- Guard and hook-file names in deny reasons and hook-integrity notices
  (issue #564). Every reason or notice line that the Claude guard
  dispatcher, the Codex hook adapter, the Codex shell dispatcher, the
  re-check lib `hooks/lib/guard-recheck.mts` and the two hook-integrity
  scripts build themselves now names a file by its path inside the hooks
  directory, as the hook runtime entry does since #521:
  `[guard-dispatch] commit-guard.mts cannot run (…)`,
  `[hook-adapter] kherep-maestro/commit-guard.mts cannot run (…)`,
  `kherep-maestro/codex-shell-checks.mts cannot be trusted (…)`,
  `live-hook-integrity.mts exited with code 1`, and the dispatcher's and
  adapter's own failures as `guard-dispatch.mts` and
  `kherep-maestro/codex-hook-adapter.mts`. A file outside that directory is
  named by its file name. The hooks directory itself and the home are no
  longer spelled out (`the coordinated hooks directory is not this
  installation's hooks/`, `no hook file under hooks/ is wired in
  config.toml`, `config.toml unreadable (<code>)`). Raw error text left
  those lines: `spawn threw (<code>)`, `spawn failed (<code>)`,
  `stat failed: <code>`, `lib/guard-recheck.mts cannot be loaded (<code>)`,
  `stdin read failed (<code>)`, `own import lib/<name>.mts cannot be loaded
  (<code>)` (also the `reason` of its journal entry) and `the integrity
  check itself failed (<code>)`, and the adapter's last-resort deny is the
  fixed `internal error`; `<code>` is a Node error code, else the error's
  class name, else `unknown`. In the Claude dispatcher a guard outside the
  hooks directory reads `outside the hooks directory`. Text a guard writes
  itself passes through unchanged: its exit-2 stderr, its own
  `permissionDecisionReason`, and the field name in `unsupported field
  <key>` outside pre-intent. The pre-intent texts of issue #538 change only
  where an error had no code: it now reads its class name instead of
  `unknown`. Tests assert that no POSIX, drive, UNC or home-relative path,
  and no `..` escape, appears in the lines those components build. The
  restore and library texts followed in #576 (next entry). No command
  definition, timeout, exit code or Codex trust hash changes.
- Restore and integrity-library texts name no absolute path (issue #576,
  follow-up of #564). The restore lines of `hooks/lib/integrity-verdict.mts`,
  `codex/hooks/hook-integrity-repair.mts` and `hooks/critical-file-integrity.mts`
  name the versioned source by its path inside the checkout:
  `NOT restored (versioned source claude/hooks/lib/x.mts unreadable (ENOENT))`,
  `… codex/hooks/shell-checks.mts is itself 0 bytes`,
  `… claude/kherep/githooks/commit-msg unreadable (ENOENT)`. Which checkout
  was tried moves from the notice into the journal: the per-file entries of
  `incidents.jsonl` written by all three restore writers gain one key,
  `checkout`. `hooks/lib/restore-write.mts` refuses a linked hooks
  subdirectory as `hooks directory or its subdirectory resolves outside the
  hooks root`, the sentence the hook runtime already uses.
  `hooks/lib/hook-syntax.mts` keeps Node's parser message but reduces every
  absolute path in it to the file name: `rejected by node --check:
  SyntaxError: … (Node named it other.js)`, `… could not confirm (exit 1:
  g.js:1)`; a check that could not run reads a Node error code, else the
  error's class name, else `unknown`, as do the catch-alls `the
  critical-file check itself failed (<code>)` and the CLI's `UNGEPRUEFT the
  check itself failed (<code>)`. `hooks/lib/integrity-heartbeat.mts` prints a
  code-less error the same way (`run.lock unavailable (TypeError)`,
  `heartbeat write failed: unknown`), never its message. Tests assert that no
  POSIX, drive, UNC or home-relative path appears in any restore, parser or
  heartbeat line on either runtime. Limit: a path with a space inside a Node
  message (not a location line) keeps its tail after the space, as a deny
  reason does; the default Windows Node install reads `exit 9: Program
  Files\nodejs\node.exe: bad option: …`. No command definition, timeout, exit
  code or Codex trust hash changes.

### Fixed

- `stitch` with an empty `--id` no longer sweeps the whole space (issue
  #710). A present `--id` that is empty, blank or not numeric now exits 1
  before any request; `reportStitch` treats any supplied id as the targeted
  mode; the Codex observation adapter refuses a non-page id itself; and
  `claude-obs` takes the id only from the `id:` line its own `create`
  printed, reporting `OBS-RESULT: failed stitch without page id` otherwise.
  On 2026-10-31 an empty id fell through to the sweep and wrote to 127
  unrelated pages. The bare `stitch --space <key>` sweep is unchanged.
- Denied-call reports name the violation, not a guard's header (issue
  #700). The commit, deploy and main-checkout guards print a header ending
  in `:` and then their violations; the journal now records the first
  violation without its list marker, so a commit-guard denial renders as
  `[commit-guard] commit message contains an em dash (U+2014)` on Claude
  and Codex. A reason whose first non-empty line is no such header keeps
  that line. Path reduction, the 240-character cut and the private-marker
  refusal apply to the chosen line, and the refusal also to the skipped
  header. Only the first violation is recorded. The journal format is
  unchanged; lines written before the fix still render with the header.
- Brain drainage confirm path (issue #687): a `code` page that declares no
  binding can be marked `evidence-superseded` when a same-space page binds the
  revision at which the measurement contradicts the claim. `decide
  --superseded-by` reads that page's storage body for its Revision lines; new
  reason `superseded-page-not-bound`, and a superseding page whose status is not
  `current` is refused (`superseded-page-not-current`). Confirm and refute still
  require the page's own bound revision.
- Codex installer: an upgrade no longer refuses a managed block into which the
  Codex CLI wrote its `[hooks.state]` trust tables and `[tui]` (issue #684);
  they move behind the end marker with the text TOML gives them, and any other
  difference, a multiline value in the block or a changed document still refuses.

- A stop failure is visible to the operator without a candidate record
  (issue #677). A failure in the `stop` or `prove-stopped` stage carries a
  fixed `stopCode` from the existing allowlist, which gains
  `STOP_UNLISTED_ALIVE`; `stopCode` classifies a stop error by an
  allowlisted `code` first and by its exact message otherwise. The CLI
  prints the field only when it is in the allowlist, never raw text.
  `service status` with a stopped service whose recorded daemon still runs
  names that state and the manual step, instead of the stale-drain upgrade
  text that the upgrade precondition refuses.

- macOS stop proof after `launchctl bootout` returned 0 and unlisted a job
  whose process stays alive (issue #677). `proveStopped` is the single
  stop-proof entry point for upgrade, rollback and both recoveries; it
  computes one deadline (75 s, monotonic clock) at its entry and hands it to
  an optional adapter hook, which replaces the generic poll. The Mac hook
  (`service-platform-mac-reclaim.mts`) records the daemon's identity right
  before bootout and, only after `launchctl print` reports the job not found
  twice at least 1 s apart with the pid alive and enough grace left, sends
  one SIGTERM, then from 5 s before the deadline one SIGKILL, each to the
  attested pid only and only after a fresh process table without
  descendants, a fresh not-found print and a matching identity read in the
  same synchronous turn. Success needs a post-exit process table with
  nothing left in the daemon's group and none of the children seen while it
  lived, also when the pid ends on its own after launchd reported the job
  not found; a refusal (identity drift, children, an unreadable table) is
  never overtaken by a later exit. No launchctl, ps, osascript or kill call,
  including the second call of a two-step read, and no liveness poll starts
  after the deadline; a parent whose fate after a signal, or after launchd
  reported the job not found, is unknown at the deadline leaves the family
  unproven. Every other
  case fails closed with a stop code; recovery then writes and starts
  nothing while the previous pid lives or its family is unproven, and the
  drain stays. Windows and adapters without the hook keep the generic poll.
  The read-to-signal pid-reuse race is stated, not closed.

- Codex model catalog read in a fresh Codex home (issue #667, macOS/POSIX).
  After the app-server exits, the process-group probe may answer EPERM for
  about 100 ms before ESRCH, and one orphaned helper of the fresh home's
  plugin sync may outlive the group leader by a few milliseconds. The
  cleanup check now re-asks the probe for a bounded time (`cleanupGraceMs`
  1..10000, default 2 s, probe cap, monotonic clock) and sends no further
  signal: a process-group number does not prove ownership once the owned
  close has run. Only ESRCH confirms; a group still present or denied at
  the deadline fails closed as `stage: cleanup`. On every platform the
  catalog app-server is started with the per-invocation override
  `-c features.plugins=false`, measured effective on codex-cli 0.160.1
  (macOS and Windows 11): the read then performs no plugin sync in a fresh
  home. This is a
  one-off CLI override; a managed configuration that pins the key, or a
  later Codex, may behave differently, and the bounded wait carries the
  read in that case. `--codex-home` naming a missing directory is created
  (0700) before the read; Codex refuses a `CODEX_HOME` that does not exist.
  `CatalogReadError` carries a bounded `stage` (`start`, `catalog`,
  `cleanup`) and whether cleanup was confirmed; the installer prints it as
  a suffix of the existing message. A transport failure of the
  `initialized` notification is reported as `stage: start`, not `catalog`.

- Codex model catalog read on Windows (issue #667, Windows). The tree
  signal's `taskkill` exit code was the verdict: a tree already gone
  answered 128 and failed the read as `stage: cleanup` (4 of 12 fresh-home
  reads; why `taskkill` answered 128 is unknown). A second mode, measured once in 40 reads, was a late child of the
  fresh home's plugin sync that outlived the root, held its stdio pipe and
  was still in the one post-kill snapshot 0.4 s after exit. The tree signal
  is still sent only while the owned child holds its root, but its report
  is no longer evidence either way. Cleanup is confirmed by observed state
  only: exit and close of the owned child and a snapshot without a tracked
  member or a descendant of the root, re-read within the same bounded
  `cleanupGraceMs` loop as on POSIX. A tree observed gone no longer fails
  because of the `taskkill` exit code. The loop itself signals nothing; only
  the client's own close may still signal, and only while the child is
  owned. A member
  still present at the deadline, a snapshot that cannot be read, or a child
  that never exits or closes fails closed as `stage: cleanup`. The catalog
  app-server now starts with `-c features.plugins=false` on Windows too;
  measured on codex-cli 0.160.1 the fresh-home tree is then the app-server
  alone. `signalGroupReport` and the fork reply close are unchanged.

- Confluence brokers: a line directly after a preformatted block is read
  as its own line (issue #669). `plainText` ended a line at `</p>`,
  `</div>`, `</h1>`-`</h6>` and `</li>`, but not at `</pre>`, so a
  `<p>Revision: …</p>`, a disqualifier or a `Code:`, `Host:` or `Doc:`
  line right after `<pre>…</pre>` was glued to the code block and never
  parsed. A missing Revision failed safe, a hidden disqualifier did not.
  Now only a `</pre>` that closes a real outermost `<pre>` ends a line,
  for the `evidence` classification and the drainage scanner alike. XML
  comments, CDATA sections and processing instructions are opaque, so a
  `<pre>` or `</pre>` spelled inside one opens or closes nothing, also
  inside a real `<pre>`; an unclosed `<pre>` ends no line, and a
  self-closing `<pre/>` opens none. Revision lines are read in two views
  (`revisionLines`, which replaces `parseRevisionLines` and takes the
  storage body): the base view keeps every line, duplicate and
  disqualifier the old reading found, in order; a marked view adds only
  lines that start right after such a `</pre>` or after an opaque region,
  which it replaces with a separator, never with nothing. Every line it
  does not add stays in it as a barrier, and so does the seam to the base
  view, so a label and a colon or value from two lines that were not
  adjacent on the page never join. A bare `Revision:` label right after a
  code block, followed by an ordinary paragraph, is an empty malformed
  declaration and refuses confirmation; label and value belong on one
  line. Text quoted
  inside a `<pre>`, comment, CDATA section or processing instruction, or
  in the excerpt of a complete measurement block, therefore never newly
  binds, and two halves of a SHA around an opaque region never join. The
  line-anchored claim signals (`Code:`, `Host:`, `Doc:` and their
  aliases, and the scanner's code-bound line check) read the same two
  views (`claimViews`), so quoted text in a comment, CDATA section, PI or
  another `<pre>` after a real `</pre>` adds no signal. Code tokens,
  tracker keys, command words, URLs and the historical signal keep the
  base text. `<blockquote>`, table cells
  and rows and `<br />` are unchanged: documented storage wraps quote
  text in `<p>`, and a table row or a line break as a line is a separate
  decision.

- Confluence brokers: a text-search result row without a readable title
  makes the exact-term half UNKNOWN instead of disappearing (issue #656).
  A row whose title was missing, not a string, or only whitespace in both
  documented places (`content.title`, then `title`) was dropped, so
  `{"results":[{}]}` read like an empty search: `related` printed
  `count: 0` with exit 0 and `stitch` counted the orphan `isolated`. A
  whitespace `content.title` also hid a readable flat `title`; it no
  longer does. Each row is now counted once, after both places, and the
  readable titles are kept. The exact half then reports
  `exact-term search: <n> of <m> result row(s) had no readable title.
  Hits from this half are incomplete and UNKNOWN. cql: <cql>` and never an
  HTTP status. `related` keeps its exit convention: with hits it prints
  `The exact-term half was not fully read. The list may be incomplete.`
  and exits 0; without hits it prints `The exact-term half was not fully
  read and nothing was found. This result is UNKNOWN, not zero.` and exits
  1. `stitch` skips that orphan before any assignment, as it does for a
  refused search: it prints `unsearched <id> <reason>`, counts it as
  unsearched, writes no link from an incompletely read search, and exits 1.
  A structurally malformed response (no `results` array, or a row that is
  not an object) still aborts with `malformed-response`.

- Staged Claude intent hook test under host load (issue #657).
  `claude-mcp-client.test.mts` scanned for the hook's published intent 100
  times, 10 ms apart, while the hook process type-strips its module graph,
  digests the input and only then renames the intent into place. On a
  `unit-engines-floor` run no published intent name was observed in those
  scans, and nothing of the hook's lifecycle or output was captured. The
  test now waits for the first of a published intent, the hook's close, or
  a bound, and every later wait is bounded as well. Only the child's
  `close` counts as closed: an `error` event is recorded, a timeout is
  reported as a timeout. A failure names the exit and close state, the
  recorded errors and bounded stdout and stderr. The fixture directory is
  removed only after the close of every hook started in it was observed;
  otherwise it is kept and the cleanup fails. The receipt is written
  atomically, and the delayed case asserts the full rewrite, since a denial
  also exits 0. Controls with real children: a 2.5 s pause before the
  intent rename that the hook reports from inside (with it, the old loop
  failed and the new wait passed in the observed runs; neither is
  guaranteed under every scheduler), a policy denial, a crash at import, a
  hang before and a hang after publication, and a hook whose stdio stays
  open after SIGKILL. The helpers live in `mcp-intent-hook-fixture.mts`.
  The hook is unchanged; the cause of the CI failure is not established.

- Confluence brokers: `related` and `stitch` build the CQL text search from
  the title's words, not the raw title (issue #651). The value of
  `text ~ "..."` is parsed by Lucene, whose syntax includes `( ) ~ " \ : * ?
  [ ] { } ^ ! + - /`; a title carrying them was sent unescaped, and a title
  with parentheses and commas drew HTTP 403, an earlier one with a tilde
  HTTP 500. The query now holds only the title's lowercase content words
  (the words `selectRelated` can accept a neighbour on), every word
  required, no phrase and no OR. A title with no such word sends no
  request. A text search that fails with an HTTP status no longer aborts
  the run or reads as a missing scope: `related` prints the status and the
  CQL, keeps hits from the semantic half, and exits 1 only when nothing
  was found by a half that ran; `stitch` skips that page, counts it as
  unsearched, prints `unsearched <id> <reason>` and exits 1 as it already
  did for a failed semantic search. The cause of the 403 is not determined
  and is not stated. `textSearch` moves to `confluence-text-search.mts`,
  which the Claude and Codex installers project and drift-check beside its
  siblings; `ConfluenceRequestError` carries Atlassian's body message as
  `detail`.

- Codex hook adapter: the capture-failed marker of the denied-call journal
  (`<CODEX_HOME>/.cache/denied-calls/<agent_id>.failed`) is on disk when the
  adapter process has exited (issue #612). `journalCall` gave the marker the
  last 400 ms of its 1 s window and `emit()` then exited through
  `process.exit(0)`, which abandons a pending `fs.promises` write; a slow
  write left no marker, and a later `render` could read a count or `none`
  for a worker whose line was lost. The marker write is now awaited until
  the hook deadline less 250 ms (about 8.25 s after the hook process
  starts, 13.25 s in the intent phase); the journal lib keeps its 600 ms.
  A write that never settles still holds the deny until that deadline
  instead of 1 s, and still leaves no marker. The shell dispatcher is
  unchanged: it exits when its event loop drains, so its marker landed
  already; a test pins it.
  The test fixture gains the fault `marker-slow` (an append on `*.failed`
  that settles after 700 ms), which is red against the previous adapter.
- Codex shell dispatcher: after its checks, flush stdout and stderr before
  exiting with code 0, so a stuck denied-call marker handle cannot retain a
  completed deny until the native timeout (issue #621). Journal and marker
  writes share at most 2 seconds, shortened by the remaining hook budget;
  the lib keeps its 600 ms cap. With the full capture window and prompt
  scheduling, a marker delayed by 700 ms still persists.
  Writes pending at that cap can lose evidence. Imported `shellChecks()`
  does not exit its caller, and uncapped attribution still prevents an
  unconditional 40-second answer guarantee. Isolated child-process tests
  cover the stuck marker, broken-adapter fallback, the deadline clip and
  both stream callbacks; installed Desktop behavior remains UNKNOWN until
  measured.
- The header of `modules/control-plane/node/wake-hook.mts` no longer quotes
  "There is no deduplication" from the Claude Code hooks page, which no
  longer carries that sentence (issue #613). It cites the current
  "Limitations" line on separate background processes and names the
  section the `timeout` sentence comes from. Comment only.
- `kherep-node doctor` hooks check (issue #592): the duplicate scan reads
  the installer template of the running source and ran in the same step as
  the settings read, so a missing template (`ENOENT`) reported a present
  Claude `settings.json` as absent. The scan now runs after the read, in its
  own step; when it cannot read the template it reports `duplicatesUnknown:
  true` and the check fails with `the control-plane template of this source
  is unreadable; duplicates unknown` instead of reading as clean or absent.
  An absent `settings.json` is still reported as absent.
- `capture.sh` on Windows (issue #592): `portable_paths` folded the Claude
  home in the forms of `CLAUDE_HOME` as given, while the renderer writes it as
  `path.resolve` gives it, on Windows with backslashes, so every
  captured command under the Claude home kept the machine path instead of
  `~/.claude`. Both forms are folded now.
- Client binding probe: on Windows the lock that serialises intent creation
  and verification (`locks/create.lock`, `locks/<requestId>.lock`) is no
  longer abandoned when another process is releasing it. An exclusive
  create on a lock file in the delete-pending state fails with
  `ERROR_ACCESS_DENIED`, reported by libuv as `EPERM`; the waiter now
  treats `EPERM` like `EEXIST` (and `EACCES` and `EBUSY` too, included
  defensively) and keeps waiting within the existing bound of 50 attempts
  of at least 4 ms each (at least 200 ms), then fails closed with the
  fixed `storage_error` as before. Two concurrent hook runs
  or two server processes on one Windows host no longer deny a call
  spuriously, and the CI job `client-binding-probe (windows-latest)` no
  longer fails in `concurrent first use waits for atomic key publication`;
  that test now awaits the helper's exit on every path, so no activity
  outlives it. POSIX behaviour is unchanged except that a genuine
  permission error on the lock file is reported after the same wait of at
  least 200 ms (issue #600).
- Control-plane locks: the other exclusive lock creates now treat a
  Windows delete-pending lock (`EPERM`, and `EACCES` and `EBUSY`
  defensively) as contention instead of a hard failure, through one shared
  classifier (`node/lock-contention.mts`) that looks only at the create.
  The mid-turn delivery lock used to skip the delivery at once; it now
  retries at most 50 times of at least 4 ms before it defers, and these
  codes never trigger its 5-second stale takeover. The autonomy budget lock
  used to deny the turn at once; such a create now uses one of its existing
  50 attempts of 10 ms. The Codex busy-ticket lock used to report `failed`;
  it now reports `busy` at once, while directory errors and every other
  create error stay `failed`. The service owner file (drain, transaction
  lock) used to throw the raw error; it now retries on one allowance of 50
  per acquisition shared with its reclaim gates, then fails with its
  "already active" message and the code as `cause`, and `EEXIST` still needs
  owner proof. The Windows launch permit retries the same codes at both of
  its creates on one shared allowance; `EEXIST` at the second create stays a
  conflict. The PID write of the mid-turn and budget locks is split from the
  create, and a failed write removes the lock it just created instead of
  leaving it for the stale rule. Client binding probe: a holder now writes a
  complete owner record (`version`, `pid`, `token`, `at`, and a closing
  newline) into its lock before it works, and a lock whose record is complete
  and whose process `process.kill(pid, 0)` reports absent is reclaimed
  through a `.reclaim` gate that rereads the exact bytes, at most 4 gate
  levels deep. An empty lock of an older version, an incomplete, malformed,
  oversized or symlinked lock, and a live or unverifiable owner are never
  removed automatically, whatever their age; the probe README documents the
  manual cleanup of a quiescent host. A failed release used to be swallowed;
  it now reports `storage_error`, keeps the persisted intent or receipt, and
  that process creates no new probe lock until it has retried that release,
  after which the exact verification returns the same receipt; a lock
  descriptor whose close failed is reported once and never closed again,
  and the lock is still removed by path. Intent
  pruning skips an intent that a concurrent verification removed after the
  listing (`ENOENT`) instead of failing the creation; every other per-entry
  error still fails it. A verification whose expired intent was removed by
  such a pruning reports `intent_expired` instead of `storage_error`. A lock
  descriptor is closed at most once at every boundary, also when its close
  fails (issue #602).
- Service owner file and launch permit: a failed write, fsync or close after
  the exclusive create no longer leaves the caller's own file behind. Such a
  partial owner file used to make every later `service upgrade` or `service
  rollback` refuse with an owner that "cannot be verified", and a partial
  permit made `claimServiceLaunchPermit` throw, until an operator removed the
  file by hand. The descriptor is still closed at most once; the file is then
  removed, also when only the close failed after a complete write, and the
  original error is rethrown unchanged. If that removal fails too, the
  original error is still rethrown and the file stays for manual cleanup
  (issue #644).
- A failed macOS upgrade recovery no longer leaves the new daemon loaded
  under the prior plist, after which every service command refused (issue
  #582). `restorePrior` wrote the prior definition after the candidate stop
  had failed; a plist write changes only the file, never the loaded job, so
  launchd kept the candidate while the file held the prior and every read
  attested the mismatch. The stop failure was swallowed. Recovery now fails
  closed: the prior bytes are written only over nothing, over themselves or
  over a candidate proven absent; a candidate that still reads as loaded
  stays in place, consistent, and the failure reports blocker
  `RECOVERY_CANDIDATE_LOADED` with one of seven fixed stop codes
  (`stopCode`), never the stop message. `removeFresh` does the same for a
  fresh install. `service/candidate.json` records the candidate (binding,
  digests, the bound prior backup, command, stage, blocker, stop code,
  `failedAt`), and three verbs finish through the proven stop path: `service
  upgrade` activates over it, `service rollback` restores the receipt's
  definition from the recorded prior backup, and after a failed install a
  repeated `service install` without `--adopt` completes it (`--adopt` over
  a recorded candidate is refused). The record is used only while its
  digests are exactly in place under the receipt's binding and its prior
  backup is bound to the receipt; anything else refuses with a fixed text
  before any mutation. `service status` reports the record as `candidate`
  (commit, command, stage, blocker, stop code, `failedAt`, whether the prior
  is bound), `stale` or `invalid`; when the native read fails it reports
  `definition: "unattested"` and `running: "unknown"` with exit 1 instead of
  throwing, on macOS with the configured plist classified by digest as
  `receipt`, `candidate` or `unknown` and a reload hint only for the first
  two. Without a receipt it reports a recorded install candidate, and
  otherwise stays `{ ok: true, managed: false }` without reading the
  service. A node that is already wedged still needs the manual reload in
  `docs/INSTALLATION.md`.

- Follow-ups of the start maintenance (issue #589, after issue #581). The
  sliced inbox purge leaves records whose file was touched within two
  seconds before the pass began as well as during it. Filesystems stamp a
  write at a coarse tick (Linux one timer tick, NTFS the system time, an
  ext4 inode without the extra field whole seconds), so a record written
  just after the pass began could carry a stamp below the pass start and
  escape the skip that keeps it, for example a refusal not yet reported.
  On macOS (APFS) every stamp was measured above a `Date.now()` read just
  before the write; on Linux and Windows the lag follows from the kernel
  and platform documentation and was not measured. The margin only delays
  the retention of such a record to the next start. The daemon's refusal
  check for sessions that are not running (the first session snapshot
  after connect, every snapshot and every `session.list`) reads the
  daemon's inbox index instead of every inbox file. After a start the
  daemon therefore reads the whole inbox at once only once, to build the
  index, instead of twice; the sliced start maintenance still reads each
  record in its own slices, and later checks stat each record. Each
  refusal is still judged on the record's file, read just before it is
  rewritten, so a stale copy can delay a refusal but never refuse a record
  readdressed to a running session. Hooks and the CLI still read the
  files. The `recorded <n> sent message(s) replied` line counts the
  records the pass wrote, not those a reply arriving meanwhile had already
  settled. The offline fallback timer of the maintenance is cleared once
  the maintenance started. The ordering test's slice count no longer
  depends on host speed (a fake clock drives the slicer in the test).
- Control Plane Worker: `agents` moves from 0.24.0 to 0.28.1, and with it
  `@modelcontextprotocol/server` and `@modelcontextprotocol/client` from
  2.0.0 to 2.3.1 and the peer-installed `@modelcontextprotocol/sdk` from
  1.30.0 to 1.32.1, plus the sdk's own express and hono dependencies such
  as express 5.3.0 (issue #591). `agents` pins its MCP peers to exact
  versions, so the four can only move together; the separate Dependabot
  bumps #542, #551 and #553 each failed `npm ci` with `ERESOLVE`. The move
  clears the advisories `npm audit --omit=dev` reported against the MCP
  packages: the high-severity GHSA-jm63-cq47-j5jp, GHSA-46jr-4wx8-v453,
  GHSA-6qxp-vccf-f47h and GHSA-22jm-h49p-29qw, and the moderate
  GHSA-rvq5-wwqv-78pq and GHSA-6prh-2h8m-c8cw. The Worker code needs no
  change: it builds a new `McpServer` per request for `createMcpHandler`,
  which the server's one-connection-per-instance rule of 2.3.0 requires.
  The install-script set and the `allowScripts` pins are unchanged. Not
  deployed; the running Worker keeps the old packages until its next
  deploy.
- The Claude installer no longer duplicates the control-plane hooks when it
  runs from another root than the install before it (issue #590). The
  replace rule identified an existing `deliver-hook.mts`, `wake-hook.mts` or
  `attribution-hook.mts` entry by the full script path, so an install from a
  service source pin after an install from the checkout added a second set:
  a macOS node held 16 control-plane entries instead of 8 over
  `UserPromptSubmit`, `Stop`, `StopFailure`, `PostToolUse` and
  `SessionStart`, every delivery and wake hook command ran twice per event,
  and neither `drift-check.sh` (the merge kept both sets, so the expected
  file equalled the live one) nor `kherep-node doctor` (it counts hooks, not
  entries per event) reported it. The identity is now the script's path from
  `modules/control-plane/node/` on, without root or extension and
  case-folded on Windows (`bootstrap/managed-hook-key.mts`
  `controlPlaneHookKey`), so an install from any root replaces every entry
  of the same script on the same event; a command that chains the script
  with a shell control operator, substitution or redirection stays as an
  operator hook, other operator hooks are untouched, and the replace stays
  unreported as before. `drift-check.sh` runs `bootstrap/duplicate-hooks.mts`
  on both settings files and fails with one
  `DUPLICATE-HOOK <event> modules/control-plane/node/<script> x<n>` line per
  script the installer template wires that appears more than once on an
  event it wires it for; the doctor's `hooks` check reports the same
  `duplicates` for the Claude file and fails with `a control-plane script is
  wired more than once on one event; run bootstrap/install.sh again`. Codex
  is not affected: its commands name the stable entry point and the
  installer replaces its managed block whole. Installing again from the
  current root removes the duplicates.
- A service upgrade, rollback or stale-drain recovery to this version no
  longer fails its 30 s health check on a node with a large local queue
  (issue #581). The daemon start's inbox maintenance (issue #520: settle
  answered sent records, then purge records older than 7 days) read every
  `sent/` and `inbox/` file before the daemon connected: 58 s on a node with
  4688 inbox and 2528 sent files, and 106 s for the old daemon during the
  rollback (cause UNVERIFIED). It now runs once per daemon process after the
  first authenticated connection, or 60 s after the start when no connection
  comes, in the background in slices of about 50 ms off the frame lanes,
  settle still before purge, with the same rules and log lines. A reply that
  arrives meanwhile is settled on arrival as before. The sliced purge leaves
  inbox files written since the pass began to the next start, so a record
  the daemon refuses meanwhile is reported refused before it is removed
  (issue #195). The connect path still captures the source identity of the
  pin, which grows with the source tree, not with the queue. The
  `connected as` line carries the seconds since the daemon start and the
  process uptime, and one line reports the maintenance's duration
  (`start maintenance done in <s> s`, or `stopped after`). The join of sent
  records with their replies is linear instead of quadratic, and a purge
  skips an entry another purge removed after its listing instead of
  aborting. When a failed health check restores the prior service, that
  restore now waits up to 180 s for its health, because a prior source may
  still maintain its queue before it connects; the forward health check
  keeps 30 s.
- Upgrade of a changed managed Claude hook (issue #568). The settings merge
  kept an existing entry next to the managed one whenever anything besides a
  spelling of the same paths differed, so after a template change both ran
  in parallel: a changed `timeout`, a changed mode, and a guard added to or
  removed from a dispatcher group, which ran every guard of that group
  twice. A managed hook that runs through the hook runtime now replaces
  every existing entry of the same event and matcher group that runs the
  same main under `<CLAUDE_HOME>/hooks/`, an operator's edit of it and an
  extra `guard-dispatch.mts` entry with other guards included. Each
  replaced entry that differed prints
  `hooks: replace <event> [<matcher>] hooks/<main>`; an unchanged upgrade
  prints nothing, and a file that already carries the duplicate heals to
  one entry. Entries for another hook file, at another matcher or under
  another home, and forms the template never renders (`& node`,
  `node <flags>`, single quotes, mixed quoting, `/c/...`, `.` or `..` in the
  main path, a line break between the parts, and a shell control operator,
  substitution or redirection after the main outside double quotes) stay.
  A template change to a managed group's matcher is not covered. The
  recogniser is the new leaf module
  `bootstrap/managed-hook-key.mts`. Codex needed no change: its installer
  replaces the managed hook block as a unit and refuses an unrecognised or
  edited previous block instead of keeping both.
- The Control Plane Worker's `allowScripts` pin names the workerd version
  its lockfile resolves (issue #559). The pin still named
  `workerd@1.20260923.1` while `package-lock.json` resolves
  `1.20261006.1`, so the pin matched nothing and `npm ci` listed workerd
  under "install scripts not yet covered by allowScripts". The pin is now
  `workerd@1.20261006.1`; `bootstrap/allow-scripts-lock.test.mts` fails when
  a pinned `allowScripts` entry in any tracked `package.json` names a
  version its sibling `package-lock.json` does not resolve. `core-js-pure`
  (a postinstall banner) and `fsevents` (an implicit node-gyp rebuild; the
  package ships its prebuilt binary, macOS only) are denied by name, so
  `npm ci` in the Worker prints no install-scripts notice. Under npm 11 an
  uncovered install script still runs with a notice and a denied one is
  skipped, so the workerd postinstall ran before this change too.
- Hook runtime error paths under injected faults (issue #521). A
  coordination database the hook process can read but not write
  (`run.sqlite` mode 0444, a read-only mount, another owner) is opened
  read-only by SQLite, where `BEGIN EXCLUSIVE` excludes nothing: the
  integrity writer and every replay of a recorded repair are now refused as
  `not admitted: unavailable` before a byte is written, where a reader with
  a pending repair used to write the target under that hollow hold; readers
  without a pending repair stay admitted. The Codex `run.lock.sqlite` in the
  same state is refused as `run.lock unavailable (ERR_SQLITE_ERROR)`
  instead of granting a second owner. A repair whose hold could not be
  taken back reports what happened instead of "busy after the repair was
  recorded": `write failed (ENOSPC)` for a write that left a prefix (the
  intent stays pending), `the repair was written but its record could not
  be cleared (<kind>); ...` for a clear that SQLite rolled back, and a
  proven repair when its replay had committed. The dispatcher's
  last-resort deny is the fixed `[guard-dispatch] guard-dispatch.mts cannot
  run (internal error); ...` without the raw Node message or a path. New
  suites `claude/hooks/hook-runtime-fault-*.test.mts` inject SQLite
  auto-rollback, ENOSPC, EACCES, spawn failures and the last-resort catches
  through `fault-preload.fixture.mts` and in-process patches.
- Observation result check at the handback (issue #555). Since Claude Code
  v2.1.271 an auto-mode subagent delivers its report through
  `SubagentHandback`, and `last_assistant_message` at `SubagentStop` holds only
  its closing text, so `obs-result-check.mts` could block a delivered report or
  pass a wrong one. A new `PostToolUse` hook, `obs-handback-record.mts`, matched
  on `SubagentHandback`, now checks a `claude-obs` report where it is
  delivered, records the verdict under
  `<CLAUDE_HOME>/.cache/obs-result-check/<agent_id>.delivered` and gives the
  operator the `failed` and still-malformed notices. `obs-result-check.mts`
  reads that state first, waits up to 2 s for it when a handback is plausible,
  never blocks when Claude Code reports `permission_mode` `auto` or when the
  subagent transcript shows a handback, and keeps its `last_assistant_message`
  path, block included, for subagents without the tool. A malformed handback
  is reported, not refused: whether a refused handback would be retried is
  UNKNOWN until measured, and an observation run follows nearly every turn.
  The stop hook writes a fixed-key trace, `<agent_id>.stop`, for that host
  measurement and prunes the directory after 24 h. The `SubagentStop` entry is
  unchanged, so the stop uses Claude Code's default hook timeout; an installer
  upgrade keeps exactly one entry of each hook, which a new bootstrap test
  renders. Codex is unchanged: its hooks reference has no `SubagentHandback`.
- Windows: `writeJsonAtomic` (daemon.json, inbox records, task and session
  records, receipt.json) retries the replace-by-rename on `EPERM`, `EBUSY` and
  `EACCES` up to 8 attempts with 10–640 ms backoff (1.27 s in total) while
  another process holds the target open; the temporary file is removed only
  after the last attempt and the original error is rethrown unchanged. A
  `kherep-node service upgrade` is less likely to fail at stage `health` with
  recovery `restored` when a reader briefly holds `daemon.json` open while the
  new daemon records its state; a hold longer than the budget still fails the
  write as before. POSIX is unchanged (issue #540).
- A daemon refusal no longer loses a delivery written meanwhile (issue #627).
  `markRefused` read an inbox record and rewrote it; a delivery hook in
  another process that offered or delivered the same record between that
  read and that write lost its update, and the record ended `refused`
  although the session had received it. Every rewrite of a record body
  (`setDeliveryTask`, `markDelivered`, `markAnswered`, `markOffered`,
  `markRetry`, `markClosedAttempt`, `readdress`, `markRefused`) now reads,
  judges and writes under the record's lock, an exclusive create of
  `.<messageId>.json.lock` next to the record
  (`node/inbox-record-lock.mts`, the lock pattern of the client binding
  probe): `EEXIST`, and on Windows `EPERM`, `EACCES` and `EBUSY` for a lock in
  the delete-pending state, mean held and are polled every 20 ms; a lock
  older than 5 s, either way of the clock, was left by a holder that died and
  is moved aside, compared and removed, never a fresh one; a newer lock that
  took its place meanwhile is linked back, or renamed back where the file
  system has no hard links. A hook, the msg CLI and the MCP client wait 1 s
  for a held record; the record locks of one delivery hook call (the prompt
  delivery, a Stop confirmation, a StopFailure retry flag) share one 1 s
  budget, so a PostToolUse delivery ends well inside its session lock's 5 s
  stale bound. The daemon waits 250 ms for all the record locks of one lane
  item together; a record held beyond that is left to the next round. A
  record still held after its wait is reported, typed `RecordLockBusy`, and
  handled per writer: an offer, delivery confirmation, retry flag, answer or
  refusal is "not written" and repeated by the next event, round or read (a
  repeated offer at worst, never a lost one); a delivery identity, closed
  attempt or readdress fails its daemon round, which runs again, except after
  an intercom session was started or resumed for the message, where the
  record is logged and left out of the hand-over so the round does not start
  a second session. `markOffered` judges the record under its lock too and
  does not offer one that was delivered or refused meanwhile. The delivery
  hook marks a record offered before it shows it and shows exactly what it
  marked; a record it could not mark waits for the next turn. The purge
  judges a record's state and receipt on the record under its lock, where it
  also removes it, instead of on the listed copy: a record delivered after
  the listing stays until a receipt confirms that state (#195). The write
  itself is still `writeJsonAtomic` with the Windows rename retry of issue
  #540. `readdress` judges each record again under its lock and returns only
  the ids it moved. The purge removes leftover lock files of retention age
  like leftover temps. The staged messaging client graph of both runtimes
  gains the new module. Limits: a holder slower than 5 s is treated as dead
  and its write can then be lost as before; a Windows reader that keeps a
  lock open while its holder releases leaves the lock to that 5 s rule; a
  Windows rename retry (1.27 s per write) inside a PostToolUse call is not
  covered by the budget, as before. Thirteen deterministic tests (each writer
  holding the lock at its rename, two with the lock held from another
  process, three of the purge) are red on the previous code.
- Record-lock follow-ups (issue #634): a busy Claude intercom handover, or a
  busy record in a task's `deliveryPending`, defers saving its mapping to the
  next watch while later tasks still run. Retrying repairs delivery identities
  for messages already moved from the previous session, and fresh moves retain
  older provenance. Each executing Codex intake-window frame or coalesced tick
  gets its own 250 ms lock-wait allowance, shared by its acquisitions,
  including work after an await. Other errors still propagate.
- A Claude task past its max runtime whose `claude stop` cannot be confirmed
  is no longer stopped again every watch round for ever (issue #541). After a
  failed stop the watch measures the run as owner status does
  (`measureClaude`): a session without a live process is recorded at once
  (`done` stays `done`, otherwise `stopped`) with the reason "max runtime
  reached; claude stop not confirmed, fresh status shows no live run"; a run
  whose process still lives, also behind a row that shows it ended, or whose
  status cannot be measured is stopped again for at most `MAX_STOP_ROUNDS`
  (10) rounds, counted on the task record (`stopAttempts`) so a daemon restart
  does not reset it, then recorded `stopped` with the reason "max runtime
  reached; claude stop not confirmed after 10 rounds". Each outcome is logged
  once; a failure while handling the unconfirmed stop is logged and the watch
  round goes on with the other tasks. Codex tasks are not changed here; the Codex deadline stop still
  retries every round when the recorded pid was reused by a live foreign
  process (issue #544).
- Interrupted Claude intercom copy handover now recovers pending messages
  associated with the exact delivery task/runtime, including older intermediate
  addresses, and corrects their destination identity (issue #635). Watcher and
  immediate resume adoption share the same record-locked operation. All pending
  messages at the previous address retain legacy movement; foreign identities,
  provenance and offer/retry evidence are preserved. Delivery identity updates
  require a matching task and runtime; a destination record belonging to the
  same task under another runtime keeps its existing identity. Busy resume
  recovery keeps its old mapping and new short ID so watch can finish without
  another launch.
  Target-local terminal metadata may correct, while terminal records elsewhere
  stay unchanged. Existing opt-in fallback limits for unowned intermediates
  remain; no historical sweep is added.
- Malformed nonempty Claude adoption IDs are deferred per task, so later tasks
  in the watch round continue. A bookkeeping error after a resumed run is kept,
  including admission release failure, no longer authorizes a second session
  start. Empty-ID mapping and the two explicit failed-resume fallback paths
  retain their existing behavior (issue #638).
- Claude start and continue mapping no longer adopts a listed full session ID
  that is not a valid session reference (issue #639). A new start, including
  the closed-session fallback, keeps its short ID, pid and pending marker
  without a full ID, so its intercom messages stay delivery-pending under the
  task name until a valid listing maps them; a continue keeps its previous
  valid full ID while pending. The watch diagnostic for a malformed listed or
  stored ID now reads `session id is not valid; mapping deferred`. An ended
  intercom task whose stored full ID is not a valid session reference is no
  longer selected for resume, so that ID never keys a turn budget file (on
  Windows a control character made the budget report `locked` every round);
  its messages take the guarded new-session path on the closed target, with
  that target's readiness, limits, working directory and budget. The direct
  resume keeps its unchanged pre-launch refusal of such an ID (issue #638),
  which this earlier selection now precedes. Existing records are not
  migrated.
- Receipts for messages whose reply had already reached this node no longer
  appear after a service restart or upgrade (issue #520). They had never been
  shown: the reply in the inbox kept them quiet, and the daemon start's purge
  of inbox records older than 7 days removed that reply, after which the
  `delivered` sent record surfaced with its week-old time. A reply now records
  the sent message `replied` on this node: on arrival, at the next
  delivery-hook read, and at every daemon start before the inbox purge. A
  record whose reply an earlier restart had already purged can still surface
  once, for a session that had no hook event since; nothing on the node
  distinguishes it from a receipt never shown.
- Control-plane e2e tests under host load, and a Worker comment (issue
  #607). `exchange-recovery-e2e.test.mts` and
  `cross-runtime-reply-e2e.test.mts` polled inbox, sent and directory files
  every 50 ms with a 5 s bound inside Vitest's default 5 s test bound, and
  slept a fixed 150 ms after every exchange round; under load the test bound
  fired first. The harnesses now log every frame the node client handled,
  dropped or sent (`test/frame-log.mts`) and wait on the frame that writes
  the record under test: `auth.ok`, `message.deliver`, `message.status` with
  the expected state, and `directory`; a resend that must not go out is
  checked on the outgoing log instead of a sleep, and the repeated-send case
  waits for the Worker's answer to every send instead of a 300 ms quiet
  period. A missing event fails after 10 s naming the frames seen; the two
  suites' test bound is 90 s. The Worker test config sets `testTimeout` to
  30 s for the other node harness tests, whose 5 s waits shared the same
  bound. The comment on `MessageStore.report` now states the receipt rule
  the code applies: a report for a row or tombstone of another target node
  gets no receipt, one for an id without a row settles from its tombstone or
  as `expired`. No behaviour changes.
- A Codex task past its max runtime whose recorded pid now belongs to another
  process (after a reboot, or daemon downtime past the deadline) is no longer
  stopped again every watch round for ever (issue #544). The watch now measures
  the run by pid and start identity before the deadline stop, as it already
  did after it: a run whose root is no longer the recorded process settles
  from its own outcome in one round (`done` after `turn.completed`,
  otherwise `failed` with "codex ended without completing the turn"), and its
  recorded descendants that still have their start identity are ended by pid
  (issue #233); a run that ended on its own past the deadline is therefore
  reported from its outcome, not as `stopped` at the max runtime. The node
  logs `its root (pid <pid>) is no longer the recorded process; settled from
  its outcome` for such a settle. A stop of such a run (the retried operator
  stop, `POST /api/tasks/{id}/stop`) no longer lists or waits on the tree
  under the reused pid: the capture is empty when a root the daemon does not
  hold has lost its recorded start identity, and the task is recorded
  `stopped`; that stop does not end the run's recorded descendants (a
  follow-up); a run past its deadline whose root is gone is settled by the
  watch, which does. The process that holds the pid now is read once, for its
  start time, and never signalled.
- The three Codex guards that still ran directly now run through the
  fail-closed hook adapter (issue #507, part 4 of 4, the last part).
  `atlassian-destructive-guard.mts --runtime codex` (last entry of the Agent,
  web and MCP `PreToolUse` group), `codex-dispatch-contract-guard.mts` and
  `playwright-file-guard.mts` are wired as
  `"<node>" ".../codex-hook-adapter.mts" ".../<guard>" "pre" [guard arguments]`,
  so a guard that is missing, empty, broken, killed or past its budget denies
  the tool call with a reason that names the file, as the other Codex guard
  groups have since part 3. The adapter passes a guard's top-level
  `systemMessage` through when it is a non-empty string (Codex documents it
  for `PreToolUse`), in its exported `runAdaptedHook` as in its command form,
  so the dispatch-contract guard's deny reasons and its brief-revision notice
  reach the session unchanged; any other extra field is still a deny. The
  shell dispatcher `codex-shell-checks.mts` gets one integer clock ending
  1.5 s before its 40 s hook timeout, which bounds stdin and every guard, and
  after its guards, before attribution, starts `codex-hook-integrity.mts
  --trigger codex-shell-checks` when the heartbeat is older than 30 minutes
  or missing or a guard could not run, with at most 6 s of what is left;
  attribution still runs uncapped after it, so the clock bounds the guards
  and the re-check, not the final answer. Each dispatcher also checks the
  other (`codex-shell-checks.mts` from the adapter, both adapter copies from
  the shell dispatcher) and treats it as a guard failure when it is missing,
  empty, not a regular file, unstatable, or when its device, inode, size or
  modification time (nanoseconds) differs from what the last proven integrity
  run recorded in `heartbeat.json` (`peers`). That run takes the record from
  an fd-bound snapshot of exactly the bytes it syntax-checked (open, `fstat`
  of that descriptor, read from it, the verdict on those bytes, then a re-stat
  of the path and its real path) and records nothing when the verdict is not
  OK or the path no longer names those bytes. The re-check then parses and
  restores the peer, so a dispatcher broken after the last proven run is
  restored by the next matched call of the other group, and a heartbeat
  without that record triggers one re-check (once after every install).
  Remaining gap: an in-place rewrite that keeps device, inode and size and
  sets the modification time back to the recorded value (or lands within the
  same tick on a filesystem with coarse timestamps) is seen only by the next
  stale-heartbeat or session-start run, a defect the syntax check cannot see
  (an import that does not resolve, a throw at load) is seen by no check, and
  both dispatchers broken at once wait for the session start. These three
  hook command definitions change, and their `commandWindows` forms with
  them; group count and every entry index stay, so no positional trust key
  moves and existing `[hooks.state]` bytes are kept. Codex marks exactly these
  three definitions for review and skips them until they are trusted in
  `/hooks`: until then the Atlassian destructive guard, the dispatch-contract
  guard and the Playwright guard do not run; the installer prints one line
  saying so when it replaces the managed hook block. The upgrade recognises
  the exact previous block and refuses any other. Every Codex hook group is
  listed with its fail-closed status in `docs/CODEX.md`: the optional
  messaging intent group stays direct (it allows with `updatedInput`, waits up
  to 8 s for its acknowledgement and lives outside `hooks/`, so the adapter
  cannot carry it), the `Stop` and `SubagentStop` gates keep their own
  `decision: block` contract, and the remaining events make no permission
  decision. Whether Codex shows the notices is UNVERIFIED; no Windows CI job
  runs the Codex suites yet. `codex/ARCHITECTURE.md` now describes the part 3
  integrity state (eight libs, run lock, heartbeat, triggers).
  This completes #507.
- Codex hook-integrity run lock under two runs that start together (issue
  #620). `takeRunLock` in `hooks/lib/integrity-heartbeat.mts` retries a busy
  answer three times, 2 to 11 ms apart on the same connection, before it
  reports `busy, holder UNKNOWN`. Measured with a preload that staged the
  interleaving: run A, already at SQLite's PENDING lock, was refused
  EXCLUSIVE because run B held SHARED for its schema read, and B's own
  BEGIN was then refused by A's PENDING; both backed off, both exited 0,
  nobody repaired the planted 0-byte lib and no journal line was written:
  the state T3.5 reported once on windows-latest; whether that run took
  this path is UNVERIFIED. A second busy path, not staged: B is refused
  RESERVED by A's RESERVED while B's SHARED blocks A's EXCLUSIVE. Every
  attempt keeps `busy_timeout 0`, so a contender against a run that is
  working is still answered within about 40 ms (measured on macOS;
  Windows UNKNOWN; T4.1 now bounds that at 250 ms). T3.5 keeps each run's
  stdout and names the path each run took when it fails; a busy pair is
  not accepted. Limits: the retries lower the chance of a repeat collision,
  they do not exclude it, and a pair that still collides is repaired by the
  next matching call, as before.
- Fail-closed Codex hook adapter and Codex hook-integrity re-check (issue #507,
  part 3 of 4). `hooks/kherep-maestro/codex-hook-adapter.mts` now denies a
  `PreToolUse` tool call, with a reason that names the file, when its guard is
  missing, empty, not a regular file, not spawnable (a spawn that throws
  included), killed, still running at its cap (the child is killed with
  SIGKILL; on Windows every signal is a forced termination), out of budget
  before it could start, exits with a code other than 0 or 2, prints more than
  1 MiB, or prints anything other than a `PreToolUse` decision; a printed
  `ask`, which Codex does not support, is a deny; a missing guard argument,
  stdin that is not a JSON object or stdin that stays open are denied too. One
  integer clock from the adapter's start bounds stdin, every guard item, the
  re-check lib load and the re-check itself, so the adapter answers at least
  1.5 s before its 10 s hook timeout and exits as soon as its output is
  written; PostToolUse phases are unchanged. Before, each of these let the call
  through, a guard that ignored SIGTERM was waited for, and in the privacy
  phase a guard's exit code and stderr were lost once it had printed.
  Arguments after the phase reach the guard unchanged.
  `codex-hook-integrity.mts` gains a `--trigger <source>` mode with plain
  lines. Before anything is restored or journalled, its own libs included, it
  takes `<CODEX_HOME>/.cache/hook-integrity/run.lock.sqlite` as an `EXCLUSIVE`
  SQLite transaction (`node:sqlite`, rollback journal `DELETE`, busy timeout
  0): a lock the operating system keeps for the holding process and releases
  when that process ends, so it is never taken over, moved or deleted by
  another run; a second run reports `busy, holder UNKNOWN` and changes
  nothing. The hook removes the heartbeat before its first repair (a failed
  removal blocks the repair), walks the import closure again after each repair
  pass through the new shared `hooks/lib/integrity-passes.mts`, which
  `live-hook-integrity.mts` now uses for the same loop, at most three passes,
  checks the live closure once more read-only, and writes `heartbeat.json`
  only when all of that passed and the write itself succeeded; journal entries
  name the `trigger`. The adapter starts that re-check after its guards when
  the heartbeat is older than 30 minutes or missing or a guard could not run,
  with at most 6 s of what is left; its lines go to stderr and, on an allowed
  call, to `additionalContext`, on a denied call to `systemMessage`, never
  into the decision. No Codex hook command definition changes, so no trust
  review is needed. Limits: the adapter itself is not checked; Codex has no
  hook runtime, so a file under repair may be loaded by a parallel call; a
  Codex home on a network filesystem is not supported for the lock; a broken
  `lib/integrity-heartbeat.mts` is reported, not repaired, until the next
  installation; whether Codex shows the notice is UNVERIFIED. The three direct
  Codex guards stay as they are until part 4.
- Upgrade from a legacy `~/.claude` watcher group (issue #507, part 2). A host
  that still ran `manifest-watch`, `loc-watch`, `umlaut-translit-watch`,
  `simplify-nudge` and `drift-managed-path-watch` raw as
  `node ~/.claude/hooks/<name>.mts` kept those commands after an upgrade: the
  four watchers the template already ran through the entry ran twice, and the
  five raw commands made `live-hook-integrity.mts` refuse every repair and
  write no heartbeat. The settings render now removes a raw command in the
  `~/.claude`, `$HOME/.claude`, `${HOME}/.claude` or `%USERPROFILE%/.claude`
  form (the script quoted or not, with `/` or `\`) when the Claude home is the
  default one, the command is exactly `node <script>` with nothing glued to the
  script, no argument, operator, redirect or line break after it, the path
  below the token a plain literal one (letters, digits, `.`, `_`, `-` and `/`;
  no expansion, glob or escape, no `.`, `..` or empty segment), in a hook
  with no field besides `type` and `command`, the template runs that main
  through `kherep/hook-runtime/entry.mts` or passes it to the dispatcher behind
  it, and the template does not run it in that form at that event; the install
  output names each with
  `hooks: unwire <event> <command> (managed under <events>)`. As for the
  absolute form since part 1, this also removes such a raw command at an event
  or matcher the template's entry does not cover: a hand-written
  `node ~/.claude/hooks/commit-guard.mts` under `PreToolUse` `Edit` goes, and
  the guard then runs only where the template's dispatcher runs it. A
  `~/.claude` command for a main the template does not manage, one with more
  than the script (`node "~/.claude/hooks/loc-watch.mts"-x.mts`,
  `... && node <other>`, an argument, a `timeout` or other own field), an
  entry command in that form and a main the template runs raw stay; so do
  `node.exe`, `node <flags>` and `& node` forms, which still count as outside
  the runtime.
  `umlaut-translit-watch`, which the template did not wire before, is now a
  managed `reader` hook in its `PostToolUse` `""` group, directly after
  `loc-watch`, as Codex already runs it.
- Publication of a missing hook file (issue #507, part 2). The new file is still
  created beside its target, so it gets that directory's ACL, default ACL and
  group, but before its first byte it gets a second name in the hooks directory
  and the name beside the target is removed. It is linked into place only while
  the hooks directory, the target's directory and that second name are the ones
  measured at the start, and only the writer's own file is ever removed: a
  foreign file renamed to the staging name is no longer published, and a
  target directory renamed away before the link no longer keeps a complete
  temporary file (early, crash and hooks-directory-rename windows remain, see
  docs/INSTALLATION.md). New refusals
  `target directory changed before the publication; refusing to publish` and
  `staging file or hooks directory changed before the publication; refusing to
  publish`. Limitation: a missing file whose directory lies on another volume
  than the hooks directory, or a hooks directory that may not get a new name, is
  no longer repaired; the publication fails closed with `publication failed
  (<code>); the target stays absent` before any byte, and existing files are
  still written in place. Shared by both `restore-write.mts` copies and Codex
  hook integrity, which gets no new hold.
- Reconnect replay of acknowledged legacy rows (issue #493). A message row
  stored before the deletion existed (no `deletable` mark) was replayed to its
  sender after every authentication although the sender had acknowledged its
  final state. The acknowledgement of its current final state by its sender
  now settles such a row: the Worker stores the acknowledged state in
  `settled_state` and audits `message.settle` with ids only. The row is kept,
  never deleted, and the replay leaves it out while its state equals the
  acknowledged one; a later state, also one set by an earlier Worker version
  after a rollback, makes it replayed again until that state is acknowledged.
  The replay reads a partial index over the unacknowledged rows. This inverts the earlier tested expectation that an
  acknowledged legacy row is replayed again after reconnect: that replay was a
  redundancy the acknowledgement already covered, not a delivery guarantee. A
  legacy row whose sender never acknowledged its current state is still
  replayed on every authentication.
- Codex hook commands stay the same across upgrades (issue #503). The six
  Control Plane hook definitions in `config.toml` (shell-group and
  `PostToolUse` attribution, and delivery on `SessionStart`, `UserPromptSubmit`,
  `Stop` and the `PostToolUse` busy hint) named the checkout or source pin the
  installer ran from, so every upgrade from a new pin changed their hash and
  Codex asked to review them again. They now name the stable entry point
  `<CODEX_HOME>/hooks/kherep-maestro/codex-control-plane-hook.mts` and a fixed
  hook name (`deliver` or `attribution`). The installer writes
  `<CODEX_HOME>/orchestra/control-plane-source.json`, the source root with its
  commit and kind, inside its install transaction. The entry point checks the
  record's shape and that the hook file (and, for a pin, its manifest) exists,
  then runs the hook as its own process with the caller's stdin, stdout,
  stderr, environment, working directory and exit code. Without a usable record
  it exits 1 with one stderr line and never falls back to another source. The
  check per run is not a verified load; `kherep-node doctor` verifies the
  source identity and reports `codex.pointer`, `stable` and `legacy`. The shell
  dispatcher still runs its three guards first and calls attribution
  in-process afterwards, so a missing record costs attribution only. The first
  install after this change rewrites the old commands once, and Codex asks for
  one review. Trust entries, rules, guards and permissions are unchanged.
- Corrected nested-runtime guidance (issue #489). When both
  `CLAUDE_CODE_SESSION_ID` and `CODEX_THREAD_ID` are set and the available
  process ancestry does not establish their nesting, the fixed `NESTED_RUNTIME`
  reason no longer suggests that any `--from` resolves it: for msg commands it
  states that `--from` needs the full id of a Codex session a Kherep hook
  recorded within 12 hours, with a matching task when `KHEREP_SESSION_ID` is
  set. The `msg` usage text, `docs/CODEX.md` (which no longer says the Codex
  thread is taken as sender regardless of ancestry) and the Control Plane
  README and architecture match it. New synthetic tests cover `--from` under an
  undecidable nesting: no record, stale record and a task bound to another
  thread are refused with nothing written; a fresh record of the own or of
  another thread is accepted. Sender checks, the refusal code and the exec
  rules are unchanged; this does not restore or explain any Windows send.

- Windows identity reads no longer block the daemon's event loop (issue #473).
  The process start-time read (`process-start`) and the process-tree query
  (`process-relations`) run as awaited child processes behind one runner
  (`node/child-run.mts`), so message intake keeps storing deliveries while a
  watch pass, a stop or an exchange round waits for PowerShell or `ps`. The
  commands, their 10 second timeouts and the meaning of their results are
  unchanged: no output is no such process, a non-zero exit or a timeout is a
  failed read, a timed-out tree query runs once more, and each signal of a stop
  still follows the read of its pid's start directly; a started run gets the
  end of its prompt only after its start time was read, so a normal run does
  not end before the read; a run that exits on its own before the read keeps no
  start time, as does a watch read whose held child ends or is replaced. The exchange round reads
  an ended Codex task's previous run only after its `maxConcurrent` and
  working-directory checks, before the readiness verdict and the turn budget,
  so no refusal and no turn changes; a task at the limit or with a refused
  working directory costs no PowerShell start per round, and while its previous
  run still ends it shows that guard's waiting code (and the `cwd-refused` note)
  instead of `target-busy`. A slow read is logged
  as `child process <name> took <s> s`; `process-start` and `process-relations`
  no longer appear in the `synchronous <name> took` line, which now also names
  a slow `taskkill`. `taskkill`, the one-time owner identity read and the MCP
  credential write stay synchronous. A stop whose held child ends or is
  replaced during a read signals nothing: the root's SIGTERM and SIGKILL and
  the force after a timeout each compare the child held when the stop began
  after the awaited read, right before the send. Such a stop still completes
  when a fresh read confirms that the captured processes ended.
- Import closure of a linked hook (issue #524). A wired hook file that is a
  link, or sits in a linked directory, now has its relative imports resolved
  from the real directory of the file Node loads and bounded by the real hooks
  directory, then named under the wired hooks directory: in the Claude
  integrity run, in its final read-only proof (from the same snapshot as the
  syntax verdict) and in `codex-hook-integrity.mts`. Before, imports were
  resolved from the alias directory, so a dependency the hook never loads could
  be checked and the one it loads missed, also where a `..` crosses a linked
  hooks root, and a healthy decoy beside the alias could let the heartbeat be
  written. A link whose target lies outside the hooks directory contributes no
  imports; the alias still names the file in reports and the journal; restore
  targets are unchanged.
- Message-retention Worker test barrier (issue #529): the test took the
  answer to a later `directory.get` as proof that a resend's `message.status`
  had been sent. Each frame reaches the Registry on its own stub, and there
  is no ordering between different stubs, so the directory answer may come
  first. The test now waits for the status, error or receipt frame itself,
  by message id and state, with every earlier frame still asserted, checks
  the row and tombstone before the resend, and a regression forces this order
  with a non-storage hold on the Registry's resend answer. The Worker is
  unchanged; the cause of the one observed CI failure is not established.
- Message-retention Worker test acks (issue #557): after an acknowledgement
  frame, which the Worker answers with no frame, the tests took the answer to
  a later `directory.get` as proof that the ack had run; there is no ordering
  between different stubs, so it may not have. Of the 25 such barriers, the
  13 acks that delete or settle a row are now awaited on that row's state,
  the 11 acks without an effect go through the Registry's RPC, whose answer
  is the completion, and the one ack the frame validator refuses keeps its
  barrier, because the error is sent before the ack reaches any stub. A
  regression holds the ack's transaction with a non-storage hold until the
  directory answer has passed. The Worker is unchanged.
- Timing-dependent tests on the macOS unit job (issue #565). Hook runtime R2
  read `child.pid` while `writeFileSync` had created it but not yet written
  it: `Number("")` is 0, and `alive(0)` signals the own process group, so the
  child never counted as ended. The child now publishes its pid by rename,
  the test refuses a value that is no process id, `alive()` throws for a pid
  of 0 or less, and a failed assertion releases the child and kills the entry
  so the file still exits. The nested guard of the hooks-root test publishes
  its pids by rename for the same window. The fake Codex app-server ended its
  child two event-loop turns after stdin ended, racing the client's 30 ms
  grace timer, so one stalled turn under load turned a clean close into a
  SIGKILL; it now ends on `process.nextTick`. The 24 h retention deadline is
  bounded by the time before the first send and after the row was read,
  without the 1 s slack, and awaited on the row, since `directory.get` is no
  barrier for the `delivered` status frames. Test and fixture code only.
- Message-retention Worker test reports (issue #569): after a `message.status`
  report, the tests took the answer to a later `directory.get` as proof that
  the report had run; there is no ordering between different stubs, so it may
  not have. The issue took these reports for receipt-less: the Worker answers
  every report of the target node with a `message.receipt` event, sent after
  the Registry's RPC returned, and only a report of another node gets none.
  The six report sites answered by a receipt now wait for that receipt, by
  message id and requested state, and assert the stored state it carries; the
  two reports of another node go through the Registry's RPC, whose null
  receipt is the completion; the reply and the resend in the same tests wait
  for the `message.status` that answers a send. The target's `message.deliver`
  frame, which the barrier used to swallow unseen, is consumed where a row is
  delivered. A regression holds the report's transaction with a non-storage
  hold until the directory answer has passed. The file is split along its
  three test groups into `message-retention-ack.test.mts`,
  `message-retention-sweep.test.mts` and `message-retention-legacy.test.mts`
  over a shared `message-retention-fixture.mts`. The Worker is unchanged.
- Timing-dependent test on the macOS unit job (issue #611). Case (h) of
  `claude/hooks/obs-result-check.test.mts` planted the recorder's state 800 ms
  after spawning the hook; on a slow runner the hook's first read came later
  and saw the record already (`state=present waited=0`). The case now calls
  `decide()` in the test process and plants the record after the call returns
  its promise, which is after the hook's first read and before its first poll,
  so the order no longer depends on how fast Node starts. Test code only.
- Claude hook writers: the capture-failed marker of the denied-call journal
  (`<CLAUDE_HOME>/.cache/denied-calls/<agent_id>.failed`) is on disk when the
  hook process has exited (issue #614, the Claude side of #612). The guard
  dispatcher, the hook runtime entry (for its own denies) and the delivery
  recorder each gave the marker write a fixed 400 ms slice and then exited
  through `process.exit`, which abandons a pending `fs.promises` write; a
  slow write left no marker, and a later `render` could read a count or
  `none` for a worker whose line was lost. The marker write is now awaited
  until each writer's own deadline: the dispatcher's, at most 25 s after
  its start; the entry's `OUTER_DEADLINE - 2_000`, 26 s after its start; and in the
  delivery recorder a new deadline 5.5 s after its process start (its entry
  has `timeout` 10, and the entry's Node start precedes its clock). The
  journal writes keep their caps (1.5 s, 0.5 s in the entry). The
  recorder's rename retry for `EPERM`, `EACCES` and `EBUSY` now runs up to
  that deadline instead of 0.4 s. A write that never settles still leaves
  no marker and now holds the decision until that deadline, which ends
  before Claude Code's hook `timeout` as long as each Node start stays
  within the assumed 2 s. The fixture fault
  `marker-slow` now also fails the journal append with `ENOSPC`, so a
  writer without a journal lib seam reaches its marker path; the three new
  tests are red against the previous writers.

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

[Unreleased]: https://github.com/CFcon-CH/kherep/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/CFcon-CH/kherep/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/CFcon-CH/kherep/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/CFcon-CH/kherep/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/CFcon-CH/kherep/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/CFcon-CH/kherep/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/CFcon-CH/kherep/releases/tag/v0.1.0
