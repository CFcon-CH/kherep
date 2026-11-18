// Issue #507, part 2: the native entry and its admission (kherep/hook-runtime/
// entry.mts, coordinator.mts). R1: neither a main nor its static imports run
// while a writer holds EXCLUSIVE, and an admitted reader keeps writers out.
// R2: the reader's lock lives as long as the child that runs the main, also
// when the entry above it is killed. R6: every way the runtime itself fails is
// a deny for PreToolUse, never an allow, and a plain failure for other events.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { preloadArg as coordinatorArg } from "../kherep/hook-runtime/coordinator.mts";
import { alive, cleanup, entry, entryAsync, holdExclusive, RUNTIME, runtimeHome, until, writerFree } from "./hook-runtime-fixture.mts";
import { copyDeclared, copyTreeDeclared } from "./copy-declare-fixture.mts";
import { plantHeartbeat } from "./guard-dispatch-fixture.mts";

after(cleanup);
const ENTRY_AS_MODULE = pathToFileURL(path.join(RUNTIME, "entry.mts")).href;
// Generated hooks are constant program text: the files they touch are named relative to
// their own location (the home's root is the parent of hooks/), never spliced in.
const SENTINEL_LIB = "import fs from \"node:fs\";\nfs.appendFileSync(new URL(\"../../trace.txt\", import.meta.url), \"import\\n\");\nexport {};\n";
const reasonOf = (stdout: string): string => JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason;

// hooks/main.mts and hooks/lib/a.mts, each appending to trace when Node runs it.
function sentinelMain(hooks: string, body = ""): { main: string; trace: string } {
  const trace = path.join(path.dirname(hooks), "trace.txt");
  fs.writeFileSync(path.join(hooks, "lib", "a.mts"), SENTINEL_LIB);
  const main = path.join(hooks, "main.mts");
  fs.writeFileSync(main, `import fs from "node:fs";\nimport "./lib/a.mts";\nfs.appendFileSync(new URL("../trace.txt", import.meta.url), "main\\n");\n${body}`);
  return { main, trace };
}

// A copy of the runtime beside a home, with coordinator.mts replaced by `coordinator`.
function brokenRuntime(root: string, coordinator: string | null): string {
  const dir = path.join(root, "kherep", "hook-runtime");
  // coordinator.mts is replaced below, so only the other runtime files are declared copies (issue #965).
  copyTreeDeclared(RUNTIME, dir, ["coordinator.mts"]);
  if (coordinator === null) fs.rmSync(path.join(dir, "coordinator.mts"));
  else fs.writeFileSync(path.join(dir, "coordinator.mts"), coordinator);
  return path.join(dir, "entry.mts");
}

test("the entry builds the same admission argument as the coordinator", async () => {
  const { preloadArg: entryArg } = await import(ENTRY_AS_MODULE) as typeof import("../kherep/hook-runtime/entry.mts");
  const config = { v: 1, mode: "reader" as const, root: "/x/hooks", target: "/x/hooks/a.mts", deadline: 123 };
  assert.equal(entryArg("file:///c.mts", config), coordinatorArg("file:///c.mts", config));
});

test("R1: a main and its static import run only after the writer released", async () => {
  const home = runtimeHome();
  const { main, trace } = sentinelMain(home.hooks);
  const release = await holdExclusive(home);
  const running = entryAsync("reader", main);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(fs.existsSync(trace), false, "nothing ran while EXCLUSIVE was held");
  release();
  const run = await running;
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(fs.readFileSync(trace, "utf8").trim().split("\n"), ["import", "main"]);
});

test("R1: an admitted reader keeps a writer out until it ends", async () => {
  const home = runtimeHome();
  const go = path.join(home.root, "go");
  const { main, trace } = sentinelMain(home.hooks,
    "while (!fs.existsSync(new URL(\"../go\", import.meta.url))) await new Promise((r) => setTimeout(r, 20));\n");
  const running = entryAsync("reader", main);
  assert.ok(await until(() => fs.existsSync(trace) && fs.readFileSync(trace, "utf8").includes("main")));
  assert.equal(await writerFree(home), false);
  fs.writeFileSync(go, "");
  assert.equal((await running).status, 0);
  assert.equal(await writerFree(home), true);
});

