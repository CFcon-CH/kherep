# Codex Hook Noise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce routine Codex PostToolUse hook processes and make research-stop feedback identify the missing evidence while preserving every existing guard and watcher behavior in scope for issue #365.

**Architecture:** Replace the four separately projected post-edit watcher commands with one fixed dispatcher that normalizes the payload once and launches the same four public watcher files with argument arrays only when the wrapper is relevant or uncertain. Keep exact historical renderers for the four-command predecessor so the installer replaces only known owned fragments and leaves positional trust and custom hooks untouched. Research enforcement keeps its parser, thresholds, classifications, privacy text and one-continuation gate; only the fixed reason becomes evidence-specific.

**Tech Stack:** Node.js 24, erasable TypeScript `.mts`, `node:test`, GitHub Git Data API.

**Current authorized phase:** The Director authorized Codex-only source implementation, functional verification and merge after green acceptance. [Authority record at #365](https://github.com/CFcon-CH/kherep/issues/365#issuecomment-6095123268). Live installation and activation are excluded. Claude, shared watcher bytes, safety guards and permissions remain unchanged.

**Related delivery plan:** [Codex Delivery Feedback Noise Plan](2026-10-09-codex-delivery-feedback-noise.md) specifies concise Codex Stop feedback and preserved peer-message retrieval. Its [existing-owner addendum](2026-10-10-codex-quiet-owner-cutover.md) requires independently identifiable A/B source stages and separate target acceptance before activation.

---

### Task 1: Lock the dispatcher contract with failing tests (completed)

**Files:**
- Create: `codex/hooks/post-edit-checks-routing.contract.test.mts`
- Create: `codex/hooks/post-edit-checks-process.contract.test.mts`
- Create: `codex/hooks/post-edit-checks-output.contract.test.mts`
- Create: `codex/lib/post-edit-dispatcher-config.contract.test.mts`
- Create: `codex/hooks/research-stop-specificity.contract.test.mts`
- Create: `codex/hooks/research-thresholds.contract.test.mts`
- Test: `codex/hooks/hook-adapter.test.mts`
- Test: `codex/hooks/research-transcript.test.mts`

- [x] **Step 1: Add existing-API RED assertions before implementation**

Use `renderHooks`, `render`, `prepareManagedConfig` and `decision` to show concrete current behavior: the edit group has four entries instead of one, no exact four-watcher predecessor renderer exists, and research-stop gives the same generic reason when only Brain or only graph evidence is missing. These failures establish missing behavior without depending on a missing module import.

- [x] **Step 2: Add dispatcher routing fixtures as executable test design**

Cover direct `Edit`/`Write`/`MultiEdit`/`apply_patch`, one-target and three-target patches, paths containing shell metacharacters, a supported read-only `functions.exec` wrapper, a pure direct `functions.exec` call to `tools.apply_patch` with three targets, mixed wrappers and unknown/dynamic wrappers. The baseline `patchPaths` recognizes Add/Update/Delete headers and does not emit `Move to` destinations; fixtures must preserve every recognized source path and must not claim destination coverage already exists. Assert dispatcher child-count projections: routine read `4 -> 0`, one edit `4 -> 4`, three recognized targets `4 -> 12`, and unknown wrapper `4 -> 4`. Baseline normalization contracts independently prove that Write/MultiEdit paths, all three recognized patch sources, and every recognized source in a mixed or unknown wrapper remain present. A `Move to` line remains inside `new_string`, but is not asserted as a normalized target because current `patchPaths` does not emit it.

- [x] **Step 3: Add output and failure fixtures before implementation**

Materialize the future dispatcher, its imports, the four byte-identical shared watcher sources and their public dependency in a synthetic flat installation directory. Use those real watchers for simultaneous manifest/LOC/simplify plaintext and Umlaut JSON findings. Use fixed synthetic children only for process tracing and a non-zero failure. Assert one valid PostToolUse JSON document for simultaneous findings, empty stdout for success/no-op, retained `systemMessage`, and a visible non-zero child failure.

- [x] **Step 4: Run the focused tests and record RED**

Run:

```sh
node --test codex/hooks/post-edit-checks-routing.contract.test.mts codex/hooks/post-edit-checks-process.contract.test.mts codex/hooks/post-edit-checks-output.contract.test.mts codex/lib/post-edit-dispatcher-config.contract.test.mts codex/hooks/research-stop-specificity.contract.test.mts codex/hooks/research-thresholds.contract.test.mts codex/hooks/hook-adapter.test.mts codex/hooks/research-transcript.test.mts
```

Expected in the current Plan/Tests-only phase: the baseline normalization and research-threshold contracts pass, while future renderer, dispatcher process/output, migration and evidence-specific reason assertions fail for independent missing behaviors. The process fixture copies the future dispatcher plus its dependencies into a metacharacter-containing temporary hook directory and uses four fixed no-shell watcher stubs to trace child inputs. Missing-module fixtures remain supplementary test design rather than the sole RED signal.

**Authorization gate for Tasks 2 through 7:** Source implementation, verification and green merge are authorized. This authorization does not permit a live installer run or advancing a checkout referenced by running hooks to stage B.

### Task 2: Implement the fixed post-edit dispatcher

**Files:**
- Create: `codex/hooks/post-edit-checks.mts`
- Test: `codex/hooks/post-edit-checks-routing.contract.test.mts`
- Test: `codex/hooks/post-edit-checks-process.contract.test.mts`
- Test: `codex/hooks/post-edit-checks-output.contract.test.mts`
- Test: `codex/hooks/hook-adapter.test.mts`

- [x] **Step 1: Reuse the existing exported post normalization seam**

Call the already-exported `normalizePayloads(payload, "post")` unchanged so apply-patch Add/Update/Delete path extraction and multi-target behavior stay identical. No hook-adapter source edit is required. Do not change `pre`, `pre-privacy`, `pre-no-transcript`, `shellCommandsFromExec` or deploy approval normalization.

- [x] **Step 2: Implement bounded wrapper classification**

Keep the existing research lexer unchanged. A dispatcher-only completeness validator accepts a fully consumed sequence of direct, optionally awaited `tools.Name(literal)` statements with literal arguments; only then apply the existing lexer and explicit supported read-only set. Expressions, nested mutable calls, dynamic names, comments, uncertain escapes and unsupported wrapper structure fall back. Route recognized direct edit/patch calls through existing post normalization. Any unknown, dynamic, malformed or mixed wrapper conservatively receives every payload returned by the existing `normalizePayloads(payload, "post")` fallback. If it already recognizes multiple patch paths, all of those paths remain covered; only a wrapper with no recognized patch path falls back to the single Bash-shaped payload. Do not add wildcard MCP exemptions, `fetch*` exemptions or shell-prefix heuristics.

- [x] **Step 3: Run the four public watcher files with argv arrays**

Resolve exactly `manifest-watch.mts`, `loc-watch.mts`, `umlaut-translit-watch.mts` and `simplify-nudge.mts` beside the installed dispatcher. Spawn `process.execPath` with `--disable-warning=ExperimentalWarning`; pass each normalized payload on stdin and never interpolate a shell command.

- [x] **Step 4: Aggregate output once**

Treat plaintext as additional context. Parse only valid watcher JSON, retain its additional context and system message, and emit exactly one valid PostToolUse hook JSON when any finding exists. Emit nothing on success/no-op. Forward child stderr and exit non-zero when a child fails so failure cannot look green.

- [x] **Step 5: Run the focused tests and record GREEN**

Run the Task 1 command. Expected: all dispatcher and existing adapter cases pass with the measured child counts and output contract.

### Task 3: Project one command and preserve the exact predecessor

**Files:**
- Modify: `codex/lib/parity-config.mts`
- Test: `codex/lib/post-edit-dispatcher-config.contract.test.mts`
- Modify: `codex/lib/parity-config.test.mts`
- Modify: `codex/lib/retired-central-brain.mts`

- [x] **Step 1: Add failing projection and trust-position tests**

Assert the current PostToolUse edit group has one dispatcher entry for matcher `Edit|Write|MultiEdit|apply_patch|functions\\.exec`; POSIX and Windows rendering remain valid; attribution stays at PostToolUse group 1 entry 0 when enabled; custom groups and other events retain their positions. Pin the complete canonical POSIX and Windows predecessor renderings to immutable SHA-256 values generated from exact base `e29eaea0a57fb40757f1a4feeda53db9e3292544`. Use deterministic pin options whose empty `hookDir` makes every `path.join("", script)` byte-identical on POSIX and Windows hosts while explicit Node, context and control-plane paths retain the two command forms. Independently verify the recorded hashes. Also build the exact predecessor fixture with the existing `command` and `hookGroup` helpers, assert its old four watcher entries at group 0 entries 0 through 3, and keep the current-renderer group substitution only as an additional positional comparison.

- [x] **Step 2: Add failing migration tests**

Feed exact POSIX and Windows four-watcher predecessor variants into `prepareManagedConfig`; assert replacement, idempotence, preserved `hooks.state` keys using real `<file>:<event>:<group>:<entry>` forms both inside and outside the owned split, unchanged custom groups and rejection of one-line unknown drift. Assert no approval or trusted hash is synthesized for the dispatcher and no old approval is copied to its new command.

- [x] **Step 3: Implement the current renderer and frozen predecessor**

Render one command for `codex-post-edit-checks.mts` in the current edit group. Add a dedicated predecessor renderer that reconstructs the immediately previous four-watcher bytes before applying later historical removals. Do not redefine `codex/lib/historical-managed-artifacts.mts` hashes and do not derive old renderers from the new current shape in a way that changes their bytes.

- [x] **Step 4: Add the predecessor to managed fragment families**

Include the exact four-watcher variants in current and retired-Central-Brain recognition only where required. Preserve exact-fragment rejection semantics for unknown drift.

- [x] **Step 5: Run focused renderer/migration tests**

Run:

```sh
node --test codex/lib/parity-config.test.mts codex/lib/post-edit-dispatcher-config.contract.test.mts codex/lib/config-preservation.test.mts codex/lib/managed-block-split.test.mts codex/lib/retired-central-brain.test.mts codex/lib/attribution-hook-config.test.mts
```

Expected: all pass; the four-watcher predecessor remains byte-exact and current trust positions match the required keys.

### Task 4: Make research-stop feedback evidence-specific

**Files:**
- Modify later: `codex/hooks/research-stop.mts`
- Modify later: `codex/hooks/research-stop.test.mts`
- Test now: `codex/hooks/research-stop-specificity.contract.test.mts`
- Test now: `codex/hooks/research-thresholds.contract.test.mts`
- Test unchanged: `codex/hooks/research-transcript.test.mts`

- [x] **Step 1: Add the failing reason matrix**

Add missing-Brain, missing-graph, missing-both and complete cases. Keep the existing negative fake-call fixture. Assert `stop_hook_active: true`, missing and wrong types produce no extra block while exactly `false` can block. Assert a nonempty opt-out marker remains required. Lock the existing substantial-work thresholds with executable green contracts at 399/400 characters and two/three read-only calls. Keep unsupported and observation calls substantial.

- [x] **Step 2: Pass missing evidence into the fixed reason**

Build concise fixed text for Brain-only, graph-only or both missing. Keep the privacy sentence. Do not change the 400-character/three-call substantial thresholds, ReadOnly/observation classification, structured-call lexer, code-change detection or one-continuation condition.

- [x] **Step 3: Run the research tests**

Run:

```sh
node --test codex/hooks/research-stop-specificity.contract.test.mts codex/hooks/research-thresholds.contract.test.mts codex/hooks/research-stop.test.mts codex/hooks/research-transcript.test.mts codex/hooks/research-first.test.mts
```

Expected after later implementation: all pass. The new threshold contract locks 399/400 characters, two/three read-only calls, unsupported calls and observation calls. The unchanged parser suite supplies executable negatives for fake user text, tool output, comments, strings and regular expressions, plus later-turn isolation.

### Task 5: Install the dispatcher and test upgrade preservation

**Files:**
- Modify: `codex/install.mts`
- Modify: `codex/install.test.mts`
- Test: `codex/lib/post-edit-dispatcher-config.contract.test.mts`

- [x] **Step 1: Add failing installer copy tests**

Extend `codex/install.test.mts` to assert an isolated install copies `post-edit-checks.mts`, its dispatcher-only completeness helper, `hook-adapter.mts`, `research-exec-parser.mts` and the four watcher dependencies, writes one current dispatcher command, upgrades the exact four-watcher block and settles byte-identically on reinstall. Map the new Codex helper to its correct source for the existing integrity check. Reuse `codex/lib/post-edit-dispatcher-config.contract.test.mts` for the renderer/migration contract.

- [x] **Step 2: Add the dispatcher source and target**

Copy the dispatcher into `hooks/kherep-maestro/codex-post-edit-checks.mts`. Preserve the four public watcher source bytes. Add only dependencies imported by the dispatcher. Do not retire or rewrite the watcher target files.

- [x] **Step 3: Verify unknown/custom/trust preservation**

Run the installer migration fixtures with custom hook groups, unrelated trust approvals and an unknown mismatched managed fragment. Expected: custom and unrelated trust text remains, the new dispatcher hash is left for normal trust review, and unknown drift refuses replacement.

### Task 6: Update public architecture documentation

**Files:**
- Modify: `codex/ARCHITECTURE.md`
- Modify: `docs/CODEX.md`
- Modify: `README.md` only if its architecture diagram needs a changed edge in the later authorized implementation

- [x] **Step 1: Document configured behavior**

Describe one projected PostToolUse dispatcher, its exact four watcher children, supported read-only wrapper silence, conservative fallback and single JSON aggregation. State that installed source and repository tests do not prove Codex Desktop execution or latency.

- [x] **Step 2: Document migration and trust**

Name the one new dispatcher trust key at PostToolUse group 0 entry 0, removal of old group 0 entries 1 through 3, stable attribution at group 1 entry 0 and preservation of custom groups/other events. Keep live Desktop review UNKNOWN until measured separately.

### Task 7: Run acceptance gates and inspect the exact remote diff

**Files:**
- Verify: all files changed above
- Verify unchanged: `claude/hooks/manifest-watch.mts`, `claude/hooks/loc-watch.mts`, `claude/hooks/umlaut-translit-watch.mts`, `claude/hooks/simplify-nudge.mts`
- Verify unchanged: `codex/lib/historical-managed-artifacts.mts`

- [x] **Step 1: Run focused functional tests**

Run all Task 2 through Task 5 commands. Expected: zero failures; report platform skips separately.

- [ ] **Step 2: Run repository gates**

Run:

```sh
npm run typecheck
npm run test:bootstrap
npm run test:codex
```

Expected: zero failures. Windows-only skips remain reported separately and are not counted as passes.

- [x] **Step 3: Re-run key deny suites**

Run the relevant privacy, commit, deploy, dispatch and acceptance test files from `claude/hooks` and `codex/hooks`. Expected: existing deny behavior remains green.

- [ ] **Step 4: Inspect remote identity and scope**

Compare the final remote branch SHA to its expected parent with the GitHub API, inspect every changed file and verify the four watcher blob SHAs plus historical artifact file SHA equal the base commit. Merge only after independent source acceptance and green checks on that exact head. Do not install, deploy or change live configuration. Record Desktop envelopes, model follow-through and latency as UNKNOWN pending the separately authorized target probe.

## Source verification, 2026-10-10

The completed source steps above were independently reviewed and functionally checked. The full Codex suite passed with 420 passes, zero failures and four skips; typecheck passed. A separate run of the privacy, commit, deploy, dispatch and acceptance suites passed all 31 tests with no skips. Installed-dispatcher execution and integrity restoration passed in isolated synthetic targets. The four shared watchers, historical artifact pins, adapter source and all Claude source remain unchanged.

The local Windows bootstrap gate is FAIL: 464 passes, three failures and ten skips. Its two failing leaf cases and parent failure match the previously measured symlink privilege limitation. The full local Control Plane gate is FAIL: 853 passes, one failure and 38 skips; that symlink failure was independently reproduced against unchanged accepted base `1d870f777afef757456025c853d7d6fa0008c9ce`. These failures are recorded as failures, not passes or skips. No test, safety policy or host permission was changed to bypass them.

The repository-gate and remote-identity checkboxes remain open in this source snapshot. Complete hosted bootstrap, unit, engine-floor, security, typecheck and smoke checks on the exact PR head are required before merge. Record their actual result and accepted source identity at the PR. Source acceptance does not establish live hook activation or same-original-owner A/B context, model intake or Desktop UI behavior; those target facts remain UNKNOWN under the separate activation scope.
