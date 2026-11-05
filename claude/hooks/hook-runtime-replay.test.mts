// Issue #507, part 2, F2: kherep/hook-runtime/replay-pending.mts. A writer
// recorded a repair of hooks/guard.mts and died; an outside writer then
// replaced the file with another inode and other bytes. Ordinary admission
// refuses that for good. The explicit replay writes the recorded bytes into the
// one replacement file the operator confirmed, after binding the intent to it.
// Synthetic temporary homes only; the command is never run against a live home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";

import { applyAcl, liftAcl, sameAcl } from "./acl-fixture.mts";
import { child, childAsync, cleanup, database, entry, type Home, runtimeHome, until } from "./hook-runtime-fixture.mts";

after(cleanup);
const PREFIX = "// a guard that proves it ran\n";
const REPLACED = "// put here by an outside installer\nprocess.stdout.write(\"other\");\n";
const sha = (text: string | Buffer): string => crypto.createHash("sha256").update(text).digest("hex");

interface Stuck { home: Home; guard: string; good: string; marker: string; ino: bigint; args: Record<string, string> }

// The F2 state: an intent for rel recorded and its writer killed, then rel replaced
// by an outside writer with another inode and other bytes.
async function stuck(rel = "guard.mts"): Promise<Stuck> {
  const home = runtimeHome("hook-runtime-replay-");
  const guard = path.join(home.hooks, rel);
  fs.mkdirSync(path.dirname(guard), { recursive: true });
  fs.writeFileSync(guard, "");
  const marker = path.join(home.root, "ran.txt");
  // Constant program text: the marker is found beside the hooks directory, never spliced in.
  const good = `${PREFIX}import fs from "node:fs";\nfs.appendFileSync(new URL("../ran.txt", import.meta.url), "ran\\n");\nprocess.stdout.write("ran");\n`;
  assert.notEqual(child(home, "record:kill", { rel, text: good }).status, 0, "the writer died");
  const tmp = `${guard}.installer`;
  fs.writeFileSync(tmp, REPLACED);
  fs.renameSync(tmp, guard);
  const st = fs.statSync(guard, { bigint: true });
  const seen = cli(home, "inspect", "--hooks-root", home.hooks);
  assert.equal(seen.code, "pending", seen.stdout);
  assert.equal(seen.fields["current-ino"], String(st.ino));
  const args = { "--hooks-root": home.hooks, "--intent": seen.fields.intent!, "--desired-sha": seen.fields["desired-sha"]!,
    "--current-dev": seen.fields["current-dev"]!, "--current-ino": seen.fields["current-ino"]!, "--current-sha": seen.fields["current-sha"]! };
  return { home, guard, good, marker, ino: st.ino, args };
}

function cli(home: Home, ...argv: string[]): { status: number | null; code: string; fields: Record<string, string>; stdout: string } {
  declareCopy(path.resolve(import.meta.dirname, "../kherep/hook-runtime/replay-pending.mts"), path.join(home.runtime, "replay-pending.mts"));
  const run = spawnSync(process.execPath, [path.join(home.runtime, "replay-pending.mts"), ...argv], { encoding: "utf8" });
  const [first, ...rest] = run.stdout.trim().split("\n");
  const fields = Object.fromEntries(rest.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  return { status: run.status, code: first?.replace("replay-pending: ", "") ?? "", fields, stdout: run.stdout + run.stderr };
}
const replayCli = (s: Stuck, change: Record<string, string> = {}) =>
  cli(s.home, "replay", ...Object.entries({ ...s.args, ...change }).flat());

async function pending(home: Home): Promise<{ n: number; target: string; before: string }> {
  const o = await database(home);
  try {
    const row = o.conn.prepare("SELECT count(*) AS n, max(target_dev) AS dev, max(target_ino) AS ino, max(before_sha256) AS b FROM pending").get() as
      { n: number; dev: string; ino: string; b: string };
    return { n: Number(row.n), target: `${row.dev}:${row.ino}`, before: row.b };
  } finally { o.conn.close(); }
}
const blocked = (s: Stuck): void => {
  const run = entry("reader", s.guard);
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /not admitted: recovery/);
};
const unchanged = async (s: Stuck): Promise<void> => {
  assert.equal(fs.readFileSync(s.guard, "utf8"), REPLACED);
  assert.equal((await pending(s.home)).n, 1);
};

// The replay as a module in a child, with seams that kill it or pause it.
function replayChild(s: Stuck, seam: string, data: object = {}): ReturnType<typeof childAsync> {
  return childAsync(s.home, `replay:${seam}`, { args: s.args, prefix: PREFIX, ...data });
}
const finished = (proc: ReturnType<typeof childAsync>): Promise<{ status: number | null; out: string }> => new Promise((resolve) => {
  let out = "";
  proc.stdout!.on("data", (chunk) => (out += chunk));
  proc.on("close", (status) => resolve({ status, out }));
});

