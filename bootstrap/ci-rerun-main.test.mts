// Issue #973. The write allow-list of the CI rerun client, the real clock, and the entry
// point bootstrap/ci-rerun-main.mts run as a child process against a local API stub.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { guardWrites, realClock } from "./ci-rerun.mts";
import type { GithubClient } from "./stall-watch-github.mts";
import { REPO, RUNS } from "./ci-rerun.fixture.mts";

const MAIN = path.join(import.meta.dirname, "ci-rerun-main.mts");

function recorder(): { gh: GithubClient; calls: string[] } {
  const calls: string[] = [];
  const gh: GithubClient = {
    get: async (p) => { calls.push(`GET ${p}`); return {}; },
    list: async (p, key, pages) => { calls.push(`LIST ${p} ${key} ${pages}`); return []; },
    post: async (p, body) => { calls.push(`POST ${p} ${JSON.stringify(body)}`); },
  };
  return { gh, calls };
}

test("only POST rerun-failed-jobs with {} passes, and nothing in a dry run", async () => {
  const { gh, calls } = recorder();
  const guarded = guardWrites(gh, REPO, false);
  await guarded.get("/x");
  await guarded.list("/y", "jobs", 2);
  await guarded.post(`/repos/${REPO}/actions/runs/123/rerun-failed-jobs`, {});
  for (const [p, body] of [
    [`/repos/${REPO}/actions/runs/123/rerun`, {}],
    [`/repos/${REPO}/actions/runs/123/rerun-failed-jobs`, { enable_debug_logging: true }],
    [`/repos/${REPO}/actions/runs/12a/rerun-failed-jobs`, {}],
    [`/repos/other/repo/actions/runs/123/rerun-failed-jobs`, {}],
    [`/repos/${REPO}/issues/1/comments`, { body: "x" }],
  ] as const) await assert.rejects(guarded.post(p, body), /write refused by the allow-list/);
  await assert.rejects(guardWrites(gh, REPO, true).post(`/repos/${REPO}/actions/runs/123/rerun-failed-jobs`, {}), /refused/);
  await assert.rejects(guardWrites(gh, "", false).post("/repos//actions/runs/1/rerun-failed-jobs", {}), /refused/);
  assert.deepEqual(calls, ["GET /x", "LIST /y jobs 2", `POST /repos/${REPO}/actions/runs/123/rerun-failed-jobs {}`]);
});

test("the real clock reads time and waits", async () => {
  const before = realClock.now();
  await realClock.sleep(5);
  assert.ok(realClock.now() >= before);
});

function node(env: Record<string, string>): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    // NODE_V8_COVERAGE passes through so the coverage producers measure the entry point.
    const coverage = process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {};
    execFile(process.execPath, [MAIN], { env: { PATH: process.env.PATH ?? "", ...coverage, ...env } }, (error, stdout) => {
      resolve({ code: error ? Number(error.code) : 0, stdout });
    });
  });
}

test("the entry point without a token exits 2 and writes the step summary", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-rerun-main-"));
  const summary = path.join(dir, "summary.md");
  try {
    const result = await node({ GITHUB_STEP_SUMMARY: summary });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "GITHUB_TOKEN is missing\n");
    assert.equal(fs.readFileSync(summary, "utf8"), "## CI rerun\n\n- GITHUB_TOKEN is missing\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the entry point evaluates one run read-only against the API it is given", async () => {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url} ${request.headers.authorization}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(RUNS["43909265750-1"]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const result = await node({
      GITHUB_TOKEN: "test-token", GITHUB_API_URL: `http://127.0.0.1:${port}`, GITHUB_REPOSITORY: REPO,
      GITHUB_EVENT_NAME: "workflow_dispatch", CI_RERUN_RUN_ID: "43909265750", CI_RERUN_DRY_RUN: "true",
    });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.stdout, "dry run: no write\nrun 43909265750 attempt 1: no rerun, conclusion cancelled, not failure\n");
    assert.deepEqual(seen, [`GET /repos/${REPO}/actions/runs/43909265750 Bearer test-token`]);
  } finally {
    server.close();
  }
});
