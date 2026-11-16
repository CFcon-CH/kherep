import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { declareCopy } from "./coverage-copy-fixture.mts";
import { relativeSpecifiers } from "../claude/hooks/lib/hook-inventory.mts";
import { cleanupHomes, codexHome } from "../codex/hooks/denials-fixture.mts";

const REPO = path.resolve(import.meta.dirname, "..");
const TRANSCRIPT_TEXT = "synthetic transcript contents, never print this";
test.after(cleanupHomes);

function copyClosure(root: string, relative: string, seen = new Set<string>()): void {
  if (seen.has(relative)) return;
  seen.add(relative);
  const original = path.resolve(REPO, relative), target = path.join(root, relative);
  assert.ok(original.startsWith(`${REPO}${path.sep}`));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(original, target);
  for (const specifier of relativeSpecifiers(fs.readFileSync(original, "utf8"))) {
    if (specifier.startsWith(".") && specifier.endsWith(".mts")) {
      copyClosure(root, path.relative(REPO, path.resolve(path.dirname(original), specifier)), seen);
    }
  }
}
function fixture(t: TestContext, relative: string, direct = true, copyLibraries = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stdin-cli-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  // Complete unchanged libs support the real dynamic integrity imports and
  // checkout-relative require paths. Every home and effect stays in this tree.
  const copied = new Set<string>();
  if (!direct) {
    if (copyLibraries) fs.cpSync(path.join(REPO, "claude/hooks/lib"), path.join(source, "claude/hooks/lib"), { recursive: true });
    copyClosure(source, relative, copied);
  }
  const entry = path.join(direct ? REPO : source, relative);
  if (!direct) declareCopy(path.join(REPO, relative), entry);
  const original = fs.readFileSync(entry);
  const claudeHome = path.join(root, "claude-home"), codexHome = path.join(root, "codex-home"), workspace = path.join(root, "workspace");
  for (const dir of [claudeHome, codexHome, workspace]) fs.mkdirSync(dir);
  const gitConfig = path.join(root, "gitconfig-global");
  fs.writeFileSync(gitConfig, "");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT,
    CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome, KHEREP_CONFIG_DIR: path.join(root, "config"), KHEREP_WORKSPACE: "",
    GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1",
    ...(process.env.NODE_V8_COVERAGE === undefined ? {} : { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }),
  };
  return { root, entry, original, claudeHome, codexHome, workspace, env, source, copied };
}
type Fixture = ReturnType<typeof fixture>;
function run(f: Fixture, input: string, args: string[] = [], overrides: NodeJS.ProcessEnv = {}) {
  assert.deepEqual(fs.readFileSync(f.entry), f.original);
  const child = spawnSync(process.execPath, [f.entry, ...args], {
    cwd: f.root, env: { ...f.env, ...overrides }, input, encoding: "utf8",
    timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(fs.readFileSync(f.entry), f.original, "declared entry stays unchanged through execution");
  assert.doesNotMatch(child.stdout + child.stderr, new RegExp(TRANSCRIPT_TEXT));
  const stderr = child.stderr.replace(/\(node:\d+\) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\r?\n/g, "")
    .replace(/\(Use .+?--trace-warnings.+?\)\r?\n/g, "");
  assert.equal(stderr, "");
  return child.stdout;
}
function files(root: string, dir = root, result: Record<string, string> = {}): Record<string, string> {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) files(root, file, result);
    else result[path.relative(root, file).replaceAll(path.sep, "/")] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  return result;
}

function sourceHashes(relative: string, result: Record<string, string> = {}): Record<string, string> {
  if (relative in result) return result;
  const file = path.resolve(REPO, relative);
  assert.ok(file.startsWith(`${REPO}${path.sep}`));
  const bytes = fs.readFileSync(file);
  result[relative] = createHash("sha256").update(bytes).digest("hex");
  for (const specifier of relativeSpecifiers(bytes.toString())) {
    if (specifier.startsWith(".") && specifier.endsWith(".mts")) {
      sourceHashes(path.relative(REPO, path.resolve(path.dirname(file), specifier)), result);
    }
  }
  return result;
}

test("checkout pre-push CLI records one real attribution journal entry", t => {
  const relative = "claude/kherep/githooks/attribution-record.mts", dependencies = sourceHashes(relative);
  const f = fixture(t, relative), before = files(f.root), ref = "refs/heads/source-cli", sha = "a".repeat(40);
  const started = Date.now();
  assert.equal(run(f, `${ref} ${sha} ${ref} ${"0".repeat(40)}\n`,
    ["push", "https://example.invalid/synthetic/repo.git", f.workspace], { KHEREP_SESSION_ID: "synthetic-source-session" }), "");
  const finished = Date.now(), journal = "config/control-plane/attribution.jsonl";
  const records = fs.readFileSync(path.join(f.root, journal), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(records.length, 1);
  const { ts, ...record } = records[0];
  assert.deepEqual(record, { v: 1, kind: "push", sessionId: "synthetic-source-session", runtime: "codex",
    sessionSource: "KHEREP_SESSION_ID", repo: "synthetic/repo", toplevel: f.workspace, branch: "source-cli",
    remoteRef: ref, sha, pr: null });
  assert.ok(Date.parse(ts) >= started && Date.parse(ts) <= finished);
  const after = files(f.root);
  assert.deepEqual(Object.keys(after).filter(file => before[file] !== after[file]), [journal]);
  assert.deepEqual(sourceHashes(relative), dependencies);
});

test("checkout post-edit CLI skips Bash and retains its exact malformed-input error", t => {
  const relative = "codex/hooks/post-edit-checks.mts", dependencies = sourceHashes(relative);
  const f = fixture(t, relative), before = files(f.root);
  assert.equal(run(f, JSON.stringify({ tool_name: "Bash", tool_input: { command: "printf safe" } })), "");
  const child = spawnSync(process.execPath, [f.entry], { cwd: f.root, env: f.env, input: "{not json", encoding: "utf8",
    timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  const stderr = child.stderr.replace(/\(node:\d+\) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\r?\n/g, "")
    .replace(/\(Use .+?--trace-warnings.+?\)\r?\n/g, "");
  assert.deepEqual([child.status, child.stdout, stderr], [1, "", "post-edit-checks received malformed JSON input\n"]);
  assert.deepEqual(files(f.root), before);
  assert.deepEqual(sourceHashes(relative), dependencies);
});

test("checkout handback gate remains quiet for out-of-scope and malformed input", t => {
  const relative = "claude/hooks/obs-handback-gate.mts", dependencies = sourceHashes(relative);
  const f = fixture(t, relative), before = files(f.root);
  assert.equal(run(f, JSON.stringify({ hook_event_name: "SessionStart" })), "");
  assert.equal(run(f, "{not json"), "");
  assert.deepEqual(files(f.root), before);
  assert.deepEqual(sourceHashes(relative), dependencies);
});

test("checkout dispatch guard denies malformed input with the exact contract", t => {
  const relative = "codex/hooks/dispatch-contract-guard.mts", dependencies = sourceHashes(relative);
  const f = fixture(t, relative), before = files(f.root);
  const reason = "Dispatch hook received malformed JSON; refusing an unclassifiable agent dispatch.";
  assert.deepEqual(JSON.parse(run(f, "{not json")), { hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason }, systemMessage: reason });
  assert.deepEqual(files(f.root), before);
  assert.deepEqual(sourceHashes(relative), dependencies);
});

test("checkout deliver CLI distinguishes readable and write-only inherited fd0", t => {
  const relative = "modules/control-plane/node/deliver-hook.mts", dependencies = sourceHashes(relative);
  const f = fixture(t, relative), control = path.join(f.root, "control-empty"), attempt = path.join(f.root, "attempt-empty");
  fs.writeFileSync(control, "");
  const controlFd = fs.openSync(control, "r"), attemptFd = fs.openSync(attempt, "wx"), before = files(f.root);
  try {
    for (const [name, fd, expected] of [["read-only-control", controlFd, ""],
      ["write-only-attempt", attemptFd, "kherep deliver-hook: cannot read stdin: stdin reader unavailable\n"]] as const) {
      const child = spawnSync(process.execPath, [f.entry], { cwd: f.root, env: f.env, stdio: [fd, "pipe", "pipe"],
        encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true });
      t.diagnostic(JSON.stringify({ platform: process.platform, mode: name, status: child.status, signal: child.signal,
        error: child.error ? { name: child.error.name, code: (child.error as NodeJS.ErrnoException).code, message: child.error.message } : null,
        stdout: child.stdout, stderr: child.stderr }));
      assert.equal(child.error, undefined);
      assert.equal(child.signal, null);
      const stderr = child.stderr.replace(/\(node:\d+\) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\r?\n/g, "")
        .replace(/\(Use .+?--trace-warnings.+?\)\r?\n/g, "");
      assert.deepEqual([child.status, child.stdout, stderr], [0, "", expected]);
    }
  } finally { fs.closeSync(controlFd); fs.closeSync(attemptFd); }
  assert.deepEqual(files(f.root), before);
  assert.deepEqual([fs.statSync(control).size, fs.statSync(attempt).size], [0, 0]);
  assert.deepEqual(sourceHashes(relative), dependencies);
});

test("acceptance CLI refuses an in-scope completion without a receipt and accepts C1-C4", t => {
  const f = fixture(t, "codex/hooks/acceptance-gate.mts"), before = files(f.root);
  const env = { KHEREP_WORKSPACE: f.workspace };
  const output = JSON.parse(run(f, JSON.stringify({ cwd: f.workspace, last_assistant_message: `Finished ${TRANSCRIPT_TEXT}` }), [], env));
  const reason = "Completion claim blocked: provide the Kherep C1-C4 acceptance receipt first.";
  assert.deepEqual(output, { continue: false, stopReason: reason, systemMessage: reason });
  assert.equal(run(f, JSON.stringify({ cwd: f.workspace, last_assistant_message: "Finished. C1 correct C2 passed C3 safe C4 scoped" }), [], env), "");
  assert.deepEqual(files(f.root), before);
});
test("observation Stop CLI requests only the first continuation", t => {
  const f = fixture(t, "codex/hooks/observation-stop.mts"), before = files(f.root);
  const payload = { turn_id: "synthetic-turn", stop_hook_active: false, last_assistant_message: TRANSCRIPT_TEXT };
  const first = JSON.parse(run(f, JSON.stringify(payload)));
  assert.equal(first.decision, "block");
  assert.match(first.reason, /dispatch the codex-obs agent/);
  assert.equal(run(f, JSON.stringify({ ...payload, stop_hook_active: true })), "");
  assert.deepEqual(files(f.root), before);
});
test("precompact CLI records metadata without copying transcript contents", t => {
  const f = fixture(t, "codex/hooks/precompact-checkpoint.mts"), transcript = path.join(f.root, "transcript.jsonl");
  fs.writeFileSync(transcript, TRANSCRIPT_TEXT);
  const payload = { transcript_path: transcript, session_id: "synthetic/session", cwd: f.workspace };
  assert.deepEqual(JSON.parse(run(f, JSON.stringify(payload))), {
    systemMessage: "Local Codex pre-compact metadata recorded; the task transcript remains the continuity source.",
  });
  const target = path.join(f.root, "memory/codex-checkpoints/synthetic_session.json");
  const metadata = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(Object.keys(metadata).sort(), ["cwd", "session_id", "timestamp", "transcript_path"]);
  assert.deepEqual({ ...metadata, timestamp: undefined }, { ...payload, timestamp: undefined });
  assert.ok(Number.isFinite(Date.parse(metadata.timestamp)));
  assert.doesNotMatch(fs.readFileSync(target, "utf8"), new RegExp(TRANSCRIPT_TEXT));
  assert.equal(fs.readFileSync(transcript, "utf8"), TRANSCRIPT_TEXT);
});
for (const relative of ["codex/hooks/acceptance-gate.mts", "codex/hooks/observation-stop.mts", "codex/hooks/precompact-checkpoint.mts", "codex/hooks/confluence-delivery-check.mts", "codex/hooks/privacy-boundary-guard.mts"]) {
  test(`${relative}: empty and malformed stdin remain bounded fail-open CLI input`, t => {
    const f = fixture(t, relative), before = files(f.root);
    assert.equal(run(f, ""), "");
    assert.equal(run(f, "{not json"), "");
    assert.deepEqual(files(f.root), before);
  });
}
test("Confluence delivery CLI leaves an out-of-scope SessionStart untouched", t => {
  const f = fixture(t, "codex/hooks/confluence-delivery-check.mts"), before = files(f.root);
  assert.equal(run(f, JSON.stringify({ hook_event_name: "SessionStart", cwd: path.join(f.root, "outside") }), [], { KHEREP_WORKSPACE: f.workspace }), "");
  assert.deepEqual(files(f.root), before);
});
const DEFAULTS = [
  "claude/hooks/critical-file-integrity.mts", "claude/hooks/drift-check-nudge.mts", "codex/hooks/kherep-maestro-context.mts",
  "claude/hooks/live-hook-integrity.mts", "claude/hooks/orphan-check-nudge.mts", "codex/hooks/research-first.mts",
  "claude/hooks/research-first.mts", "codex/hooks/research-stop.mts", "claude/hooks/runtime-capability-snapshot.mts", "claude/hooks/smoke-test-nudge.mts",
];
for (const relative of DEFAULTS) test(`${relative}: empty EOF and an empty object have equivalent bounded effects`, t => {
  const observed: { stdout: string; changed: string[] }[] = [];
  for (const input of ["", "{}"]) {
    const f = fixture(t, relative), before = files(f.root), stdout = run(f, input), after = files(f.root);
    const changed = Object.keys(after).filter(file => before[file] !== after[file]).sort();
    if (relative.includes("critical-file-integrity")) {
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
      assert.match(parsed.hookSpecificOutput.additionalContext, /^ORCHESTRA CRITICAL-FILE-INTEGRITY:/);
      assert.match(parsed.hookSpecificOutput.additionalContext, /NOT restored \(no kherep checkout resolved\)/);
      assert.deepEqual(changed, ["claude-home/.cache/hook-integrity/incidents.jsonl"]);
      const records = fs.readFileSync(path.join(f.claudeHome, ".cache/hook-integrity/incidents.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.ok(records.length > 0 && records.length < 20);
      for (const record of records) {
        assert.equal(record.restoreProven, false);
        assert.equal(record.checkout, "");
        assert.equal(record.restoreDetail, "no kherep checkout resolved");
        assert.ok(record.path.replaceAll("\\", "/").startsWith(`${f.claudeHome.replaceAll("\\", "/")}/`));
      }
    } else if (relative.includes("live-hook-integrity")) {
      assert.deepEqual(JSON.parse(stdout), { hookSpecificOutput: { hookEventName: "SessionStart",
        additionalContext: "ORCHESTRA LIVE-HOOK-INTEGRITY:\n  - no live settings could be read in this home, so WHICH hooks are wired is UNKNOWN here" } });
      assert.deepEqual(changed, []);
    } else {
      assert.equal(stdout, "", "default input outside configured scope yields no reminder or decision");
      assert.deepEqual(changed, [], "default input starts no background work and writes no state");
    }
    observed.push({ stdout: stdout.replaceAll(f.root.replaceAll(path.sep, "/"), "<fixture>").replaceAll(f.root, "<fixture>"), changed });
  }
  assert.deepEqual(observed[0], observed[1]);
});
test("malformed source post-adapter input never invokes its guard; valid input retains its result", t => {
  // Post mode only parses stdin and invokes this absolute synthetic guard. Its
  // dependency graph and explicit homes/config do not read an installed home.
  const f = fixture(t, "codex/hooks/hook-adapter.mts", true), marker = path.join(f.root, "invoked"), guard = path.join(f.root, "post-guard.mts");
  fs.writeFileSync(guard, `import fs from "node:fs";fs.writeFileSync(${JSON.stringify(marker)},"invoked");process.stdin.resume();process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:"SYNTHETIC_POST_RESULT"}}));`);
  assert.equal(run(f, "{not json", [guard, "post"]), "");
  assert.equal(fs.existsSync(marker), false);
  const output = run(f, JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(f.workspace, "public.txt"), content: "safe" } }), [guard, "post"]);
  assert.equal(fs.readFileSync(marker, "utf8"), "invoked");
  assert.equal(JSON.parse(output).hookSpecificOutput.additionalContext, "SYNTHETIC_POST_RESULT");
});
test("installed post-adapter invokes one real guard and creates no denial journal", t => {
  const home = codexHome({ "recording-guard.mts": `import fs from "node:fs";import path from "node:path";let text="";process.stdin.on("data",chunk=>text+=chunk);process.stdin.on("end",()=>{fs.appendFileSync(path.resolve(import.meta.dirname,"../..","invocations.jsonl"),text+"\\n");process.stdout.write("INSTALLED_POST_RESULT");process.stderr.write("installed-post-diagnostic\\n");process.exitCode=2;});` }, "missing", false);
  const marker = path.join(home.root, "invocations.jsonl"), target = path.join(home.hookDir, "recording-guard.mts");
  const entry = path.join(home.hookDir, "codex-hook-adapter.mts"), original = fs.readFileSync(path.join(REPO, "codex/hooks/hook-adapter.mts"));
  const helper = path.join(home.hookDir, "stdin-reader.mts"), canonical = fs.readFileSync(path.join(REPO, "claude/hooks/lib/stdin-reader.mts"));
  assert.deepEqual(fs.readFileSync(entry), original);
  assert.deepEqual(fs.readFileSync(helper), canonical);
  declareCopy(path.join(REPO, "codex/hooks/hook-adapter.mts"), entry);
  const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", entry, target, "post"], {
    cwd: home.root, input: JSON.stringify({ agent_id: "synthetic-post-agent", tool_use_id: "synthetic-post-call",
      tool_name: "Write", tool_input: { file_path: path.join(home.root, "public.txt"), content: "safe" } }),
    encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", windowsHide: true,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, CODEX_HOME: home.root,
      CLAUDE_HOME: path.join(home.root, "claude-home"), KHEREP_CONFIG_DIR: path.join(home.root, "config"), KHEREP_WORKSPACE: "",
      ...(process.env.NODE_V8_COVERAGE === undefined ? {} : { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }) },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.deepEqual([child.status, child.stdout, child.stderr], [2, "INSTALLED_POST_RESULT", "installed-post-diagnostic\n"]);
  const invocations = fs.readFileSync(marker, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].tool_name, "Write");
  assert.equal(fs.existsSync(path.join(home.root, ".cache", "denied-calls")), false);
  assert.deepEqual(fs.readFileSync(entry), original);
  assert.deepEqual(fs.readFileSync(helper), canonical);
});

