// Issue #965: the refusals of kherep/hook-runtime/replay-pending.mts that the F2 suite
// (hook-runtime-replay.test.mts) does not reach: argument parsing, a database without a
// pending intent or with a foreign schema, an intent recorded for an absent target, a
// target that cannot be measured, and a state that changes between the two transactions.
// Synthetic temporary homes only; inspect and replay are called in this process.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { openDatabase } from "../kherep/hook-runtime/coordinator-db.mts";
import { recordIntent } from "../kherep/hook-runtime/coordinator-intent.mts";
import { inspect, parse, replay, type ReplayArgs } from "../kherep/hook-runtime/replay-pending.mts";
import { withoutTypeStrippingWarning } from "../../codex/lib/node-warning-fixture.mts";
import { cleanup, database, type Home, runtimeHome } from "./hook-runtime-fixture.mts";

after(cleanup);
const CLI = path.resolve(import.meta.dirname, "..", "kherep", "hook-runtime", "replay-pending.mts");
const GOOD = Buffer.from("// the recorded repair\nexport {};\n");

// A home whose database holds one pending intent for rel; the target exists (empty) unless absent.
async function pendingHome(rel = "guard.mts", { absent = false } = {}): Promise<{ home: Home; file: string; intent: string; sha: string }> {
  const home = runtimeHome("hook-runtime-replay-refusals-");
  const file = path.join(home.hooks, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!absent) fs.writeFileSync(file, "");
  const o = await database(home);
  try {
    o.conn.exec("BEGIN EXCLUSIVE");
    const recorded = recordIntent(o, rel, GOOD);
    o.conn.exec("COMMIT");
    return { home, file, intent: recorded.intent, sha: recorded.sha };
  } finally { o.conn.close(); }
}

// Arguments in valid form for home: the pending intent's own values where given, zeros otherwise.
const argsFor = (home: Home, intent = "0".repeat(32), sha = "0".repeat(64)): ReplayArgs =>
  ({ hooksRoot: home.hooks, intent, desiredSha: sha, currentDev: "1", currentIno: "1", currentSha: "0".repeat(64) });

test("parse takes each known flag once with a value, and only the flags of its command", () => {
  for (const argv of [[], ["nope"], ["inspect", "--hooks-root"], ["inspect", "--hooks-root", "/a", "--hooks-root", "/b"],
    ["inspect", "--nope", "x"], ["inspect", "--intent", "x"]]) assert.equal(parse(argv), null, JSON.stringify(argv));
  assert.deepEqual(parse(["inspect", "--hooks-root", "/r"]), { command: "inspect", args: { hooksRoot: "/r" } });
  assert.deepEqual(parse(["replay", "--intent", "i"]), { command: "replay", args: { intent: "i" } });
});

test("the command line: usage exits 2 with its usage text; a refusal exits 1; a finding exits 0", async () => {
  const cli = (...argv: string[]) => spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8", windowsHide: true });
  for (const argv of [[], ["inspect"], ["inspect", "--hooks-root", "relative/hooks"]]) {
    const run = cli(...argv);
    assert.deepEqual([run.status, run.stdout], [2, "replay-pending: usage\n"], JSON.stringify(argv));
    assert.match(withoutTypeStrippingWarning(run.stderr, 1), /^usage: replay-pending\.mts inspect --hooks-root <root> \| replay /);
  }
  const bare = runtimeHome("hook-runtime-replay-refusals-");
  const refused = cli("inspect", "--hooks-root", bare.hooks);
  assert.deepEqual([refused.status, refused.stdout], [1, "replay-pending: database\n"]);
  assert.equal(fs.existsSync(path.join(bare.hooks, ".kherep-integrity")), false, "no database was created");
  const s = await pendingHome();
  const found = cli("inspect", "--hooks-root", s.home.hooks);
  assert.equal(found.status, 0, found.stderr);
  assert.match(found.stdout, new RegExp(`^replay-pending: pending\nintent=${s.intent}\n`));
});

test("an uninitialized database, an initialized one without an intent, and a foreign schema", async () => {
  const empty = runtimeHome("hook-runtime-replay-refusals-");
  (await openDatabase(empty.hooks)).conn.close();
  assert.deepEqual(await inspect(empty.hooks), { ok: true, code: "no-pending", lines: [] });
  assert.deepEqual(await replay(argsFor(empty)), { ok: false, code: "schema", lines: [] });
  const ready = runtimeHome("hook-runtime-replay-refusals-");
  (await database(ready)).conn.close();
  assert.deepEqual(await inspect(ready.hooks), { ok: true, code: "no-pending", lines: [] });
  assert.deepEqual(await replay(argsFor(ready)), { ok: false, code: "no-pending", lines: [] });
  const foreign = runtimeHome("hook-runtime-replay-refusals-");
  const f = await openDatabase(foreign.hooks);
  f.conn.exec("CREATE TABLE unrelated (x)");
  f.conn.close();
  assert.deepEqual(await inspect(foreign.hooks), { ok: false, code: "schema", lines: [] });
  assert.deepEqual(await replay(argsFor(foreign)), { ok: false, code: "schema", lines: [] });
});

