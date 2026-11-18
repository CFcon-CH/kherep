// Issue #507, part 2, review of 1dd1ca9 (P1). The runtime admits every process
// of one installation on the database of that installation's hooks root
// (<home>/hooks beside <home>/kherep/hook-runtime), a main or guard in a
// subdirectory of it included. No database is ever derived from a main's own
// directory, so an EXCLUSIVE writer on the root keeps nested mains out too.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { copyDeclared } from "./copy-declare-fixture.mts";
import { plantHeartbeat } from "./guard-dispatch-fixture.mts";
import { alive, cleanup, describeProbe, entry, entryAsync, fakeOpener, holdExclusive, type Home, probeWriter, runtimeHome, type Step, until,
  type WriterProbe, writerFree } from "./hook-runtime-fixture.mts";

after(cleanup);
// Constant program text: each hook names its marker relative to its own place (the home is hooks/..).
const TOP_MAIN = "import fs from \"node:fs\";\nfs.writeFileSync(new URL(\"../top.marker\", import.meta.url), \"executed\");\n";
const NESTED_MAIN = "import fs from \"node:fs\";\nfs.writeFileSync(new URL(\"../../nested.marker\", import.meta.url), \"executed\");\n";

interface Clock { now(): number; sleep(ms: number): Promise<void> }
const REAL: Clock = { now: () => performance.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
interface Wait { ok: boolean; attempts: number; summary: string }

// The final availability check (issue #641): one complete writer probe within a test deadline. The 10 s are a test
// tolerance, not a measured release bound. Only a classified busy open or BEGIN is retried; anything else fails at once,
// and no probe starts once the deadline has passed. A success after the deadline is still a failure.
async function writerFreeWithin(probe: () => Promise<WriterProbe>, clock = REAL, deadline = 10_000, every = 20): Promise<Wait> {
  const start = clock.now();
  const counts = { open: 0, begin: 0, rollback: 0, close: 0 };
  let attempts = 0;
  let first: WriterProbe | undefined;
  let last: WriterProbe | undefined;
  const sample = (p?: WriterProbe): string => (p ? `[${describeProbe(p)}]` : "none");
  const done = (outcome: string): Wait => ({ ok: outcome === "ok", attempts, summary: `root-runtime fixture writer probe: `
    + `outcome=${outcome} attempts=${attempts} elapsedMs=${Math.round(clock.now() - start)} failed open=${counts.open} `
    + `begin=${counts.begin} rollback=${counts.rollback} close=${counts.close} first=${sample(first)} last=${sample(last)}` });
  for (;;) {
    const result = await probe();
    attempts++;
    const elapsed = clock.now() - start;
    if (!result.ok) {
      first ??= result;
      last = result;
      if (result.phase) counts[result.phase]++;
      if (result.close === "error") counts.close++;
    }
    if (result.ok && elapsed <= deadline) return done("ok");
    if (!result.ok && !result.retryable) return done("fatal");
    if (elapsed >= deadline) return done(result.ok ? "late-success" : "timeout");
    await clock.sleep(Math.min(every, deadline - elapsed));
    if (clock.now() - start >= deadline) return done("timeout");
  }
}
// A late success stays visible in the test output; an immediate one is quiet.
function report(t: { diagnostic(message: string): void }, wait: Wait): void {
  if (wait.ok && wait.attempts > 1) t.diagnostic(wait.summary);
  assert.equal(wait.ok, true, wait.summary);
}

test("a main in a subdirectory waits for the root's writer like a main at the root", async () => {
  const home = runtimeHome();
  fs.mkdirSync(path.join(home.hooks, "sub"));
  const top = path.join(home.root, "top.marker");
  const nested = path.join(home.root, "nested.marker");
  fs.writeFileSync(path.join(home.hooks, "main.mts"), TOP_MAIN);
  fs.writeFileSync(path.join(home.hooks, "sub", "main.mts"), NESTED_MAIN);
  const release = await holdExclusive(home);
  const runs = [entryAsync("pretool", path.join(home.hooks, "main.mts")), entryAsync("pretool", path.join(home.hooks, "sub", "main.mts"))];
  await new Promise((resolve) => setTimeout(resolve, 800));
  const whileExclusive = { topExecuted: fs.existsSync(top), nestedExecuted: fs.existsSync(nested),
    nestedDbCreated: fs.existsSync(path.join(home.hooks, "sub", ".kherep-integrity")) };
  release();
  const done = await Promise.all(runs);
  assert.deepEqual(whileExclusive, { topExecuted: false, nestedExecuted: false, nestedDbCreated: false });
  for (const run of done) assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.existsSync(top) && fs.existsSync(nested), true, "both ran after the release");
  assert.equal(fs.existsSync(path.join(home.hooks, "sub", ".kherep-integrity")), false, "only the root database exists");
});

