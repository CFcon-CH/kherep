// Automatic failed-only rerun of CI runs that lost macOS jobs to runner capacity (issue #973).
//
// .github/workflows/ci-rerun.yml runs this script from the default branch on every completed
// CI run, on an off-the-hour sweep over the last six hours and on manual dispatch. Every path
// reads the run fresh and asks the same idempotent decide(). A run is rerun only when every
// red job is LOST (a macos-latest job GitHub never gave a runner) or DERIVED (coverage-report
// failing only in its gate step because a contributing job was LOST). Anything else blocks.
//
// No pull request code runs and no API text reaches a shell. Job names in the output are
// reduced to a safe character set; annotation text is compared, never printed.
//
//   env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_NAME, CI_RERUN_RUN_ID,
//        CI_RERUN_RUN_ATTEMPT, CI_RERUN_DRY_RUN=true prints the decision instead of posting.
//
// Exit codes: 0 done (also when the attempt cap is reached: a warning), 2 a read failed, the
// rerun was refused, or it was accepted but did not start. A failed read never means "nothing lost".

import { errorMessage, field } from "./shape.mts";
import type { GithubClient } from "./stall-watch-github.mts";

export const CI_PATH = ".github/workflows/ci.yml";
export const NOT_ACQUIRED = "The job was not acquired by Runner of type hosted even after multiple attempts";
const HIGHER_PRIORITY = "Canceling since a higher priority waiting request";
export const GATE = {
  job: "coverage-report",
  step: "Require successful contributing jobs",
  needs: ["unit", "unit-windows", "typescript", "control-plane-worker", "client-binding-probe"],
};
export const MAX_ATTEMPTS = 8;
const MINUTE = 60_000;
export const MAX_AGE_MS = 360 * MINUTE;
export const SETTLE_MS = 10 * MINUTE;
export const HANG_MS = 120 * MINUTE;
export const BOT = "github-actions[bot]";
const NEUTRAL = new Set(["success", "skipped"]);
const REPO = /^[\w.-]+\/[\w.-]+$/;
const ID = /^[1-9]\d{0,19}$/;

export type Kind = "neutral" | "lost" | "derived" | "blocked";
export interface Verdict { kind: Kind; reason: string }
export interface Decision { action: "rerun" | "none" | "cap"; reason: string }
export interface DecideInput {
  repository: string; run: unknown; attempt: number; jobs: unknown[];
  annotations: Record<string, unknown>; newer: unknown[]; now: number;
}
export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export interface Result { code: number; lines: string[] }

const text = (value: unknown): string => (typeof value === "string" ? value : "");
export const plain = (value: unknown): string => text(value).replace(/[^\w .()+=,/-]/g, "").slice(0, 120);
const blocked = (reason: string): Verdict => ({ kind: "blocked", reason });

function time(value: unknown, what: string): number {
  const ms = Date.parse(text(value));
  if (Number.isNaN(ms)) throw new Error(`${what} unparsable`);
  return ms;
}

export function lostShaped(job: unknown): boolean {
  const steps = field(job, "steps");
  return field(job, "conclusion") === "cancelled" && Array.isArray(steps) && steps.length === 0 && field(job, "runner_id") === 0;
}

export function classifyJob(job: unknown, annotations: unknown): Verdict {
  const raw = text(field(job, "name"));
  const name = plain(raw);
  const conclusion = text(field(job, "conclusion"));
  if (field(job, "status") !== "completed") return blocked(`${name}: not completed`);
  if (NEUTRAL.has(conclusion)) return { kind: "neutral", reason: name };
  const steps = field(job, "steps");
  if (!Array.isArray(steps)) return blocked(`${name}: steps unreadable`);
  if (raw === GATE.job && conclusion === "failure") {
    const red = steps.filter((step) => !NEUTRAL.has(text(field(step, "conclusion"))));
    const only = red.length === 1 && field(red[0], "name") === GATE.step && field(red[0], "conclusion") === "failure";
    return only ? { kind: "derived", reason: name } : blocked(`${name}: failed outside its gate step`);
  }
  if (!lostShaped(job)) return blocked(`${name}: ${plain(conclusion) || "no conclusion"}`);
  if (!Array.isArray(annotations)) throw new Error(`annotations of ${name} unread`);
  const failures = annotations.filter((a) => field(a, "annotation_level") === "failure").map((a) => text(field(a, "message")));
  if (failures.some((message) => message.startsWith(HIGHER_PRIORITY))) return blocked(`${name}: cancelled for a higher priority request`);
  // GitHub may list the not-acquired annotation twice (job 134153805849); duplicates count as one.
  if (failures.length === 0 || failures.some((message) => message !== NOT_ACQUIRED)) return blocked(`${name}: cancelled, not only "not acquired"`);
  const labels = field(job, "labels");
  if (!Array.isArray(labels) || labels.length !== 1 || labels[0] !== "macos-latest") return blocked(`${name}: LOST, out of scope (not macos-latest)`);
  return { kind: "lost", reason: name };
}

const isNeed = (name: string): boolean => GATE.needs.some((need) => name === need || name.startsWith(`${need} (`));

