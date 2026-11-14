# Coverage collection and reruns

CI keeps one raw V8 union and converts it once with c8 `--all`. Worker `src/`
is covered by Istanbul in workerd and remains outside the Node population.
No native test command, timeout, sanitizer, exclusion or required check is
changed to collect coverage. Coverage is enabled only on existing test steps.

## Producers and identities

The 15 required producers are Ubuntu `unit`, `unit-macos`, the ten
`unit-windows-<suite>` matrix members, `typescript`, `probe` and `worker`.
The Windows bootstrap members come from `SHARDS` in `bootstrap/ci-shard.mts`;
`hooks`, `control-plane` and `codex` are the existing additional matrix suites.
The coverage workflow contract fixture compares those populations.

Each raw artifact is named `coverage-<producer>-<runId>-<attempt>` and contains
`manifest.json` plus `raw/` for V8 or `lcov.info` for Worker. Its exact manifest
fields are `producer`, `runId`, `attempt`, `checkoutSha`, `testOutcome` and
`sourceRootUrl`. The root is the canonical directory file URL of the collection
checkout. A manifest or upload failure fails its producer job. Retention is two
days for raw and accepted reports.

Assembly downloads only this run's matching artifacts into separate directories.
It selects the numerically latest attempt for each producer, bounded by its own
attempt. Earlier producer attempts may be reused only with the same run and
checkout SHA. An invalid, failed, cancelled or skipped newest candidate fails
assembly; it never falls back to an older success. Unknown names, mismatched
manifests, missing producers, ambiguous identities, symlinks, unexpected content,
empty or oversized data and malformed reports fail visibly. Old unselected raw
payloads are not parsed. There is no alternate run, repository, token or cache.

The accepted final manifest is `{runId, attempt, checkoutSha, producers}`.
The outer attempt belongs to assembly; each inner attempt is its actual selected
producer attempt. `summary.json` records producer names, attempts, artifact names,
retained/ignored V8 counts and omitted wholly erased type-only files. Both final
LCOV families use unique repository-relative slash-separated `SF:` paths.

## Foreign roots and copied scripts

Producer URLs are interpreted independently of the assembler's operating system.
Only contained repository source and exact byte-verified copy declarations receive
attribution. Drive-letter case can differ; the rest of each path retains its case.
Authorities/UNC paths, queries, fragments, backslashes, encoded separators and
traversal are rejected. Missing contained source and symlink escapes fail.

V8 ranges and counts are preserved. Cached map keys, map locations, nested
`sources` and `sourceRoot` are relocated using their original URL locations;
mappings, names, line lengths and `sourcesContent` are retained. Unsupported
maps for retained scripts fail. No producer path or map URL is fetched.

Tests can declare unchanged copies with `declareCopy(original, copy)` from
`bootstrap/coverage-copy-fixture.mts`. The helper verifies bytes and writes a
sidecar only when coverage is already enabled. Exact copy URLs and original
SHA-256 values are checked during assembly. An unused declaration is logged as
no data, which permits a child killed before flushing; it does not invent hits.
The helper does not track changes made to a copy after declaration.

The local `--source-root` flag is only a consistency assertion: every selected
manifest root must equal that canonical directory URL. It cannot override
individual foreign producer roots.

## Failed-only and scanner-only reruns

After a failed producer is rerun, successful earlier producer artifacts from the
same run/SHA can be reused. A new successful assembly emits
`sonar-coverage-<runId>-<assemblyAttempt>` and passes that name and attempt through
job outputs to the reusable scanner. Outputs are emitted only after validation
and upload succeed.

A scanner-only rerun uses the preserved assembly outputs. Before the scan uses
the Sonar secret, it checks the exact artifact name, final manifest identity,
complete producer set, both LCOV families and
`1 <= assemblyAttempt <= scannerAttempt`. Fork PRs validate coverage and skip
the secret-bearing scan; the required Sonar check needs a same-repository branch.
Same-run provenance is consistency evidence, not authentication of PR code.

A missing/expired artifact requires a new complete run, under the operator's
normal publication/rerun authority. Never fetch another run or weaken validation.

## Verification and acceptance

Run focused fixtures after `npm ci --ignore-scripts`:

```sh
node --test bootstrap/coverage-report.test.mts bootstrap/coverage-artifacts.test.mts bootstrap/coverage-source-urls.test.mts bootstrap/coverage-copies.test.mts bootstrap/coverage-erased-types.test.mts
npm run typecheck
```

Dependency-free compatibility jobs explicitly skip c8/parser fixtures when the
dependencies are absent; the installed-dependency CI step runs them as well.
Local fixtures do not establish native compatibility or hosted rerun behavior.
The documented Windows verdict route in CONTRIBUTING remains mandatory where
that verdict is requested; never remove Codex markers to bypass its refusal.

| Evidence | Acceptance requirement |
| --- | --- |
| Focused fixtures | Complete-set and negative manifests; numeric attempt selection; foreign URLs/maps and exact copy hashes; real typed/child hits, zero lines and untaken branches; scanner-only rerun |
| Native CI | Full Ubuntu/macOS jobs and all ten Windows shards, with raw reports and platform outcomes |
| Hosted failed-only rerun | Same run/SHA, mixed selected producer attempts, final artifact identity and successful scan |
| Coverage measurements | Comparable before/after metrics for `service-platform-windows.mts` and `service-platform-mac.mts`, with source SHA and metric definition |
| Runtime | Per unit job median baseline B from three green main runs; candidate A <= min(1.15 * B, B + 180 seconds); assembly A <= B + 120 seconds |

Measure job wall time including setup/collection/upload and assembly I/O; do not
average Windows shards or assign zero duration to reused jobs. Preserve artifact
IDs, sizes, hashes, actual attempts and checkout identity in the authorized issue
or PR evidence. Live rerun behavior, percentage gains and runtime bounds remain
unverified until those target measurements are collected. Required-check names,
permissions and the existing Sonar coverage threshold stay unchanged.