test("a nested guard under the dispatcher holds the root's database, also when it outlives its parents", async (t) => {
  const home = runtimeHome();
  fs.mkdirSync(path.join(home.hooks, "sub"));
  copyDeclared(path.join(import.meta.dirname, "guard-dispatch.mts"), path.join(home.hooks, "guard-dispatch.mts"));
  copyDeclared(path.join(import.meta.dirname, "lib", "guard-recheck.mts"), path.join(home.hooks, "lib", "guard-recheck.mts"));
  plantHeartbeat(home.root);
  const go = path.join(home.root, "go");
  const pids = path.join(home.root, "pids");
  // The pids arrive by rename: a poller never sees the file created but not yet written (issue #565).
  fs.writeFileSync(path.join(home.hooks, "sub", "guard.mts"), "import fs from \"node:fs\";\n"
    + "fs.writeFileSync(new URL(\"../../pids.tmp\", import.meta.url), JSON.stringify([process.pid, process.ppid]));\n"
    + "fs.renameSync(new URL(\"../../pids.tmp\", import.meta.url), new URL(\"../../pids\", import.meta.url));\n"
    + "while (!fs.existsSync(new URL(\"../../go\", import.meta.url))) await new Promise((r) => setTimeout(r, 20));\n");
  const running = entryAsync("pretool", path.join(home.hooks, "guard-dispatch.mts"), [path.join(home.hooks, "sub", "guard.mts")],
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "true" } }));
  assert.ok(await until(() => fs.existsSync(pids)), "the nested guard was admitted and runs");
  const [guard, dispatcher] = JSON.parse(fs.readFileSync(pids, "utf8")) as number[];
  process.kill(running.pid!, "SIGKILL");
  process.kill(dispatcher!, "SIGKILL");
  await running;
  assert.ok(await until(() => !alive(dispatcher!)));
  if (process.platform === "win32") {
    // A Windows child ends with its parent (libuv's job object): its lock goes only with it.
    assert.ok(await until(() => !alive(guard!)), "the guard ends with its dispatcher");
  } else {
    assert.equal(alive(guard!), true, "the guard outlives its parents");
    assert.equal(await writerFree(home), false, "and still holds the root's database");
    fs.writeFileSync(go, "");
    assert.ok(await until(() => !alive(guard!)), "the guard ends by itself");
  }
  report(t, await writerFreeWithin(() => probeWriter(home)));
  assert.equal(fs.existsSync(path.join(home.hooks, "sub", ".kherep-integrity")), false, "only the root database exists");
});

test("only the root's own live-hook-integrity.mts is a writer, and a main of another installation is refused", () => {
  const home = runtimeHome();
  fs.mkdirSync(path.join(home.hooks, "sub"));
  fs.writeFileSync(path.join(home.hooks, "sub", "live-hook-integrity.mts"), "process.stdout.write(\"ran\");\n");
  const nestedWriter = entry("writer", path.join(home.hooks, "sub", "live-hook-integrity.mts"));
  assert.equal(nestedWriter.stdout, "");
  assert.match(nestedWriter.stderr, /not admitted: mode/);
  const other = runtimeHome();
  fs.writeFileSync(path.join(other.hooks, "main.mts"), "process.stdout.write(\"ran\");\n");
  const foreign = entry("pretool", path.join(other.hooks, "main.mts"), [], "{}", 40_000, process.env, home);
  assert.match(JSON.parse(foreign.stdout).hookSpecificOutput.permissionDecisionReason, /not admitted: main-outside/);
  assert.equal(fs.existsSync(path.join(other.hooks, ".kherep-integrity")), false, "no database beside a foreign main");
});

