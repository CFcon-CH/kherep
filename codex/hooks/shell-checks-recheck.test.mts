// Issue #507, part 4. In its installed layout (<home>/hooks/kherep-maestro) the
// Codex shell dispatcher re-checks hook integrity after its guards and before
// attribution, when the heartbeat is stale or missing, a guard could not run, or
// one of its two adapter copies changed since the last proven integrity run
// recorded it (heartbeat.json "peers"). Each case builds that layout from copies
// of the dispatcher and the adapter, the real lib/guard-recheck.mts, guards and an
// attribution hook that trace their start, and a synthetic codex-hook-integrity.mts
// that traces its run, restores every 0-byte or `export const broken = ;` file from
// pristine copies and writes the heartbeat with fresh peers. No real hook or home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { ADAPTER_MODULES } from "./hook-adapter.fixture.mts";

const MIN = 60_000;
const REPO = path.resolve(import.meta.dirname, "..", "..");
const PAYLOAD = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "shell_command", tool_input: { command: "git status ü" } });
const GUARDS = ["commit-guard", "deploy-guard", "main-checkout-guard", "module-label-guard"];
const BROKEN = "export const broken = ;\n";
// One source literal: the test parses it as data, the fake integrity hook embeds it as code.
const PEERS_SOURCE = '["codex-hook-adapter.mts", "hook-adapter.mts", "codex-shell-checks.mts"]';
const PEERS: string[] = JSON.parse(PEERS_SOURCE);
const now = "performance.timeOrigin + performance.now()";
// The peers record the fake integrity hook writes, from one bigint stat per dispatcher file (as beat() below).
const PEERS_OF = `(dir) => Object.fromEntries(${PEERS_SOURCE}.flatMap((name) => { try {
  const s = fs.statSync(path.join(dir, name), { bigint: true });
  return [[name, { dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs), sha256: "fixture" }]];
} catch { return []; } }))`;
const INTEGRITY = `import fs from "node:fs";
import path from "node:path";
const home = process.env.CODEX_HOME;
const dir = path.join(home, "hooks", "kherep-maestro");
const trace = (row) => fs.appendFileSync(path.join(home, "trace.jsonl"), JSON.stringify(row) + "\\n");
trace({ who: "recheck-start", t: ${now}, argv: process.argv.slice(2), input: fs.readFileSync(0, "utf8"), home });
if (fs.existsSync(path.join(home, "integrity-sleeps"))) await new Promise((resolve) => setTimeout(resolve, 10_000));
let restored = 0;
for (const name of fs.readdirSync(dir)) {
  const file = path.join(dir, name);
  if (!name.endsWith(".mts") || !fs.statSync(file).isFile()) continue;
  const text = fs.readFileSync(file, "utf8");
  if (text.length && !text.startsWith(${JSON.stringify(BROKEN.trim())})) continue;
  fs.copyFileSync(path.join(home, "pristine", name), file);
  restored++;
  console.log(name + ": broken -> RESTORED from the repo, verified at the target (sha256 0123456789ab)");
}
fs.mkdirSync(path.join(home, ".cache", "hook-integrity"), { recursive: true });
fs.writeFileSync(path.join(home, ".cache", "hook-integrity", "heartbeat.json"), JSON.stringify({ peers: (${PEERS_OF})(dir) }) + "\\n");
console.log("all 3 files OK (" + restored + " restored), heartbeat refreshed");
trace({ who: "recheck-end", t: ${now} });
`;
const guardSource = (trace: string, name: string, extra = ""): string => `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ who: ${JSON.stringify(name)}, t: ${now} }) + "\\n");
${extra}`;

interface Box { root: string; dir: string; trace: string; beat: string; attribution: string }

