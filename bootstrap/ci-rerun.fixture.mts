// Fixtures for the CI rerun tests (issue #973), generated from read-only GitHub API
// responses of CFcon-CH/kherep on 2026-11-19: GET actions/runs/{id}/attempts/{n},
// .../attempts/{n}/jobs, actions/jobs/{id}, check-runs/{id}/annotations and
// actions/workflows/ci.yml/runs?created=>=. Only the fields the helper reads are kept:
// steps only where a job is not neutral, annotations only as [level, message].
// NOW is the evaluation time of each attempt: ten seconds or so after it completed,
// except 44327898911-1, evaluated after the newer main push 44376576769 (19:04:31Z).

export const REPO = "CFcon-CH/kherep";

export interface Run {
  id: number; path: string; event: string; status: string; conclusion: string | null; run_attempt: number;
  created_at: string; updated_at: string; run_started_at: string; head_branch: string;
  head_repository: { full_name: string }; triggering_actor: { login: string };
}

const n = (id: number, name: string, conclusion: string) => ({ id, name, status: "completed", conclusion });
const j = (id: number, name: string, status: string, conclusion: string, runner_id: number | null, labels: string[], steps: string[][]) =>
  ({ id, name, status, conclusion, runner_id, labels, steps: steps.map(([stepName, stepConclusion]) => ({ name: stepName, conclusion: stepConclusion })) });
const a = (...list: string[][]) => list.map(([annotation_level, message]) => ({ annotation_level, message }));

export const RUNS: Record<string, Run> = {
  "44115918168-1": {"id":44115918168,"path":".github/workflows/ci.yml","event":"pull_request","status":"completed","conclusion":"failure","run_attempt":1,"created_at":"2026-11-17T15:34:38Z","updated_at":"2026-11-17T16:16:51Z","run_started_at":"2026-11-17T15:34:38Z","head_branch":"feat/broker-pr-merge-lean","head_repository":{"full_name":"CFcon-CH/kherep"},"triggering_actor":{"login":"cfcon-claude[bot]"}},
  "44397779907-1": {"id":44397779907,"path":".github/workflows/ci.yml","event":"pull_request","status":"completed","conclusion":"failure","run_attempt":1,"created_at":"2026-11-18T21:05:16Z","updated_at":"2026-11-18T22:04:30Z","run_started_at":"2026-11-18T21:05:16Z","head_branch":"test/bootstrap-coverage","head_repository":{"full_name":"CFcon-CH/kherep"},"triggering_actor":{"login":"cfcon-claude[bot]"}},
  "44337919183-1": {"id":44337919183,"path":".github/workflows/ci.yml","event":"pull_request","status":"completed","conclusion":"failure","run_attempt":1,"created_at":"2026-11-18T15:38:11Z","updated_at":"2026-11-18T16:44:16Z","run_started_at":"2026-11-18T15:38:11Z","head_branch":"feat/codex-start-latest","head_repository":{"full_name":"CFcon-CH/kherep"},"triggering_actor":{"login":"cfcon-codex[bot]"}},
  "44327898911-1": {"id":44327898911,"path":".github/workflows/ci.yml","event":"push","status":"completed","conclusion":"failure","run_attempt":1,"created_at":"2026-11-18T14:46:08Z","updated_at":"2026-11-18T15:54:56Z","run_started_at":"2026-11-18T14:46:08Z","head_branch":"main","head_repository":{"full_name":"CFcon-CH/kherep"},"triggering_actor":{"login":"cfcon-claude[bot]"}},
  "43909265750-1": {"id":43909265750,"path":".github/workflows/ci.yml","event":"pull_request","status":"completed","conclusion":"cancelled","run_attempt":1,"created_at":"2026-11-16T16:35:57Z","updated_at":"2026-11-16T16:44:30Z","run_started_at":"2026-11-16T16:35:57Z","head_branch":"feat/737-codex-model-selection","head_repository":{"full_name":"CFcon-CH/kherep"},"triggering_actor":{"login":"cfcon-claude[bot]"}},
};

