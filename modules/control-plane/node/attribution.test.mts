// Issue #325, PR-A. The local attribution log: one JSON object per line in
// <configRoot>/control-plane/attribution.jsonl, written by the pre-push git hook
// and the gh pr create hook, read only by `kherep-node attribution`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import * as attribution from "./attribution.mts";
import { nodePaths, type NodePaths } from "./config.mts";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-10-08T12:00:00.000Z");

function tempPaths(t: TestContext): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-attribution-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return nodePaths(root);
}

function record(ts: number, sha: string): attribution.AttributionRecord {
  return { v: 1, ts: new Date(ts).toISOString(), kind: "push", sessionId: "synthetic-session-1", runtime: "claude",
    sessionSource: "CLAUDE_CODE_SESSION_ID", repo: "example/repo", toplevel: "/synthetic/repo", branch: "feat/x",
    remoteRef: "refs/heads/feat/x", sha, pr: null };
}

test("nodePaths names the attribution log and the pending markers in the control-plane directory", () => {
  const paths = nodePaths(path.join("/synthetic", "root"));
  assert.equal(paths.attribution, path.join("/synthetic", "root", "control-plane", "attribution.jsonl"));
  assert.equal(paths.attributionPending, path.join("/synthetic", "root", "control-plane", "attribution", "pending"));
});

test("append then read returns the records, and malformed lines are skipped", (t) => {
  const paths = tempPaths(t);
  attribution.appendAttribution(paths, record(NOW - 1000, "a".repeat(40)), NOW);
  fs.appendFileSync(paths.attribution, "not json\n{\"v\":2}\n[]\n\n");
  attribution.appendAttribution(paths, record(NOW, "b".repeat(40)), NOW);
  assert.deepEqual(attribution.readAttribution(paths).map((entry) => entry.sha), ["a".repeat(40), "b".repeat(40)]);
});

test("reading a log that does not exist yet returns no records", (t) => {
  assert.deepEqual(attribution.readAttribution(tempPaths(t)), []);
});

test("the log is created with mode 0600", { skip: process.platform === "win32" }, (t) => {
  const paths = tempPaths(t);
  attribution.appendAttribution(paths, record(NOW, "c".repeat(40)), NOW);
  assert.equal(fs.statSync(paths.attribution).mode & 0o777, 0o600);
});

// The coordinator's retention proof: the trim runs on the real append path.
test("an append trims records older than 90 days and keeps the fresh ones", (t) => {
  const paths = tempPaths(t);
  fs.mkdirSync(path.dirname(paths.attribution), { recursive: true });
  const stale = record(NOW - 91 * DAY, "d".repeat(40));
  const kept = record(NOW - 89 * DAY, "e".repeat(40));
  fs.writeFileSync(paths.attribution, `${JSON.stringify(stale)}\n${JSON.stringify(kept)}\n`);
  attribution.appendAttribution(paths, record(NOW, "f".repeat(40)), NOW);
  assert.deepEqual(attribution.readAttribution(paths).map((entry) => entry.sha), ["e".repeat(40), "f".repeat(40)]);
  assert.equal(attribution.ATTRIBUTION_RETENTION_MS, 90 * DAY);
});

test("repoSlug keeps owner/name and never the userinfo of a remote URL", () => {
  const cases: [string, string | null][] = [
    ["https://user:secret-token@git.example.test/example/repo.git", "example/repo"],
    ["https://git.example.test/example/repo", "example/repo"],
    ["git@git.example.test:example/repo.git", "example/repo"],
    ["ssh://git@example.com:2222/example/repo.git/", "example/repo"],
    ["/synthetic/remotes/example/repo.git", "example/repo"],
    ["C:\\synthetic\\remotes\\example\\repo.git", "example/repo"],
    ["", null],
  ];
  for (const [url, slug] of cases) assert.equal(attribution.repoSlug(url), slug, url);
});

test("session ids are plain file-name characters", () => {
  for (const id of ["0198d1c2-aaaa-7bbb-8ccc-123456789abc", "synthetic-session-1"]) assert.ok(attribution.isSessionId(id), id);
  for (const id of ["", "../x", "a/b", "a\nb", "x".repeat(200), 7]) assert.ok(!attribution.isSessionId(id), String(id));
});

test("a pending marker is keyed by the toplevel and holds only id, runtime and time", (t) => {
  const paths = tempPaths(t);
  attribution.writePendingMarker(paths, "/synthetic/repo", "synthetic-codex-1", "codex", NOW);
  const file = attribution.pendingMarkerFile(paths, "/synthetic/repo/");
  assert.equal(path.dirname(file), paths.attributionPending);
  assert.match(path.basename(file), /^[0-9a-f]{64}\.json$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")),
    { sessionId: "synthetic-codex-1", runtime: "codex", at: new Date(NOW).toISOString() });
  attribution.writePendingMarker(paths, "/synthetic/repo", "../escape", "codex", NOW);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).sessionId, "synthetic-codex-1", "an invalid id writes no marker");
});