function box(t: TestContext, installed = true): Box {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-shell-recheck-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = installed ? path.join(root, "hooks", "kherep-maestro") : path.join(root, "checkout");
  const trace = path.join(root, "trace.jsonl");
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "pristine"));
  const files: Record<string, string> = {
    "codex-shell-checks.mts": fs.readFileSync(path.join(import.meta.dirname, "shell-checks.mts"), "utf8"),
    "hook-adapter.mts": fs.readFileSync(path.join(import.meta.dirname, "hook-adapter.mts"), "utf8"),
    "codex-hook-adapter.mts": fs.readFileSync(path.join(import.meta.dirname, "hook-adapter.mts"), "utf8"),
    ...Object.fromEntries(ADAPTER_MODULES.map((name) => [name, fs.readFileSync(path.join(import.meta.dirname, name), "utf8")])),
    "codex-hook-integrity.mts": INTEGRITY,
    ...Object.fromEntries(GUARDS.map((name) => [`${name}.mts`, guardSource(trace, name)])),
  };
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), text);
    fs.writeFileSync(path.join(root, "pristine", name), text);
  }
  fs.copyFileSync(path.join(REPO, "claude", "hooks", "lib", "guard-recheck.mts"), path.join(dir, "lib", "guard-recheck.mts"));
  const attribution = path.join(root, "attribution", "attribution-hook.mts");
  fs.mkdirSync(path.dirname(attribution));
  fs.writeFileSync(attribution, `import fs from "node:fs";
export function handleAttributionHook() { fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ who: "attribution", t: ${now} }) + "\\n");
  if (fs.existsSync(${JSON.stringify(path.join(root, "attribution-sleeps"))})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1800); }\n`);
  fs.writeFileSync(path.join(path.dirname(attribution), "config.mts"), "export const nodePaths = () => ({});\n");
  return { root, dir, trace, beat: path.join(root, ".cache", "hook-integrity", "heartbeat.json"), attribution };
}

// A heartbeat ageMs old; peers: the current record, none (part 3 form) or a malformed file.
function beat(b: Box, ageMs: number, peers: "current" | "none" | "malformed" = "current"): void {
  fs.mkdirSync(path.dirname(b.beat), { recursive: true });
  const record = Object.fromEntries(PEERS.flatMap((name) => {
    try {
      const s = fs.statSync(path.join(b.dir, name), { bigint: true });
      return [[name, { dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs), sha256: "fixture" }]];
    } catch { return []; }
  }));
  fs.writeFileSync(b.beat, peers === "malformed" ? "{peers" : `${JSON.stringify(peers === "none" ? { ts: "fixture" } : { peers: record })}\n`);
  const then = new Date(Date.now() - ageMs);
  fs.utimesSync(b.beat, then, then);
}

interface Doc { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string }; systemMessage?: string }
interface Run { stdout: string; stderr: string; doc?: Doc; ms: number }

function call(b: Box, attribution = true, timeout = 45_000): Run {
  const begin = Date.now();
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(b.dir, "codex-shell-checks.mts"),
    ...(attribution ? [b.attribution, "--runtime", "codex"] : [])], { input: PAYLOAD, encoding: "utf8", windowsHide: true, timeout });
  assert.equal(run.status, 0, `dispatcher exit ${run.status}; stderr ${run.stderr}`);
  return { stdout: run.stdout, stderr: run.stderr, doc: run.stdout ? JSON.parse(run.stdout) as Doc : undefined, ms: Date.now() - begin };
}

const rows = (b: Box): { who: string; t: number; argv?: string[]; input?: string; home?: string }[] => fs.existsSync(b.trace)
  ? fs.readFileSync(b.trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const runs = (b: Box): number => rows(b).filter((row) => row.who === "recheck-start").length;
const pristine = (b: Box, name: string): boolean => fs.readFileSync(path.join(b.dir, name)).equals(fs.readFileSync(path.join(b.root, "pristine", name)));

test("T7a a stale heartbeat, healthy guards: one re-check with --trigger codex-shell-checks, one notice document, no decision", (t) => {
  const b = box(t);
  beat(b, 31 * MIN);
  const run = call(b);
  const start = rows(b).find((row) => row.who === "recheck-start")!;
  assert.deepEqual([start.argv, start.input, start.home], [["--trigger", "codex-shell-checks"], PAYLOAD, b.root]);
  assert.equal(runs(b), 1);
  assert.equal(run.doc?.hookSpecificOutput?.permissionDecision, undefined, run.stdout);
  assert.match(String(run.doc?.hookSpecificOutput?.additionalContext), /^hook integrity re-check \(stale heartbeat, last OK [^)]+\):\n {2}- all 3 files OK \(0 restored\), heartbeat refreshed$/);
  assert.ok(run.stderr.includes(String(run.doc?.hookSpecificOutput?.additionalContext)), "the block also goes to stderr");
});

test("T7b a fresh heartbeat whose peers match: no re-check, empty stdout", (t) => {
  const b = box(t);
  beat(b, 0);
  assert.equal(call(b).stdout, "");
  assert.equal(runs(b), 0);
});