export const JOBS: Record<string, unknown[]> = {
  "44115918168-1": [
    n(134153802750, "unit-engines-floor (24.1.0)", "success"),
    n(134153803217, "unit-engines-floor (22.18.0)", "success"),
    n(134153803363, "client-binding-probe (ubuntu-latest)", "success"),
    n(134153803397, "commit-policy", "success"),
    n(134153803453, "unit-windows (bootstrap-rest)", "success"),
    n(134153803494, "unit-windows (control-plane)", "success"),
    n(134153803512, "contract (ubuntu-latest)", "success"),
    n(134153803551, "control-plane-worker", "success"),
    n(134153803587, "unit-windows (commit-policy-install)", "success"),
    n(134153803708, "unit (ubuntu-latest)", "success"),
    n(134153803722, "unit-windows (control-plane-stable-install)", "success"),
    n(134153803799, "unit-windows (control-plane-hook-install)", "success"),
    n(134153803865, "unit-windows (hooks)", "success"),
    j(134153803950, "contract (macos-latest)", "completed", "cancelled", 0, ["macos-latest"], []),
    n(134153804099, "unit-windows (install-preview-safety)", "success"),
    n(134153804119, "client-binding-probe (windows-latest)", "success"),
    n(134153804243, "unit-windows (project-rules-install)", "success"),
    n(134153804400, "typescript", "success"),
    n(134153804464, "unit-windows (drift-check-optional-tools)", "success"),
    n(134153804656, "unit-windows (codex)", "success"),
    j(134153805849, "unit (macos-latest)", "completed", "cancelled", 0, ["macos-latest"], []),
    n(134164044332, "smoke", "skipped"),
    j(134182246179, "coverage-report", "completed", "failure", 1000008678, ["ubuntu-26.04"], [["Set up job","success"],["Run actions/checkout@v7","success"],["Run actions/setup-node@v7","success"],["Run npm ci --ignore-scripts","success"],["Require successful contributing jobs","failure"],["Download this run's raw coverage attempts","skipped"],["Assemble and validate real coverage","skipped"],["Upload accepted Sonar coverage","skipped"],["Export accepted coverage identity","skipped"],["Fork pull request scan policy","skipped"],["Coverage failure summary","success"],["Post Run actions/setup-node@v7","skipped"],["Post Run actions/checkout@v7","success"],["Complete job","success"]]),
    n(134182246311, "unit (windows-latest)", "success"),
    n(134182448725, "sonar", "skipped"),
  ],
  "44397779907-1": [
    n(135132216658, "typescript", "success"),
    n(135132216913, "client-binding-probe (ubuntu-latest)", "success"),
    n(135132216935, "contract (macos-latest)", "success"),
    n(135132217029, "contract (ubuntu-latest)", "success"),
    n(135132217058, "unit-engines-floor (22.18.0)", "success"),
    j(135132217156, "unit-engines-floor (24.1.0)", "completed", "failure", 1000009463, ["ubuntu-26.04"], [["Set up job","success"],["Run actions/checkout@v7","success"],["Run actions/setup-node@v7","success"],["Hook test suites","success"],["Bootstrap suites (TypeScript on Node, no build)","failure"],["Run npm ci --ignore-scripts","skipped"],["Codex projection suites and run guard (issue","skipped"],["local-inference and mcp-auth-bridge suites","skipped"],["atl-jira broker suites","skipped"],["Fetch pinned public legacy reader","skipped"],["Control Plane protocol and node suites","skipped"],["Post Run actions/setup-node@v7","skipped"],["Post Run actions/checkout@v7","success"],["Complete job","success"]]),
    n(135132217166, "unit-windows (project-rules-install)", "success"),
    n(135132217177, "control-plane-worker", "success"),
    n(135132217179, "unit-windows (install-preview-safety)", "success"),
    n(135132217181, "commit-policy", "success"),
    n(135132217197, "unit (macos-latest)", "success"),
    n(135132217229, "unit (ubuntu-latest)", "success"),
    n(135132217241, "client-binding-probe (windows-latest)", "success"),
    n(135132217246, "unit-windows (control-plane)", "success"),
    n(135132217263, "unit-windows (drift-check-optional-tools)", "success"),
    n(135132217306, "unit-windows (codex)", "success"),
    n(135132217359, "unit-windows (control-plane-hook-install)", "success"),
    n(135132217360, "unit-windows (hooks)", "success"),
    n(135132217388, "unit-windows (commit-policy-install)", "success"),
    n(135132217402, "unit-windows (bootstrap-rest)", "success"),
    n(135132217444, "unit-windows (control-plane-stable-install)", "success"),
    j(135138612627, "smoke (macos-latest)", "completed", "cancelled", 0, ["macos-latest"], []),
    n(135138612790, "smoke (ubuntu-latest)", "success"),
    n(135165206425, "coverage-report", "success"),
    n(135165206916, "unit (windows-latest)", "success"),
    n(135166842252, "sonar / sonar", "success"),
  ],
  "44337919183-1": [
    n(134919828801, "unit-engines-floor (24.1.0)", "success"),
    n(134919829174, "unit-windows (control-plane-hook-install)", "success"),
    n(134919829222, "unit-windows (control-plane-stable-install)", "success"),
    n(134919829338, "unit-windows (bootstrap-rest)", "success"),
    n(134919829346, "unit-windows (drift-check-optional-tools)", "success"),
    n(134919829358, "typescript", "success"),
    n(134919829361, "unit (ubuntu-latest)", "success"),
    n(134919829364, "unit-engines-floor (22.18.0)", "success"),
    n(134919829398, "unit-windows (commit-policy-install)", "success"),
    n(134919829399, "unit-windows (hooks)", "success"),
    n(134919829471, "unit-windows (project-rules-install)", "success"),
    n(134919829477, "commit-policy", "success"),
    n(134919829533, "control-plane-worker", "success"),
    j(134919829572, "unit-windows (codex)", "completed", "failure", 1000009235, ["windows-latest"], [["Set up job","success"],["Run actions/checkout@v7","success"],["Run actions/setup-node@v7","success"],["Hook test suites","skipped"],["Windows ACL decision against real descriptors (Windows PowerShell)","skipped"],["Install dependencies for native Control Plane tests","skipped"],["Fetch pinned public legacy reader","skipped"],["Control Plane protocol and node suites (Windows)","skipped"],["Codex projection suites and run guard (Windows, issues","failure"],["Bootstrap shard (TypeScript on Node, no build)","skipped"],["Coverage manifest (Windows shard)","skipped"],["Upload coverage (Windows shard)","skipped"],["Post Run actions/setup-node@v7","skipped"],["Post Run actions/checkout@v7","success"],["Complete job","success"]]),
    n(134919829639, "client-binding-probe (windows-latest)", "success"),
    n(134919829658, "client-binding-probe (ubuntu-latest)", "success"),
    n(134919829659, "unit-windows (install-preview-safety)", "success"),
    n(134919829690, "contract (ubuntu-latest)", "success"),
    j(134919829745, "unit (macos-latest)", "completed", "cancelled", 0, ["macos-latest"], []),
    n(134919829975, "contract (macos-latest)", "success"),
    n(134919839223, "unit-windows (control-plane)", "success"),
    n(134929625101, "smoke (ubuntu-latest)", "success"),
    n(134929625140, "smoke (macos-latest)", "success"),
    j(134964852515, "coverage-report", "completed", "failure", 1000009260, ["ubuntu-26.04"], [["Set up job","success"],["Run actions/checkout@v7","success"],["Run actions/setup-node@v7","success"],["Run npm ci --ignore-scripts","success"],["Require successful contributing jobs","failure"],["Download this run's raw coverage attempts","skipped"],["Assemble and validate real coverage","skipped"],["Upload accepted Sonar coverage","skipped"],["Export accepted coverage identity","skipped"],["Fork pull request scan policy","skipped"],["Coverage failure summary","success"],["Post Run actions/setup-node@v7","skipped"],["Post Run actions/checkout@v7","success"],["Complete job","success"]]),
    j(134964852640, "unit (windows-latest)", "completed", "failure", 1000009261, ["ubuntu-26.04"], [["Set up job","success"],["Every Windows shard succeeded","failure"],["Complete job","success"]]),
    n(134965081834, "sonar", "skipped"),
  ],
  "44327898911-1": [
    n(134884030775, "unit-windows (drift-check-optional-tools)", "success"),
    n(134884031102, "unit-windows (project-rules-install)", "success"),
    n(134884031276, "unit (macos-latest)", "success"),
    n(134884031396, "contract (macos-latest)", "success"),
    n(134884031429, "unit-windows (control-plane-hook-install)", "success"),
    n(134884031699, "unit-windows (control-plane)", "success"),
    n(134884031749, "unit-windows (bootstrap-rest)", "success"),
    n(134884031961, "unit-windows (control-plane-stable-install)", "success"),
    n(134884032076, "unit-windows (install-preview-safety)", "success"),
    n(134884032430, "unit-engines-floor (24.1.0)", "success"),
    n(134884032719, "control-plane-worker", "success"),
    n(134884032828, "client-binding-probe (ubuntu-latest)", "success"),
    n(134884032990, "unit-engines-floor (22.18.0)", "success"),
    n(134884033168, "unit (ubuntu-latest)", "success"),
    n(134884034287, "contract (ubuntu-latest)", "success"),
    n(134884034345, "client-binding-probe (windows-latest)", "success"),
    n(134884034606, "unit-windows (hooks)", "success"),
    n(134884035016, "commit-policy", "skipped"),
    n(134884035405, "unit-windows (codex)", "success"),
    n(134884035905, "typescript", "success"),
    n(134884036024, "unit-windows (commit-policy-install)", "success"),
    j(134891974366, "smoke (macos-latest)", "completed", "cancelled", 0, ["macos-latest"], []),
    n(134891974813, "smoke (ubuntu-latest)", "success"),
    n(134923502045, "coverage-report", "success"),
    n(134923502052, "unit (windows-latest)", "success"),
    n(134926688887, "sonar / sonar", "success"),
  ],
};

