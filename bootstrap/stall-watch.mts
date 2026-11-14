#!/usr/bin/env node
// Scheduled stall watch for open pull requests (issue #744).
//
// .github/workflows/stall-watch.yml runs this script from the default branch
// every ten minutes. It reads the required checks of `main` live from the
// branch rules, the open pull requests against `main` and the check runs of
// each head SHA. A pull request whose latest run of a required check (matched
// on name and app id) ended red, and stayed red for the threshold, gets one
// comment per head SHA, and its user author is assigned if not yet assigned.
// A new commit changes the head SHA and so restarts the clock; a re-run puts
// the check back in progress, so it no longer counts as red.
//
// Required checks are read as check runs; a commit status is not read.
//
// No pull request code runs, and the comment is built from API fields only: it
// carries no title, branch, login or `@`. The once-per-head marker counts only
// in a comment by github-actions[bot], so nobody else can silence the watch.
//
//   node bootstrap/stall-watch.mts
//   env: GITHUB_TOKEN, GITHUB_REPOSITORY, STALL_WATCH_TIMEZONE (default UTC),
//        STALL_WATCH_DRY_RUN=true prints the actions instead of posting them.
//
// Exit codes: 0 done, 2 a read or write failed or a cap was hit. A failed read
// is never reported as "nothing stalled".

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { errorMessage, field } from "./shape.mts";
import { githubClient, type GithubClient } from "./stall-watch-github.mts";

export const BOT = "github-actions[bot]";
export const BASE = "main";
const RED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const SHA = /^[0-9a-f]{40}$/;
const CHECK_URL = /^https:\/\/github\.com\/[\w./-]+$/;

export interface Config { thresholdMinutes: number; includeDrafts: boolean; maxPulls: number; timeZone: string }
export const DEFAULT_CONFIG: Config = { thresholdMinutes: 20, includeDrafts: true, maxPulls: 50, timeZone: "UTC" };

export interface Input { repository: string; rules: unknown; pulls: unknown; checkRuns: Record<string, unknown> }
export interface RedCheck { name: string; conclusion: string; url: string | null }
export interface Stalled { pull: number; headSha: string; redSince: number; redMinutes: number; red: RedCheck[]; assignee: string | null }
export interface Counts { scanned: number; stalled: number; alreadyReported: number; skippedDrafts: number }
export type Action = { kind: "comment"; pull: number; body: string } | { kind: "assign"; pull: number; login: string };
export interface Assessment { stalled: Stalled[]; counts: Counts; errors: string[] }
export interface Decision { actions: Action[]; counts: Counts; errors: string[] }

interface Required { context: string; appId: number | null }