// Issue #641: the writer probe's phases, its busy-only wait and its fixed diagnostics, on fake connections and clocks.
const FAKE: Home = { root: "", hooks: "", db: "", runtime: "" };
const SECRET = "/Users/someone/private/run.sqlite\n\u0007";
const sqlite = (errcode: unknown): Error => Object.assign(new Error(`SQLITE ${SECRET}`), { errcode });
const refusal = (kind: string): Error => Object.assign(new Error(`hook runtime: ${kind}`), { kherepKind: kind });
type Fail = Partial<Record<Step, unknown>>;
const BEGUN = "open BEGIN EXCLUSIVE close";
const FULL = "open BEGIN EXCLUSIVE ROLLBACK close";
const CASES: [string, Fail, string, Partial<WriterProbe>, boolean | "rejects"][] = [
  ["complete", {}, FULL, { ok: true, retryable: false, acquired: true, rolledBack: true, close: "ok" }, true],
  ["open busy", { open: refusal("busy") }, "open", { phase: "open", error: { kind: "busy" }, retryable: true, close: "not-returned" }, false],
  ["open database", { open: refusal("database") }, "open", { phase: "open", error: { kind: "database" }, retryable: false }, false],
  ["open raw busy code", { open: sqlite(5) }, "open", { phase: "open", error: { kind: "other", errcode: 5 }, retryable: false }, false],
  ["open unknown kind", { open: refusal(SECRET) }, "open", { phase: "open", error: { kind: "other" }, retryable: false }, false],
  ["begin busy", { begin: sqlite(5) }, BEGUN, { phase: "begin", acquired: false, rolledBack: false, close: "ok", retryable: true }, false],
  ["begin locked", { begin: sqlite(6) }, BEGUN, { error: { kind: "other", errcode: 6 }, retryable: true }, false],
  ["begin extended busy", { begin: sqlite(517) }, BEGUN, { retryable: true }, false],
  ["begin busy refusal", { begin: refusal("busy") }, BEGUN, { error: { kind: "busy" }, retryable: true }, false],
  ["begin other code", { begin: sqlite(1) }, BEGUN, { error: { kind: "other", errcode: 1 }, retryable: false }, false],
  ["begin no code", { begin: new Error(SECRET) }, BEGUN, { error: { kind: "other" }, retryable: false }, false],
  ["begin string code", { begin: sqlite("5") }, BEGUN, { error: { kind: "other" }, retryable: false }, false],
  ["rollback", { rollback: sqlite(5) }, FULL, { phase: "rollback", acquired: true, rolledBack: false, close: "ok", retryable: false }, false],
  ["close only", { close: sqlite(5) }, FULL,
    { ok: false, phase: undefined, rolledBack: true, close: "error", closeError: { kind: "other", errcode: 5 }, retryable: false }, "rejects"],
  ["begin busy and close", { begin: sqlite(5), close: sqlite(1) }, BEGUN, { phase: "begin", error: { kind: "other", errcode: 5 },
    close: "error", closeError: { kind: "other", errcode: 1 }, retryable: false }, "rejects"],
  ["rollback and close", { rollback: sqlite(1), close: refusal("busy") }, FULL,
    { phase: "rollback", error: { kind: "other", errcode: 1 }, close: "error", closeError: { kind: "busy" }, retryable: false }, "rejects"],
];
const clean = (text: string): boolean => /^[\x20-\x7e]*$/.test(text) && !text.includes("someone");

test("the writer probe keeps open, BEGIN, ROLLBACK and close apart, and writerFree keeps its boolean", async () => {
  for (const [name, fail, events, expected, legacy] of CASES) {
    const seen: string[] = [];
    const probe = await probeWriter(FAKE, fakeOpener(fail, seen));
    assert.equal(seen.join(" "), events, name);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(probe[key as keyof WriterProbe], value, `${name}: ${key}`);
    assert.equal(clean(JSON.stringify(probe)) && clean(describeProbe(probe)), true, name);
    const again: string[] = [];
    if (legacy === "rejects") {
      await assert.rejects(writerFree(FAKE, fakeOpener(fail, again)), (error: Error) => clean(error.message) && error.cause === undefined);
    } else assert.equal(await writerFree(FAKE, fakeOpener(fail, again)), legacy, name);
    assert.equal(again.join(" "), events, `${name}: one attempt`);
  }
});