// Jobs of other runs, for classifyJob only.
export const SINGLE_JOBS: Record<string, unknown> = {
  134966328146: j(134966328146, "unit (macos-latest)", "completed", "cancelled", 0, ["macos-latest"], []),
  135103208949: j(135103208949, "unit (macos-latest)", "completed", "cancelled", 1000009388, ["macos-latest"], [["Set up job","success"],["Run actions/checkout@v7","success"],["Run actions/setup-node@v7","success"],["Hook test suites","success"],["Bootstrap suites (TypeScript on Node, no build)","cancelled"],["Install dependencies for native Control Plane tests","skipped"],["Fetch pinned public legacy reader","skipped"],["Control Plane protocol and node suites (macOS)","skipped"],["Coverage manifest (unit)","skipped"],["Upload coverage (unit)","skipped"],["Post Run actions/setup-node@v7","skipped"],["Post Run actions/checkout@v7","success"],["Complete job","success"]]),
  134919628393: j(134919628393, "coverage-report", "completed", "cancelled", null, ["ubuntu-26.04"], []),
  132189887668: j(132189887668, "coverage-report", "completed", "cancelled", 0, ["ubuntu-26.04"], []),
  132586093599: j(132586093599, "unit-windows (control-plane-hook-install)", "completed", "cancelled", 0, ["windows-latest"], []),
};