test("F2.1: ordinary admission stays refused; the confirmed replay lands the recorded bytes in the replacement inode", async () => {
  const s = await stuck();
  blocked(s);
  await unchanged(s);
  const run = replayCli(s);
  assert.equal(run.status, 0, run.stdout);
  assert.equal(run.code, "replayed");
  assert.equal(fs.readFileSync(s.guard, "utf8"), s.good);
  assert.equal(fs.statSync(s.guard, { bigint: true }).ino, s.ino, "the replacement inode, written in place");
  assert.equal((await pending(s.home)).n, 0);
  assert.equal(fs.existsSync(s.marker), false, "the replay ran no hook");
  assert.equal(fs.existsSync(path.join(s.home.root, ".cache")), false, "and wrote no heartbeat");
  assert.equal(entry("reader", s.guard).stdout, "ran", "the next ordinary invocation runs");
});

describe("F2.2: a replay killed at any point", () => {
  for (const [label, seams, recovers] of [
    ["before the binding commit", "kill-after-rebind", false],
    ["after the binding commit", "kill-after-rebind-commit", true],
    ["after the truncate", "kill-at-write", true],
    ["after a valid nonempty prefix", "kill-after-prefix", true],
    ["before the completion commit", "kill-before-clear-commit", true],
  ] as const) {
    test(label, async () => {
      const s = await stuck();
      const dbIno = fs.statSync(s.home.db).ino;
      const died = await finished(replayChild(s, seams));
      assert.notEqual(died.status, 0, "the replay died");
      if (!recovers) {
        blocked(s);
        await unchanged(s);
        assert.notEqual((await pending(s.home)).target, `${s.args["--current-dev"]}:${s.args["--current-ino"]}`, "not bound");
      } else {
        assert.equal(entry("reader", s.guard).stdout, "ran", "the next admission completes the recorded bytes");
        assert.equal(fs.readFileSync(s.guard, "utf8"), s.good);
        assert.equal((await pending(s.home)).n, 0);
      }
      assert.equal(fs.statSync(s.guard, { bigint: true }).ino, s.ino, "the same confirmed replacement inode");
      assert.equal(fs.statSync(s.home.db).ino, dbIno, "the same database inode");
    });
  }
});

describe("F2.3: another process completes the intent in the gap", () => {
  const paused = (s: Stuck) => replayChild(s, "pause-after-rebind-commit",
    { bound: path.join(s.home.root, "bound"), go: path.join(s.home.root, "go") });

  test("the replay measures the target itself and does not apply its request again", async () => {
    const s = await stuck();
    const replaying = finished(paused(s));
    assert.ok(await until(() => fs.existsSync(path.join(s.home.root, "bound"))));
    assert.equal(entry("reader", s.guard).stdout, "ran", "an admitted reader completed the bound intent");
    fs.writeFileSync(s.guard, `${s.good}// touched after completion\n`);
    fs.writeFileSync(path.join(s.home.root, "go"), "");
    const out = JSON.parse((await replaying).out.trim().split("\n").at(-1)!);
    assert.deepEqual([out.ok, out.code], [false, "unproven"], "a changed target is not reported as replayed");
    assert.equal(fs.readFileSync(s.guard, "utf8"), `${s.good}// touched after completion\n`, "and is not written again");
  });

  test("a successor intent is left alone", async () => {
    const s = await stuck();
    fs.writeFileSync(path.join(s.home.hooks, "other.mts"), "");
    const replaying = finished(paused(s));
    assert.ok(await until(() => fs.existsSync(path.join(s.home.root, "bound"))));
    assert.equal(entry("reader", s.guard).stdout, "ran");
    child(s.home, "record:kill", { rel: "other.mts", text: "export {};\n" });
    fs.writeFileSync(path.join(s.home.root, "go"), "");
    const out = JSON.parse((await replaying).out.trim().split("\n").at(-1)!);
    assert.deepEqual([out.ok, out.code], [false, "successor-pending"]);
    assert.equal((await pending(s.home)).n, 1, "the successor stays pending");
    assert.equal(fs.readFileSync(path.join(s.home.hooks, "other.mts"), "utf8"), "");
  });

  test("a replay that finds its own intent completed reports it only after measuring", async () => {
    const s = await stuck();
    const replaying = finished(paused(s));
    assert.ok(await until(() => fs.existsSync(path.join(s.home.root, "bound"))));
    assert.equal(entry("reader", s.guard).stdout, "ran");
    fs.writeFileSync(path.join(s.home.root, "go"), "");
    const out = JSON.parse((await replaying).out.trim().split("\n").at(-1)!);
    assert.deepEqual([out.ok, out.code], [true, "replayed-elsewhere"]);
  });
});