// On Windows libuv keeps every child in a job object that ends with its parent, so
// killing the entry ends the child as well; its lock goes only with it, and the
// late import never runs. Elsewhere the orphan lives on and keeps its lock.
test("R2: killing the entry does not end the child's lock; the child's own end does", async (t) => {
  const home = runtimeHome();
  const go = path.join(home.root, "go");
  const pidFile = path.join(home.root, "child.pid");
  const lateRan = path.join(home.root, "late.txt");
  fs.writeFileSync(path.join(home.hooks, "lib", "late.mts"),
    "import fs from \"node:fs\";\nfs.writeFileSync(new URL(\"../../late.txt\", import.meta.url), \"\");\nexport const late = 1;\n");
  // The pid arrives by rename: a poller never sees child.pid created but not yet written (issue #565).
  const { main } = sentinelMain(home.hooks, "fs.writeFileSync(new URL(\"../child.pid.tmp\", import.meta.url), String(process.pid));\n"
    + "fs.renameSync(new URL(\"../child.pid.tmp\", import.meta.url), new URL(\"../child.pid\", import.meta.url));\n"
    + "while (!fs.existsSync(new URL(\"../go\", import.meta.url))) await new Promise((r) => setTimeout(r, 20));\n"
    + "await import(\"./lib/\" + \"late.mts\");\n");
  const running = entryAsync("reader", main);
  let ended = false;
  void running.then(() => { ended = true; });
  // A failed assertion must not leave the child waiting for go and the entry for it: node would never exit (issue #565).
  t.after(() => { fs.writeFileSync(go, ""); if (!ended) process.kill(running.pid!, "SIGKILL"); });
  assert.ok(await until(() => fs.existsSync(pidFile)));
  const child = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(Number.isInteger(child) && child > 0, `child.pid holds no process id: ${JSON.stringify(fs.readFileSync(pidFile, "utf8"))}`);
  process.kill(running.pid!, "SIGKILL");
  await running;
  if (process.platform === "win32") {
    assert.ok(await until(() => !alive(child)), "the child ends with its entry");
    assert.equal(await writerFree(home), true);
    fs.writeFileSync(go, "");
    assert.equal(fs.existsSync(lateRan), false, "the late import never ran");
    return;
  }
  assert.equal(alive(child), true);
  assert.equal(await writerFree(home), false, "the orphaned child still holds its read lock");
  fs.writeFileSync(go, "");
  assert.ok(await until(() => !alive(child)), "the child ends by itself");
  assert.equal(fs.existsSync(lateRan), true, "the late import ran under the lock");
  assert.equal(await writerFree(home), true);
});

describe("R6: a runtime that cannot admit denies PreToolUse and runs no main", () => {
  for (const [label, coordinator] of [
    ["missing", null],
    ["empty", ""],
    ["syntax-broken", "export const x = ;\n"],
    ["without its API", "export const nothing = 1;\n"],
  ] as const) {
    test(`a ${label} coordinator`, () => {
      const home = runtimeHome(undefined, { declare: false });
      const { main, trace } = sentinelMain(home.hooks);
      const run = spawnEntry(brokenRuntime(home.root, coordinator), "pretool", main);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, "deny");
      assert.match(reasonOf(run.stdout), /cannot run \(not admitted: bootstrap failed\)/);
      assert.equal(fs.existsSync(trace), false, "neither the main nor its import ran");
    });
  }

  test("a coordinator that admits nothing and sends no ready: the main's result is not accepted", () => {
    const home = runtimeHome(undefined, { declare: false });
    const { main } = sentinelMain(home.hooks, "process.stdout.write(\"{}\");\n");
    const run = spawnEntry(brokenRuntime(home.root, "export async function preload() {}\n"), "pretool", main);
    assert.match(reasonOf(run.stdout), /cannot run \(not admitted: it ended before admission\)/);
  });

  for (const [label, body, pattern] of [
    ["killed by a signal", "process.kill(process.pid, \"SIGKILL\");\n", /killed by SIGKILL|exit code/],
    ["exiting 1", "process.exit(1);\n", /exit code 1/],
    ["printing an unsupported shape", "process.stdout.write(JSON.stringify({ decision: \"block\" }));\n", /not a PreToolUse decision/],
  ] as const) {
    test(`a main ${label}`, () => {
      const home = runtimeHome();
      const { main } = sentinelMain(home.hooks, body);
      assert.match(reasonOf(entry("pretool", main).stdout), pattern);
    });
  }

  test("an empty or missing main", () => {
    const home = runtimeHome();
    fs.writeFileSync(path.join(home.hooks, "empty.mts"), "");
    assert.match(reasonOf(entry("pretool", path.join(home.hooks, "empty.mts")).stdout), /not admitted: main-empty/);
    assert.match(reasonOf(entry("pretool", path.join(home.hooks, "gone.mts")).stdout), /not admitted: main-missing/);
  });
});

// Second review of 1dd1ca9 (P3-1): the deny reason reaches the model, so it names the
// main relative to the hooks directory and carries no absolute path.
test("a deny names the main by its place in the hooks directory, never by an absolute path", () => {
  const home = runtimeHome();
  fs.mkdirSync(path.join(home.hooks, "sub"));
  for (const [target, label] of [[path.join(home.hooks, "gone.mts"), "gone.mts"], [path.join(home.hooks, "sub", "gone.mts"), "sub/gone.mts"]]) {
    const reason = reasonOf(entry("pretool", target).stdout);
    assert.ok(reason.startsWith(`[hook-entry] ${label} cannot run (not admitted: main-missing)`), reason);
    assert.ok(!reason.includes(home.root), reason);
    const other = entry("reader", target);
    assert.equal(other.stderr, `[hook-entry] ${label} not admitted: main-missing\n`);
  }
});

