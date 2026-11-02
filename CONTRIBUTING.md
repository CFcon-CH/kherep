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

## Submitting changes

Keep changes focused and preserve unrelated work. Include the problem, resulting behavior and relevant verification. Update architecture and installation reference alongside changes to interfaces, authentication or wiring.

Track changes to Kherep in the repository's GitHub Issues. Open or reference an issue before a non-trivial change and close it from the pull request with `Closes #<number>`. Typo and documentation fixes can go straight to a pull request. Commits and branch names in this repository carry no external tracker keys.

Give every issue and every pull request at least one module label when you open it, so the work can be reported per module. Use several when a change spans modules:

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
| `local-inference`, `mcp-auth-bridge`, `twg` | The module of the same name |

Add `flaky-test` to an intermittent or load-dependent test failure, and `documentation` to a change that touches only documentation. When you work on an existing issue without a module label, add one.

Changes reach `main` only through a pull request, which is merged by rebase.

The `commit-policy` CI check re-runs the `commit-msg` hook on every commit of a pull request with this repository's policy: no work-item key is required, and co-author trailers and AI attribution are allowed. A commit made with `git commit --no-verify` that breaks the policy fails the check; reword it and push again.

The repository deletes a pull request's branch when the pull request is merged. A pull request closed without merging keeps its branch, for example one replaced by a new pull request after a rebase. Close such a pull request with `gh pr close <number> --delete-branch`, or delete its branch right after closing it. Its commits stay reachable from the closed pull request.

Keep organization-specific policy, personal configuration and credentials outside the reusable product. The work-item and commit conventions of a workspace where Kherep is installed apply to that workspace's repositories, not to contributions to Kherep.

Preserve upstream license notices and attribution when changing bundled third-party material.
