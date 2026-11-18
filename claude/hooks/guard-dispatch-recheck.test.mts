// Issue #507, part 2. The dispatcher starts the hook integrity re-check when the
// heartbeat is stale or missing, or after a guard of this call could not run,
// and its lines never change the verdict. Each case gets its own copy of the
// dispatcher (guard-dispatch-fixture.mts) with a synthetic live-hook-integrity.mts
// beside it that traces its argv, stdin and CLAUDE_HOME, restores every 0-byte
// guard, and writes the heartbeat. No real hook, home or checkout is involved.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { dispatcherFixture, heartbeatPath, plantHeartbeat } from "./guard-dispatch-fixture.mts";

const MIN = 60_000;
const PAYLOAD = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status ü" } });
const GOOD = "process.exit(0);\n";
const roots: string[] = [];
after(() => { for (const root of roots) try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

// Constant program text: the fake writes its trace into CLAUDE_HOME, where the box keeps it.
const INTEGRITY = `import fs from "node:fs";
import path from "node:path";
const home = process.env.CLAUDE_HOME;
fs.appendFileSync(path.join(home, "trace.jsonl"), JSON.stringify({ argv: process.argv.slice(2), input: fs.readFileSync(0, "utf8"), home }) + "\\n");
let restored = 0;
for (const name of fs.readdirSync(path.join(home, "hooks"))) {
  const file = path.join(home, "hooks", name);
  if (!name.endsWith(".mts") || !fs.statSync(file).isFile() || fs.statSync(file).size > 0) continue;
  fs.writeFileSync(file, "process.exit(0);\\n");
  restored++;
  console.log(name + ": 0 bytes -> RESTORED from the repo, verified at the target (sha256 0123456789ab)");
}
fs.mkdirSync(path.join(home, ".cache", "hook-integrity"), { recursive: true });
fs.writeFileSync(path.join(home, ".cache", "hook-integrity", "heartbeat.json"), "{}\\n");
console.log("all 2 files OK (" + restored + " restored), heartbeat refreshed");
`;

const GUARDS: Record<string, string> = {
  "allow.mts": GOOD,
  "json-deny.mts": "process.stdout.write(JSON.stringify({ hookSpecificOutput: "
    + "{ hookEventName: \"PreToolUse\", permissionDecision: \"deny\", permissionDecisionReason: \"json says no\" } }));\n",
};

interface Box { root: string; hooks: string; dispatch: string; trace: string }

// heartbeatAgeMs null: no heartbeat at all.
function box(heartbeatAgeMs: number | null, editsRecheck = false): Box {
  const fixture = dispatcherFixture("guard-dispatch-recheck-", { heartbeat: false, editsRecheck });
  roots.push(fixture.root);
  const trace = path.join(fixture.root, "trace.jsonl");
  fs.writeFileSync(path.join(fixture.hooks, "live-hook-integrity.mts"), INTEGRITY);
  for (const [name, source] of Object.entries(GUARDS)) fs.writeFileSync(path.join(fixture.hooks, name), source);
  if (heartbeatAgeMs !== null) plantHeartbeat(fixture.root, heartbeatAgeMs);
  return { ...fixture, trace };
}

interface Printed { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string }
interface Run { stdout: string; stderr: string; output?: Printed }

function dispatch({ hooks, dispatch: file }: Box, ...guards: string[]): Run {
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", file, ...guards.map((g) => path.join(hooks, g))],
    { input: PAYLOAD, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(run.status, 0, `dispatcher exit ${run.status}; stderr ${run.stderr}`);
  const output = run.stdout ? (JSON.parse(run.stdout) as { hookSpecificOutput: Printed }).hookSpecificOutput : undefined;
  return { stdout: run.stdout, stderr: run.stderr, output };
}

const traced = (b: Box): { argv: string[]; input: string; home: string }[] => fs.existsSync(b.trace)
  ? fs.readFileSync(b.trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];

test("a heartbeat 29 minutes old: no re-check, no output", () => {
  const b = box(29 * MIN);
  assert.equal(dispatch(b, "allow.mts").stdout, "");
  assert.deepEqual(traced(b), []);
});

test("a heartbeat 31 minutes old: one re-check with the exact payload, reported, no decision", () => {
  const b = box(31 * MIN);
  const lastOk = new Date(fs.statSync(heartbeatPath(b.root)).mtimeMs).toISOString();
  const run = dispatch(b, "allow.mts");
  assert.deepEqual(traced(b), [{ argv: ["--trigger", "guard-dispatch"], input: PAYLOAD, home: b.root }]);
  assert.equal(run.output?.permissionDecision, undefined, run.stdout);
  assert.equal(run.output?.permissionDecisionReason, undefined, run.stdout);
  assert.equal(run.output?.additionalContext, `hook integrity re-check (stale heartbeat, last OK ${lastOk}):\n`
    + "  - all 2 files OK (0 restored), heartbeat refreshed");
  assert.ok(run.stderr.includes(String(run.output?.additionalContext)), "the block also goes to stderr");
  assert.ok(Date.now() - fs.statSync(heartbeatPath(b.root)).mtimeMs < MIN, "the heartbeat mtime moved");
});

test("no heartbeat: re-checked with last OK none", () => {
  const b = box(null);
  const run = dispatch(b, "allow.mts");
  assert.equal(traced(b).length, 1);
  assert.equal(run.output?.permissionDecision, undefined);
  assert.match(String(run.output?.additionalContext), /^hook integrity re-check \(no heartbeat, last OK none\):\n {2}- all 2 files OK/);
});

test("a stale heartbeat next to a policy deny: the deny and its reason stay, the block is appended", () => {
  const b = box(31 * MIN);
  const run = dispatch(b, "allow.mts", "json-deny.mts");
  assert.equal(run.output?.permissionDecision, "deny");
  assert.equal(run.output?.permissionDecisionReason, "json says no");
  assert.match(String(run.output?.additionalContext), /^hook integrity re-check \(stale heartbeat, .*heartbeat refreshed$/s);
});

test("a fresh heartbeat next to a policy deny: no re-check", () => {
  const b = box(0);
  const run = dispatch(b, "json-deny.mts");
  assert.deepEqual(run.output, { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "json says no" });
  assert.deepEqual(traced(b), []);
});

for (const [label, age, why] of [["stale", 31 * MIN, "stale heartbeat"], ["fresh", 0, "guard failure"]] as const) {
  test(`${label} heartbeat, empty guard: this call stays denied, the next runs the restored guard`, () => {
    const b = box(age);
    fs.writeFileSync(path.join(b.hooks, "empty.mts"), "");
    const first = dispatch(b, "allow.mts", "empty.mts");
    assert.equal(first.output?.permissionDecision, "deny");
    assert.ok(String(first.output?.permissionDecisionReason).includes("empty.mts cannot run (empty, 0 bytes)"));
    assert.ok(String(first.output?.additionalContext).startsWith(`hook integrity re-check (${why}, last OK `));
    assert.ok(String(first.output?.additionalContext).includes("empty.mts: 0 bytes -> RESTORED"));
    assert.equal(fs.readFileSync(path.join(b.hooks, "empty.mts"), "utf8"), GOOD);
    const second = dispatch(b, "allow.mts", "empty.mts");
    assert.equal(second.stdout, "", "allow, no re-check");
    assert.equal(traced(b).length, 1, "no further re-check");
  });
}

test("an unrunnable live-hook-integrity.mts is named and spawns nothing", () => {
  const b = box(31 * MIN);
  fs.writeFileSync(path.join(b.hooks, "live-hook-integrity.mts"), "");
  const run = dispatch(b, "json-deny.mts");
  assert.equal(run.output?.permissionDecision, "deny");
  assert.equal(run.output?.permissionDecisionReason, "json says no");
  assert.ok(String(run.output?.additionalContext).includes("\n  - live-hook-integrity.mts cannot run (empty, 0 bytes)"), run.stdout);
  assert.ok(!String(run.output?.additionalContext).includes(b.hooks), "named inside hooks/, not by its path (issue #564)");
  assert.deepEqual(traced(b), []);
});

test("an empty lib/guard-recheck.mts is one unavailable line; the verdict is unchanged", () => {
  const b = box(31 * MIN, true);
  fs.writeFileSync(path.join(b.hooks, "lib", "guard-recheck.mts"), "");
  const run = dispatch(b, "json-deny.mts");
  assert.equal(run.output?.permissionDecision, "deny");
  assert.equal(run.output?.permissionDecisionReason, "json says no");
  // An empty lib loads as an empty module; calling its missing recheckAfter is a TypeError (issue #564: no message).
  assert.match(String(run.output?.additionalContext), /^hook integrity re-check unavailable \(lib\/guard-recheck\.mts cannot be loaded \(TypeError\)\)$/);
  assert.deepEqual(traced(b), []);
});

// A lib whose only entry point, recheckAfter, is replaced by the given function.
function fakeRunner(b: Box, recheckAfter: string): void {
  fs.writeFileSync(path.join(b.hooks, "lib", "guard-recheck.mts"), `export ${recheckAfter}\n`);
}

test("a lib whose import never settles: one unavailable line within 2 s, the deny stays", () => {
  const b = box(31 * MIN, true);
  fs.writeFileSync(path.join(b.hooks, "lib", "guard-recheck.mts"), "await new Promise(() => {});\n");
  const begin = Date.now();
  const run = dispatch(b, "json-deny.mts");
  assert.ok(Date.now() - begin < 5000, `took ${Date.now() - begin} ms`);
  assert.equal(run.output?.permissionDecision, "deny", run.stdout);
  assert.equal(run.output?.permissionDecisionReason, "json says no");
  assert.match(String(run.output?.additionalContext),
    /^hook integrity re-check unavailable \(lib\/guard-recheck\.mts did not load within 2000 ms\)$/);
});

test("a lib that leaves a handle open: the dispatcher still exits right after its output", () => {
  const b = box(31 * MIN, true);
  fakeRunner(b, `async function recheckAfter() { setInterval(() => {}, 1000); return "re-check fixture left an interval"; }`);
  const begin = Date.now();
  const run = dispatch(b, "allow.mts");
  assert.ok(Date.now() - begin < 3000, `took ${Date.now() - begin} ms`);
  assert.equal(run.output?.additionalContext, "re-check fixture left an interval");
});

test("every PreToolUse dispatcher entry's timeout equals HOOK_TIMEOUT_MS", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "guard-dispatch.mts"), "utf8");
  const pinned = Number(/^const HOOK_TIMEOUT_MS = ([\d_]+);$/m.exec(source)?.[1]?.replaceAll("_", ""));
  const settings = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "settings.user.json"), "utf8"));
  const entries = (settings.hooks.PreToolUse as { hooks: { command: string; timeout?: number }[] }[])
    .flatMap((group) => group.hooks).filter((entry) => entry.command.includes("/hooks/guard-dispatch.mts"));
  assert.ok(entries.length >= 5, `found ${entries.length} dispatcher entries`);
  for (const entry of entries) assert.equal(Number(entry.timeout) * 1000, pinned, entry.command);
});