// Annotations as GitHub listed them, duplicates included; only level and message are read.
export const ANNOTATIONS: Record<string, unknown[]> = {
  132189887668: a(["failure", "The run was canceled by @cfaysal."]),
  132586093599: a(["failure", "Canceling since a higher priority waiting request for CI-928 exists"]),
  134153803950: a(["failure", "The job was not acquired by Runner of type hosted even after multiple attempts"], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."]),
  134153805849: a(["failure", "The job was not acquired by Runner of type hosted even after multiple attempts"], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."], ["failure", "The job was not acquired by Runner of type hosted even after multiple attempts"], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."]),
  134182246179: a(["failure", "Process completed with exit code 1."]),
  134891974366: a(["failure", "The job was not acquired by Runner of type hosted even after multiple attempts"], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."]),
  134919628393: a(),
  134919829745: a(["failure", "The job was not acquired by Runner of type hosted even after multiple attempts"], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."]),
  134966328146: a(["failure", "Canceling since a higher priority waiting request for CI-971 exists"], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."]),
  135103208949: a(["failure", "Canceling since a higher priority waiting request for CI-974 exists"], ["failure", "The operation was canceled."], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."]),
  135132217156: a(["failure", "Process completed with exit code 1."]),
  135138612627: a(["failure", "The job was not acquired by Runner of type hosted even after multiple attempts"], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."], ["notice", "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."]),
};

// CI runs created after each evaluated run and before its evaluation time.
export const NEWER: Record<string, unknown[]> = {
  "44115918168": [
  ],
  "44397779907": [
    {"id":44405996086,"event":"pull_request","head_branch":"test/atl-jira-brokers-coverage","head_repository":{"full_name":"CFcon-CH/kherep"},"created_at":"2026-11-18T21:52:51Z"},
    {"id":44405424725,"event":"push","head_branch":"main","head_repository":{"full_name":"CFcon-CH/kherep"},"created_at":"2026-11-18T21:49:31Z"},
  ],
  "44337919183": [
  ],
  "44327898911": [
    {"id":44376576769,"event":"push","head_branch":"main","head_repository":{"full_name":"CFcon-CH/kherep"},"created_at":"2026-11-18T19:04:31Z"},
    {"id":44365591712,"event":"pull_request","head_branch":"feat/codex-start-latest","head_repository":{"full_name":"CFcon-CH/kherep"},"created_at":"2026-11-18T18:04:04Z"},
    {"id":44351566693,"event":"pull_request","head_branch":"feat/codex-start-latest","head_repository":{"full_name":"CFcon-CH/kherep"},"created_at":"2026-11-18T16:48:57Z"},
    {"id":44337919183,"event":"pull_request","head_branch":"feat/codex-start-latest","head_repository":{"full_name":"CFcon-CH/kherep"},"created_at":"2026-11-18T15:38:11Z"},
    {"id":44337618314,"event":"pull_request","head_branch":"fix/coverage-sourceurl-range","head_repository":{"full_name":"CFcon-CH/kherep"},"created_at":"2026-11-18T15:36:37Z"},
    {"id":44330521919,"event":"pull_request","head_branch":"feat/codex-start-latest","head_repository":{"full_name":"CFcon-CH/kherep"},"created_at":"2026-11-18T15:00:08Z"},
  ],
  "43909265750": [
    {"id":43910764028,"event":"pull_request","head_branch":"feat/737-codex-model-selection","head_repository":{"full_name":"CFcon-CH/kherep"},"created_at":"2026-11-16T16:44:11Z"},
  ],
};

export const NOW: Record<string, number> = {
  "44115918168-1": Date.parse("2026-11-17T16:17:00Z"),
  "44397779907-1": Date.parse("2026-11-18T22:05:00Z"),
  "44337919183-1": Date.parse("2026-11-18T16:45:00Z"),
  "44327898911-1": Date.parse("2026-11-18T19:10:00Z"),
  "43909265750-1": Date.parse("2026-11-16T16:45:00Z"),
};
