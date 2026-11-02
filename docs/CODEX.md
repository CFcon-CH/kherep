# Codex integration

Kherep projects shared rules, skills and agents into Codex through a separate adapter. Claude and Codex keep their own configuration and account bindings.

## Install

Use Node.js 24 (at least 22.18 on the 22 line, or 23.6) and the shared dependencies described in [Installation](INSTALLATION.md). From the checkout:

```sh
node codex/install.mts --workspace "$HOME/projects"
```

Replace the workspace with your chosen absolute path. The installer uses your Codex configuration home and existing MCP source registry. Shared knowledge lives in the Central Brain, the Confluence space this installer resolves for the host; see [turn-completion observations](#turn-completion-observations).

On Windows, the PowerShell entry point accepts the same workspace:

```powershell
./codex/install.ps1 -Workspace C:/Projects
```

To record standing authority for Codex observation publication, add the explicit
`-AuthorizeObservationPublishing` switch. The switch is intentionally separate from target
configuration: a configured space alone never grants publication authority.

Review a disposable candidate before replacing an existing setup. The CLI supports these options:

| Option | Purpose |
| --- | --- |
| `--workspace` | Workspace in which Kherep applies |
| `--codex-home` | Destination Codex configuration home |
| `--refresh-models` | Resolve the family policy against the current native model catalog instead of retaining the installed resolution |
| `--claude-config-dir` | Shared Claude dependency/configuration home |
| `--mcp-registry` | Absolute path to your source MCP registry |
| `--memory-provider-config` | Absolute path to explicit memory-backend selection JSON; only `{ "provider": "unconfigured" }` is accepted |
| `--enable-messaging-client` | Install the disabled-by-default local Control Plane messaging MCP client and exact intent hook |

Both entry points run `codex/install.mts`, so the two host-owned values it needs are resolved by the same run whichever one you use: the Confluence knowledge space for this host, written to `kherep/confluence.json` in the resolved Codex home, and the Atlassian service-account credential. Each prompts only when a terminal is attached and otherwise fails with the variable named, so a scripted install does not block on stdin. If either is missing the parity installation above it still stands, and the observation agent writes nothing until the space file exists.

Keep private registry configuration outside the checkout. Read [adapter architecture](../codex/ARCHITECTURE.md) for supported transport, authentication and backend-selection formats.

The first CLI model resolution requires a signed-in Codex context in the selected configuration home. For an isolated or offline candidate, the synchronous `install()` API accepts a complete `modelCatalog` object exported by `node codex/scripts/model-catalog.mts` from an existing context. Login files do not need to be copied. Model metadata alone does not establish Desktop activation or access under a different account.

### Routing-only update

For the exact predecessor at `2b592140fd25e5e1f49dc3547ca3a798ef418721`, the
standalone updater changes only `orchestra/ROUTING.md`. Review a synthetic
candidate first. Supply absolute Codex-home and public Control Plane config-root
paths and an explicit public example address. The config root is only a rendering
input; the updater does not open it.

The Codex home must already exist at its canonical real path, with no linked
ancestors. Resolve it with `fs.realpathSync` before invoking the CLI. For example,
macOS `/tmp/candidate-codex` may resolve to `/private/tmp/candidate-codex`; pass
the resolved path. The example home below must contain recognized routing.

```sh
node codex/install-routing.mts check --codex-home /opt/public-candidate-codex --config-root /opt/public-kherep --example-target peer/session
node codex/install-routing.mts apply --codex-home /opt/public-candidate-codex --config-root /opt/public-kherep --example-target peer/session
node codex/install-routing.mts rollback --codex-home /opt/public-candidate-codex --backup-id <returned-backup-id>
```

On Windows use absolute paths such as `C:/Public/CandidateCodex` and
`C:/Public/Kherep`. The host's stable launcher command is rendered through the
shared pure renderer. No command or binding is inferred from installed text.

`check` returns `ready` or `unchanged` without writes. `apply` accepts only the
complete rendered predecessor bytes, or returns `unchanged` for the complete
current bytes with no backup or timestamp change. Unknown drift, newline
differences, missing targets, directory targets and redirected paths are refused.
Successful application saves the original bytes at
`backups/kherep-routing/<id>/orchestra/ROUTING.md` and a sanitized `receipt.json`
in the same directory. The unique id binds the public render parameters. The
receipt records predecessor revision, source and before/after/backup SHA-256
digests, render binding and status. Transaction failures restore and verify the
original routing bytes.

Rollback verifies the receipt, binding, frozen predecessor, backup hash and exact
current target before restoring. A repeated exact rollback is a no-op; corrupted
evidence or later routing changes are refused. Keep this source checkout with
the backup: rollback requires the same versioned routing source. Backup evidence
is retained after rollback. It is local integrity evidence, not a signed audit
record or protection against an actor able to replace all evidence.

This entry point reads only its fixed routing source/predecessor and the selected
target, plus its dedicated receipt and backup on rollback. It checks ancestor
path metadata without enumerating the home. It never invokes the full installer,
reads private profiles or registries, refreshes models, changes hooks or
integrations, reads Claude configuration, or updates the top-level parity
receipt. These routing instructions assign SOL coordination and implementation
and Astra design ownership; they add no runtime enforcement. Native compliance
remains UNKNOWN until separately measured at the target.

### Remote messaging client opt-in

`--enable-messaging-client`, or `-EnableMessagingClient` through `install.ps1`, adds the
`kherep_messaging` stdio MCP table and the exact five-tool PreToolUse intent hook. API callers use
`install({ messagingClient: true })`. The table contains only the Node executable, installed bridge
path and non-secret Kherep config-root path. It contains no bearer, endpoint, native identity or
approval override. A normal install without this option projects neither the table nor the hook.

The local bridge reloads node configuration, effective policy and the private rotating credential
for every HTTP request. It derives `/mcp` from the enrolled node's control URL, sends the bearer only
in the HTTP Authorization header, rejects redirects, and forwards native JSON-RPC and `_meta`
without adding caller, thread or session identities. Callers omit the hook-owned `requestId`. After
a durable intent receipt, the hook returns `permissionDecision: "allow"` together with `updatedInput`
to apply the [native PreToolUse argument rewrite](https://learn.chatgpt.com/docs/hooks#pretooluse).
Normal Codex MCP approval remains in force.

This client option does not enable the Worker's committed remote MCP flag or the node's
`remoteMcp.enabled` policy. Both remain separate explicit activation gates. Validate installed source
and config at the target, then run direct and two-distinct-chat production canaries before treating
the client as supported. The binding probe's Code Mode result is separate probe evidence.

## Turn-completion observations

On both hosts, the managed `Stop` group retains the acceptance gate and adds the once-only research gate, but it no longer requests an observation continuation. The `UserPromptSubmit` context hook gives the Maestro a short, quiet turn reminder to dispatch `codex-obs` before its final response, while the separate research prompt hook supplies the evidence-first instruction. Missing required research can therefore produce one visible continuation prompt. Observation dispatch stays quiet. A reinstall replaces the exact old macOS and Windows managed Stop projections; their old script files may remain in the installation but are not configured as hooks.

The normal projection installs pinned Luna/low `codex-obs` with a read-only filesystem sandbox and a narrow local `kherep_observations` stdio MCP adapter. The agent extracts and publishes observations with exactly `mcp__kherep_observations__publish_observations`, then copies one strict canonical `OBS-RESULT` receipt or returns a bounded non-adapter `OBS-ATTEMPT` report when no receipt exists. The adapter reuses the Codex service-account broker, reads canonical authority internally, checks the resolved space and trusted account, resolves mapped placement and app children, completes related lookup, creates one page per finding with labels, verifies body/parent/space/labels/author, and stitches only newly created IDs with readback. It exposes no arbitrary CLI, shell, update, delete, path, configuration or space override. Credentials and configuration stay out of model context. Only the names of the existing broker/semantic/TLS environment bindings are projected.

The Maestro supplies a bounded nonprivate turn summary, session and turn IDs, and any named node with `fork_turns: "none"`. Candidates still carry exactly `title`, `bodyStorage`, `evidence`, `labels`, `placement` and pass the pure validator before publication. The three base labels are required, with an optional product variant label. The broker adds session/runtime labels. Empty findings perform zero I/O. Durable local create intents and receipts prevent duplicate or replacement pages after repeats, corrective requests or uncertain outcomes. Partial failures include created IDs and never trigger an automatic retry.

The context hook takes IDs only from native top-level `session_id` and `turn_id`, validates each against `^[a-z0-9][a-z0-9._-]{0,79}$`, and supplies a bounded JSON header for verbatim copying into the Luna brief. These are the dispatching main turn's IDs, never the worker's. It does not echo prompt, cwd or transcript fields, recover IDs from environment or history, or normalize invalid input. If either ID is unavailable, the Maestro continues the user task and its tools, passing that condition to the observation worker. That worker returns `OBS-ATTEMPT: failed missing-turn-identity detail=none publication=not-attempted created=none` without worker tool calls, including when there are no findings. The ordinary reminder and successful hook exit remain. The [native hook contract](https://developers.openai.com/codex/hooks#userpromptsubmit) documents these fields; their availability in a particular native session remains UNKNOWN until measured there.

Before creation, the broker serializes literal `>` and double quotes in accepted attribute-free prose as `&gt;` and `&quot;`, matching Confluence storage. Prose tags, existing entities, apostrophes and backslashes retain their bytes. Related anchors are appended afterward and remain untouched by this serializer. Readback still requires exact body equality; it does not normalize returned HTML or accept text, backslash, tag or link corruption.

Space lookup receipts distinguish `space-lookup-unavailable` (a thrown, malformed or incomplete lookup), `space-unresolved` (a complete valid lookup found no matching space visible to the service account), and `space-mismatch` (a matching key resolved to a valid numeric ID different from canonical authority). Space keys retain the broker's case-insensitive comparison and trimmed canonical query. The observation adapter validates required space row fields and refuses continuation or duplicate results. For the exact spaces endpoint, nonempty Link metadata requires exactly one result in the bounded JSON body before text is cached. That positive row still passes all key, shape, body-continuation and canonical-ID checks; empty or ambiguous results cannot establish absence. Header contents remain inside the process, no Link relation is inferred, and other endpoints are unchanged. Fixed `space-lookup-bindings-missing`, `space-lookup-network-unavailable` and `space-lookup-timeout` codes report only missing required process bindings or explicit allowlisted transport properties. Unknown failures retain the generic lookup code. No provider messages, bodies, paths, binding values or arbitrary error details enter receipts or journals. These codes diagnose a failed space phase; they do not restore connectivity. Failed requests remain terminal without automatic retries.

The final `SubagentStop` hook checks one canonical `OBS-RESULT: wrote <n> <comma-separated IDs>`, `OBS-RESULT: empty no-admissible-findings`, or `OBS-RESULT: failed <safe-code>` receipt, with ` created=<IDs>` on partial failure, or the worker-only `OBS-ATTEMPT` form. Canonical receipts and all their IDs are copied verbatim even when `isError: true`; genuine canonical denials also set that flag, so it never establishes an outer refusal alone. The RPC adapter validates publisher output and uses fixed JSON-RPC error `publication-outcome-unknown` for throws or malformed output, without guessing a phase or exposing provider text.

The finite worker-attempt tuples are defined in `codex/agents/codex-obs.md` and checked separately from canonical receipts. Missing main identity or an unavailable tool before invocation means not-attempted/none; a refusal, protocol/tool error, malformed response or unavailable original evidence after an attempt retains UNKNOWN publication and created IDs. Only the exact visible standard risk sentence permits unacceptable-risk detail. Attempts cannot enter the journal. A malformed handback gets one correction permitting NO further publication or tool calls; unavailable original evidence uses the fixed evidence-unavailable attempt. Every attempt and canonical failure warns in the same turn; a second malformed or invisible result also warns. The hook has no original tool envelope and validates the final report only. The Maestro independently validates handbacks and canonical created targets and never silently publishes or repairs observations. Hook group indices and permissions stay unchanged.

Configured source, prompt contracts and generated tests do not prove model compliance, native discovery, dispatch, trust or live publication. Restart the affected native Desktop/MCP session after a separately authorized installation and verify exact installed hashes, hook trust and native tool discovery. A standalone process is not Desktop evidence. Require one genuine admissible observation, its canonical receipt and independent journal/page body, space, parent, labels and author reads. A targeted backlink requires a genuine eligible neighbour and independent neighbour readback; a no-neighbour case leaves that behavior untested. No artificial test page or replay of failed historical IDs establishes delivery.

### Observation-only upgrade

For an existing known managed installation, review a disposable candidate, then use:

```sh
node codex/install-observations.mts --codex-home /absolute/codex-home --workspace /absolute/workspace
```

The handback upgrade recognizes exactly the affected agent, hooks, result helper, routing, Maestro rule and broker bytes from `57c0c471092623e15466300400a849f6bdda29b6`, frozen in `codex/parity/observation-handback-predecessor.json`, including the preceding Related serializer. Generated upgrade tests verify exact target bytes, idempotence, rollback and refusal of one-byte drift before writes. This recognition grants no installation authority and leaves unrelated configuration and native trust untouched.

The turn-identity upgrade also recognizes the exact preceding context and observer bytes from `60cde716f45882715a4976cfd0acf8f5a6dc8575`, frozen in `codex/parity/observation-turn-identity-predecessor.json`, and the exact pilot observer from `9241eba1ddeffe38bdd9a38c95660228b21246d7`, frozen separately in `observation-turn-identity-pilot-predecessor.json`. It preserves the historical predecessor chain and refreshes the verified context recovery snapshot. Unknown context or observer drift still refuses before writes. After upgrading, verify the installed hook with synthetic native input, then measure that a fresh trusted native turn supplies its actual ID pair before testing Luna publication; a synthetic stdin run alone proves no native availability.

Both context commands now carry the installer-selected workspace as a canonical base64url UTF-8 `--workspace-b64` argument. They do not rely on `shell_environment_policy.set` or native hook environment inheritance. The cwd must still equal that root or be its descendant; out-of-scope input stays silent. A valid explicit binding overrides absent, empty or conflicting ambient workspace values. Malformed explicit arguments stay silent without ambient fallback. Historical no-argument commands retain their previous behavior. The workspace/token and prompt fields are never echoed; native main/turn identity validation is unchanged.

The scoped updater accepts the exact unbound context command pair or the exact pair already bound to the requested workspace. Mixed, duplicate, foreign-workspace or modified definitions refuse before writes. The c1 context source is frozen separately in `codex/parity/observation-context-workspace-predecessor.json`. Only the two context definitions change, with all positions and unrelated bytes preserved by reversing their exact command edits plus any publisher-table insertion. The receipt names this workspace binding and the two definitions on every run, including an idempotent rerun. Existing hook state is preserved, and no trust hash is created or copied. Review and trust both changed definitions through the supported native `/hooks` flow, restart the affected session and measure actual native context activation before claiming delivery. Synthetic installed-process tests with no ambient workspace establish process behavior only; actual Windows hook environment and causal activation remain UNKNOWN until host measurement.

This scoped updater reads only installed Codex observation artifacts and model metadata, and public source. It does not read a private registry or Claude configuration, refresh models, run credential/space setup or contact a service. It preserves canonical authority, unrelated MCP configuration, hook positions/state and the shared Control Plane source pointer. Exact immediate predecessor bytes from commit `1532ccdf7d23b35114a2d80bb2b5453e0e4e84a1` and the broker bytes from `e13e8c79c5b675f2e30a803a78247e430c43a397` and `b2d23faad79d03de3f7515456011c2bb0a81153c` are recognized alongside the earlier fixed predecessor; unknown observer/helper/broker drift fails before writing. The `b2d23faa` predecessor contains only that exact broker file. The scoped-revision predecessor contains only the `f0893d7e62823a48d89ec57f1e33f5c8f57eebca` bytes of the observer, both observation hooks, the candidate policy and the routing observation section (issue #693). The worker-brief predecessor `codex/parity/observation-worker-brief-predecessor.json` contains only the `764200b637af55475b8c4137bb7e69aa3d4932f7` bytes of `codex/hooks/hook-integrity-sources.mts`, before it registered the dispatch guard's worker-brief lib (issue #701). Its two transactions restore home/workspace files on failure; retain the returned backup for explicit recovery. `orchestra/observation-install-receipt.json` is a separate receipt, not a refreshed full parity receipt. A hash-verified observation-only snapshot supports integrity repair without changing unrelated source pointers. Restart the native session after upgrading. The adapter uses newline JSON-RPC stdio with the legacy 2024-11-05 protocol fallback; source tests are not native activation proof.

### Evidence-first research hook

For headless broker research, opt into approval review for that invocation:

```sh
codex exec --approve-for-me "Research the configured knowledge space before answering; request command-scoped approval if sandbox networking blocks the read-only broker search."
```

Use `--skip-git-repo-check` as well when the working directory is not a Git repository. `--approve-for-me` selects the workspace-write sandbox and routes eligible approval requests through automatic review; do not combine it with `--sandbox`, which the CLI rejects. If the read-only broker search is blocked by sandbox networking, the agent requests `sandbox_permissions="require_escalated"` for that command; the reviewer can allow or deny it. This does not grant approval for other broker verbs, remove privacy guards, or enable global networking. A run with `approval_policy="never"` has no path to request that escalation. Follow managed approval requirements; a denied request stays denied.

A broker `status: unavailable` means the lookup could not run and the result is UNKNOWN. It does not prove that Confluence is down or that no page matches. Compare the failing boundary with an authorized read before reporting an outage. Search exit 0 means hits, exit 1 means the search ran without matches, and exit 2 means unavailable. A shell wrapper may report a different process exit code, so inspect the broker status as well. See the [official sandbox and approval documentation](https://learn.chatgpt.com/docs/agent-approvals-security).

The native `research-first` prompt hook emits a fixed local instruction and no prompt text. The `research-stop` hook reads only the absolute local Codex rollout path in the Stop payload, rejects Claude-private paths, and examines the latest matching `task_started` turn. It accepts direct `function_call` and `custom_tool_call` records, including the hyphenated and underscored codebase-memory server names. A local lexer also recognizes actual `tools.*(...)` call syntax inside `functions.exec`, including records with separate `name: "exec"` and `namespace: "functions"` fields and the `custom_tool_call` named `exec` without a namespace field that Codex Desktop records. A bare `exec` `function_call` and other namespaces do not count as this wrapper. A nested `exec_command` counts when its command is the broker search; a later `write_stdin` that collects the process output is neither required nor evidence. Quoted examples, comments, template literals and regular-expression literals in the supported JavaScript contexts do not count. User messages and tool output never count. Dynamically constructed JavaScript remains outside this classifier. This lexical evidence records an attempted call only. It does not prove that a conditional branch ran, that a lookup succeeded, or that the result supports the answer.

A substantial turn must show a Central Brain lookup attempt. A detected repository change through `apply_patch`, an explicit file-write tool or a common shell mutation command also requires a codebase-memory call. Feedback names only the missing Brain attempt, graph attempt or both, with the existing privacy and opt-out instructions. Missing evidence is not reported as a service outage. The existing 400-character and three-read-only-call thresholds and observation-call classification stay unchanged. Arbitrary shell programs can hide file mutations from this classifier. A final `[research: none - <reason>]` with a nonempty reason opts out. The Stop hook blocks only when `stop_hook_active` is exactly false, so its continuation cannot loop. It emits fixed text and never emits transcript content or performs network I/O.

A wholly malformed, unreadable, relative, Claude-private or unrecognized transcript is undecidable and fails open. A malformed trailing line is ignored when earlier records still identify and describe the requested current turn. Codex's rollout format is unstable, so an undecidable read is documented rather than treated as evidence that research was absent. Under the [official Codex Stop hook contract](https://learn.chatgpt.com/docs/hooks?translationFallback=de-DE), a matching `continue: false` result takes precedence over continuation decisions. If the acceptance gate rejects the same stop, Codex stops on that result and does not surface the research continuation. The research gate therefore enforces the once-only continuation when acceptance allows stopping.

The source check named research parity covers only `research-first.mts` and `research-stop.mts` in the Claude and Codex adapters. It fails if one of those four source files is missing. It does not establish general Claude/Codex parity. Repository tests establish source behavior and projected configuration. Whether a particular Desktop host trusts and executes both hooks remains UNKNOWN until the installed target is inspected and a missing-research turn is observed there.

### Post-edit checks

Codex config projects one `PostToolUse` command for edits and `functions.exec`: `hooks/kherep-maestro/codex-post-edit-checks.mts`. It normalizes the payload with the existing post adapter and runs the four shared manifest, line-count, Umlaut transliteration and simplifier watchers as sibling Node processes. Their plain findings and valid JSON findings are combined into one `PostToolUse` JSON response. An all-green run is silent. Child errors and nonzero exits are forwarded.

The existing literal classifier skips the dispatcher body when the entire `functions.exec` source is a sequence of direct calls to explicitly listed Codebase Memory read-only tools with literal arguments. Dynamic or unknown wrappers still use conservative normalization, preserving every recognized patch target. If normalization yields `Bash`, no watcher children start, because all four shared watchers reject that tool before examining input. This also removes four empty children for ordinary shell/status wrappers. Edit and patch targets retain all four checks.

A reinstall replaces the exact prior four-command group with the one dispatcher command. Existing custom hook groups and positional hook state entries remain in place, and the installer does not create a trusted hash for the dispatcher. Any unknown drift in the predecessor is refused. Installation and source tests establish only the configured projection. Desktop execution and latency are UNKNOWN until the installed hook is separately activated and measured.

### Shell checks and hook starts

The shell `PreToolUse` group uses one `codex-shell-checks.mts` command instead of three adapter commands and a separate attribution command. All three guards still execute with their original normalization; privacy remains independent. Guard execution failures return a native JSON deny. After the guards and the hook integrity re-check described below, pre-tool attribution resolves the attribution hook through the stable entry point described below and calls it in-process with the original owner payload; a missing or invalid source record skips attribution with one stderr line and never skips a guard or changes a deny; post-tool attribution and the independent Intercom return-point consumer remain configured.

Reinstall recognizes the exact prior shell group, preserves custom groups and existing state bytes, and refuses unknown drift. Group positions remain stable, but the consolidated command changes its definition and requires review in `/hooks`; the installer supplies no trusted hash. Inspect the isolated candidate before an authorized host update, review the definition and restart the affected native session. Source tests establish the projection and functional behavior. Native Desktop execution and Hook-Runs accounting require the bounded [host acceptance procedure](CODEX-HOOK-RUNS.md#host-acceptance).

The hook adapter, `hooks/kherep-maestro/codex-hook-adapter.mts`, fails closed in its `PreToolUse` phases. It denies the tool call, with a reason that names the file by its path inside `<CODEX_HOME>/hooks` (`kherep-maestro/<guard>.mts`) and an error by its code or class name, never by its message (issue #564), when its guard is missing, empty or not a regular file, cannot be spawned (a spawn that throws included), is killed, is still running at its budget, finds less than 100 ms of budget left, exits with a code other than 0 or 2, prints more than 1 MiB or prints anything other than a `PreToolUse` decision. A printed `ask`, which Codex parses but does not support, is a deny, and so are a missing or relative guard argument and stdin that is no JSON object or stays open. One integer clock from the adapter's start ends 8.5 seconds later, 1.5 seconds before the `timeout = 10` of its entries: stdin, every guard item (at most 5 seconds, then killed with `SIGKILL`; on Windows every signal is a forced termination), the re-check lib load (2 seconds) and the re-check (at most 6 seconds of what is left, none below 1 second) all draw on it, and the adapter exits as soon as its output is written. Arguments after the phase reach the guard unchanged. When the installed adapter finds `<CODEX_HOME>/.cache/hook-integrity/heartbeat.json` older than 30 minutes or missing, or its guard could not run, it starts `codex-hook-integrity.mts --trigger hook-adapter` after the guard. Its lines, headed `hook integrity re-check (<reason>, last OK <time or none>):`, go to stderr, and to `additionalContext` on an allowed call or to a top-level `systemMessage` on a denied one; they never change the decision. Whether Codex shows them, and how it treats a deny that carries a `systemMessage`, is UNVERIFIED. `PostToolUse` phases keep their behaviour. A guard's top-level `systemMessage` passes through when it is a non-empty string, which Codex documents for `PreToolUse`; on a deny with a re-check notice the guard's line comes first, then the integrity line. Any other extra top-level field, or a `systemMessage` that is not a non-empty string, is still a deny. The Claude dispatcher keeps refusing a `systemMessage`; its guards print none. The phase `pre-intent` (issue #538) runs the messaging intent hook: its clock ends 13.5 seconds after the start, 1.5 seconds before that entry's `timeout = 15`, and the guard cap is 12 seconds. `updatedInput` is accepted only with `permissionDecision: "allow"` and only as the call's `tool_input` plus a UUID `requestId`, which the adapter rebuilds from its own payload; an allow without it, a document without a decision, silence, an `ask`, an exit 2 and any other shape are a deny. Every failure reads `[hook-adapter] mcp-intent-hook.mts cannot run (<why>); the messaging call is blocked until the Codex installer reinstalls the messaging client`, with the basename and no error text, the guard's stderr is not forwarded, and no intent-file failure starts a re-check. A re-check notice of this phase goes to stderr only, so Codex reads the hook's own document. Since issue #533 the adapter imports three modules from beside it, `hook-adapter-payload.mts`, `hook-adapter-verdict.mts` and `hook-adapter-run.mts`, which the installer copies under their own names; a broken module makes the adapter exit 1 before it runs, a non-blocking failure for Codex exactly like a broken adapter file, until the shell dispatcher's next call or the next `SessionStart` restores it.

#### The three formerly direct guards, the shell dispatcher and the peer check (issue #507, part 4)

The Atlassian destructive guard, the dispatch-contract guard and the Playwright guard run through the adapter. Their entries are `"<node>" "<hooks>/codex-hook-adapter.mts" "<hooks>/atlassian-destructive-guard.mts" "pre" "--runtime" "codex"` (last entry of the Agent, web and MCP group), `"<node>" "<hooks>/codex-hook-adapter.mts" "<hooks>/codex-dispatch-contract-guard.mts" "pre"` and `"<node>" "<hooks>/codex-hook-adapter.mts" "<hooks>/playwright-file-guard.mts" "pre"`, each with `timeout = 10` and the Windows form `& <command>`. So a missing, empty, broken, killed or late guard of these groups is a deny that names the file, and the dispatch-contract guard's deny reasons and its brief-revision notice keep their `systemMessage`.

`codex-shell-checks.mts` has one integer clock that ends 1.5 seconds before its `timeout = 40`. It bounds stdin, every guard (each still capped at 10 seconds), journal capture and the re-check. The order is: guards, journal capture, re-check, attribution, then one answer. The first deny stays the decision. In the installed layout the dispatcher starts `codex-hook-integrity.mts --trigger codex-shell-checks` with `CODEX_HOME` set to its home when the heartbeat is older than 30 minutes or missing, or a guard could not run, with at most 6 seconds of what is left and none below 1 second. Its lines go to stderr, and to a top-level `systemMessage` on a deny or to `additionalContext` on an allowed call, which is a new output for this group. Attribution runs after the re-check, uncapped and in-process (each of its `git` and `gh` children has its own 5-second timeout), so the clock does not bound the final answer: no end-to-end deadline is claimed, and installed Desktop behavior remains UNKNOWN until measured. In the [Codex command runner at `17a0e6f`](https://github.com/openai/codex/blob/17a0e6f63fad13f577ef87b36b4ea37fc06385e9/codex-rs/hooks/src/engine/command_runner.rs#L332-L340), timeout discards captured stdout and returns an error; the [PreToolUse parser](https://github.com/openai/codex/blob/17a0e6f63fad13f577ef87b36b4ea37fc06385e9/codex-rs/hooks/src/events/pre_tool_use.rs#L193-L211) records that error without setting `should_block`, and the [core runtime](https://github.com/openai/codex/blob/17a0e6f63fad13f577ef87b36b4ea37fc06385e9/codex-rs/core/src/hook_runtime.rs#L223-L225) continues when the aggregate does not block. A deny already written by this hook can therefore be lost on timeout in that source revision; independent guards may still block.

Neither dispatcher can check itself: an empty one exits 0 and a broken one exits 1, and Codex continues. Each checks the other instead. The adapter checks `codex-shell-checks.mts`; the shell dispatcher checks both adapter copies, `codex-hook-adapter.mts` and `hook-adapter.mts`. A peer counts as a guard failure, so the re-check runs, when it is missing, empty, not a regular file or unstatable, or when its device, inode, size or modification time (nanoseconds) differs from what the last proven integrity run recorded in `heartbeat.json` under `peers`. The re-check restores the peer only when the integrity run judges it defective and the restore from the Kherep checkout is proven; a peer that is not a regular file or cannot be read is reported, not repaired. That run takes each record from an fd-bound snapshot of exactly the bytes it syntax-checked: open, `fstat` of that descriptor, read from it, the syntax verdict on those bytes, then a re-stat of the path and its real path. When the verdict is not OK or the path no longer names those bytes, it records nothing, and the dispatcher reports `no proven record`. The dispatchers compare one stat with the record and parse nothing; the parse stays in the integrity run. The notice then starts with `<hooks-relative file> cannot be trusted (<what changed>)`, for example `kherep-maestro/codex-shell-checks.mts cannot be trusted (no proven record)`. The lines the adapter, the shell dispatcher, `lib/guard-recheck.mts`, `codex-hook-integrity.mts` and its restore and library texts build name no absolute path and no error message; a versioned source is named by its path inside the checkout (`claude/hooks/<file>`, `codex/hooks/<file>`) and Node's parser message keeps only file names (issues #564, #576). Text a guard writes itself (its exit-2 stderr, its own reason, the field name in `unsupported field <key>`) passes through unchanged. After every install or upgrade the record no longer matches the new files, and a heartbeat written before part 4 has none, so the first matched call runs one re-check, which proves and records the new files. Limits: an in-place rewrite that keeps device, inode and size and sets the modification time back to the recorded value, or lands within the same tick on a filesystem with coarse timestamps (NTFS, HFS+ and FAT were not measured), is seen only by the next stale-heartbeat or `SessionStart` run. A defect the syntax check cannot see, such as an import that does not resolve or a throw at load, is seen by no Kherep check. Both dispatchers broken at once wait for `SessionStart`. The other wired files keep the part 3 limit that the Codex final pass binds no snapshot. A module both adapter copies import is caught when the shell dispatcher cannot load it: its import of `hook-adapter.mts` fails, it denies with `Shell guard adapter could not load; this tool call is blocked.`, and its re-check restores the module. Both copies share those modules, so a broken module disables both at once, where a broken `hook-adapter.mts` alone leaves `codex-hook-adapter.mts` running; detection and restore are equivalent.

These three command definitions change, and their `commandWindows` forms with them. The group count and every entry index stay, so no positional trust key moves, and existing `[hooks.state]` bytes are kept. The installer recognises the exact previous block, refuses any other and mints no trust. Codex marks changed definitions for review and skips them until they are trusted, so **between the upgrade and the review the Atlassian destructive guard, the dispatch-contract guard and the Playwright guard do not run**; for Atlassian deletes the managed table's `approval_mode = "prompt"` stays the second layer. When the installer replaces the managed hook block it prints `config.toml: the managed hook block was replaced; Codex skips a changed hook definition until it is reviewed and trusted in /hooks`, followed by the names of the changed entries the previous block ran directly: the three guards and, from issue #538, the messaging intent entry. Operator steps: inspect an isolated candidate first (its receipt reports `managedFragment: "replaced"`); run the installer once from the new source; start Codex, open `/hooks`, review and trust exactly the three `PreToolUse` definitions, and restart the affected native session; then verify in one disposable workspace that a `file://` navigation is denied with the Playwright reason, that `executeDestructive` is denied with `[atlassian-destructive]`, that a `codex-obs` dispatch without the pinned model is denied with `pinned to model`, and that an allowed dispatch with an unbound finding shows the brief-revision notice. `kherep-node doctor` does not see trust state. Expect one `hook integrity re-check` notice on the first guarded call after the install, none afterwards.

On installs with the messaging client, issue #538 changes one more definition: the single entry of the messaging intent group becomes `"<node>" "<hooks>/codex-hook-adapter.mts" "<CODEX_HOME>/orchestra/control-plane/node/mcp-intent-hook.mts" "pre-intent" "--config-root" "<config root>"` with `timeout = 15` and the Windows form `& <command>`. Same group, same position, no index moves. Codex skips it until it is trusted in `/hooks`, so **between the upgrade and the review the five messaging tools are unavailable**: the hook does not add its `requestId`, and the Worker requires one in every messaging schema (`modules/control-plane/worker/src/mcp-http.mts`) and a stored intent for it (`mcp-registry.mts`, `intent not found`); this is read from code, not measured on a host. Operator step: trust that definition too, then verify one messaging call. Installs without the messaging client see no change.

| Event / group | Fail-closed at file level | Reason |
|---|---|---|
| `PreToolUse` privacy groups, Atlassian destructive guard, dispatch contract, Playwright | yes, through the adapter | the adapter files themselves are not self-checked; the shell dispatcher's peer check re-checks them and restores a defective one, with the limits above |
| `PreToolUse` shell group | yes for its three guards | the dispatcher file is not self-checked; the adapter's peer check re-checks it and restores it when defective |
| `PreToolUse` messaging intent group (only with the messaging client) | yes, through the adapter (`pre-intent`) | the adapter denies when `mcp-intent-hook.mts` is missing, empty, not a file, late, silent or prints anything but its contract; the file lives outside `hooks/`, so it is not inventoried or restored: the deny names it and `codex/install.mts --enable-messaging-client` reinstalls it. The adapter copy keeps the part 4 peer-check limit |
| `Stop`, `SubagentStop` | not applicable | own `decision: block` continuation contract; a deny on breakage would lock the operator in a loop. Inventoried and restored |
| `UserPromptSubmit`, `PostToolUse`, `SessionStart`, `PreCompact`, `SubagentStart` | not applicable | no permission decision; a broken hook is silent or visible, never a block. Inventoried and restored |

#### Denied-call capture (issue #504)

The adapter's `main()` and the shell dispatcher journal a delegated call's verdicts to `<CODEX_HOME>/.cache/denied-calls/<agent_id>.jsonl` through the installed `hooks/kherep-maestro/lib/denial-journal.mts`, without changing the decision; the shell dispatcher journals every denying guard, not only the first. `preToolUse()` and `runAdaptedHook()` never journal. Codex documents no `agent_id` on a child's `PreToolUse` payload, so capture writes nothing until a child-thread key is measured (#537), and every Codex worker reads `unknown (journal-missing)`. No Codex hook group is added, so nothing new needs trust in `/hooks`. The renderer is installed as `<CODEX_HOME>/hooks/kherep-maestro/denied-calls.mts` (`render <agent_id>`, `list`, `prune`, as on Claude). The adapter loads the journal lib by a computed path; `hook-integrity-sources.mts` registers it for both adapter copies, so Codex hook integrity inventories and restores it like `guard-recheck`.

The journal lib retains its 600 ms cap. In the standalone adapter, the capture-failed marker is awaited until the hook deadline less 250 ms (issue #612), because `process.exit(0)` abandons a pending write. In the shell dispatcher, the lib and marker share at most 2 seconds, shortened to the remaining hook budget less 250 ms, including the fallback when the adapter cannot load (issue #621). With the full capture window and prompt scheduling, a marker settling 700 ms after the lib's timeout persists, but a write still pending at the cap can lose evidence; filesystem capture is not guaranteed. After re-check and attribution finish, the CLI waits for stdout and stderr write callbacks, including empty barriers on a silent allow, then exits with code 0 so lingering journal handles cannot retain it. Importing or calling exported `shellChecks()` does not exit its caller. Attribution remains uncapped, so this fix does not establish an unconditional 40-second answer deadline. These are source and isolated process-test guarantees; installed Desktop behavior remains UNKNOWN until separately measured.

CI runs the Codex suites on `windows-latest` as the `codex` shard of the `unit-windows` matrix, gated by the required check `unit (windows-latest)`; the `commandWindows` forms of the four changed entries are not accepted on a live Windows host. In that shard and in the ubuntu jobs `typescript` and `unit-engines-floor`, CI no longer calls `npm run test:codex`: it runs `node codex/scripts/codex-run-guard.mts run --platform <win32|linux>`, which reads the patterns from the `test:codex` script and fails the step when a pattern selects no file, the test count falls below `minTests`, or the skipped tests differ from the accepted set for the platform in `codex/scripts/codex-run-expected.json` (issue #550), or a summary counter or the plan line contradicts the records the TAP holds (C8, issue #578). On a skip difference the step log carries the observed list between the `observed skips (<platform>) begin` and `end` lines; `gh run view --job <job-id> --log | cut -f3- | sed -E 's/^[^ ]+ //'` strips the log prefix, and the list goes into the expected file in the same pull request as the change that moved the skip. A local `codex-run-guard.mts run` yields the skip list of the host it runs on, which equals the CI list only on a host that matches that platform's CI image; the guard prints the observed skips after any skip check failure (C3, C4, C7) and the regeneration hint only when the skipped tests differ from the list (C3), the one failure an edit of the expected file clears.

The per-turn Maestro reminder is shorter but retains its evidence, privacy, delegation, acceptance and observation rules. It remains present on every prompt. Research and the session-bound receive recipe are not cached away, so compacted or restarted sessions still get the current instructions.

This minimal graph does not enable the broader Atlassian surfaces. `KHEREP_INSTALL_ATLASSIAN_TOOLS=1` is the explicit opt-in for the Codex Jira graph, the Claude Jira and Confluence broker copies, and the managed v2 Atlassian remote MCP server `atlassian` (`https://mcp.atlassian.com/v2/mcp`). Codex reaches that server as the Codex service account: the managed table runs `orchestra/supergateway-secret-wrapper.mts` with the API key file `KHEREP_ATL_MCP_TOKEN_FILE_CODEX` (default `<CODEX_HOME>/kherep/atl-mcp-credential-codex.txt`) and sets `approval_mode = "prompt"` for `executeDestructive`. Without a usable key file, or with a file that belongs to the Claude service account or a broker credential, no table is written, the installer warns and exits 1, and the receipt's `atlassianMcp.status` says why. A block with the earlier native OAuth table is replaced. An upgrade keeps the tool set when the installed managed block carries an `atlassian` table: without `KHEREP_INSTALL_ATLASSIAN_TOOLS` it is installed again, and the key file the installed service-account table names is reused ahead of the default (receipt `tokenSource` `installed`); `KHEREP_ATL_MCP_TOKEN_FILE_CODEX` still wins. If that table's key file is not usable, the installer stops before writing anything and names the file and the variable. `KHEREP_INSTALL_ATLASSIAN_TOOLS` set to any value other than `1` opts out, removes the managed table and records `atlassianMcp.status` `removed`. See [Atlassian MCP server](INSTALLATION.md#atlassian-mcp-server). An operator's own `atlassian` table outside the managed block is preserved. The v1 `rovo` table is retired, and the installer no longer registers the legacy `atlassian-rovo@openai-curated` plugin; a registration from an earlier install stays until the operator removes it. The Claude bootstrap installer places both Confluence brokers by default, because it installs `claude-obs`. Codex and Claude brokers continue to use separate service-account credential bindings.

### Windows target setup and migration

`codex/install.ps1` forwards the publication switch to the shared Node installer. The Node installer resolves the Codex credential first and then runs the space setup once. That setup also resolves placement nodes through the Codex service account and persists them beside the space identity.

The shared Node installer resolves the observation target and writes `<CODEX_HOME>/kherep/confluence.json`. It selects a space key in this order: `KHEREP_CONFLUENCE_SPACE_KEY`, an existing canonical file, the legacy `<CODEX_HOME>/orchestra/confluence.json`, then an interactive prompt. Only `spaceKey` is read from a legacy file.

The helper does not copy legacy bytes. It reads the selected space through the Codex `atl-confluence.mts` service-account broker and writes the canonical `spaceKey`, `spaceId` and `spaceName` only after that read succeeds. With `-AuthorizeObservationPublishing`, it also writes the literal `observationPublishingAuthorized: true`. A later run without the switch preserves an existing canonical literal `true` only when the prior canonical `spaceId` equals the newly resolved `spaceId`; a fresh run or a changed space identity omits the property, and authority is never imported from the legacy file. The helper never writes a false value. It retains the legacy file. If target setup fails, the parity installation remains installed but the warning means the Confluence destination is not established and observation delivery is UNKNOWN.

Before any Codex observation write, the narrow adapter reads the canonical file and
requires `observationPublishingAuthorized` to be literal `true`. That value is durable standing authority
only for non-secret observation pages in the configured space through the Codex service account.
It does not authorize another space, another content type, secrets, permission changes or another
identity. If the property is absent or has any other value, the agent writes nothing and reports
`OBS-RESULT: failed authority-denied`. The worker never reads this file; it calls only the narrow publication tool.
Claude's direct broker authorization and publication path is unchanged.

## Messages for the current Codex app session

A Codex desktop app restart starts a new session with a new id, so a `wake.sessions` list of full ids stops matching the session the operator works in. The optional node policy field `wake.codexApp` (boolean, `false` when a written `wake` section omits it) adds one grant for it. A policy file without a `wake` section gets the built-in default `{ "enabled": true, "sessions": ["*"], "codexApp": true, "replies": true }`, so waking, this grant included, is on by default; `"wake": { "enabled": false }` turns it off (issue #390):

```json
"wake": { "enabled": true, "sessions": [], "codexApp": true }
```

With `codexApp: true` the list may be empty or absent. Any non-boolean value turns waking off, as a malformed list does. The grant selects exactly one Codex session that the list does not name: the most recently seen session recorded by the delivery hook whose rollout, `<CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`, begins with a `session_meta` line for that id with `originator` `"Codex Desktop"` and `source` `"vscode"`, and no parent thread. The node reads that line itself. It searches the newest 62 date directories, reads at most 256 KiB, follows no links and refuses a missing, unreadable or garbled file or any other value. Exec runs, Codex tasks and app subagent threads are never granted. If two app sessions share the latest time, neither is granted. A TUI reachable on the shared app-server daemon (below) is never granted and is skipped when the newest app session is chosen.

An eligible Desktop or Terminal session receives a CP hint admission. The node
publishes metadata directly after the existing authorization guards. When
`wake.nativeQueue` is `true`, a separate guarded producer submits a fixed native
Queue pointer to that exact owner, retaining peer text in the persistent CP Inbox.
Native arbitration waits while active and can start the same idle loaded owner.
No thread is resumed or replaced. Legacy queue bindings remain untouched.
The producer is off by default (issue #429): a `wake` section without
`nativeQueue`, the built-in default included, submits no native Queue card, and the
owner still gets the CP hint. `nativeQueue` grants nothing by itself; the owner
still needs full-id authorization or the `codexApp` grant. Any non-boolean value
turns waking off, as for `codexApp`:

```json
"wake": { "enabled": true, "sessions": ["<full thread id>"], "nativeQueue": true }
```

The Composer's Queue or Steer default is an independent user preference and does
not control this route. Kherep does not change that setting.

Each synchronous Codex admission round reads, parses and indexes the Inbox once
after finding eligible non-task owners. Decisions reread only indexed records for
that owner's full id and unique aliases. Records already consumed, removed or
readdressed are excluded; arrivals after the snapshot wait for the next round.
The index is discarded at the end of the round. Publication rechecks required
policy, enrollment, kill switch, permissions, task exclusion and the admitted
references. It does not add newly arriving records.

A ticket carries at most eight admitted ID/address pairs, its exact owner, an
immutable generation, TTL and policy fingerprint. The trusted synchronous native
PostToolUse hook validates original-owner identity from the native session and
transcript basename without opening the transcript. It checks current policy and
permissions and reads only those bounded references. A durable claim produces
one fixed additionalContext hint in the same running turn at the next supported
tool boundary. The hint contains no peer bodies, IDs, paths or receive command.
This does not interrupt sampling or send a literal `turn/steer` RPC. Without a
tool boundary, an opted-in native pointer remains available for the next
eligible turn.
The existing Stop continuation remains available for accepted messages
under its existing budget and permissions.

Idle evidence (issue #408): the node's record of each Codex session keeps the
last hook event that reached it and when, plus the time of the last `Stop`.
The original owner's `PostToolUse` refreshes the event of an existing record
only; a subagent's call writes nothing. A session counts as idle only when its
last event is a `Stop` that ended its turn at least 90 seconds ago and it was
seen within 12 hours.
This is evidence, not proof. Only the opt-in Codex fork reply below acts on it;
`msg sessions` shows the last event of this node's Codex sessions and
`kherep-node doctor` counts them per event. A turn ended by native
`turn/interrupt` fires no `Stop` (measured on Codex 0.162.0-alpha.17.2 and
0.163.0), so an interrupted turn leaves the session not idle until a later
turn completes. CLI Escape fires no `Stop` either (measured on macOS with a
positive `Stop` control); the Desktop stop button is not
measured.
Whether an approval wait can be told apart is UNKNOWN. A `Stop` counts as ending its
turn only once the hook marks it with `lastStopEnded`, after recording it, on
every exit that returns no blocking continuation; every hook event clears the
mark. A `Stop` that blocked, or whose mark could not be written, does not count
as idle.

Codex fork reply (issue #408, in progress). Nothing changes while
`wake.codexFork` is absent, except that relays made while it was present are
still withdrawn when the owner reads and cleaned up after 24 hours; nothing is
sent, forked or audited. With it present only `darwin` is accepted, and the
answer is relayed to the peer as one labelled proxy answer while the owner stays
idle (below). Upgrade the Worker before the nodes. The section names the Codex chats whose
history an ephemeral read-only fork may use to answer an idle owner's peer
message:

```json
"wake": { "enabled": true, "sessions": ["*"],
  "codexFork": { "enabled": true, "sessions": ["<full thread id>"], "platforms": ["darwin"],
                 "idleAfterSeconds": 90, "maxAnswerBytes": 4096 } }
```

Absent means off. The daemon reads the policy at every exchange round (every 2
seconds) and applies it to that round, the exchange's send gate included: adding or removing `wake.codexFork`, or
an owner in `wake.sessions` or `codexFork.sessions`, takes effect at the next
round without a daemon restart (issue #444). Only full thread ids are accepted (in any case, kept in
lowercase), never `*` or a name, and
only `darwin`. Windows was measured and stays off (issues #464, #477): the helper's process tree
cannot be proven contained, and a forced close cannot confirm the helper's process tree once the
helper has exited (`taskkill /T` needs a living root), so an attempt whose close is forced after the
helper exited keeps the service admission lease. A turn timeout on a living root measured exactly
that: `uncertain/close-unconfirmed` with the lease kept. The fork itself completes on Windows
(Codex CLI 0.160.1, a Desktop-created owner): the `-32600` refusal first measured in #464 came from
the measurement probe, which passed one MCP server override that codex rejects; the production fork
guards drop such names (`computeOverrides`). Enabling Windows needs the per-descendant identity
kill of the stop path (issue #231) in the fork and a containment capture from creation on, a
separate change. Any other shape turns off
only the fork reply; waking stays as written. The node already records one
attempt per message and decides admission (opt-in, kill switch, enrollment,
policy unchanged, recorded non-task owner, permission mode, platform, the Codex
delivery hook on `PostToolUse`, idle evidence, an accepted exact-addressed
message with valid reply admission, no earlier attempt, a working directory inside
the workspace roots, readiness and the shared turn budget). The owner's recorded
`cwd` must lie inside `sessions.workspaceRoots`, with `sessions.enabled` and
`codex` in `sessions.runtimes`; the fork loads `AGENTS.md` from that directory,
so an owner started outside the approved roots is refused `cwd-refused` at
every attempt. With the section
present on `darwin`, the daemon starts one short-lived `codex app-server` (the
`codex` on `PATH`, run directly, in its own process group, with
`KHEREP_CODEX_FORK=1`) per eligible message, one at a time on the node. It
reads the owner without loading it (`thread/read`; the newest turn through
`thread/turns/list`, which must be `completed`; and `thread/goal/get`, which
must show no goal or a complete one). It then forks the idle owner ephemerally
at that turn with tools, hooks, goals, web search, request-user-input and every
discovered MCP server off. `deferGoalContinuation` is never sent: it cannot be
combined with an ephemeral fork, and it copies the goal into a persisted one.
The fork is driven only after `thread/goal/get` on it answers `-32600` with
exactly `ephemeral thread does not support goals: <fork id>`, the server's
statement that the fork cannot hold a goal; any other answer, `goal: null`
included, fails the attempt. Both goal reads need goals enabled in the Codex
config of the identity (the default): with goals disabled the helper cannot
read the owner's goal, and every attempt refuses `goals-disabled` after its
admission. No version or hash of `codex` is pinned: an upgrade that answers the
same way keeps working, and one that answers differently fails visibly with a
fixed reason code.
The fork gets one bounded structured question; the daemon validates the answer
and stores it in `codex-fork-attempts/<owner>/<message>.json`. A JSON-RPC error
response to `initialize`, `thread/read`, `thread/turns/list` or `thread/fork`
is recorded only as one content-free daemon log line (issue #477):
`kherep-node: Codex fork helper refused <method> (code <code|none>, <shape>, sha256 <12 hex>, mentions <list|none>)`,
with the code only when it is an integer, the shape `missing`, `empty`, `text`
or `overlong` (over 4096 UTF-8 bytes), the first 12 hex digits of the SHA-256
of the message, and which of the owner id, the newest turn id, the working
directory, the Codex home and the word `kherep` the message contains. No text
of the server's message is kept anywhere, and no persisted field is added: the
attempt keeps its reason code as before, `wake.jsonl` and the relay are
unchanged, and a code alone names no cause. Any approval or
other request from the server, a tool item, a goal change or a turn the helper
did not start fails the attempt. The owner's inbox record, progress, session
record and thread are untouched; the owner's next turn reads the message as
before. Each attempt writes one
`wake.jsonl` line (`fork`, `fork-declined`, `fork-failed`, `fork-uncertain`,
`fork-superseded`). Every refusal before the claim is one `wake.jsonl` line per
owner, message and code (issue #444): `fork-disabled-platform`, `fork-not-idle`,
`fork-cwd-refused`, `fork-permission-mode`, `fork-budget-spacing` and so on (the
admission code with the prefix `fork-`), and the producer's own `fork-producer`,
`fork-mcp-unknown`, `fork-features-unknown` and `fork-relay-unsupported`. A line
carries ids and the code only, never a path or text. A line whose append failed
is not marked as noted: the next poll that meets the same refusal writes it
again once the audit file is writable. On another platform the only effect is the
`fork-disabled-platform` line. The fork spends the owner's turn budget once per
attempt. A non-interactive `codex exec` session reports `approval_policy=never`
to the hooks even with `-a on-request` and `--sandbox read-only` (measured
2026-10-16, codex-cli 0.160.1), so its record carries `permissionMode:
bypassPermissions` and admission refuses it (`fork-permission-mode`); fork
owners are interactive sessions (TUI or Desktop). `kherep-node doctor` prints the section with a count of opted-in
sessions and counts the attempts per state.

Relay of a completed answer (issue #408, fourth increment). The daemon's sweep,
in every poll before the inbox filter, writes one outbox record per completed
attempt: a proxy answer to the original's sender, from the owner's session, with
`proxyOf` naming the original, never `inReplyTo`, so the original is never
marked replied, and with the original's reply depth plus one. Its text starts
with a fixed header that names the owner session, the fork and the original and
says the owner has not read the message yet. There is no stored release: the
sweep writes the record only when the relay guards pass, and the exchange runs
the same guards again at every send, resends included, so a guard that fails
after the write holds the record from the next exchange round on. The guards,
in order: the attempt at most 24 hours old (`fork-relay-stale`); the policy read
fresh (the section present, enrolled, no kill switch, the fingerprint the
attempt was admitted under, the owner opted in, the platform, the answer within
`maxAnswerBytes`); the Worker capability `messaging.proxy.v1` proven by a
directory frame of the current authenticated connection (cleared at every close
and every authentication, never read from `directory.json`); the original still
`accepted` for the owner; and the owner's recorded session with admission's own
clauses (recorded and recent, not a task session, no bypass or unknown
permission mode, the `PostToolUse` hook, idle evidence). A relay spends no turn
and starts no helper. The send also needs the message's sidecar
`inbox/proxied/<message>.json` to match the attempt, the relay id and the fork;
a missing, unreadable or mismatched one holds the record. A Worker without the
capability refuses every fork before admission (`fork-relay-unsupported`).

When the owner reads or answers first, the daemon withdraws before any send guard
is consulted, in every poll for every message with a sidecar, whatever the
owner's session state and whether or not `wake.codexFork` is present (the
`fork-superseded` audit line only while it is): exactly (outbox record and
sidecar removed) when no frame can have left this node, and otherwise as
unconfirmed, keeping the record (never sent again) for a late Worker status. A
held record that gets no Worker status within 24 hours is removed by the same
per-poll bookkeeping (a missing sidecar is not recreated, one naming another
relay is left as it is, and a record that is not the attempt's relay is never
removed); the sidecar then records `unresolvedAt`, and the outcome is
unknown, not "not delivered": a later status is acknowledged and not recorded
locally, and the Worker's message listing and audit may hold it. The Worker
refuses a proxy whose original row is missing or does not match (`proxy parent
unknown`, also for a deleted original with a tombstone), is answered
(`original already answered`) or is not `accepted` (`original not waiting`), and
beyond the reply depth. The owner's reply, and the owner node's `delivered` or
`refused` report of the original, refuse every proxy of it still queued; a
delivery frame produced before that is dropped where it is pushed. A proxy
already accepted at the peer stays: the peer then holds both the proxy and the
owner's reply (audit `message.proxy.late-delivery` when a refused proxy is
reported taken); closing that needs a reservation (a later increment).

`relayedAt` in the attempt means the control plane answered the relay (its first
status in `sent/`), and the attempt is audited `fork-relayed`. The owner's next
delivery and `msg inbox` show one line per state, derived from the sidecar, the
outbox and `sent/`: prepared and not queued; queued locally or awaiting
confirmation; may have reached the control plane; queued by the control plane;
reached the peer (the only line that says not to answer again); could not be
delivered (with the quoted reason); and no delivery status before local cleanup
(outcome unknown). The proxy's own sent record produces no failure or receipt
notice for the owner. The peer sees `Proxy answer for your message <id>` and
`msg inbox` prints `proxy for: <id>`; its reply to the proxy is an ordinary
reply to the owner's session.

Measured on synthetic threads (2026-10-16, Codex 0.160.1 on `PATH`,
0.162.0-alpha.17.2 and 0.163.0): `thread/goal/get` answers `goal: null` for an
owner no server has loaded and the exact ephemeral refusal for a fork, both
answer "goals feature is disabled" with goals off, and a fork turn with the
output schema runs with no turn or goal event the helper did not start.

Measured on macOS, on synthetic threads only, with the real
`codex` on `PATH` (0.160.1), the bundled binary (0.162.0-alpha.17.2) and the
daemon's (0.163.0) and the existing login: the fork reply completes with no
server request and no authentication request; a long rollout (1.7 MB) forks;
with `features.hooks=false` the fork adds no hook event; a synthetic
Desktop-created owner is declined (`needs-owner`) with its rollout unchanged;
MCP servers start for the fork. No real chat belongs in `codexFork.sessions`.
Still open are goal isolation with an active goal set on the owner; a fork of
an owner loaded by the Desktop app and the absence of a new chat or Queue card
in its UI; the Desktop stop button; the native renewal of the login; the real
model catalog and plugins as a separate measurement; and an installed daemon
with the fork switched on. The fork stays `darwin` only (measured in issues #464 and #477): on
Windows the fork completes, but `taskkill /T` cannot reach the descendants of a
helper that already exited, so the close there is never confirmed and the
lease is kept.

Admission and a metadata claim leave messages `accepted`. Explicit
`msg inbox --receive` offers only complete messages actually returned. The Maestro
executes the returned `msg inbox --ack <receipt> --from <owner>` command after
processing them; Stop never confirms fetched content. An interrupted offer can be
received again immediately without consuming an offer attempt. An oversized
message gets an exact `--receive <messageId>` recovery command. See the
[receipt contract](../modules/control-plane/CODEX-RECEIPTS.md).
Messages outside the ticket or a limited Receive remain in the CP Inbox under
its existing retention contract. The normal prompt/Stop intake remains available.

After confirming delivery, normal Stop awaits bounded cleanup of exact native
pointer groups. Every member must be delivered to the original owner; the Queue
ID, full input, local producer binary/hash and Codex home must match. Public
list/delete and a complete readback establish removal. Attempts remain durable
duplicate barriers. Offered, uncertain, partial and foreign cards are retained.
Late producer settlement and existing daemon polls recover pending cleanup,
including already-delivered pointers after wake is disabled. No new model turn
is started by cleanup. A pointer already claimed, or admitted after Stop before
its ID is known, may already have started a turn; cleanup does not interrupt it.

Separate `.busy-admission.json` metadata records the authorized generation and
publication time; old `.queued.json` history never authorizes or blocks CP hints.
Successful publication waits up to ten minutes for intake. If still accepted
then, fresh admission rechecks guards without booking an autonomous turn. Claim
alone is no Receive. Publication failure or contention retries the same generation on
existing poll rounds without booking a turn while its TTL and policy are valid.
Policy drift or expiry invalidates that retry. Restart recovers valid CP metadata;
missing or unreadable metadata requires a fresh authorized admission. Native
attempts remain independent of hint retries. Progress is `waiting/awaiting-user-turn` while intake is
pending, `waiting/retry-pending` after publication failure and
`waiting/awaiting-turn-confirmation` after an actual offer.

Reinstall projects this separate PostToolUse definition even when the three older
intake hooks are externally owned. Review and trust the exact new definition in
Codex, restart the original owner, and test active peer processing at a supported tool boundary.
The installer stops before writes if an operator-owned PostToolUse group would
move to another positional trust key. It does not mint or move trust hashes.
Source and fixture tests alone do not establish either host's native acceptance.

An interactive Codex TUI on Codex 0.160 can write the same first rollout line as a
Desktop chat (measured on macOS, issue #268). The TUI marker and cached
shared-daemon probe still restrict the automatic `codexApp` grant: a positively
reachable TUI is excluded, and a marked candidate with unknown reachability waits
without admission bookkeeping. Full-id policy authorization permits CP admission
independently of that probe. The probe remains bounded to two seconds and cached
for ten seconds; Windows does not connect to that daemon socket.

The kill switch, full-id authorization or `codexApp` grant, permission-mode check
and Worker-issued reply-admission checks remain. Legacy paths retain the six-hop limit; guarded paths use pair strikes and the 256-admission segment fuse. CP hint admission and claim do not check or spend
the shared turn budget or spacing. Actual listener wakes and Stop continuations retain their existing
autonomous-turn gates.
App-grant decisions retain `"grant": "codexApp"` in the metadata-only wake audit.
Codex background tasks and genuinely closed targets retain their separate policy
paths; Claude delivery is unchanged. Source and synthetic tests do not establish
installation, hook trust or processing on either Desktop host. Actual owner-turn
acceptance is tracked in [issue #374](https://github.com/cfaysal/kherep/issues/374).

## Retired memory backend

Earlier installers could select a separate Central Brain MCP server with native context and capture hooks. That backend is retired; the Central Brain is now the Confluence knowledge space described above. A reinstall over such a host reads the persisted `orchestra/memory-provider.json`, resets it to `{ "provider": "unconfigured" }` with the previous file in the installation backup, and replaces the managed configuration block the old installer rendered, which removes its MCP table and native hooks. The receipt reports `retiredMemoryProvider: "central-brain"` for that run. A block that differs from what the old installer wrote is not overwritten; the installer stops and leaves it for review. A `central-brain` MCP table outside the managed block is removed only when it is exactly the table the old installer rendered for the persisted selection; otherwise it stays and the receipt lists it under `retiredMcpServers` as `retained-for-review`. A Codex project trust entry for the old `central-brain` checkout is an operator setting and stays untouched. An explicit `central-brain` selection is refused.

## Verify and upgrade

The installer manages routing, hooks, plugin registration and an installation receipt. It preserves unrelated settings and uses recoverable transactions. The managed hook block is replaced as a unit: a changed field of a managed hook, such as a `timeout`, never leaves the old entry next to the new one, and a previous block the installer does not recognise, one with an operator edit included, is refused instead of merged (issue #568).

The top-level `model_reasoning_effort` in `config.toml` belongs to you. If it is set, the installer keeps that line byte for byte. Only when it is absent does the installer write the default `model_reasoning_effort = "xhigh"`, which matches the Maestro's default root tier. A value inside a table such as `[profiles.<name>]` does not count as top-level and is never changed. The receipt records the outcome as `reasoningEffort`, with `status` `preserved-existing` or `configured` and the `value` kept or written.

Agent model selection comes from [`codex/parity/model-policy.toml`](../codex/parity/model-policy.toml), which names families rather than release numbers. The main designer uses Astra with high reasoning, builders use SOL with high reasoning, support and research use Terra with medium and low reasoning, and observers and brokers use Luna with low reasoning. The root role uses SOL with xhigh reasoning. The `feature-dev` code architect takes designer precedence over generic plugin model mappings; Opus agents and the code simplifier map to the builder role. Claude definitions remain unchanged.

For nontrivial design work, use the managed Astra designer, normally `code-architect`; product implementation belongs to the managed SOL `kherep-builder`. The SOL Maestro owns grounding, coordination, review and final acceptance. Resolve both actual managed names and validate their identity and task purpose through the installed routing; role alone is ambiguous, and missing or inconsistent identity requires STOP/UNKNOWN. A brief to `kherep-builder` or `dc-plugin-build-runner` marks `revision: <name>@<sha>` and `decided: <decision>` (or `decided: none`) at the start of a line, and the dispatch guard denies it otherwise; the builder ends its receipt with `REVISION:`. The Worker briefs part of the Dispatch section of the installed `ROUTING.md` has the full rule, the review receipt and the reviewer rule, and its Verification section the Maestro's revision comparison (issue #701). If a personal agent already owns the designer's normal name, consult `projection.agentDefaults` in the receipt or `projectedAgents` in the installed dispatch snapshot for the actual managed name and role.

The metadata collector initializes an isolated Codex app-server and exhausts visible `model/list` pagination. It opens no threads and starts no inference. Resolution selects the numerically newest exact family member that advertises the requested reasoning level. Hidden, preview, dated or ambiguous aliases do not establish a family match. Missing families, incomplete pagination, unsupported reasoning or unconfirmed process cleanup stop model selection. An unavailable catalog names the failing stage (start, catalog or cleanup) without any server output, and cleanup confirmation re-asks its probe (the process-group probe on POSIX; on Windows exit and close of the owned child followed by a process snapshot without a tracked member or a descendant of the root, the tree signal's report counting for nothing) within a default retry budget of two seconds (`cleanupGraceMs`, configurable up to ten seconds) with a capped number of probes; the budget bounds the probes, not the wall-clock time, which event-loop scheduling can extend. During that wait nothing is signalled again, because a process-group number does not prove ownership after the owned close; only a measured disappearance confirms cleanup, and a group still present or denied at the deadline is an unconfirmed cleanup. A missing directory named with `--codex-home` is created with mode 0700 before the read. On every platform the catalog app-server is started with the per-invocation override `-c features.plugins=false`, measured effective on codex-cli 0.160.1 on macOS and Windows 11, so the read performs no plugin sync in a fresh home; this is a one-off override whose behaviour under a managed configuration or a later Codex release is not guaranteed. Offline tests inject catalog fixtures and never call a real Codex account.

The resolved model IDs and supported reasoning levels form one installation snapshot used for both native agent TOMLs and the dispatch guard. It includes every actual projected plugin name, including collision renames, with its model and reasoning default. Its evidence includes the policy file's SHA-256, catalog hash and resolution time. Ordinary reinstall retains a valid snapshot; run `node codex/install.mts --refresh-models` with your usual installation arguments to adopt a new catalog or changed policy. The policy is installed at `orchestra/model-policy.toml` in the selected Codex home. The observation pin remains exact: an omitted or different model is denied. Known projected roles use native agent defaults, and the guard validates the effective model and reasoning combination without network calls. An explicit model override still inherits that agent's reasoning unless reasoning is also explicitly supplied, so an unsupported inherited combination is denied. Generic or unknown agents may inherit the runtime's parent settings without overrides; when overriding, supply both model and reasoning explicitly because the policy's root defaults do not measure the active parent's settings.

After installation, restart Codex in the selected workspace. Check rule and plugin discovery, a harmless tool call and each configured MCP connection. A plugin entry alone does not establish a working connection.

Review and trust the exact hook definitions using the host's supported hook controls. Feature and administrator policies can prevent execution; installation does not override them. Inspect discovery and execution at the actual Desktop host, then verify a quiet observation turn as described above. Desktop hook support is UNKNOWN until this measurement. CLI discovery or a prepared output receipt alone does not prove delivery. See the [official Codex hook contract](https://developers.openai.com/codex/hooks).

For turn-completion observations, keep the following evidence separate:

On both hosts, inspect both `UserPromptSubmit` hooks and confirm that the `Stop` group contains the research and acceptance gates, with no observation hook. Then run one substantial synthetic turn without research and verify exactly one research continuation; repeat it with `stop_hook_active: true` and verify no second continuation.

The managed block also runs a hook-integrity check, `hooks/kherep-maestro/codex-hook-integrity.mts`, as the last entry of the Maestro `SessionStart` group. At every session start it checks each hook file `config.toml` wires under `<CODEX_HOME>/hooks` and the files they import. It restores a missing, empty or unparsable file from the Kherep checkout and counts the restore only when the bytes at the target match the checkout. It reports what it found in the session and appends each finding to `<CODEX_HOME>/.cache/hook-integrity/incidents.jsonl`; when everything is healthy it prints nothing. The two observation hooks the installer renders are only reported, and a reinstall repairs them. Without a resolvable checkout it writes nothing and reports the file as not restored. An upgrade from the previous projection appends this one entry and leaves every other entry at its position, so Codex marks exactly this new hook for review. Trust it with `/hooks`; until then the check does not run. Check the journal path after a test session if you need evidence that it ran.

The same check runs as `codex-hook-integrity.mts --trigger <source>`, with plain lines instead of the session-start output, when the hook adapter re-checks. Codex has no hook runtime, so before it restores or journals anything, its own libs included, the check takes `<CODEX_HOME>/.cache/hook-integrity/run.lock.sqlite` as an `EXCLUSIVE` SQLite transaction (`node:sqlite`, rollback journal `DELETE`, busy timeout 0; a busy answer is retried three times, 2 to 11 ms apart, because two runs that start together can each see the other's transient lock and both back off, issue #620). The operating system keeps that lock for the process holding it and releases it when the process ends, so another run never takes it over, moves or deletes it. A second run reports `another integrity run holds run.lock (busy, holder UNKNOWN); nothing checked, heartbeat not written` and changes nothing; the holder is not named. The database and its `-journal` file are permanent and hold no data, and a Codex home on a network filesystem is not supported for this lock. The run removes the heartbeat before its first repair (a removal that fails blocks the repair), walks the import closure again after each repair pass, at most three passes, through `hooks/lib/integrity-passes.mts`, which the Claude integrity hook shares, checks the live closure once more without falling back to the checkout, and writes `heartbeat.json` (`ts`, `trigger`, `runtime`, `files`, `pid`) only when all of that passed and the write itself succeeded; at session start the trigger is `session-start`. Journal entries name the `trigger`. Limits: a parallel tool call may load a file while it is restored in place; a broken `lib/integrity-heartbeat.mts` is reported, not repaired, until the next installation, because the restore needs the lock it provides; a Node without `node:sqlite` reports and repairs nothing.

The managed block also runs the control-plane delivery hook, `modules/control-plane/node/deliver-hook.mts --runtime codex`, for `SessionStart`, `UserPromptSubmit` and `Stop`, from the checkout or source pin the installer runs from. It hands messages from other agent sessions to the Codex session and is inert without an enrolled control-plane node. SessionStart and every UserPromptSubmit supply the session's exact receive recipe in bounded developer context, even with an empty inbox. Stop emits only `Kherep: New peer messages are waiting. Check this session's inbox and report any relevant update.` The CLI and escalation instructions remain in context; peer content and identifiers never enter this visible reason. Like every non-managed hook it runs only after you review and trust it in Codex. See [Codex sessions](../modules/control-plane/README.md#codex-sessions).

Since issue #503 no Control Plane hook command names that source. Codex trusts a hook by a hash over its definition, command line included, so a command naming `<CODEX_HOME>/orchestra/source-pins/<commit>` changed with every upgrade and asked for review again. The six definitions (shell-group and `PostToolUse` attribution, delivery on `SessionStart`, `UserPromptSubmit`, `Stop` and the `PostToolUse` busy hint) name the stable entry point and a fixed hook name instead: `"<node>" "--disable-warning=ExperimentalWarning" "<CODEX_HOME>/hooks/kherep-maestro/codex-control-plane-hook.mts" "deliver" "--runtime" "codex"`, `... "attribution" ...`, and for the shell group `"<node>" ".../codex-shell-checks.mts" ".../codex-control-plane-hook.mts" "attribution" "--runtime" "codex"`; `commandWindows` is the same with `& ` in front. The Node flag applies to the entry point only: on the Node versions that print a type-stripping warning, a hook run then shows the stderr of a direct hook call, and every warning of the hook itself still shows. The shell dispatcher loads the entry point in-process and needs no flag. The installer writes `<CODEX_HOME>/orchestra/control-plane-source.json` (`version` 1, the absolute source `root`, its `commit` when known, `kind` `pin` or `checkout`, `verified`) inside its install transaction, so a failed install or a rollback restores the previous record with the rest. The entry point accepts only `deliver` and `attribution`, never a path. It checks the record's shape, that `<root>/modules/control-plane/node/<hook>` is a file and, for a pin, that `<root>/.kherep-source.json` exists, then runs that hook with the same Node executable as its own process, with the caller's stdin, stdout, stderr, environment and working directory, and passes its exit code on. Without a usable record it exits 1 with one stderr line naming the record and `codex/install.mts`, and never falls back to its own directory, the working directory, the workspace, `PATH` or the service receipt. This per-run check is not a verified load: `kherep-node doctor` verifies the source identity behind the record. The service launcher's receipt stays the service's own record; the Codex installer writes only this one.

The receive recipe and short feedback have separate source pins. A source merge does not activate them. Before switching a referenced checkout to short feedback, verify the actual stage-A context boundary in every affected original owner and finish any pre-A turn. A new chat, installation receipt or harness receive is insufficient. Live hook installation and same-owner Desktop acceptance remain separate from this source change; see the [cutover plan](superpowers/plans/2026-10-10-codex-quiet-owner-cutover.md).

The `<!-- kherep:start -->` block of `<CODEX_HOME>/AGENTS.md` and `orchestra/ROUTING.md` name the host's intercom command, `node "<config dir>/bin/kherep-node.mjs"` (issue #436, see [Intercom command](INSTALLATION.md#intercom-command)); the installer renders it from the config dir of the outbox below, and the text outside the block keeps its bytes.

So that a Codex session can answer peers without an approval per message (issue #72), the installer also writes the rule file `rules/kherep-control-plane.rules`, which allows only the `msg send`, `msg sessions`, `msg inbox` and `msg status` subcommands of the control-plane CLI. It holds one `prefix_rule`, for the intercom command: `node` with `<config dir>/bin/kherep-node.mjs` in forward slashes, the command the daemon's task prompt, the delivery hook's recipes and the instructions name on a host with a managed service (issue #436). The rule for the checkout's `modules/control-plane/node/cli.mts` that earlier installs wrote is gone, and a reinstall rewrites the whole file. Upgrade the service first (`kherep-node service upgrade` to a pin with this change), then run this installer; until then `kherep-node doctor` reports the old rules file as `stale`. The installer also makes the node outbox (`<config dir>/control-plane/outbox`, where the config dir is `KHEREP_CONFIG_DIR` or the per-OS location) an extra writable root of the `workspace-write` sandbox through `sandbox_workspace_write.writable_roots`. The node directory itself, with its key and `policy.json`, stays read-only. TOML allows one `[sandbox_workspace_write]` table, so where the outbox goes depends on your `config.toml`:

- No `sandbox_workspace_write` of yours: the managed block carries `[sandbox_workspace_write]` with `writable_roots = ["<outbox>"]` and owns it.
- Your own `[sandbox_workspace_write]` table or top-level `sandbox_workspace_write.*` keys (anywhere outside the managed block): the managed block carries no table, and the installer appends the outbox to your `writable_roots`, or adds that key when it is missing. It never removes an entry of yours, and a reinstall that finds the outbox already listed changes nothing. If you later drop your table, the next install moves the outbox back into the managed block; an outbox path from an older config directory stays in your list until you remove it.
- An inline table (`sandbox_workspace_write = { ... }`), a `writable_roots` value that is not a plain array of strings, or `default_permissions` (which the configuration reference says not to combine with `[sandbox_workspace_write]`): the installer leaves your text byte-identical and writes nothing for the outbox. The first `msg send` of a session then needs the escalated retry, as before.

The receipt records the outcome as `controlPlaneOutbox.status`: `managed`, `operator-merged`, `operator-present`, `skipped-inline-table`, `skipped-unparseable` or `skipped-default-permissions`. The root takes effect only when `sandbox_mode = "workspace-write"`.

A Codex session's `msg send` needs no `--from` when `CODEX_THREAD_ID` is in its shell environment and the CLI can determine the runtime that runs the command. Codex sets the variable for its shell commands (source-defined, not named in the Codex docs; measured with Codex 0.160.1 on macOS, Windows unmeasured). The sender check distinguishes three evidence cases (issues #471 and #489, see [CLI](../modules/control-plane/README.md#cli)):

- Only `CODEX_THREAD_ID` is set, without `CLAUDE_CODE_SESSION_ID`: the thread is the sender; the process ancestry is not needed.
- Both `CODEX_THREAD_ID` and an inherited `CLAUDE_CODE_SESSION_ID` are set, as for a `codex exec` started from a Claude Code tool or a `claude -p` started from a Codex tool: a complete, recognisable process ancestry decides the runtime, in either nesting direction.
- Both are set and the available process ancestry does not establish the nesting: an implicit send is refused with the fixed `NESTED_RUNTIME` reason and nothing is written. `--from` is then accepted only when it is the full id of a Codex session a Kherep hook recorded within 12 hours and, if `KHEREP_SESSION_ID` is set, that task records the same thread. Without such a record the send stays refused, even when `--from` repeats `CODEX_THREAD_ID`; otherwise use an authorized command context where the runtime can be determined. A fresh record does not mean that the separate outbox filesystem access succeeds.

These cases describe the sender check, not how a particular command was executed: the rule file and sandbox configuration described above do not by themselves establish which rule applied to a command, which permissions it ran with or how much process ancestry it could read. Which conditions leave the ancestry undecided on a given platform is not measured.

Measured on Windows on 2026-09-27: the Codex desktop app does not apply this root. Without `sandbox_mode` in the config, an app thread runs under a managed `:workspace`-style permission profile (workspace, temp, the thread's visualizations folder), and `msg send` fails with `EPERM` on the outbox. A `default_permissions` profile that adds the outbox did not reach an existing thread after a restart either, so the installer does not write one. What works in the app is the rule file: an escalation request for the `msg` command runs outside the sandbox without asking. The delivery hook's context therefore tells a Codex session to request escalation for the `msg` command on the first attempt; measured, a woken app thread then answered with no user action. The writable root still serves `codex exec` runs.

1. **Configured target and readback:** confirm the installed `codex-obs` role, the quiet context reminder and acceptance-only Stop entry, the adapter import closure in `<workspace>/tools` and the canonical JSON fields. Run `node <workspace>/tools/atl-confluence.mts space --space <spaceKey>` and compare its returned identity with the canonical file. This proves configured discovery and a service-account read, not a write or automatic dispatch.
2. **Manual one-observation write:** dispatch one bounded `codex-obs` pass for a completed turn that contains one durable finding. Require its strict publication receipt, then independently read the created targets. Verify the create receipt, target space, labels and service-account author through the broker's independent readback. A worker result or dispatch report without target readback is insufficient.
3. **Manual zero-write:** run a separate completed turn with no durable finding. Require exactly `OBS-RESULT: empty no-admissible-findings`, zero adapter I/O and independent evidence that the run created no page. A failed, skipped or unobserved run is UNKNOWN, not zero observations.
4. **Automatic quiet dispatch:** complete a normal main-thread turn without manually invoking `codex-obs`. Verify that the trusted context hook ran, exactly one observation pass occurred before final, and no observation prompt appeared in the chat. Manual success and installed source do not prove this step.
5. **One pass only:** verify that an observation worker run does not trigger another observation run.

Installed hook trust is a prerequisite for steps 4 and 5. Live Windows acceptance remains UNKNOWN until these checks are measured on the actual target; repository tests and configured source are regression evidence only.

Before an upgrade, compare source and managed target files in both directions and review operator edits. Retain the transaction backup and verify recovery in a disposable candidate.

An upgrade may run from another checkout or source pin than the installation it replaces, for example `<CODEX_HOME>/orchestra/source-pins/<commit>`. A block an installer before issue #503 wrote names that directory before the control-plane `deliver-hook.mts` and `attribution-hook.mts`, also as the shell dispatcher's argument, and possibly an earlier Node executable. The installer treats such a block as its own, also when the Codex app has split it around its trust tables, rewrites those commands once to the stable entry-point form and the Node it runs with, and updates the source record; Codex then asks for one review of the six definitions, and later upgrades leave them byte-identical. Exact external delivery groups outside the block keep sole ownership in the stable form and in the old form bound to the installing source; they are never rewritten. Such an old-form group names the installing source's own path, so it stops matching after the next change of checkout or source pin, and the managed block then renders its own delivery groups next to it; `kherep-node doctor` reports these commands under `codex.legacy`. Replace them with the stable form, or remove them, before that upgrade. Any other difference in the block is still refused. On a host, run `kherep-node service upgrade` as before, then this installer once from the new source. `kherep-node doctor` counts a hook that names a source pin of the checked-out commit as this checkout and lists it under `pinned`; a pin or checkout of another commit, one with tracked changes, a missing pin or a path that is not a hook of such a source still fails the hook check; since issue #445 a hook in a checkout whose source identity matches the pin the doctor runs from counts as well and is listed under `checkouts`. A pin's commit is its git `HEAD` where it has one, otherwise its directory name. A Codex command in the stable form counts only through this home's entry point and the deliver hook its source record names; the record's state is reported as `codex.pointer` (`valid`, `missing`, `invalid`, `unresolved`), with `codex.stable` and `codex.legacy` (commands still in the path form, until the next install rewrites them). A stable command with an unusable record fails the hook check.

For source changes, run `npm run typecheck` and `npm run test:codex`. Keep skips and unavailable integration checks separate from passing results.

### Guarded Control Plane reply admission

The daemon, wake/resume hooks, native Queue producer, busy hints and fork admission share the same predicate: absent Worker loop metadata retains the legacy depth-six ceiling; present metadata must validate exactly and match the stored authoritative depth. Valid new/new guarded paths can exceed six, subject to all existing owner, permission, task, attempt, generation, kill-switch and wake-budget checks. The Worker holds a session pair after three consecutive bounded ACK/exact-normalized-repeat strikes, or on attempted admission 257 across roots. This is a textual signal, not proof of semantic progress. Peer framing requests information-bearing replies and tells the owner to stop on a hold.

The Worker and all consuming node/hook/staged-client artifacts must ship together before advanced capability is advertised. A queued downgrade is refused, and remembered local guarded lineage is deny-only when an older Worker omits metadata. Release is operator-only via the existing Access API, with version checks; it starts no session, sends no message and resets no local turn budget. Derived keyed fingerprints and durable content-free hold retention are documented in the [Control Plane reference](../modules/control-plane/README.md#pair-loop-brake-and-operator-release). Source verification does not establish installed or live behavior.

Native MCP `reply` calls retain the same local downgrade denial as CLI/proxy sends: before intent publication, the trusted common hook records a bounded content-free deny-only marker from validated guarded inbox history. It is not a sent record or caller-controlled admission and authorizes no activity. Marker persistence/capacity/read failure fails closed; markers are not time-released or evicted. The explicit staged client graph includes the marker helper. Worker replay and queued push use the same complete stored-lineage validation as parent admission, and refuse partial or invalid proof without emitting loop context.