export const marker = (headSha: string): string => `<!-- kherep-stall-watch:v1 sha=${headSha} -->`;
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const plain = (value: string): string => value.replace(/[@#<>`\r\n]/g, "");

export function requiredChecks(rules: unknown): Required[] {
  if (!Array.isArray(rules)) throw new Error("branch rules are not a list");
  const found = rules.filter((rule) => field(rule, "type") === "required_status_checks");
  if (found.length === 0) throw new Error(`no required_status_checks rule on ${BASE}`);
  const checks = found.flatMap((rule) => {
    const list = field(field(rule, "parameters"), "required_status_checks");
    if (!Array.isArray(list)) throw new Error("a required_status_checks rule has no check list");
    return list;
  });
  if (checks.length === 0) throw new Error(`required_status_checks on ${BASE} lists no check`);
  return checks.map((check) => {
    const context = text(field(check, "context"));
    const appId = field(check, "integration_id");
    if (!context) throw new Error("a required_status_checks entry has no context");
    return { context, appId: typeof appId === "number" ? appId : null };
  });
}

function latestRun(runs: unknown[], required: Required): unknown {
  let latest: unknown;
  for (const run of runs) {
    if (field(run, "name") !== required.context) continue;
    if (required.appId !== null && field(field(run, "app"), "id") !== required.appId) continue;
    if (latest === undefined || Number(field(run, "id")) > Number(field(latest, "id"))) latest = run;
  }
  return latest;
}

function assessPull(pull: unknown, input: Input, required: Required[], now: number, config: Config): Stalled | null {
  const number = Number(field(pull, "number"));
  const head = field(pull, "head");
  const headSha = text(field(head, "sha"));
  if (!SHA.test(headSha)) throw new Error(`pull request ${number}: head SHA unreadable`);
  const runs = input.checkRuns[headSha];
  if (!Array.isArray(runs)) throw new Error(`pull request ${number}: check runs unread`);
  const red: RedCheck[] = [];
  let redSince = Infinity;
  for (const check of required) {
    const run = latestRun(runs, check);
    const conclusion = text(field(run, "conclusion"));
    if (field(run, "status") !== "completed" || !RED.has(conclusion)) continue;
    const completed = Date.parse(text(field(run, "completed_at")));
    if (Number.isNaN(completed)) throw new Error(`pull request ${number}: completed_at of ${check.context} unparsable`);
    redSince = Math.min(redSince, completed);
    const url = text(field(run, "html_url"));
    red.push({ name: plain(check.context), conclusion, url: CHECK_URL.test(url) ? url : null });
  }
  if (red.length === 0) return null;
  const redMinutes = Math.floor((now - redSince) / 60_000);
  if (redMinutes < config.thresholdMinutes) return null;
  const author = field(pull, "user");
  const assignees = field(pull, "assignees");
  const login = text(field(author, "login"));
  const fork = text(field(field(head, "repo"), "full_name")) !== input.repository;
  const assigned = Array.isArray(assignees) && assignees.some((a) => field(a, "login") === login);
  const assignee = field(author, "type") === "User" && login && !fork && !assigned ? login : null;
  return { pull: number, headSha, redSince, redMinutes, red, assignee };
}

export function assess(input: Input, now: number, config: Config): Assessment {
  const counts: Counts = { scanned: 0, stalled: 0, alreadyReported: 0, skippedDrafts: 0 };
  const errors: string[] = [];
  const stalled: Stalled[] = [];
  let required: Required[];
  try {
    required = requiredChecks(input.rules);
  } catch (error) {
    return { stalled, counts, errors: [errorMessage(error)] };
  }
  if (!Array.isArray(input.pulls)) return { stalled, counts, errors: ["open pull requests are not a list"] };
  if (input.pulls.length > config.maxPulls) errors.push(`more than ${config.maxPulls} open pull requests; only the first ${config.maxPulls} were read`);
  for (const pull of input.pulls.slice(0, config.maxPulls)) {
    if (field(pull, "draft") === true && !config.includeDrafts) { counts.skippedDrafts++; continue; }
    counts.scanned++;
    try {
      const found = assessPull(pull, input, required, now, config);
      if (found) stalled.push(found);
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }
  counts.stalled = stalled.length;
  return { stalled, counts, errors };
}

export function formatTime(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} ${timeZone}`;
}

export function commentBody(stalled: Stalled, timeZone: string): string {
  return [
    marker(stalled.headSha),
    `**Stalled: required checks red for ${stalled.redMinutes} min, no new commit.**`,
    "",
    `Head \`${stalled.headSha.slice(0, 7)}\`, red since ${formatTime(stalled.redSince, timeZone)}.`,
    "",
    ...stalled.red.map((check) => `- ${check.name}: ${check.conclusion}${check.url ? ` - ${check.url}` : ""}`),
    "",
    "Owner: tell the operator in one line each what blocks, what would unblock it and who can do it.",
    "Any session may read these public job logs and post the root cause here; the fix stays with the owner.",
    "",
    "Posted once per head commit by .github/workflows/stall-watch.yml.",
  ].join("\n");
}

// Comments are read only for stalled pull requests; a missing list is an error.
export function plan(assessment: Assessment, comments: Record<number, unknown>, config: Config): Decision {
  const actions: Action[] = [];
  const errors = [...assessment.errors];
  const counts = { ...assessment.counts };
  for (const stalled of assessment.stalled) {
    const list = comments[stalled.pull];
    if (!Array.isArray(list)) { errors.push(`pull request ${stalled.pull}: comments unread`); continue; }
    const seen = list.some((c) => field(field(c, "user"), "login") === BOT && text(field(c, "body")).includes(marker(stalled.headSha)));
    if (seen) counts.alreadyReported++;
    else actions.push({ kind: "comment", pull: stalled.pull, body: commentBody(stalled, config.timeZone) });
    // The assignment is retried while the author is unassigned, also after the comment.
    if (stalled.assignee) actions.push({ kind: "assign", pull: stalled.pull, login: stalled.assignee });
  }
  return { actions, counts, errors };
}

export function decide(input: Input & { comments: Record<number, unknown> }, now: number, config: Config): Decision {
  return plan(assess(input, now, config), input.comments, config);
}

function validZone(zone: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; }
}