export function judgeJobs(jobs: unknown[], annotations: Record<string, unknown>): { ok: boolean; reason: string } {
  const judged = jobs.map((job) => ({ job, verdict: classifyJob(job, annotations[String(field(job, "id"))]) }));
  const reasons = judged.filter((j) => j.verdict.kind === "blocked").map((j) => j.verdict.reason);
  for (const gate of judged.filter((j) => j.verdict.kind === "derived")) {
    const red = judged.filter((j) => isNeed(text(field(j.job, "name"))) && field(j.job, "conclusion") !== "success");
    if (red.length === 0 || red.some((j) => j.verdict.kind !== "lost")) reasons.push(`${gate.verdict.reason}: a contributing job is red for another reason`);
  }
  if (reasons.length) return { ok: false, reason: `blocked: ${reasons.join("; ")}` };
  const lost = judged.filter((j) => j.verdict.kind === "lost").map((j) => j.verdict.reason);
  return lost.length ? { ok: true, reason: `lost: ${lost.join(", ")}` } : { ok: false, reason: "no lost macOS job" };
}

export function ineligible(run: unknown, attempt: number, repository: string, now: number): string | null {
  const event = text(field(run, "event"));
  const current = field(run, "run_attempt");
  if (field(run, "path") !== CI_PATH) return "not a run of .github/workflows/ci.yml";
  if (event !== "push" && event !== "pull_request") return `event ${plain(event) || "unknown"} is neither push nor pull_request`;
  if (field(field(run, "head_repository"), "full_name") !== repository) return "head repository is not this repository";
  if (field(run, "status") !== "completed") return "not completed";
  if (field(run, "conclusion") !== "failure") return `conclusion ${plain(field(run, "conclusion")) || "none"}, not failure`;
  if (current !== attempt) return `current attempt ${Number(current)} is not the evaluated attempt ${attempt}`;
  if (now - time(field(run, "created_at"), "created_at") > MAX_AGE_MS) return "created more than 6 h ago";
  return null;
}

export function capCheck(run: unknown, now: number): Decision | null {
  const attempt = Number(field(run, "run_attempt"));
  if (attempt >= MAX_ATTEMPTS) return { action: "cap", reason: `attempt ${attempt} reached the cap of ${MAX_ATTEMPTS} attempts` };
  if (attempt >= 2 && now - time(field(run, "updated_at"), "updated_at") < SETTLE_MS) {
    return { action: "none", reason: `attempt ${attempt} finished less than 10 min ago; a later sweep decides` };
  }
  return null;
}

// The concurrency group of ci.yml: a pull request, or the branch of a push or dispatch.
export function supersededBy(run: unknown, newer: unknown[]): number | null {
  const pr = field(run, "event") === "pull_request";
  const fork = field(field(run, "head_repository"), "full_name");
  for (const other of newer) {
    if (Number(field(other, "id")) <= Number(field(run, "id")) || field(other, "head_branch") !== field(run, "head_branch")) continue;
    const event = field(other, "event");
    const same = pr ? event === "pull_request" && field(field(other, "head_repository"), "full_name") === fork
      : event === "push" || event === "workflow_dispatch";
    if (same) return Number(field(other, "id"));
  }
  return null;
}

export function decide(input: DecideInput): Decision {
  const not = ineligible(input.run, input.attempt, input.repository, input.now);
  if (not) return { action: "none", reason: not };
  const jobs = judgeJobs(input.jobs, input.annotations);
  if (!jobs.ok) return { action: "none", reason: jobs.reason };
  const cap = capCheck(input.run, input.now);
  if (cap) return cap;
  const newer = supersededBy(input.run, input.newer);
  return newer ? { action: "none", reason: `superseded by run ${newer}` } : { action: "rerun", reason: jobs.reason };
}

// The only write: POST .../actions/runs/<id>/rerun-failed-jobs with {}, and none in a dry run.
export function guardWrites(gh: GithubClient, repository: string, dryRun: boolean): GithubClient {
  const prefix = `/repos/${repository}/actions/runs/`;
  const suffix = "/rerun-failed-jobs";
  return {
    get: (path) => gh.get(path),
    list: (path, key, maxPages) => gh.list(path, key, maxPages),
    async post(path, body) {
      const id = path.startsWith(prefix) && path.endsWith(suffix) ? path.slice(prefix.length, -suffix.length) : "";
      if (dryRun || !REPO.test(repository) || !/^\d+$/.test(id) || JSON.stringify(body) !== "{}") throw new Error("write refused by the allow-list");
      await gh.post(path, body);
    },
  };
}

export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const ciRunsSince = (repo: string, ms: number): string => `/repos/${repo}/actions/workflows/ci.yml/runs?created=${encodeURIComponent(`>=${iso(ms)}`)}`;

