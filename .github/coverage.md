# Coverage collection and reruns

CI keeps one raw V8 union and converts it once with c8 `--all`. Worker `src/`
is covered by Istanbul in workerd and remains outside the Node population.
Native test commands, timeouts, sanitizers, maintained source inclusion/exclusion
configuration and required checks stay unchanged. Coverage is step-local; the
Windows Codex suite remains functional-only.

## Producers and identities

The 14 required coverage producers are Ubuntu `unit`, `unit-macos`, nine
`unit-windows-<suite>` members, `typescript`, `probe` and `worker`: thirteen V8
producers plus one Worker producer. Windows coverage derives from `SHARDS` in
`bootstrap/ci-shard.mts` plus `hooks` and `control-plane`. All ten functional
Windows members, including `codex`, remain in the matrix. Codex emits no coverage
manifest or artifact; its guard command, assertions and 60-minute timeout remain.
Its functional failure still blocks both the required Windows aggregate and
coverage-report through the complete unit-windows dependency. The 15 required
checks remain a separate unchanged set; c8 --all still includes maintained
Codex source. An unexpected Codex coverage artifact is rejected.

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
retained/ignored/untrimmed V8 counts and omitted wholly erased type-only files. Both final
LCOV families use unique repository-relative slash-separated `SF:` paths.

## Selected producer completeness and order

Each selected V8 producer must retain at least one script after relocation and
exclusion across all its raw reports. An empty individual child report is
allowed; an entirely empty or excluded-only producer fails with its label
before conversion or accepted-output creation. Worker uses LCOV and is exempt.
Retained zero-count scripts are valid; the existing aggregate hit check remains,
so this is not proof that every producer adds positive maintained-source hits.
An unused copy declaration remains no data when its producer has another
retained script. Selected artifacts and both provenance arrays use deterministic
code-unit producer order; numeric latest-attempt selection and refusals remain.

## Foreign roots and copied scripts

Producer URLs are interpreted independently of the assembler's operating system.
Only contained repository source and exact byte-verified copy declarations receive
attribution. Drive-letter case can differ; the rest of each path retains its case.
Authorities/UNC paths, fragments, backslashes, encoded separators and traversal
are rejected before parser normalization. Missing retained source and symlink
escapes fail. Queries remain forbidden in all attribution interfaces.

Two script-only discard policies recognize the entire ASCII numeric query:
`?isolated=[0-9]+` only for true outside-root scripts, and reserved
`?node-test-mock=[0-9]+` only for true in-root scripts. Raw canonical validation
precedes namespace comparison; ambiguous root case, mixed path dialects, empty
segments/filename and wrong-side membership refuse. Neither extension nor
node_modules exclusion proves membership. Exact full/base copy collisions
refuse before either discard. Each discarded script counts once and supplies
no credit, copy use or map; every other query form fails.

The reserved key is a policy spelling, not proof that Node generated the code.
Genuine code using it loses hits and observed branch structure. In a measured
paired c8 --all synthetic example, the SF universe and LF 15 stayed fixed while
LH 15 fell to 1, BRF 14 to 3 and BRH 4 to 2: branch coverage rose from 28.57% to 66.67%.
This deliberate metric discontinuity is not execution gain or a monotonically
conservative percentage. Compare source identities and LF/LH/BRF/BRH; a Sonar
combined percentage requires its own server measurement.