for (const direct of [false, true]) test(direct
  ? "checkout privacy CLI post-emission fault preserves a real denial byte for byte"
  : "privacy CLI post-emission fault preserves a real denial byte for byte", t => {
  // INJECTED POST-EMISSION FAILURE: the unchanged guard emits the denial first.
  // This does not claim recovery from a natural Node output failure.
  const relative = "claude/hooks/privacy-boundary-guard.mts";
  const injected = fixture(t, relative, direct, false), control = fixture(t, relative, direct, false);
  const dependencies = sourceHashes(relative);
  assert.equal(Object.keys(dependencies).length, 7);
  if (!direct) {
    assert.equal(injected.copied.size, 7);
    assert.deepEqual([...injected.copied].sort(), Object.keys(dependencies).sort());
    assert.deepEqual([...control.copied].sort(), Object.keys(dependencies).sort());
  }
  const hashes = (f: Fixture) => Object.fromEntries([...f.copied].sort().map(file => {
    const bytes = fs.readFileSync(path.join(f.source, file));
    assert.deepEqual(bytes, fs.readFileSync(path.join(REPO, file)));
    return [file, createHash("sha256").update(bytes).digest("hex")];
  }));
  const before = hashes(injected), beforeControl = hashes(control);
  const receipt = path.join(injected.root, "fault-receipt.json"), harness = path.join(injected.root, "fault-harness.mts");
  fs.writeFileSync(harness, `import fs from "node:fs";import {pathToFileURL} from "node:url";
const original=process.stdout.write,record=fs.writeFileSync;let calls=0;
process.stdout.write=function(...args){calls++;process.stdout.write=original;Reflect.apply(original,process.stdout,args);record(${JSON.stringify(receipt)},JSON.stringify({calls,originalReturned:true,restored:process.stdout.write===original}));throw new Error("synthetic post-emission failure");};
await import(pathToFileURL(process.argv[2]).href);`);
  const payload = JSON.stringify({ tool_name: "Read", tool_input: null });
  const execute = (f: Fixture, args: string[]) => {
    const output = path.join(f.root, "guard-output.json"), fd = fs.openSync(output, "wx");
    try {
      const child = spawnSync(process.execPath, args, {
        cwd: f.root, env: f.env, input: payload, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
        stdio: ["pipe", fd, "pipe"], windowsHide: true,
      });
      assert.equal(child.error, undefined);
      assert.equal(child.signal, null);
      assert.equal(child.status, 0, child.stderr);
      assert.doesNotMatch(child.stderr, /synthetic post-emission failure/);
      return { bytes: fs.readFileSync(output), stderr: child.stderr, status: child.status };
    } finally { fs.closeSync(fd); }
  };
  const fault = execute(injected, [harness, injected.entry]), normal = execute(control, [control.entry]);
  assert.deepEqual(fault.bytes, normal.bytes, "the one real guard document is byte-identical to fresh uninjected control");
  assert.deepEqual(JSON.parse(fault.bytes.toString()), { hookSpecificOutput: { hookEventName: "PreToolUse",
    permissionDecision: "deny", permissionDecisionReason: "[privacy-boundary] Malformed input for a privacy-relevant tool; request denied." } });
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt, "utf8")), { calls: 1, originalReturned: true, restored: true });
  assert.deepEqual(hashes(injected), before);
  assert.deepEqual(hashes(control), beforeControl);
  assert.deepEqual(sourceHashes(relative), dependencies);
});