async function evaluate(repo: string, gh: GithubClient, clock: Clock, id: string, given: number | null, dryRun: boolean): Promise<Result> {
  const path = `/repos/${repo}/actions/runs/${id}`;
  let label = `run ${id}`;
  try {
    const run = await gh.get(path);
    const attempt = given ?? Number(field(run, "run_attempt"));
    label = `run ${id} attempt ${attempt}`;
    const input: DecideInput = { repository: repo, run, attempt, jobs: [], annotations: {}, newer: [], now: clock.now() };
    if (!ineligible(run, attempt, repo, input.now)) {
      input.jobs = await gh.list(`${path}/attempts/${attempt}/jobs`, "jobs", 2);
      for (const job of input.jobs.filter(lostShaped)) {
        const jobId = Number(field(job, "id"));
        if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error("a job id is unreadable");
        input.annotations[String(jobId)] = await gh.list(`/repos/${repo}/check-runs/${jobId}/annotations`, null, 2);
      }
      // The superseded guard reads last, directly before the POST.
      if (decide(input).action === "rerun") input.newer = await gh.list(ciRunsSince(repo, time(field(run, "created_at"), "created_at")), "workflow_runs", 3);
    }
    const decision = decide(input);
    if (decision.action === "cap") return { code: 0, lines: [`::warning::${label}: no rerun, ${decision.reason}`] };
    if (decision.action === "none") return { code: 0, lines: [`${label}: no rerun, ${decision.reason}`] };
    if (dryRun) return { code: 0, lines: [`${label}: dry run, would rerun the failed jobs (${decision.reason})`] };
    try { await gh.post(`${path}/rerun-failed-jobs`, {}); }
    catch (error) { return { code: 2, lines: [`${label}: rerun refused: ${errorMessage(error)}`] }; }
    for (let poll = 0; poll < 6; poll++) {
      await clock.sleep(10_000);
      const fresh = await gh.get(path);
      if (Number(field(fresh, "run_attempt")) > attempt || field(fresh, "status") !== "completed") {
        return { code: 0, lines: [`${label}: rerun of the failed jobs started (${decision.reason})`] };
      }
    }
    return { code: 2, lines: [`${label}: rerun accepted but not started within 60 s`] };
  } catch (error) {
    return { code: 2, lines: [`${label}: read failed, nothing decided: ${errorMessage(error)}`] };
  }
}

async function sweep(repo: string, gh: GithubClient, now: number): Promise<{ ids: string[]; lines: string[] }> {
  const runs = await gh.list(ciRunsSince(repo, now - MAX_AGE_MS), "workflow_runs", 3);
  const ids: string[] = [];
  const lines: string[] = [];
  for (const run of runs) {
    const id = String(field(run, "id"));
    if (!ID.test(id)) throw new Error("a run id is unreadable");
    const attempt = Number(field(run, "run_attempt"));
    if (field(run, "status") === "completed") { if (field(run, "conclusion") === "failure") ids.push(id); continue; }
    if (field(field(run, "triggering_actor"), "login") === BOT && attempt >= 2 && now - Date.parse(text(field(run, "run_started_at"))) > HANG_MS) {
      lines.push(`::warning::run ${id} attempt ${attempt}, started by ${BOT}, has not completed after 120 min`);
    }
  }
  return { ids, lines: [`sweep: ${runs.length} CI run(s) since ${iso(now - MAX_AGE_MS)}, ${ids.length} failed`, ...lines] };
}

export async function run(env: NodeJS.ProcessEnv, gh: GithubClient, clock: Clock): Promise<Result> {
  const repo = text(env.GITHUB_REPOSITORY);
  const id = text(env.CI_RERUN_RUN_ID) === "0" ? "" : text(env.CI_RERUN_RUN_ID);
  const attempt = text(env.CI_RERUN_RUN_ATTEMPT);
  const event = text(env.GITHUB_EVENT_NAME);
  const dryRun = env.CI_RERUN_DRY_RUN === "true";
  if (!REPO.test(repo)) return { code: 2, lines: ["GITHUB_REPOSITORY is missing or malformed"] };
  if ((id && !ID.test(id)) || (attempt && !ID.test(attempt))) return { code: 2, lines: ["CI_RERUN_RUN_ID or CI_RERUN_RUN_ATTEMPT is not numeric"] };
  const head = dryRun ? ["dry run: no write"] : [];
  if (event === "workflow_run") {
    if (!id || !attempt) return { code: 2, lines: ["workflow_run needs CI_RERUN_RUN_ID and CI_RERUN_RUN_ATTEMPT"] };
    const result = await evaluate(repo, gh, clock, id, Number(attempt), dryRun);
    return { code: result.code, lines: [...head, ...result.lines] };
  }
  if (event !== "schedule" && event !== "workflow_dispatch") return { code: 2, lines: [`unsupported event ${plain(event) || "none"}`] };
  let found: { ids: string[]; lines: string[] };
  try { found = id ? { ids: [id], lines: [] } : await sweep(repo, gh, clock.now()); }
  catch (error) { return { code: 2, lines: [...head, `sweep read failed, nothing decided: ${errorMessage(error)}`] }; }
  const lines = [...head, ...found.lines];
  let code = 0;
  for (const each of found.ids) {
    const result = await evaluate(repo, gh, clock, each, null, dryRun);
    code = Math.max(code, result.code);
    lines.push(...result.lines);
  }
  return { code, lines };
}