Node's type stripping keeps offsets and appends `\n\n//# sourceURL=<url>` to every
`.mts` module, so one source ends at a different offset at every path: per
producer root and per copy (#969). Without correction the merge treats these
top-level ranges as different functions, keeps the last one and lists its
branches once per path. Relocation reads the retained source as UTF-16 text and
trims every range end that reaches past it back to its length, but only when the
excess equals 16 plus the length of that script's own reported URL. A range that
starts past the source is dropped, with its function if it is the function's own
range. Any other excess leaves the script untouched; `summary.json` counts it
per producer as `untrimmed` and the assembly log prints the total. Copies stay
byte-verified, so the original's length is theirs. Measured on run 44292304991,
Ubuntu, macOS, Windows and typescript reports all matched this formula, including
sources with non-ASCII text.

Retained V8 ranges and counts are otherwise preserved. Cached map keys, map locations, nested
`sources` and `sourceRoot` are relocated using their original URL locations;
mappings, names, line lengths and `sourcesContent` are retained. Unsupported
maps for retained scripts fail. Every query-bearing cache key, location, sourceRoot,
source, declaration or manifest still fails, even a cache key matching a discarded
script. The observed CP zero-cache result is producer-specific, not a full-union
guarantee. No producer path or map URL is fetched.

Tests can declare unchanged copies with `declareCopy(original, copy)` from
`bootstrap/coverage-copy-fixture.mts`. The helper verifies bytes and writes a
sidecar only when coverage is already enabled. Exact copy URLs and original
SHA-256 values are checked during assembly. An unused declaration is logged as
no data, which permits a child killed before flushing; it does not invent hits.
The helper does not track changes made to a copy after declaration. Undeclared
external temporary test copies, including runtime-imports copies, receive no
coverage credit as before; this intentional loss is not a measured percentage gain.

The hook-runtime fixtures declare their runtime copies: `copyRuntime` in
`claude/hooks/hook-runtime-fixture.mts`, used by `runtimeHome`, the integrity
sandbox and the wired suite, declares every copied `.mts` source. A case that
alters its runtime copy after the copy, such as a replaced coordinator, uses
`runtimeHome(prefix, { declare: false })` or its own copy and stays undeclared.

Sonar's `sonar.coverage.exclusions` removes only
`modules/control-plane/worker/vitest.config.mts` and `**/*.ps1` from the
coverage population; no producer measures either (Vitest loads its config, and
Istanbul instruments only Worker `src/`). Maintained `.mts` sources stay in it.

The local `--source-root` flag is only a consistency assertion: every selected
manifest root must equal that canonical directory URL. It cannot override
individual foreign producer roots.

## Failed-only and scanner-only reruns

After a failed producer is rerun, successful earlier producer artifacts from the
same run/SHA can be reused. A new successful assembly emits
`sonar-coverage-<runId>-<assemblyAttempt>` and passes that name and attempt through
job outputs to the reusable scanner. Outputs are emitted only after validation
and upload succeed. If only functional Codex failed, its successful rerun may
reuse all fourteen earlier producer artifacts; no fake Codex report is created.
Historical fifteen-producer runs retain their old source contract and are not
reinterpreted as fourteen-producer successes.

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
| Native CI | Full Ubuntu/macOS and all ten Windows functional jobs; nine Windows coverage artifacts, fourteen producers total, platform outcomes |
| Hosted failed-only rerun | Same run/SHA, actual selected attempts (all fourteen earlier artifacts allowed after Codex-only rerun), final identity and successful scan |
| Coverage measurements | Comparable before/after metrics for `service-platform-windows.mts` and `service-platform-mac.mts`, with source SHA and metric definition |
| Runtime | Same three-main-run medians B; all 14 coverage-producing jobs A <= 1.6 * B; uninstrumented functional Codex cap unchanged; successful assembly A <= B + 120 seconds |

All 14 coverage-producing jobs use the approved prospective cap 1.6 * B,
without a B + 180 term: Ubuntu/macOS unit, nine Windows suites, TypeScript,
Ubuntu probe and Worker. For example, Ubuntu 854 * 1.6 = 1366.4 seconds and
macOS 1350 * 1.6 = 2160 seconds. The same three historical main runs give
TypeScript B = 1222, Ubuntu probe B = 22 and Worker B = 122 seconds.
Functional Codex has no coverage and keeps its 2085-second cap. Coverage-report
assembles and verifies reports without collecting its own coverage; its
164-second cap remains. Preserve immutable baselines and earlier overlays;
label a new-policy evaluation of an existing run with its versioned overlay
and keep the prior evaluation unchanged. No performance gain is implied;
new source still needs its own run. No timeout or Sonar-threshold change.

Measure job wall time including setup/collection/upload and assembly I/O; do not
average Windows shards or assign zero duration to reused jobs. Preserve artifact
IDs, sizes, hashes, actual attempts and checkout identity in the authorized issue
or PR evidence. Live rerun behavior, percentage gains and runtime bounds remain
unverified until those target measurements are collected. Required-check names,
permissions and the existing Sonar coverage threshold stay unchanged.