test("T7c a fresh heartbeat, empty deploy-guard.mts: denied naming it, restored, the next call allows without a run", (t) => {
  const b = box(t);
  fs.writeFileSync(path.join(b.dir, "deploy-guard.mts"), "");
  beat(b, 0);
  const first = call(b);
  assert.equal(first.doc?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(String(first.doc?.hookSpecificOutput?.permissionDecisionReason), /deploy-guard\.mts/);
  assert.ok(String(first.doc?.systemMessage).startsWith("Kherep hook integrity: hook integrity re-check (guard failure"), first.doc?.systemMessage);
  assert.ok(pristine(b, "deploy-guard.mts"));
  assert.equal(call(b).stdout, "");
  assert.equal(runs(b), 1);
});

for (const broken of ["", BROKEN]) {
  test(`T7d the imported adapter ${broken ? "syntax-broken" : "empty"}: denied as unloadable, restored, the next call runs every guard`, (t) => {
    const b = box(t);
    beat(b, 0);
    fs.writeFileSync(path.join(b.dir, "hook-adapter.mts"), broken);
    const first = call(b);
    assert.equal(first.doc?.hookSpecificOutput?.permissionDecisionReason, "Shell guard adapter could not load; this tool call is blocked.");
    assert.equal(runs(b), 1);
    assert.ok(pristine(b, "hook-adapter.mts"));
    fs.writeFileSync(b.trace, "");
    assert.equal(call(b).stdout, "");
    assert.deepEqual(rows(b).map((row) => row.who), [...GUARDS, "attribution"]);
  });
}

test("T7e the command copy of the adapter syntax-broken after a proven run: guards allow, one run, restored, then quiet", (t) => {
  const b = box(t);
  beat(b, 0);
  const adapter = path.join(b.dir, "codex-hook-adapter.mts");
  fs.writeFileSync(adapter, BROKEN);
  const first = call(b);
  assert.equal(first.doc?.hookSpecificOutput?.permissionDecision, undefined, first.stdout);
  assert.ok(String(first.doc?.hookSpecificOutput?.additionalContext)
    .startsWith("kherep-maestro/codex-hook-adapter.mts cannot be trusted (size changed since the last proven check)\nhook integrity re-check (guard failure, last OK "),
  first.doc?.hookSpecificOutput?.additionalContext);
  assert.ok(pristine(b, "codex-hook-adapter.mts"));
  assert.equal(call(b).stdout, "");
  assert.equal(runs(b), 1);
});

for (const form of ["none", "malformed"] as const) {
  test(`T7e2 a fresh heartbeat with ${form === "none" ? "no peers record (part 3 form)" : "malformed JSON"}: one run, then quiet`, (t) => {
    const b = box(t);
    beat(b, 0, form);
    const first = call(b);
    assert.match(String(first.doc?.hookSpecificOutput?.additionalContext), /codex-hook-adapter\.mts cannot be trusted \(no proven record\)\n/);
    assert.equal(call(b).stdout, "");
    assert.equal(runs(b), 1);
  });
}

test("T7f the checkout layout never re-checks", (t) => {
  const b = box(t, false);
  assert.equal(call(b).stdout, "");
  assert.equal(runs(b), 0);
});

test("T7h order: every guard, then the re-check, then attribution; the first deny stays the decision", (t) => {
  const b = box(t);
  fs.writeFileSync(path.join(b.dir, "commit-guard.mts"), guardSource(b.trace, "commit-guard", "process.stderr.write('synthetic deny'); process.exit(2);"));
  const run = call(b);
  assert.equal(run.doc?.hookSpecificOutput?.permissionDecisionReason, "synthetic deny");
  const order = rows(b);
  assert.deepEqual(order.map((row) => row.who), [...GUARDS, "recheck-start", "recheck-end", "attribution"]);
  for (let i = 1; i < order.length; i++) assert.ok(order[i]!.t >= order[i - 1]!.t, `${order[i]!.who} after ${order[i - 1]!.who}`);
});

test("T12 residual: an in-place same-size rewrite of a peer with the recorded mtime is not seen until the heartbeat is stale", (t) => {
  const b = box(t);
  const adapter = path.join(b.dir, "codex-hook-adapter.mts");
  const when = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000);
  fs.utimesSync(adapter, when, when);
  beat(b, 0);
  const ino = fs.statSync(adapter).ino;
  const size = fs.statSync(adapter).size;
  fs.writeFileSync(adapter, `${BROKEN}//${"x".repeat(size - BROKEN.length - 2)}`);
  fs.utimesSync(adapter, when, when);
  assert.deepEqual([fs.statSync(adapter).ino, fs.statSync(adapter).size], [ino, size], "same inode, same size");
  assert.equal(call(b).stdout, "", "the gate is blind to this rewrite by design (named residual)");
  assert.equal(runs(b), 0);
  const stale = new Date(Date.now() - 31 * MIN);
  fs.utimesSync(b.beat, stale, stale);
  assert.match(String(call(b).doc?.hookSpecificOutput?.additionalContext), /stale heartbeat/);
  assert.ok(pristine(b, "codex-hook-adapter.mts"), "the stale-heartbeat run restores it");
});