// Scripted probes on a fake clock: fail(n) names the injected errors of attempt n; each attempt takes `cost` ms.
function scripted(fail: (n: number) => Fail, cost = 0) {
  let now = 0;
  let running = false;
  const starts: number[] = [];
  const sleeps: number[] = [];
  const clock: Clock = { now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } };
  const probe = async (): Promise<WriterProbe> => {
    assert.equal(running, false, "one probe at a time");
    running = true;
    starts.push(now);
    now += cost;
    try { return await probeWriter(FAKE, fakeOpener(fail(starts.length))); } finally { running = false; }
  };
  return { clock, probe, starts, sleeps };
}

test("the wait retries busy until a complete probe, and reports the late success once", async () => {
  const run = scripted((n) => (n < 3 ? { begin: sqlite(5) } : {}), 3);
  const wait = await writerFreeWithin(run.probe, run.clock);
  assert.deepEqual([wait.ok, wait.attempts, run.starts.length], [true, 3, 3]);
  assert.ok(run.sleeps.every((ms) => ms > 0 && ms <= 20));
  assert.match(wait.summary, /outcome=ok attempts=3 .* begin=2 .*first=\[phase=begin error=other\/5 .*last=\[phase=begin/);
  const notes: string[] = [];
  report({ diagnostic: (message) => notes.push(message) }, wait);
  const immediate = scripted(() => ({}));
  report({ diagnostic: (message) => notes.push(message) }, await writerFreeWithin(immediate.probe, immediate.clock));
  assert.deepEqual(notes, [wait.summary], "a delayed success is reported once, an immediate one not at all");
});

test("the wait stops at the deadline: no probe after it, and a success after it fails", async () => {
  const busy = scripted(() => ({ open: refusal("busy") }), 7);
  const wait = await writerFreeWithin(busy.probe, busy.clock);
  assert.equal(wait.ok, false);
  assert.ok(busy.starts.every((at) => at < 10_000), "no probe starts after the deadline");
  assert.deepEqual([busy.starts.length, busy.sleeps.at(-1), busy.clock.now()], [371, 3, 10_000], "the last sleep is capped");
  assert.match(wait.summary, /outcome=timeout attempts=371 elapsedMs=10000 failed open=371 .*last=\[phase=open error=busy /);
  const late = scripted(() => ({}), 10_500);
  assert.match((await writerFreeWithin(late.probe, late.clock)).summary, /outcome=late-success attempts=1 /);
});

test("the wait fails at once on anything but busy, and never consumes the success after it", async () => {
  for (const fatal of [{ open: refusal("database") }, { open: sqlite(5) }, { begin: sqlite(1) }, { rollback: sqlite(5) },
    { begin: sqlite(5), close: sqlite(5) }, { close: sqlite(5) }]) {
    const run = scripted((n) => (n === 1 ? fatal : {}));
    const wait = await writerFreeWithin(run.probe, run.clock);
    assert.deepEqual([wait.ok, wait.attempts, run.starts.length, run.sleeps.length], [false, 1, 1, 0], Object.keys(fatal).join("+"));
    assert.match(wait.summary, /outcome=fatal attempts=1 /);
    assert.equal(clean(wait.summary), true);
  }
  const secret = scripted((n) => (n === 1 ? { begin: Object.assign(sqlite(5), { kherepKind: SECRET }) } : {}));
  const late = await writerFreeWithin(secret.probe, secret.clock);
  assert.deepEqual([late.ok, late.attempts, clean(late.summary)], [true, 2, true], "a late-success diagnostic carries no raw error");
});

test("on SQLite, a held exclusive lock passes once released; a lock past the deadline or a missing root fails", async (t) => {
  const home = runtimeHome();
  let release = await holdExclusive(home);
  setTimeout(release, 1_000);
  const freed = await writerFreeWithin(() => probeWriter(home));
  report(t, freed);
  assert.ok(freed.attempts > 1, freed.summary);
  release = await holdExclusive(home);
  const held = await writerFreeWithin(() => probeWriter(home), REAL, 300);
  release();
  t.diagnostic(held.summary);
  assert.match(held.summary, /outcome=timeout .*last=\[phase=(open|begin) error=/);
  const missing = await writerFreeWithin(() => probeWriter({ ...home, hooks: path.join(home.root, "missing") }));
  assert.match(missing.summary, /outcome=fatal attempts=1 .*first=\[phase=open error=root /);
});