test("four native Node invocation forms keep recorder argv fallback distinct from main not entered", t => {
  const f = fixture(t, "claude/hooks/obs-handback-record.mts", false, false), url = pathToFileURL(f.entry).href;
  // Snapshot the native argument once for a consistent diagnostic, not a main guard.
  const observe = `const entry=process.argv[1];process.stderr.write(JSON.stringify({argv1Present:typeof entry==="string"&&entry.length>0,argv1Type:typeof entry,equalsEntry:entry===${JSON.stringify(f.entry)}})+"\\n");await import(${JSON.stringify(url)});`;
  const forms = [
    { name: "direct", args: [f.entry], main: true },
    { name: "eval-import", args: ["--input-type=module", "--eval", observe], main: false },
    { name: "eval-import-with-real-argument", args: ["--input-type=module", "--eval", observe, f.entry], main: true },
    { name: "import-before-empty-eval", args: ["--import", url, "--eval", ""], main: false },
  ];
  const original = fs.readFileSync(f.entry, "utf8"), sourceUrl = pathToFileURL(f.entry).href;
  const start = original.indexOf('process.argv[1] || ""') + 'process.argv[1] '.length;
  assert.ok(start > 0);
  const observations = [];
  for (const form of forms) {
    const child = spawnSync(process.execPath, form.args, { cwd: f.root, env: f.env, input: "{}", encoding: "utf8",
      timeout: 10_000, killSignal: "SIGKILL", windowsHide: true });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "");
    const native = form.name.startsWith("eval-") ? JSON.parse(child.stderr.trim().split("\n").find(line => line.startsWith("{"))!) : null;
    if (native) assert.deepEqual(native, {
      argv1Present: form.main, argv1Type: form.main ? "string" : "undefined", equalsEntry: form.main,
    });
    let ranges: { main: number; isMainModule: number; fallback: number | null; raw: string[] } | null = null;
    if (process.env.NODE_V8_COVERAGE) {
      const raw = fs.readdirSync(process.env.NODE_V8_COVERAGE).filter(name => name.startsWith(`coverage-${child.pid}-`) && name.endsWith(".json"));
      assert.ok(raw.length > 0);
      const scripts = raw.flatMap(name => JSON.parse(fs.readFileSync(path.join(process.env.NODE_V8_COVERAGE!, name), "utf8")).result)
        .filter((script: { url: string }) => script.url === sourceUrl);
      assert.equal(scripts.length, 1);
      const functions = scripts[0].functions as { functionName: string; ranges: { startOffset: number; endOffset: number; count: number }[] }[];
      const main = functions.find(fn => fn.functionName === "main")!.ranges[0]!.count;
      const isMainModule = functions.find(fn => fn.functionName === "isMainModule")!.ranges[0]!.count;
      const fallback = functions.flatMap(fn => fn.ranges).find(range => range.startOffset === start && range.endOffset === start + 5)?.count ?? null;
      assert.equal(main > 0, form.main);
      if (form.main) assert.equal(fallback, 0, "native nonempty argv does not execute the fallback");
      ranges = { main, isMainModule, fallback, raw };
    }
    observations.push({ form: form.name, native, ranges, status: child.status });
    assert.deepEqual(fs.readFileSync(f.entry), f.original);
  }
  t.diagnostic(JSON.stringify(observations.map(({ form, native, ranges, status }) => ({
    form, native, status,
    ranges: ranges === null ? null : { main: ranges.main, isMainModule: ranges.isMainModule, fallback: ranges.fallback },
  }))));
});
