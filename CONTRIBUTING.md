# Contributing

Use Node.js 24 (at least 22.18 on the 22 line, or 23.6), npm and a Git checkout. Source development and portable tests do not require access to an Atlassian site.

## Source setup

```sh
npm ci
npm run typecheck
npm run test:bootstrap
```

Read [AGENTS.md](AGENTS.md) and the instructions in the component you change. New executable Kherep source uses `.mts`, ESM and erasable TypeScript syntax.

## Component checks

| Change | Checks |
| --- | --- |
| Bootstrap and profiles | `npm run typecheck`, `npm run test:bootstrap` |
| Codex adapters | `npm run test:codex` |
| Shared modules | `npm run test:modules` |
| Jira and Confluence brokers | `npm run test:brokers` |
| Control Plane node and protocol | `npm run test:control-plane` |
| Control Plane Worker | In `modules/control-plane/worker`: `npm ci`, `npm run typecheck`, `npm test`, `npm run check:bundle` |

Windows CI runs the bootstrap suites in parallel shards defined in `bootstrap/ci-shard.mts`. A new install test that runs for minutes on Windows gets its own named shard there and in the `unit-windows` suite list of `.github/workflows/ci.yml`; `bootstrap/ci-shard.test.mts` fails until both agree. Locally, `npm run test:bootstrap` stays the command. The same matrix also runs `npm run test:codex` as the `codex` shard, outside the bootstrap shard map, so the required check `unit (windows-latest)` covers the Codex suites as well.

**Windows verdict route.** A local Windows test count is a verdict only when it comes from `npm run test:route -- --base <ref>` (`bootstrap/test-route.mts`, default suites `control-plane,bootstrap` plus the type check). Exit 0 means the route proved this: the base and the candidate define the named suites identically (`test:<name>` scripts byte-equal, patterns selecting files in both trees), both runs finished with complete, self-consistent TAP, every test that passed on the base passed on the candidate, no test failed only on the candidate, the known failures stayed within 1 % of the base's tests, and the candidate was a clean committed checkout, different from the base and descended from it, unchanged across the run. Exit 1 means at least one test failed only on the candidate. Exit 2 means no verdict: a refusal (a Codex marker in the environment, Git for Windows not in a standard location, no `node_modules` in the candidate, a dirty candidate, a base equal to the candidate or not an ancestor of it, a differing suite definition, a `tsconfig.json` that is not byte-identical in both commits while the type check runs, a temp directory (`TMP`/`TEMP`/`TMPDIR`) inside a protected tree), a failed base install, a run that did not finish, or base tests that are `missing` on the candidate (deleted, renamed, skipped or not reached). A pull request that deletes or renames tests gets exit 2 with the missing names in `receipt.json`; the reviewer compares them with the diff and records the decision. A pull request that changes a `test:*` script gets exit 2 with both script lines, and one that changes `tsconfig.json` gets exit 2 unless the type check is switched off. The route runs in the candidate checkout and writes `receipt.json` and the logs into a new directory under the temp folder, printed as `test-route: receipt <path>`. It puts Git for Windows first on the test process's PATH, runs the candidate and a temporary shared clone of `<ref>` one after the other (run nothing else heavy beside it), installs nothing in the candidate, and reports `fixed` and `gone` base failures without changing the exit code. The type check compares error identities (file, code, message), not a single pass/fail. The route refuses to run when a Codex marker is set (`CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED` or `CODEX_THREAD_ID`); it cannot itself prove that it is outside a sandbox. The 1 % ceiling is calibrated on two pairs of numbers only (the route's 12 known failures of 2862 tests and 0 of 828, against the sandbox runs' 80 of about 2900 and 35 of about 830), and a sandbox with under 1 % failures and without a marker would pass, so the route is no proof against every sandbox.

Exit 0 does not rule out these named limits:

- A test gutted under the same name still counts as a pass.
- `// @ts-nocheck` in a file and a remapping through `imports` in `package.json` hide a regression from the comparison.
- A stale `node_modules` in the candidate tests the old dependencies; the route installs nothing there.
- A change undone before the run ends leaves the candidate's identity unchanged, so it goes unnoticed.
- A base test that fails for environmental reasons makes a real candidate failure of that name known.
- The ceiling allows one known failure in a suite of up to 100 tests.
- "Every test that passed" means by name: names are compared as a multiset, not by file or body.

The Ubuntu `unit` job fetches full history to audit every available legacy whole-file project template, including the public v0.1.0 release. Shallow checkouts and source exports explicitly skip that history audit; deterministic template and archive-ref regressions still run everywhere. For the same audit locally, use a full clone (or run `git fetch --unshallow --tags` in a shallow clone), then `node --test bootstrap/project-rules-block.test.mts`. Templates from v0.1.1 onward were installed inside managed blocks and do not belong in the legacy whole-file allowlist.

On Windows, select Git for Windows Bash in the test process's `PATH` before WSL Bash. Do not change global shell configuration for a test run.

Keep production configuration out of tests. Tests that need an unavailable platform capability can skip; report skips separately from passing checks.

