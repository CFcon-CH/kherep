import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  INSTALL_PAUSE_STALE_MS, installPaused, installPauseFile, markedProbe, noticeInterruptedProbe, PROBE_MARKER_STALE_MS, probeInFlight,
  probeMarkerFile,
} from "./install-pause.mts";

// Issue #403: the install lock pauses Claude probing only while it is fresh.
test("no lock, a fresh lock and a stale lock", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-install-pause-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = { dir };
  const now = Date.now();
  assert.equal(installPaused(paths, now), false, "no lock");
  fs.writeFileSync(installPauseFile(paths), "pid=1\n");
  assert.equal(installPaused(paths, now), true, "fresh lock");
  const old = new Date(now - INSTALL_PAUSE_STALE_MS - 60_000);
  fs.utimesSync(installPauseFile(paths), old, old);
  assert.equal(installPaused(paths, now), false, "a 31-minute-old lock is stale");
  const future = new Date(now + INSTALL_PAUSE_STALE_MS + 60_000);
  fs.utimesSync(installPauseFile(paths), future, future);
  assert.equal(installPaused(paths, now), false, "a lock from the far future cannot pause for good");
  fs.rmSync(installPauseFile(paths));
  fs.mkdirSync(installPauseFile(paths));
  assert.equal(installPaused(paths, now), false, "a directory is not the lock");
});

test("a Claude probe is marked in flight and does not start once the install lock exists", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-install-pause-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = { dir };
  let seen = false;
  assert.deepEqual(await markedProbe(paths, async () => {
    seen = probeInFlight(paths);
    return { ok: true };
  }), { ok: true });
  assert.equal(seen, true, "the marker exists while the probe runs");
  assert.equal(fs.existsSync(probeMarkerFile(paths)), false, "and is removed afterwards");
  fs.writeFileSync(installPauseFile(paths), "pid=1\n");
  let started = false;
  const result = await markedProbe(paths, async () => { started = true; return { ok: true }; });
  assert.equal(started, false, "a lock written before the marker check stops the probe");
  assert.deepEqual(result, { ok: false, cause: "error", detail: "probe deferred: install in progress" });
  assert.equal(fs.existsSync(probeMarkerFile(paths)), false);
  fs.writeFileSync(probeMarkerFile(paths), "1\n");
  const old = new Date(Date.now() - PROBE_MARKER_STALE_MS - 1_000);
  fs.utimesSync(probeMarkerFile(paths), old, old);
  assert.equal(probeInFlight(paths), false, "a marker a crashed daemon left is stale after the probe bound");
});

// Issue #420: a killed daemon never removes its marker; the next daemon names
// the interrupted probe instead of overwriting the marker silently.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test("the marker names the daemon pid and the probe start", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-install-pause-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let content = "";
  await markedProbe({ dir }, async () => { content = fs.readFileSync(probeMarkerFile({ dir }), "utf8"); return { ok: true }; });
  const [pid, at] = content.trimEnd().split(" ");
  assert.equal(Number(pid), process.pid);
  assert.match(at, ISO);
  assert.ok(content.endsWith("\n"));
});

test("a marker of a dead daemon is reported, removed and returned; a live daemon's stays; none is nothing", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-install-pause-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = { dir };
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  assert.equal(noticeInterruptedProbe(paths, log), null, "no marker");
  assert.deepEqual(logs, []);

  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  fs.writeFileSync(probeMarkerFile(paths), `${dead} 2026-10-15T08:00:00.000Z\n`);
  const record = noticeInterruptedProbe(paths, log);
  const { noticedAt, ...interrupted } = record!;
  assert.deepEqual(interrupted, { runtime: "claude", pid: dead, at: "2026-10-15T08:00:00.000Z" });
  assert.match(noticedAt, ISO);
  assert.equal(fs.existsSync(probeMarkerFile(paths)), false, "removed");
  assert.deepEqual(logs, [`kherep-node: the previous daemon stop interrupted a claude probe (daemon pid ${dead}, started `
    + "2026-10-15T08:00:00.000Z); if the next probe reports sign-in required, that stop likely interrupted a login renewal"]);

  logs.length = 0;
  fs.writeFileSync(probeMarkerFile(paths), `${process.pid} ${new Date().toISOString()}\n`);
  assert.equal(noticeInterruptedProbe(paths, log), null, "another daemon's probe is in flight");
  assert.equal(fs.existsSync(probeMarkerFile(paths)), true, "and its marker stays");
  assert.deepEqual(logs, [`kherep-node: another daemon's claude probe (daemon pid ${process.pid}) is in flight`]);

  logs.length = 0;
  const old = new Date(Date.now() - PROBE_MARKER_STALE_MS - 1_000);
  fs.utimesSync(probeMarkerFile(paths), old, old);
  assert.equal(noticeInterruptedProbe(paths, log)?.pid, process.pid, "a live pid on a stale marker is a reused pid");
  assert.equal(fs.existsSync(probeMarkerFile(paths)), false);
});

test("a legacy marker with only the pid takes its start from the file time", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-install-pause-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  fs.writeFileSync(probeMarkerFile({ dir }), `${dead}\n`);
  const mtime = new Date("2026-10-12T09:30:00.000Z");
  fs.utimesSync(probeMarkerFile({ dir }), mtime, mtime);
  const record = noticeInterruptedProbe({ dir }, () => {});
  assert.deepEqual([record?.pid, record?.at], [dead, "2026-10-12T09:30:00.000Z"]);
});

test("interrupted probe markers parse bounded pids and emit reconstructed canonical ISO times", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-install-pause-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = { dir }, fallback = "2026-10-12T09:30:00.000Z", started = "2026-10-15T08:00:00.000Z";
  const rows: [string, number | null, string][] = [
    [`123 ${started}\n`, 123, started],
    [`0 ${started}`, null, started],
    [`0123 ${started}`, null, started],
    [`2147483648 ${started}`, null, started],
    [`999999999999999999999999 ${started}`, null, started],
    ["123 2026-10-15", 123, fallback],
    ["123 2026-02-30T08:00:00.000Z", 123, fallback],
    ["123 2026-10-15T08:00:00.000Z\u001b[31m", 123, fallback],
    [`123 ${started} extra`, null, fallback],
  ];
  for (const [content, pid, at] of rows) {
    fs.writeFileSync(probeMarkerFile(paths), content);
    const mtime = new Date(fallback);
    fs.utimesSync(probeMarkerFile(paths), mtime, mtime);
    const seen: unknown[] = [], logs: string[] = [];
    const record = noticeInterruptedProbe(paths, (line) => logs.push(line), (value) => { seen.push(value); return false; });
    assert.deepEqual([record?.pid, record?.at], [pid, at]);
    assert.deepEqual(seen, pid === null ? [] : [pid]);
    assert.ok(logs[0]?.includes(`daemon pid ${pid ?? "unknown"}, started ${at})`));
    assert.equal(logs[0]?.includes("\u001b"), false);
    assert.equal(fs.existsSync(probeMarkerFile(paths)), false);
  }
});