test("inspect and replay: a target recorded absent is shown but never replayed", async () => {
  const s = await pendingHome("new.mts", { absent: true });
  const seen = await inspect(s.home.hooks);
  assert.equal(seen.code, "pending");
  assert.ok(seen.lines.includes("recorded-target=absent"), seen.lines.join("\n"));
  assert.ok(seen.lines.includes("current=unsupported (the target was recorded absent)"), seen.lines.join("\n"));
  assert.deepEqual(await replay(argsFor(s.home, s.intent, s.sha)), { ok: false, code: "absent-target-unsupported", lines: [] });
  assert.equal(fs.existsSync(s.file), false, "nothing was written");
});

test("inspect names a target it cannot measure by a fixed code instead of its identity", async () => {
  const s = await pendingHome();
  fs.rmSync(s.file);
  assert.ok((await inspect(s.home.hooks)).lines.includes("current=target-absent"));
  fs.mkdirSync(s.file);
  assert.ok((await inspect(s.home.hooks)).lines.includes("current=target-irregular"));
});

// The recorded parent reached through a linked ancestor that now resolves outside the hooks root.
test("inspect names a parent that resolves outside the hooks root, and never follows it", async () => {
  const s = await pendingHome("a/b/guard.mts");
  const outside = path.join(path.dirname(s.home.hooks), "outside");
  fs.mkdirSync(outside);
  fs.renameSync(path.join(s.home.hooks, "a"), path.join(outside, "a"));
  fs.symlinkSync(path.join(outside, "a"), path.join(s.home.hooks, "a"), "dir");
  assert.ok((await inspect(s.home.hooks)).lines.includes("current=parent-outside"));
  assert.equal(fs.readFileSync(path.join(outside, "a", "b", "guard.mts"), "utf8"), "");
});

test("a writer refusal without a known reason is reported by the fixed code refused", async () => {
  const s = await pendingHome();
  const out = await replay(confirmed(s), { writer: () => "an unclassified writer failure" });
  assert.deepEqual(out, { ok: false, code: "replay-refused", lines: ["reason=refused"] });
  assert.equal(fs.readFileSync(s.file, "utf8"), "");
});

test("arguments in the wrong form are usage, before any database is opened", async () => {
  const s = await pendingHome();
  const good = argsFor(s.home, s.intent, s.sha);
  for (const change of [{ hooksRoot: "relative" }, { intent: "A".repeat(32) }, { desiredSha: "0".repeat(63) }, { currentDev: "01" },
    { currentIno: "x" }, { currentSha: "g".repeat(64) }] as Partial<ReplayArgs>[]) {
    assert.deepEqual(await replay({ ...good, ...change }), { ok: false, code: "usage", lines: [] }, JSON.stringify(change));
  }
  for (const partial of [{ hooksRoot: 7 }, { hooksRoot: s.home.hooks }]) {
    assert.deepEqual(await replay(partial as unknown as ReplayArgs), { ok: false, code: "usage", lines: [] }, JSON.stringify(partial));
  }
  assert.equal(fs.readFileSync(s.file, "utf8"), "");
});

const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
// Valid arguments confirming the target of s as it is now: the empty file pendingHome left.
function confirmed(s: { home: Home; file: string; intent: string; sha: string }): ReplayArgs {
  const st = fs.statSync(s.file, { bigint: true });
  return { ...argsFor(s.home, s.intent, s.sha), currentDev: String(st.dev), currentIno: String(st.ino), currentSha: EMPTY_SHA };
}

// The binding commits; another connection then binds the intent elsewhere before the replay's second transaction.
test("an intent bound elsewhere between the two transactions is refused, the target unwritten", async () => {
  const s = await pendingHome();
  const other = await database(s.home);
  try {
    const out = await replay(confirmed(s), { afterRebindCommit: () => { other.conn.prepare("UPDATE pending SET target_ino = ?").run("1"); } });
    assert.deepEqual(out, { ok: false, code: "intent-changed", lines: [] });
  } finally { other.conn.close(); }
  assert.equal(fs.readFileSync(s.file, "utf8"), "");
});

// A reader holding its shared lock makes BEGIN EXCLUSIVE busy; the replay retries until the reader is gone.
test("a replay waits out a reader's transaction, then lands the recorded bytes", async () => {
  const s = await pendingHome();
  const reader = await database(s.home);
  reader.conn.exec("BEGIN");
  reader.conn.prepare("SELECT count(*) FROM pending").get();
  const release = setTimeout(() => { reader.conn.exec("ROLLBACK"); reader.conn.close(); }, 200);
  try {
    assert.equal((await replay(confirmed(s))).code, "replayed");
  } finally { clearTimeout(release); try { reader.conn.close(); } catch { /* closed by the timer */ } }
  assert.deepEqual(fs.readFileSync(s.file), GOOD);
});
