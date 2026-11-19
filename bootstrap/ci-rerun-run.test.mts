// Issue #973. run() of the CI rerun helper through the real REST client against a fake
// fetch serving real API responses: the workflow_run, dispatch and sweep paths, the POST
// and its start check, dry run, cap and every exit-2 path.
import assert from "node:assert/strict";
import test from "node:test";

import { BOT, run } from "./ci-rerun.mts";
import { githubClient } from "./stall-watch-github.mts";
import { ANNOTATIONS, JOBS, NEWER, NOW, REPO, RUNS } from "./ci-rerun.fixture.mts";

const API = "https://api.example.test";
const R = `/repos/${REPO}`;
const LOST = "44115918168";
interface Call { method: string; path: string; body: unknown }
type Answer = { status?: number; body: unknown; link?: string };
type Routes = Record<string, Answer | (() => Answer)>;

function client(routes: Routes, calls: Call[]) {
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace(API, "");
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${path}`];
    const answer = typeof route === "function" ? route() : route;
    if (!answer) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: new Headers(answer.link ? { link: answer.link } : {}) });
  }) as typeof fetch;
  return githubClient({ api: API, token: "t", fetch: fetcher });
}

const since = (iso: string) => `${R}/actions/workflows/ci.yml/runs?created=${encodeURIComponent(`>=${iso}`)}&per_page=100`;

function routesFor(id: string, attempt: number, run: Record<string, unknown> = {}): Routes {
  const key = `${id}-1`;
  const routes: Routes = {
    [`GET ${R}/actions/runs/${id}`]: { body: { ...RUNS[key], ...run } },
    [`GET ${R}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`]: { body: { total_count: 26, jobs: JOBS[key] ?? [] } },
    [`GET ${since(RUNS[key].created_at)}`]: { body: { total_count: 0, workflow_runs: NEWER[id] } },
    [`POST ${R}/actions/runs/${id}/rerun-failed-jobs`]: { status: 201, body: {} },
  };
  for (const [job, list] of Object.entries(ANNOTATIONS)) routes[`GET ${R}/check-runs/${job}/annotations?per_page=100`] = { body: list };
  return routes;
}

function clock(now: number) {
  const sleeps: number[] = [];
  return { sleeps, now: () => now, sleep: async (ms: number) => { sleeps.push(ms); } };
}

const workflowRun = (id: string, attempt: number, extra: Record<string, string> = {}) =>
  ({ GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: "workflow_run", CI_RERUN_RUN_ID: id, CI_RERUN_RUN_ATTEMPT: String(attempt), ...extra });
const posts = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

test("a lost macOS run is rerun once, with an empty body, and the new attempt is confirmed", async () => {
  const calls: Call[] = [];
  const routes = routesFor(LOST, 1);
  let polls = 0;
  routes[`GET ${R}/actions/runs/${LOST}`] = () => ({ body: polls++ < 1 ? RUNS[`${LOST}-1`] : { ...RUNS[`${LOST}-1`], run_attempt: 2, status: "queued" } });
  const c = clock(NOW[`${LOST}-1`]);
  const result = await run(workflowRun(LOST, 1), client(routes, calls), c);
  assert.equal(result.code, 0, result.lines.join("\n"));
  assert.deepEqual(posts(calls), [{ method: "POST", path: `${R}/actions/runs/${LOST}/rerun-failed-jobs`, body: {} }]);
  assert.deepEqual(result.lines, [`run ${LOST} attempt 1: rerun of the failed jobs started (lost: contract (macos-latest), unit (macos-latest))`]);
  assert.deepEqual(c.sleeps, [10_000]);
  const last = calls.map((x) => x.path).lastIndexOf(since(RUNS[`${LOST}-1`].created_at));
  assert.equal(calls[last + 1].method, "POST", "the superseded guard is the last read before the POST");
});

test("a rerun accepted but not started within 60 s exits 2", async () => {
  const calls: Call[] = [];
  const c = clock(NOW[`${LOST}-1`]);
  const result = await run(workflowRun(LOST, 1), client(routesFor(LOST, 1), calls), c);
  assert.equal(result.code, 2);
  assert.deepEqual(result.lines, [`run ${LOST} attempt 1: rerun accepted but not started within 60 s`]);
  assert.equal(c.sleeps.length, 6);
  assert.equal(posts(calls).length, 1);
});

test("a refused POST exits 2", async () => {
  const routes = { ...routesFor(LOST, 1), [`POST ${R}/actions/runs/${LOST}/rerun-failed-jobs`]: { status: 403, body: {} } };
  const result = await run(workflowRun(LOST, 1), client(routes, []), clock(NOW[`${LOST}-1`]));
  assert.equal(result.code, 2);
  assert.match(result.lines[0], /rerun refused: POST .* answered HTTP 403/);
});

test("dry run makes no write call and says what it would do", async () => {
  const calls: Call[] = [];
  const result = await run(workflowRun(LOST, 1, { CI_RERUN_DRY_RUN: "true" }), client(routesFor(LOST, 1), calls), clock(NOW[`${LOST}-1`]));
  assert.equal(result.code, 0);
  assert.equal(posts(calls).length, 0);
  assert.deepEqual(result.lines, ["dry run: no write", `run ${LOST} attempt 1: dry run, would rerun the failed jobs (lost: contract (macos-latest), unit (macos-latest))`]);
});

test("failed reads exit 2 and never read as nothing lost", async () => {
  for (const broken of [`GET ${R}/actions/runs/${LOST}`, `GET ${R}/actions/runs/${LOST}/attempts/1/jobs?per_page=100`,
    `GET ${R}/check-runs/134153805849/annotations?per_page=100`, `GET ${since(RUNS[`${LOST}-1`].created_at)}`]) {
    const calls: Call[] = [];
    const result = await run(workflowRun(LOST, 1), client({ ...routesFor(LOST, 1), [broken]: { status: 500, body: {} } }, calls), clock(NOW[`${LOST}-1`]));
    assert.equal(result.code, 2, broken);
    assert.match(result.lines.at(-1) ?? "", /read failed, nothing decided/, broken);
    assert.equal(posts(calls).length, 0, broken);
  }
  const badJob = { ...routesFor(LOST, 1), [`GET ${R}/actions/runs/${LOST}/attempts/1/jobs?per_page=100`]: { body: { jobs: [{ id: "x", conclusion: "cancelled", steps: [], runner_id: 0 }] } } };
  assert.match((await run(workflowRun(LOST, 1), client(badJob, []), clock(NOW[`${LOST}-1`]))).lines[0], /run 44115918168 attempt 1: read failed, nothing decided: a job id is unreadable/);
});

test("the cap warns and exits 0 without a POST", async () => {
  const calls: Call[] = [];
  const now = NOW[`${LOST}-1`];
  const routes = routesFor(LOST, 8, { run_attempt: 8, updated_at: new Date(now - 30 * 60_000).toISOString() });
  const result = await run(workflowRun(LOST, 8), client(routes, calls), clock(now));
  assert.equal(result.code, 0);
  assert.deepEqual(result.lines, [`::warning::run ${LOST} attempt 8: no rerun, attempt 8 reached the cap of 8 attempts`]);
  assert.equal(posts(calls).length, 0);
});

test("mixed and cancelled runs: no POST, and no superseded read for a run that is not rerun", async () => {
  for (const id of ["44397779907", "44337919183", "43909265750"]) {
    const calls: Call[] = [];
    const env = { GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: "workflow_dispatch", CI_RERUN_RUN_ID: id };
    const result = await run(env, client(routesFor(id, 1), calls), clock(NOW[`${id}-1`]));
    assert.equal(result.code, 0, id);
    assert.match(result.lines[0], new RegExp(`^run ${id} attempt 1: no rerun, `));
    assert.equal(posts(calls).length, 0, id);
    assert.ok(!calls.some((c) => c.path.includes("/workflows/ci.yml/runs")), id);
  }
});

test("the sweep evaluates failed CI runs of the last 6 h and warns about a hanging bot attempt", async () => {
  const now = NOW[`${LOST}-1`];
  const started = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const listed = [
    { id: Number(LOST), status: "completed", conclusion: "failure", run_attempt: 1 },
    { id: 2, status: "completed", conclusion: "success", run_attempt: 1 },
    { id: 3, status: "in_progress", conclusion: null, run_attempt: 2, run_started_at: started(130), triggering_actor: { login: BOT } },
    { id: 4, status: "queued", conclusion: null, run_attempt: 2, run_started_at: started(30), triggering_actor: { login: BOT } },
    { id: 5, status: "in_progress", conclusion: null, run_attempt: 2, run_started_at: started(300), triggering_actor: { login: "someone" } },
  ];
  const routes = { ...routesFor(LOST, 1), [`GET ${since("2026-11-17T10:17:00Z")}`]: { body: { workflow_runs: listed } } };
  const calls: Call[] = [];
  const result = await run({ GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: "workflow_dispatch", CI_RERUN_DRY_RUN: "true", CI_RERUN_RUN_ID: "0" }, client(routes, calls), clock(now));
  assert.equal(result.code, 0, result.lines.join("\n"));
  assert.deepEqual(result.lines.slice(0, 3), [
    "dry run: no write",
    "sweep: 5 CI run(s) since 2026-11-17T10:17:00Z, 1 failed",
    "::warning::run 3 attempt 2, started by github-actions[bot], has not completed after 120 min",
  ]);
  assert.match(result.lines[3], /^run 44115918168 attempt 1: dry run, would rerun/);
  assert.equal(posts(calls).length, 0);
});

test("a sweep whose list is capped or unreadable exits 2; one failed evaluation still exits 2", async () => {
  const now = NOW[`${LOST}-1`];
  const list = `GET ${since("2026-11-17T10:17:00Z")}`;
  const env = { GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: "schedule" };
  const capped = { [list]: { body: { workflow_runs: [] }, link: `<${API}/more>; rel="next"` } };
  const more = { ...capped, "GET /more": { body: { workflow_runs: [] }, link: `<${API}/more2>; rel="next"` }, "GET /more2": { body: { workflow_runs: [] }, link: `<${API}/more3>; rel="next"` } };
  assert.match((await run(env, client(more, []), clock(now))).lines[0], /sweep read failed, nothing decided: .*more than 3 page/);
  const badId = { [list]: { body: { workflow_runs: [{ id: "1; rm" }] } } };
  assert.equal((await run(env, client(badId, []), clock(now))).code, 2);
  const failing = { [list]: { body: { workflow_runs: [{ id: 9, status: "completed", conclusion: "failure" }] } } };
  const result = await run(env, client(failing, []), clock(now));
  assert.equal(result.code, 2);
  assert.match(result.lines.at(-1) ?? "", /^run 9: read failed/);
});

test("malformed environment and unsupported events exit 2 before any read", async () => {
  const calls: Call[] = [];
  const gh = client({}, calls);
  const c = clock(0);
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ GITHUB_EVENT_NAME: "schedule" }, /GITHUB_REPOSITORY is missing/],
    [{ GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: "workflow_dispatch", CI_RERUN_RUN_ID: "1 2" }, /not numeric/],
    [{ GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: "workflow_run", CI_RERUN_RUN_ID: "1", CI_RERUN_RUN_ATTEMPT: "-1" }, /not numeric/],
    [{ GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: "workflow_run", CI_RERUN_RUN_ID: "1" }, /workflow_run needs/],
    [{ GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: "pull_request" }, /unsupported event pull_request/],
    [{ GITHUB_REPOSITORY: REPO }, /unsupported event none/],
  ];
  for (const [env, expected] of cases) {
    const result = await run(env, gh, c);
    assert.equal(result.code, 2);
    assert.match(result.lines.join("\n"), expected);
  }
  assert.equal(calls.length, 0);
});
