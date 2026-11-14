// API-shaped fixtures for stall-watch.test.mts (issue #744). Every value is
// synthetic; the PR title and branch carry `@` and `#1` on purpose, so a test
// can prove that no PR-controlled text reaches the comment body.

export const REPO = "example-org/example-repo";
export const BOT = "github-actions[bot]";
export const ACTIONS_APP = 15368;
export const NOW = Date.parse("2026-11-14T12:00:00Z");

export const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
export const sha = (char: string): string => char.repeat(40);

export const CONFIG = { thresholdMinutes: 20, includeDrafts: true, maxPulls: 50, timeZone: "UTC" };

export function rules(checks: unknown[] = [
  { context: "typescript", integration_id: ACTIONS_APP },
  { context: "unit (ubuntu-latest)", integration_id: ACTIONS_APP },
  { context: "SonarCloud Code Analysis", integration_id: 12526 },
]): unknown[] {
  return [
    { type: "deletion", ruleset_id: 1 },
    { type: "required_status_checks", ruleset_id: 1, parameters: { strict_required_status_checks_policy: false, required_status_checks: checks } },
  ];
}

export function pull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    draft: false,
    title: "Fix @someone #1",
    head: { sha: sha("a"), ref: "feat/@someone-#1", repo: { full_name: REPO } },
    base: { ref: "main", repo: { full_name: REPO } },
    user: { login: "example-author", type: "User" },
    assignees: [],
    ...overrides,
  };
}

let nextId = 1000;

export function run(name: string, conclusion: string | null, completedMinutesAgo: number | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const id = nextId++;
  return {
    id,
    name,
    app: { id: ACTIONS_APP },
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    completed_at: completedMinutesAgo === null ? null : minutesAgo(completedMinutesAgo),
    html_url: `https://github.com/${REPO}/actions/runs/1/job/${id}`,
    ...extra,
  };
}

export function comment(login: string, body: string): Record<string, unknown> {
  return { user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" }, body };
}

export function input(pulls: unknown[], runs: Record<string, unknown[]>, comments: Record<number, unknown[]> = {}) {
  return { repository: REPO, rules: rules(), pulls, checkRuns: runs, comments };
}
