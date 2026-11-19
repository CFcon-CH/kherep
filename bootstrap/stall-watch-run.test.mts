// Issue #744. The REST layer and the run of the stall watch against a fake
// fetch: pagination, caps, the origin guard, dry run and the write order.
import assert from "node:assert/strict";
import test from "node:test";

import { marker, run } from "./stall-watch.mts";
import { githubClient, nextLink } from "./stall-watch-github.mts";
import { BOT, NOW, REPO, comment, pull, rules, run as checkRun, sha } from "./stall-watch.fixture.mts";

const API = "https://api.example.test";
const A = sha("a");

interface Call { method: string; url: string; body: unknown }
type Routes = Record<string, { status?: number; body: unknown; link?: string }>;

function fakeFetch(routes: Routes, calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${url.replace(API, "")}`;
    const route = routes[key] ?? (method === "POST" ? { status: 201, body: {} } : undefined);
    if (!route) return new Response("not found", { status: 404 });
    const headers = new Headers(route.link ? { link: route.link } : {});
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers });
  }) as typeof fetch;
}

function routes(extra: Routes = {}): Routes {
  return {
    [`GET /repos/${REPO}/rules/branches/main?per_page=100`]: { body: rules() },
    [`GET /repos/${REPO}/pulls?state=open&base=main&per_page=100`]: { body: [pull()] },
    [`GET /repos/${REPO}/commits/${A}/check-runs?filter=latest&per_page=100`]: { body: { total_count: 1, check_runs: [checkRun("typescript", "failure", 30)] } },
    [`GET /repos/${REPO}/issues/7/comments?per_page=100`]: { body: [] },
    ...extra,
  };
}

const env = (extra: Record<string, string> = {}) => ({ GITHUB_REPOSITORY: REPO, ...extra });
const client = (calls: Call[], r: Routes = routes()) => githubClient({ api: API, token: "t", fetch: fakeFetch(r, calls) });

test("nextLink reads only the rel=next target", () => {
  assert.equal(nextLink(`<${API}/a?page=2>; rel="next", <${API}/a?page=9>; rel="last"`), `${API}/a?page=2`);
  assert.equal(nextLink(`<${API}/a?page=1>; rel="prev"`), null);
  assert.equal(nextLink(null), null);
});

test("list follows next links, and more pages than allowed is an error", async () => {
  const calls: Call[] = [];
  const paged = client(calls, {
    "GET /x?per_page=100": { body: [1, 2], link: `<${API}/x?page=2>; rel="next"` },
    "GET /x?page=2": { body: { items: [3] } },
  });
  await assert.rejects(paged.list("/x", null, 2), /did not answer a list/);
  const ok = client(calls, {
    "GET /x?per_page=100": { body: [1, 2], link: `<${API}/x?page=2>; rel="next"` },
    "GET /x?page=2": { body: [3] },
  });
  assert.deepEqual(await ok.list("/x", null, 2), [1, 2, 3]);
  await assert.rejects(ok.list("/x", null, 1), /more than 1 page/);
});

test("get reads one object and throws on a non-2xx answer (#973)", async () => {
  const calls: Call[] = [];
  const gh = client(calls, { "GET /one": { body: { id: 1 } }, "GET /gone": { status: 404, body: {} } });
  assert.deepEqual(await gh.get("/one"), { id: 1 });
  await assert.rejects(gh.get("/gone"), /GET \/gone answered HTTP 404/);
  assert.deepEqual(calls.map((c) => c.method), ["GET", "GET"]);
});

test("a next link outside the API origin is refused", async () => {
  const calls: Call[] = [];
  const evil = client(calls, { "GET /x?per_page=100": { body: [1], link: `<https://elsewhere.example/x?page=2>; rel="next"` } });
  await assert.rejects(evil.list("/x", null, 5), /outside/);
  assert.equal(calls.length, 1);
});

test("a stalled pull request gets the comment, then the assignment", async () => {
  const calls: Call[] = [];
  const result = await run(env(), client(calls), NOW);
  assert.equal(result.code, 0, result.lines.join("\n"));
  const posts = calls.filter((c) => c.method === "POST");
  assert.deepEqual(posts.map((c) => c.url.replace(API, "")), [`/repos/${REPO}/issues/7/comments`, `/repos/${REPO}/issues/7/assignees`]);
  assert.ok(String((posts[0].body as { body: string }).body).startsWith(marker(A)));
  assert.deepEqual(posts[1].body, { assignees: ["example-author"] });
  assert.match(result.lines[0], /scanned 1, stalled 1, already reported 0, skipped drafts 0, writes 2/);
});

test("dry run writes nothing and says what it would do", async () => {
  const calls: Call[] = [];
  const result = await run(env({ STALL_WATCH_DRY_RUN: "true" }), client(calls), NOW);
  assert.equal(result.code, 0);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  assert.ok(result.lines.some((l) => /dry run, would comment on pull request 7/.test(l)));
});

test("an existing bot marker for the head means no second comment; only a missing assignment is written", async () => {
  const commented = { [`GET /repos/${REPO}/issues/7/comments?per_page=100`]: { body: [comment(BOT, marker(A))] } };
  const assigned = { [`GET /repos/${REPO}/pulls?state=open&base=main&per_page=100`]: { body: [pull({ assignees: [{ login: "example-author" }] })] } };
  const calls: Call[] = [];
  const result = await run(env(), client(calls, routes({ ...commented, ...assigned })), NOW);
  assert.equal(result.code, 0);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  assert.match(result.lines[0], /already reported 1/);
  const retry: Call[] = [];
  await run(env(), client(retry, routes(commented)), NOW);
  assert.deepEqual(retry.filter((c) => c.method === "POST").map((c) => c.url.replace(API, "")), [`/repos/${REPO}/issues/7/assignees`]);
});

test("a refused comment skips the assignment and exits 2", async () => {
  const calls: Call[] = [];
  const r = routes({ [`POST /repos/${REPO}/issues/7/comments`]: { status: 403, body: {} } });
  const result = await run(env(), client(calls, r), NOW);
  assert.equal(result.code, 2);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  assert.ok(result.lines.some((l) => /HTTP 403/.test(l)));
});

test("failed reads exit 2 and are never reported as nothing stalled", async () => {
  for (const broken of [`GET /repos/${REPO}/rules/branches/main?per_page=100`, `GET /repos/${REPO}/commits/${A}/check-runs?filter=latest&per_page=100`, `GET /repos/${REPO}/issues/7/comments?per_page=100`]) {
    const calls: Call[] = [];
    const result = await run(env(), client(calls, routes({ [broken]: { status: 500, body: {} } })), NOW);
    assert.equal(result.code, 2, broken);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0, broken);
  }
  const capped = routes({ [`GET /repos/${REPO}/pulls?state=open&base=main&per_page=100`]: { body: [pull()], link: `<${API}/more>; rel="next"` } });
  assert.equal((await run(env(), client([], capped), NOW)).code, 2);
});

test("a malformed repository or time zone is reported", async () => {
  assert.equal((await run({}, client([]), NOW)).code, 2);
  const calls: Call[] = [];
  const result = await run(env({ STALL_WATCH_TIMEZONE: "Nowhere/Invalid", STALL_WATCH_DRY_RUN: "true" }), client(calls), NOW);
  assert.equal(result.code, 2);
  assert.ok(result.lines.some((l) => /STALL_WATCH_TIMEZONE/.test(l)));
});