## SonarQube Cloud coverage

CI collects raw Node V8 coverage in the existing Ubuntu and macOS unit tests,
nine Windows suites (all except Codex), TypeScript suites and Ubuntu binding probe. Worker
`src/` uses Istanbul in workerd. The `coverage-report` job requires all
contributing functional jobs, including Windows Codex, to succeed, validates the
complete 14-producer coverage set and converts
one V8 union with c8 `--all`. Unexecuted maintained Node source contributes zero.
Worker configuration and shared protocol code remain in the Node population.
Existing source/test classification, exclusions and the 80% new-code threshold
are unchanged.

Raw artifacts carry exact producer/run/attempt/SHA/outcome identities and a
canonical checkout directory file URL. Assembly selects each producer's latest
attempt from the same run/SHA, up to the assembly attempt, and rejects a bad
newest candidate without falling back. It preserves actual producer attempts in
the final manifest. Successful assembly passes its accepted artifact name and
attempt to Sonar, allowing failed-only producer reruns and scanner-only reruns.
Both reports and identity are validated before the secret-bearing scan. Fork
PRs skip that scan and therefore cannot satisfy the required
`SonarCloud Code Analysis` check without a same-repository branch.

Foreign Windows/macOS/Linux script URLs and nested cached source maps are
relocated to contained repository source. Exact declared copy URLs retain
SHA-256 verification; unused declarations are logged as no data. Retained V8 ranges and
counts remain intact. The pinned TypeScript parser omits a whole LCOV record
only when every statement is an erased type-only import, interface or type alias;
mixed/runtime/unknown files keep their records. The summary lists omitted paths.
No new Sonar exclusion is added. All ten Windows functional members and all
15 required checks remain; Codex alone loses coverage env/manifest/upload, while
its guard, assertions, 60-minute timeout and maintained c8 --all source stay.

Two exact script discard policies allow numeric isolated queries only outside
the canonical producer root and reserved numeric node-test-mock queries only
inside. Structural/raw URL validation and full/base copy collision refusal run
before discard. All other queries, ambiguous/cross-dialect paths and every
query-bearing cache/map/declaration/manifest input still fail. The reserved key
is not proof of Node-generated code: genuine code using it loses coverage.
A measured paired c8 --all example retained LF 15/the SF universe but changed
LH 15 to 1, BRF 14 to 3 and BRH 4 to 2, raising branch coverage 28.57% to 66.67%. This
metric-policy discontinuity is not real execution gain or a conservative
percentage guarantee. Undeclared external temp-copy code remains uncredited.

All 14 coverage-producing jobs have prospective runtime cap 1.6 * their
same-three-main-run median B: Ubuntu/macOS unit, nine Windows suites,
TypeScript, Ubuntu probe and Worker. Functional Codex remains uninstrumented
with cap 2085 seconds. Coverage-report consumes reports without collecting its
own coverage, so its assembly cap remains 164 seconds. Preserve historical
baselines and evaluations; label a new-policy evaluation of an existing run
with its versioned overlay. No performance gain is implied. New source still
needs its own run. See the CI contract for provenance and metric limits.

See [the CI coverage contract](.github/coverage.md) for producer identities,
validation, reruns, copy-helper limits and required native/runtime evidence.
These local focused checks need installed dependencies:

```sh
node --test bootstrap/coverage-report.test.mts bootstrap/coverage-artifacts.test.mts bootstrap/coverage-source-urls.test.mts bootstrap/coverage-copies.test.mts bootstrap/coverage-erased-types.test.mts
npm run typecheck
```

Dependency-free jobs explicitly skip c8/parser fixtures when dependencies are
unavailable; CI also runs them after `npm ci`. Local fixture success does not
prove native Windows/macOS behavior, hosted rerun support or a percentage gain.
Coverage variables remain step-local, and existing test-environment sanitizers
are preserved. Raw and final artifacts expire after two days.

For local assembly, put each manifest and payload under its exact
`coverage-<producer>-<runId>-<attempt>` artifact directory. Collect into `raw/`
and use `npm run coverage:report -- manifest` for Node producers; Worker carries
`lcov.info`. Use a complete real producer set and one checkout identity:

```sh
npm run coverage:report -- assemble --artifacts /tmp/coverage-inputs \
  --run-id 1 --attempt 1 --checkout-sha "$(git rev-parse HEAD)"
npm run coverage:report -- verify --run-id 1 --attempt 1 \
  --checkout-sha "$(git rev-parse HEAD)"
```

`--source-root` optionally asserts that every selected producer root equals
that canonical collection directory; it does not override foreign producer roots.
Outputs are `coverage/node/lcov.info` and `coverage/worker/lcov.info`, with
unique repository-relative `SF:` paths. Generated coverage stays out of Git.

## Submitting changes

Keep changes focused and preserve unrelated work. Include the problem, resulting behavior and relevant verification. Update architecture and installation reference alongside changes to interfaces, authentication or wiring.

