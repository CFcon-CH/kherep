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
| Teamwork Graph | `node --test modules/twg/*.test.mts` |
| Control Plane node and protocol | `npm run test:control-plane` |
| Control Plane Worker | In `modules/control-plane/worker`: `npm ci`, `npm run typecheck`, `npm test`, `npm run check:bundle` |

Windows CI runs the bootstrap suites in parallel shards defined in `bootstrap/ci-shard.mts`. A new install test that runs for minutes on Windows gets its own named shard there and in the `unit-windows` suite list of `.github/workflows/ci.yml`; `bootstrap/ci-shard.test.mts` fails until both agree. Locally, `npm run test:bootstrap` stays the command. The same matrix also runs `npm run test:codex` as the `codex` shard, outside the bootstrap shard map, so the required check `unit (windows-latest)` covers the Codex suites as well.

The Ubuntu `unit` job fetches full history to audit every available legacy whole-file project template, including the public v0.1.0 release. Shallow checkouts and source exports explicitly skip that history audit; deterministic template and archive-ref regressions still run everywhere. For the same audit locally, use a full clone (or run `git fetch --unshallow --tags` in a shallow clone), then `node --test bootstrap/project-rules-block.test.mts`. Templates from v0.1.1 onward were installed inside managed blocks and do not belong in the legacy whole-file allowlist.

On Windows, select Git for Windows Bash in the test process's `PATH` before WSL Bash. Do not change global shell configuration for a test run.

Keep production configuration out of tests. Tests that need an unavailable platform capability can skip; report skips separately from passing checks.

## SonarQube Cloud coverage

CI produces real LCOV from the existing current-LTS Ubuntu test steps. The
`unit`, `typescript` and `client-binding-probe` jobs collect step-local Node V8
coverage; the Worker tests use Istanbul in workerd. Tests keep their original
exit status. The `coverage-report` job requires all four contributing jobs to
succeed, validates their non-empty artifacts, and converts the Node union once
with c8 `--all`. Unexecuted maintained Node source therefore contributes zero.
Worker `src/` belongs to Istanbul; Worker configuration and shared protocol code
remain in the Node population. The existing Sonar source/test classifications
are unchanged.

Each producer manifest contains only its producer, run ID, attempt, checkout SHA
and test outcome. Assembly and the reusable scanner verify all four against the
same event checkout, run and attempt. On pull requests that is the default merge
checkout, not the PR head SHA. Raw and final artifacts expire after two days.
These same-run artifacts transport reports; they do not make PR code trusted.
A missing, malformed or mismatched report fails `coverage-report` visibly; a
partial report is never accepted for scanning. The scanner receives only the
named Sonar secret after report validation. Fork PRs run coverage validation and
skip the secret-bearing scan with a summary.

`SonarCloud Code Analysis` is a **required merge check** on `main`. A fork PR gets
no scan, so it cannot satisfy this check; a maintainer has to move such a change
to a same-repository branch. The existing 80% coverage threshold on new code
stays unchanged; no exclusions, synthetic hits or ignored-line
comments are added to reach it. Linux coverage does not prove native Windows or
macOS behavior. Their existing compatibility checks and engine-floor jobs remain
in place. The matrix dependencies wait for their sibling jobs. Child processes
that clear the coverage variable, die before flushing, or execute temporary
installed copies may remain uncovered. Environment sanitization is preserved.
Raw coverage is about 1.3 GB for `unit` and 599 MB for `typescript` on the runner;
the compressed artifacts measured 168 MB and 78 MB in the #790 run.

Tests that execute unchanged copies can call `declareCopy(original, copy)` from
`bootstrap/coverage-copy-fixture.mts`. It checks identical bytes. When
`NODE_V8_COVERAGE` is already set, it appends a `coverage-copies.jsonl` sidecar in
that directory, carried by the existing raw artifact upload. It never enables
coverage or changes a child environment. Without the variable it only checks
the bytes. A test that edits its copy after declaring it must not declare it;
this simple mechanism does not track later mutations or file identity.
Assembly maps only an exact declared script URL to its repository original,
after checking the original's SHA-256 against the declaration. Invalid hashes,
paths, conflicting mappings and declarations with no matching script in that
producer's reports fail assembly. Undeclared external scripts remain ignored;
synthetic dependencies receive no attribution. V8 ranges and counts are retained
for the single c8 union conversion. Initially only `shell-checks.test.mts` adopts
the helper.

After conversion, the pinned TypeScript parser removes an entire LCOV record
only when every statement is an erased type-only import, interface or type alias.
Mixed files, value imports, runtime constants, unknown syntax and parse failures
keep their records unchanged. `coverage/summary.json` lists the dropped paths.
These sources remain analysed, with no new Sonar exclusion. Whether Sonar stops
counting `contracts.mts` after omission is UNKNOWN until a real pull request.

For a local typed-source and child-process diagnostic after `npm ci`, run:

```sh
node --test bootstrap/coverage-report.test.mts bootstrap/coverage-copies.test.mts bootstrap/coverage-erased-types.test.mts
```

The c8 integration and TypeScript parser fixtures explicitly skip when dependencies are unavailable
in a dependency-free compatibility job. CI runs these fixtures after `npm ci` in
`typescript`. Pure validation fixtures always run. To assemble local real
reports, collect `NODE_V8_COVERAGE` into each producer's `raw/` directory, create
its manifest with `npm run coverage:report -- manifest`, and provide the four
producer directories (Worker contains `lcov.info`) to:

```sh
npm run coverage:report -- assemble --artifacts /tmp/coverage-inputs \
  --run-id 1 --attempt 1 --checkout-sha "$(git rev-parse HEAD)"
npm run coverage:report -- verify --run-id 1 --attempt 1 \
  --checkout-sha "$(git rev-parse HEAD)"
```

Use a single real checkout identity throughout. `--source-root` explicitly names
the trusted collection checkout root when relocation is needed; only contained
repository file URLs and byte-verified copy declarations are relocated. Other
temporary installation paths are not mapped back. Outputs are
`coverage/node/lcov.info` and `coverage/worker/lcov.info`, with
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
| `local-inference`, `mcp-auth-bridge`, `twg` | The module of the same name |

Add `flaky-test` to an intermittent or load-dependent test failure, and `documentation` to a change that touches only documentation. When you work on an existing issue without a module label, add one.

Changes reach `main` only through a pull request, which is merged by rebase.

The `commit-policy` CI check re-runs the `commit-msg` hook on every commit of a pull request with this repository's policy: no work-item key is required, and co-author trailers and AI attribution are allowed. A commit made with `git commit --no-verify` that breaks the policy fails the check; reword it and push again.

The repository deletes a pull request's branch when the pull request is merged. A pull request closed without merging keeps its branch, for example one replaced by a new pull request after a rebase. Close such a pull request with `gh pr close <number> --delete-branch`, or delete its branch right after closing it. Its commits stay reachable from the closed pull request.

Keep organization-specific policy, personal configuration and credentials outside the reusable product. The work-item and commit conventions of a workspace where Kherep is installed apply to that workspace's repositories, not to contributions to Kherep.

Preserve upstream license notices and attribution when changing bundled third-party material.
