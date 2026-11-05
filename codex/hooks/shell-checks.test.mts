import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { nodePaths } from "../../modules/control-plane/node/config.mts";
import { copyAdapter } from "./hook-adapter.fixture.mts";
import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";

const GUARDS = ["commit-guard", "deploy-guard", "main-checkout-guard"];
function fixture(t: import("node:test").TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shell-dispatch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(path.join(import.meta.dirname, "shell-checks.mts"), path.join(root, "shell-checks.mts"));
  declareCopy(path.join(import.meta.dirname, "shell-checks.mts"), path.join(root, "shell-checks.mts"));
  copyAdapter(root);
  const trace = path.join(root, "trace.jsonl");
  fs.writeFileSync(trace, "");
  for (const guard of GUARDS) fs.writeFileSync(path.join(root, `${guard}.mts`), `import fs from 'node:fs';
const payload=JSON.parse(fs.readFileSync(0,'utf8'));
fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({guard:${JSON.stringify(guard)},payload})+'\\n');`);
  const attribution = path.join(root, "attribution-hook.mts");
  fs.writeFileSync(attribution, `import fs from 'node:fs'; export function handleAttributionHook(payload,runtime){fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({guard:'attribution',payload,runtime})+'\\n');}`);
  fs.writeFileSync(path.join(root, "config.mts"), "export const nodePaths=()=>({});");
  const run = (payload: unknown = { tool_name: "shell_command", tool_input: { command: "git status" } }, target = attribution) => spawnSync(process.execPath,
    [path.join(root, "shell-checks.mts"), target, "--runtime", "codex"], {
      input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8", timeout: 20_000,
      env: { ...process.env, KHEREP_CONFIG_DIR: root, KHEREP_WORKSPACE: root },
    });
  const rows = () => fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s) as { guard: string; payload: { tool_name: string; transcript_path?: string | null; tool_input: { command: string } }; runtime?: string });
  return { root, run, rows };
}

test("exec normalization, transcript-free deploy approval and raw attribution share one dispatcher", (t) => {
  const f = fixture(t);
  const payload = { hook_event_name: "PreToolUse", tool_name: "functions.exec", transcript_path: "/synthetic/never-read",
    tool_input: String.raw`await tools.shell_command({command:"$env:KHEREP_DEPLOY_AUTH='approved'; kubectl delete pods synthetic"});` };
  const r = f.run(payload);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  const rows = f.rows();
  assert.deepEqual(rows.map(x => x.guard), [...GUARDS, "attribution"]);
  assert.equal(rows[0]?.payload.tool_name, "Bash");
  assert.equal(rows[0]?.payload.transcript_path, payload.transcript_path);
  assert.equal(rows[1]?.payload.transcript_path, null);
  assert.match(rows[1]!.payload.tool_input.command, /^KHEREP_DEPLOY_AUTH=approved /);
  assert.equal(rows[3]?.payload.tool_name, "functions.exec");
  assert.equal(rows[3]?.runtime, "codex");
});

test("the real attribution module records a pending push for the original owner in-process", (t) => {
  const f = fixture(t);
  assert.equal(spawnSync("git", ["init", f.root], { encoding: "utf8" }).status, 0);
  const owner = "01a0db74-0000-7000-8000-000000000001";
  const result = f.run({ hook_event_name: "PreToolUse", session_id: owner, cwd: f.root,
    tool_name: "functions.exec", tool_input: 'await tools.shell_command({command:"git push origin main"});' },
  path.resolve(import.meta.dirname, "../../modules/control-plane/node/attribution-hook.mts"));
  assert.equal(result.status, 0, result.stderr);
  const dir = nodePaths(f.root).attributionPending;
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, files[0]!), "utf8")).sessionId, owner);
});

test("a deny is one JSON document; other guards and attribution still execute", (t) => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.root, "commit-guard.mts"), "process.stderr.write('synthetic deny'); process.exit(2);");
  const r = f.run();
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, "synthetic deny");
  assert.deepEqual(f.rows().map(x => x.guard), [...GUARDS, "attribution"]);
});

for (const failure of ["missing", "empty", "syntax", "exit", "signal", "timeout", "adapter-missing", "malformed-output", "unsupported-output"]) {
  test(`guard ${failure} fails closed through JSON instead of a nonblocking native exit`, (t) => {
    const f = fixture(t);
    const file = path.join(f.root, "deploy-guard.mts");
    if (failure === "missing") fs.unlinkSync(file);
    else if (failure === "empty") fs.writeFileSync(file, "");
    else if (failure === "syntax") fs.writeFileSync(file, "export const broken = ;");
    else if (failure === "exit") fs.appendFileSync(file, "process.exit(1);");
    else if (failure === "signal") fs.appendFileSync(file, "process.kill(process.pid,'SIGTERM');");
    else if (failure === "timeout") fs.appendFileSync(file, "setInterval(()=>{},1000);");
    else if (failure === "malformed-output") fs.appendFileSync(file, "process.stdout.write('broken');");
    else if (failure === "unsupported-output") fs.appendFileSync(file, "process.stdout.write('[]');");
    else fs.unlinkSync(path.join(f.root, "hook-adapter.mts"));
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  });
}

test("malformed input denies without starting a guard", (t) => {
  const f = fixture(t);
  for (const input of ["{broken", "null", "[]"]) {
    const r = f.run(input);
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  }
  assert.equal(f.rows().length, 0);
});