Track changes to Kherep in the repository's GitHub Issues. Open or reference an issue before a non-trivial change and close it from the pull request with `Closes #<number>`. Typo and documentation fixes can go straight to a pull request. Commits and branch names in this repository carry no external tracker keys.

Give every issue and every pull request at least one module label when you open it, so the work can be reported per module. Use several when a change spans modules. `module-label-guard` and the GitHub broker check this at creation; `.github/module-labels.json` is the list they read and must name the same labels as this table:

| Label | Area |
| --- | --- |
| `cp:intercom` | Control Plane node: messaging, inbox, delivery, wake, sessions |
| `cp:codex-sessions` | Control Plane node: Codex app and session integration (`codex-*`) |
| `cp:service` | Control Plane node: service install, upgrade and rollback, launcher, daemon lifecycle |
| `cp:doctor` | Control Plane node: `kherep-node doctor` checks |
| `cp:tasks` | Control Plane node: daemon-started tasks |
| `cp:node-core` | Control Plane node: other node internals (config, policy, protocol, CLI) |
| `cp:worker` | Control Plane Cloudflare Worker |
| `cp:binding-probe` | Control Plane client binding probe |
| `claude:hooks` | Claude adapter hooks, hook runtime, guard dispatch, integrity |
| `claude:agents-skills` | Claude adapter agents, skills, commands, team routing |
| `codex:hooks` | Codex adapter hooks and shell dispatcher |
| `codex:install-parity` | Codex installer, parity projection, Codex lib and scripts |
| `bootstrap` | Installers, drift check, manifests, transactions |
| `atlassian-brokers` | Jira and Confluence brokers, the evidence verb, brain drainage |
| `github-broker` | GitHub issue broker |
| `local-inference`, `mcp-auth-bridge` | The module of the same name |

Add `flaky-test` to an intermittent or load-dependent test failure, and `documentation` to a change that touches only documentation. When you work on an existing issue without a module label, add one.

Changes reach `main` only through a pull request, which is merged by rebase.

The `commit-policy` CI check re-runs the `commit-msg` hook on every commit of a pull request with this repository's policy: no work-item key is required, and co-author trailers and AI attribution are allowed. A commit made with `git commit --no-verify` that breaks the policy fails the check; reword it and push again.

The `Stall watch` workflow (`.github/workflows/stall-watch.yml`, issue #744) runs every ten minutes from `main`. When a required check of an open pull request has stayed red for 20 minutes on the same head commit, it posts one comment on that pull request and assigns the pull request to its author if the author is a user and not yet assigned. Each new head commit gets at most one comment. The comment asks the owner to tell the operator what blocks the pull request, and says that any session may read the public job logs and post the root cause there. Push a fix, re-run the check or say what blocks. The workflow runs no pull request code. Its token has `contents: read`, `checks: read` and `pull-requests: write`. A manual run (`gh workflow run stall-watch.yml`) is a dry run unless `dry_run` is set to false. The repository variable `STALL_WATCH_TIMEZONE` sets the time zone of the comment (default `UTC`). A failed read or write fails the run instead of reporting nothing stalled.

The `CI rerun` workflow (`.github/workflows/ci-rerun.yml`, issue #973) re-runs the failed jobs of a CI run that lost a macOS job to GitHub runner capacity. It runs when a CI run completes, every ten minutes as a sweep over the CI runs of the last six hours, and on manual dispatch. Each path reads the run fresh and applies the same decision. A job is lost when it ran on `macos-latest`, was cancelled without a runner or a step, and its only failure annotation says the job was not acquired by a hosted runner. `coverage-report` counts as following from a lost job when it failed only in `Require successful contributing jobs` and every red job it needs was lost. The workflow requests `rerun-failed-jobs` only for a failed `push` or `pull_request` run from this repository, created in the last six hours, whose red jobs are all lost or follow from a lost job, and that no newer CI run of the same pull request or branch has superseded. Any other red job blocks the rerun. A not-acquired job on another runner, such as Windows, is reported but not rerun. At most seven automatic reruns run per CI run (attempt 8 is the cap), and a second or later attempt is rerun only ten minutes after it finished. At the cap the workflow writes a warning and stops. The workflow runs no pull request code. Its token has `actions: write`, `checks: read` and `contents: read`, and its only write is that one request. A manual run (`gh workflow run ci-rerun.yml`) is a dry run unless `dry_run` is set to false; `run_id` evaluates one run instead of the sweep. A failed read, a refused request or a rerun that does not start within 60 seconds fails the run. Expect the `Stall watch` comment on the pull request while a lost job waits for its rerun.

The repository deletes a pull request's branch when the pull request is merged. A pull request closed without merging keeps its branch, for example one replaced by a new pull request after a rebase. Close such a pull request with `gh pr close <number> --delete-branch`, or delete its branch right after closing it. Its commits stay reachable from the closed pull request.

Keep organization-specific policy, personal configuration and credentials outside the reusable product. The work-item and commit conventions of a workspace where Kherep is installed apply to that workspace's repositories, not to contributions to Kherep.

Preserve upstream license notices and attribution when changing bundled third-party material.