describe("F2.4: anything not exactly confirmed leaves the intent and the files as they are", () => {
  for (const [label, change, code] of [
    ["a wrong intent", { "--intent": "0".repeat(32) }, "intent-mismatch"],
    ["a wrong desired hash", { "--desired-sha": "0".repeat(64) }, "desired-mismatch"],
    ["a wrong current device", { "--current-dev": "1" }, "current-mismatch"],
    ["a wrong current inode", { "--current-ino": "1" }, "current-mismatch"],
    ["a wrong current hash", { "--current-sha": "0".repeat(64) }, "current-mismatch"],
    ["a malformed value", { "--current-ino": "-1" }, "usage"],
  ] as const) {
    test(label, async () => {
      const s = await stuck();
      const run = replayCli(s, change);
      assert.equal(run.code, code, run.stdout);
      assert.equal(run.status, code === "usage" ? 2 : 1);
      await unchanged(s);
    });
  }

  test("incomplete arguments", async () => {
    const s = await stuck();
    const run = cli(s.home, "replay", "--hooks-root", s.home.hooks, "--intent", s.args["--intent"]!);
    assert.deepEqual([run.status, run.code], [2, "usage"]);
    await unchanged(s);
  });

  test("an invalid pending row", async () => {
    const s = await stuck();
    const o = await database(s.home);
    o.conn.prepare("UPDATE pending SET rel = ?").run("../outside.mts");
    o.conn.close();
    assert.equal(replayCli(s).code, "pending-invalid");
    assert.equal(fs.readFileSync(s.guard, "utf8"), REPLACED);
    assert.equal((await pending(s.home)).n, 1);
  });

  test("a hooks root that is no longer the recorded one", async () => {
    const s = await stuck();
    fs.cpSync(s.home.hooks, `${s.home.hooks}-copy`, { recursive: true });
    fs.renameSync(s.home.hooks, `${s.home.hooks}-old`);
    fs.renameSync(`${s.home.hooks}-copy`, s.home.hooks);
    assert.equal(replayCli(s).code, "root-moved");
    await unchanged(s);
  });

  test("a parent directory that is no longer the recorded one, or a link elsewhere", async () => {
    const s = await stuck("lib/guard.mts");
    const lib = path.join(s.home.hooks, "lib");
    fs.renameSync(lib, `${lib}-old`);
    fs.mkdirSync(lib);
    fs.copyFileSync(path.join(`${lib}-old`, "guard.mts"), s.guard);
    assert.equal(replayCli(s).code, "parent-moved");
    fs.rmSync(lib, { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "replay-outside-"));
    fs.copyFileSync(path.join(`${lib}-old`, "guard.mts"), path.join(outside, "guard.mts"));
    fs.symlinkSync(outside, lib, "dir");
    assert.match(replayCli(s).code, /^parent-(moved|outside)$/);
    assert.equal(fs.readFileSync(path.join(outside, "guard.mts"), "utf8"), REPLACED);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test("a leaf that is a link, or has a second name", async () => {
    const s = await stuck();
    const elsewhere = path.join(s.home.root, "elsewhere.mts");
    fs.renameSync(s.guard, elsewhere);
    fs.symlinkSync(elsewhere, s.guard);
    assert.equal(replayCli(s).code, "target-link");
    assert.equal(fs.readFileSync(elsewhere, "utf8"), REPLACED);
    fs.rmSync(s.guard);
    fs.renameSync(elsewhere, s.guard);
    fs.linkSync(s.guard, path.join(s.home.root, "second-name.mts"));
    assert.equal(replayCli(s).code, "target-shared");
    await unchanged(s);
  });

  test("an unavailable database is refused and never created", async () => {
    const s = await stuck();
    const bare = path.join(s.home.root, "bare-hooks");
    fs.mkdirSync(bare);
    const run = cli(s.home, "replay", ...Object.entries({ ...s.args, "--hooks-root": bare }).flat());
    assert.equal(run.code, "database");
    assert.equal(fs.existsSync(path.join(bare, ".kherep-integrity")), false);
    assert.equal(cli(s.home, "inspect", "--hooks-root", bare).code, "database");
    assert.equal(fs.existsSync(path.join(bare, ".kherep-integrity")), false);
    await unchanged(s);
  });

  test("a target swapped at the before-open seam stays unwritten", async () => {
    const s = await stuck();
    const swap = path.join(s.home.root, "swap.mts");
    fs.writeFileSync(swap, "// swapped in\n");
    const out = JSON.parse((await finished(replayChild(s, "swap-before-open", { swap }))).out.trim().split("\n").at(-1)!);
    assert.deepEqual([out.ok, out.code, out.lines], [false, "replay-refused", ["reason=target-changed"]]);
    assert.equal(fs.readFileSync(s.guard, "utf8"), "// swapped in\n");
    assert.equal((await pending(s.home)).n, 1);
  });
});

// Review of bcab653 (H2): a refused replay prints a fixed reason code, never raw text or a path.
test("a parent swapped to a link outside at the before-open seam is refused with a fixed code and no path", async () => {
  const s = await stuck("lib/guard.mts");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "replay-outside-"));
  fs.writeFileSync(path.join(outside, "guard.mts"), "// outside\n");
  const out = JSON.parse((await finished(replayChild(s, "swap-parent-before-open", { swap: outside }))).out.trim().split("\n").at(-1)!);
  const lib = path.dirname(s.guard);
  assert.ok(fs.lstatSync(lib).isSymbolicLink() && fs.existsSync(`${lib}-old`), "the seam swapped the parent");
  assert.deepEqual([out.ok, out.code, out.lines], [false, "replay-refused", ["reason=parent-outside"]]);
  assert.ok(!JSON.stringify(out).includes("/"), JSON.stringify(out));
  assert.equal(fs.readFileSync(path.join(outside, "guard.mts"), "utf8"), "// outside\n");
  assert.equal((await pending(s.home)).n, 1);
  fs.rmSync(outside, { recursive: true, force: true });
});