export async function run(env: NodeJS.ProcessEnv, gh: GithubClient, now: number): Promise<{ code: number; lines: string[] }> {
  const repo = text(env.GITHUB_REPOSITORY);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { code: 2, lines: ["GITHUB_REPOSITORY is missing or malformed"] };
  const errors: string[] = [];
  const zone = env.STALL_WATCH_TIMEZONE || "UTC";
  const zoneValid = validZone(zone);
  if (!zoneValid) errors.push("STALL_WATCH_TIMEZONE is not a valid time zone; UTC is used");
  const config = { ...DEFAULT_CONFIG, timeZone: zoneValid ? zone : "UTC" };
  const dryRun = env.STALL_WATCH_DRY_RUN === "true";
  const lines: string[] = [];
  let decision: Decision;
  try {
    const rules = await gh.list(`/repos/${repo}/rules/branches/${BASE}`, null, 5);
    const pulls = await gh.list(`/repos/${repo}/pulls?state=open&base=${BASE}`, null, 1);
    const checkRuns: Record<string, unknown> = {};
    for (const pull of pulls.slice(0, config.maxPulls)) {
      const sha = text(field(field(pull, "head"), "sha"));
      if (!SHA.test(sha)) continue;
      try { checkRuns[sha] = await gh.list(`/repos/${repo}/commits/${sha}/check-runs?filter=latest`, "check_runs", 5); }
      catch (error) { errors.push(errorMessage(error)); }
    }
    const assessment = assess({ repository: repo, rules, pulls, checkRuns }, now, config);
    const comments: Record<number, unknown> = {};
    for (const stalled of assessment.stalled) {
      try { comments[stalled.pull] = await gh.list(`/repos/${repo}/issues/${stalled.pull}/comments`, null, 10); }
      catch (error) { errors.push(errorMessage(error)); }
    }
    decision = plan(assessment, comments, config);
  } catch (error) {
    return { code: 2, lines: [...errors, errorMessage(error)] };
  }
  let posted = 0;
  const failed = new Set<number>();
  for (const action of decision.actions) {
    if (failed.has(action.pull)) continue;
    const what = action.kind === "comment" ? `comment on pull request ${action.pull}` : `assign pull request ${action.pull} to its author`;
    if (dryRun) { lines.push(`dry run, would ${what}`); continue; }
    try {
      if (action.kind === "comment") await gh.post(`/repos/${repo}/issues/${action.pull}/comments`, { body: action.body });
      else await gh.post(`/repos/${repo}/issues/${action.pull}/assignees`, { assignees: [action.login] });
      posted++;
      lines.push(`done: ${what}`);
    } catch (error) {
      failed.add(action.pull);
      errors.push(`${what}: ${errorMessage(error)}`);
    }
  }
  const c = decision.counts;
  lines.unshift(`scanned ${c.scanned}, stalled ${c.stalled}, already reported ${c.alreadyReported}, skipped drafts ${c.skippedDrafts}, writes ${posted}${dryRun ? " (dry run)" : ""}`);
  const allErrors = [...errors, ...decision.errors];
  lines.push(...allErrors.map((e) => `error: ${e}`));
  return { code: allErrors.length ? 2 : 0, lines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.GITHUB_TOKEN || "";
  const gh = githubClient({ api: process.env.GITHUB_API_URL || "https://api.github.com", token, fetch });
  const result = token ? await run(process.env, gh, Date.now()) : { code: 2, lines: ["GITHUB_TOKEN is missing"] };
  for (const line of result.lines) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Stall watch\n\n${result.lines.map((l) => `- ${l}`).join("\n")}\n`);
  process.exitCode = result.code;
}