test("R6: a valid decision, a silent allow and exit 2 pass through unchanged", () => {
  const home = runtimeHome();
  const decision = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "why" } });
  const { main } = sentinelMain(home.hooks, "process.stdout.write(JSON.stringify({ hookSpecificOutput: "
    + "{ hookEventName: \"PreToolUse\", permissionDecision: \"ask\", permissionDecisionReason: \"why\" } }));\n");
  assert.equal(entry("pretool", main).stdout, decision);
  fs.writeFileSync(path.join(home.hooks, "quiet.mts"), "process.exitCode = 0;\n");
  const quiet = entry("pretool", path.join(home.hooks, "quiet.mts"));
  assert.deepEqual([quiet.status, quiet.stdout], [0, ""]);
  fs.writeFileSync(path.join(home.hooks, "block.mts"), "process.stderr.write(\"blocked by policy\\n\");\nprocess.exitCode = 2;\n");
  const block = entry("pretool", path.join(home.hooks, "block.mts"));
  assert.deepEqual([block.status, block.stdout, block.stderr], [2, "", "blocked by policy\n"]);
});

// The runtime's own experimental warnings (node:sqlite on Node 22 and 24.1, type
// stripping of its .mts files) are no output of the hook; the hook's own are.
// Emitted here by the main itself, so this holds on every Node version.
const SQLITE = "process.emitWarning(\"SQLite is an experimental feature and might change at any time\", \"ExperimentalWarning\");\n";
const STRIP = "process.emitWarning(\"Type Stripping is an experimental feature and might change at any time\", \"ExperimentalWarning\");\n";
const OWN = "process.emitWarning(\"synthetic hook warning\", \"ExperimentalWarning\");\n";
const warns = (...code: string[]): string => code.join("");

test("only the runtime's own experimental warnings are dropped from a hook's stderr", () => {
  const home = runtimeHome();
  fs.writeFileSync(path.join(home.hooks, "warn.mts"), `${warns(SQLITE, STRIP, OWN)}`
    + "process.stderr.write(\"blocked by policy\\n\");\nprocess.exitCode = 2;\n");
  for (const mode of ["pretool", "reader"]) {
    const run = entry(mode, path.join(home.hooks, "warn.mts"));
    assert.equal(run.status, 2, run.stderr);
    assert.doesNotMatch(run.stderr, /SQLite is an experimental|Type Stripping is an experimental/, mode);
    assert.match(run.stderr, /ExperimentalWarning: synthetic hook warning/, mode);
    assert.match(run.stderr, /blocked by policy\n/, mode);
  }
});

test("a guard under the admitted dispatcher keeps its exit-2 reason free of the runtime's warnings", () => {
  const home = runtimeHome();
  copyDeclared(path.join(import.meta.dirname, "guard-dispatch.mts"), path.join(home.hooks, "guard-dispatch.mts"));
  copyDeclared(path.join(import.meta.dirname, "lib", "guard-recheck.mts"), path.join(home.hooks, "lib", "guard-recheck.mts"));
  plantHeartbeat(home.root);
  fs.writeFileSync(path.join(home.hooks, "guard.mts"), `${warns(SQLITE, STRIP)}process.stderr.write("own reason\\n");\nprocess.exitCode = 2;\n`);
  const run = entry("pretool", path.join(home.hooks, "guard-dispatch.mts"), [path.join(home.hooks, "guard.mts")],
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "true" } }));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(reasonOf(run.stdout), "own reason");
});

test("R6: another event is never given a PreToolUse decision; its own output and exit pass through", () => {
  const home = runtimeHome();
  const { main } = sentinelMain(home.hooks, "process.stdout.write(\"context\");\nprocess.exitCode = 3;\n");
  const ok = entry("reader", main, ["--flag"]);
  assert.deepEqual([ok.status, ok.stdout], [3, "context"]);
  const missing = entry("reader", path.join(home.hooks, "gone.mts"));
  assert.deepEqual([missing.status, missing.stdout], [1, ""]);
  assert.match(missing.stderr, /not admitted: main-missing/);
});

test("R8: argv tail, cwd, stdin bytes and environment reach the main unchanged", () => {
  const home = runtimeHome();
  const { main } = sentinelMain(home.hooks,
    "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin: fs.readFileSync(0, \"utf8\"), env: process.env.HOOK_PROBE }));\n");
  const input = JSON.stringify({ tool_input: { command: "echo ü \"quoted\" $HOME" } });
  const run = entry("reader", main, ["a b", "--x=1"], input, 40_000, { ...process.env, HOOK_PROBE: "seen" });
  assert.deepEqual(JSON.parse(run.stdout), { argv: ["a b", "--x=1"], cwd: process.cwd(), stdin: input, env: "seen" });
});

function spawnEntry(entryFile: string, mode: string, target: string) {
  return spawnSync(process.execPath, [entryFile, mode, target], { input: "{}", encoding: "utf8", timeout: 40_000 });
}