test("F2.5: a write-denied replay after the binding keeps the replacement bytes, the intent and its before-hash", async () => {
  const s = await stuck();
  const before = (await pending(s.home)).before;
  assert.equal(before, sha(""), "the before-hash is the original target's");
  const out = JSON.parse((await finished(replayChild(s, "write-denied"))).out.trim().split("\n").at(-1)!);
  assert.deepEqual([out.ok, out.code, out.lines], [false, "replay-refused", ["reason=open-failed"]]);
  const row = await pending(s.home);
  assert.deepEqual([row.n, row.before, row.target], [1, before, `${s.args["--current-dev"]}:${s.args["--current-ino"]}`],
    "still pending, bound to the replacement, before-hash not rewritten");
  assert.equal(fs.readFileSync(s.guard, "utf8"), REPLACED);
  assert.equal(entry("reader", s.guard).stdout, "ran", "a later permitted replay needs no second binding");
  assert.equal(fs.statSync(s.guard, { bigint: true }).ino, s.ino);
});

// F2.6, with the ACL fixture of lib/restore-write-acl.test.mts: an ACL on the replacement
// leaf survives the replay, a write-denying one refuses it and keeps the intent, and once
// that ACL is lifted the same confirmed replay completes. Windows runs both, never skipped.
for (const deny of [false, true]) {
  test(`F2.6: a replacement with ${deny ? "a write-denying" : "a restricting"} ACL keeps it, its inode, mode and owner`, async (t) => {
    const s = await stuck();
    const acl = applyAcl(t, s.guard, deny);
    if (!acl) return;
    const before = { stat: fs.statSync(s.guard, { bigint: true }), row: await pending(s.home) };
    const run = replayCli(s);
    assert.equal(run.code, deny ? "replay-refused" : "replayed", run.stdout);
    if (deny) assert.equal(run.fields.reason, "open-failed", run.stdout);
    sameAcl(s.guard, acl.before);
    const now = fs.statSync(s.guard, { bigint: true });
    assert.deepEqual([now.dev, now.ino, now.uid, now.gid, now.mode],
      [before.stat.dev, s.ino, before.stat.uid, before.stat.gid, before.stat.mode]);
    assert.equal(fs.readFileSync(s.guard, "utf8"), deny ? REPLACED : s.good);
    const row = await pending(s.home);
    assert.equal(row.n, deny ? 1 : 0);
    if (deny) assert.equal(row.before, before.row.before, "the before-hash is not rewritten");
    liftAcl(s.guard);
    if (deny) {
      const again = replayCli(s);
      assert.equal(again.code, "replayed", again.stdout);
      assert.equal(fs.readFileSync(s.guard, "utf8"), s.good);
      assert.equal(fs.statSync(s.guard, { bigint: true }).ino, s.ino);
      assert.equal((await pending(s.home)).n, 0);
    }
    fs.rmSync(s.guard);
    assert.equal(fs.existsSync(s.guard), false, "the file can be removed after the reset");
  });
}
