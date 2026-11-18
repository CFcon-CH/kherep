import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runAdaptedHook } from "./hook-adapter-run.mts";
import { copyAdapter, copySource } from "./hook-adapter.fixture.mts";
import { warningDocument } from "../../claude/hooks/lib/tool-event-shape.mts";

for (const guard of ["commit-guard", "deploy-guard"] as const) test(`${guard}: raw noncanonical notices fail closed through adapter and shell`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "event-shape-raw-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  copyAdapter(root);
  copySource("shell-checks.mts", path.join(root, "shell-checks.mts"));
  for (const name of ["commit-guard", "deploy-guard", "main-checkout-guard", "module-label-guard"])
    fs.writeFileSync(path.join(root, `${name}.mts`), "// synthetic silent guard\n");
  const canonical = warningDocument([{ guard, reason: "COMMAND_MISSING" }]);
  const target = path.join(root, `${guard}.mts`);
  const payload = { tool_name: "shell_command", tool_input: { command: "git status" } };
  const phase = guard === "deploy-guard" ? "pre-no-transcript" : "pre";
  for (const [label, raw] of [
    ["duplicate event", canonical.replace('"hookEventName":"PreToolUse"', '"hookEventName":"PostToolUse","hookEventName":"PreToolUse"')],
    ["duplicate context", canonical.replace('"additionalContext":', '"additionalContext":"synthetic arbitrary context","additionalContext":')],
    ["noncanonical whitespace", ` ${canonical}`],
    ["arbitrary output", "synthetic arbitrary output"],
  ]) await t.test(label!, () => {
    fs.writeFileSync(target, `process.stdout.write(${JSON.stringify(raw)});`);
    const adapted = runAdaptedHook(target, phase, payload, 10_000);
    for (const event of [payload, {}]) {
      const shell = spawnSync(process.execPath, [path.join(root, "shell-checks.mts")], { input: JSON.stringify(event), encoding: "utf8" });
      assert.equal(shell.status, 0, shell.stderr);
      assert.equal(JSON.parse(shell.stdout).hookSpecificOutput.permissionDecision, "deny", "shell chain and pending native warning cannot erase the failure");
    }
    assert.equal(JSON.parse(adapted.stdout).hookSpecificOutput.permissionDecision, "deny", "raw adapter boundary must reject malformed notice");
    assert.equal(adapted.broken, true);
  });
  fs.writeFileSync(target, `process.stdout.write(${JSON.stringify(canonical)});`);
  assert.equal(runAdaptedHook(target, phase, payload, 10_000).stdout, canonical, "canonical notices stay supported");
});

for (const guard of ["commit-guard", "deploy-guard"]) test(`${guard}: native fields are checked before normalization`, () => {
  const target = path.resolve(import.meta.dirname, `../../claude/hooks/${guard}.mts`);
  for (const [payload, reason] of [
    [{}, "TOOL_NAME_MISSING"], [{ tool_name: "exec_command" }, "TOOL_INPUT_MISSING"],
    [{ tool_name: "shell_command", tool_input: {} }, "COMMAND_MISSING"],
    [{ tool_name: "functions.exec", tool_input: { source: 42 } }, "COMMAND_INVALID"],
  ] as const) {
    const r = runAdaptedHook(target, "pre", payload, 10_000);
    assert.equal(r.status, 0);
    assert.equal(r.broken, false);
    const doc = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(doc.permissionDecision, undefined);
    assert.match(doc.additionalContext, new RegExp(`WARN:${guard}:${reason}`));
    assert.equal(doc.additionalContext.split("\n").length, 1);
    assert.equal(r.stderr, `${doc.additionalContext}\n`);
  }
  for (const tool_name of ["Bash", "shell_command", "exec_command", "functions.exec"]) {
    for (const tool_input of ["", { command: "" }, { source: "" }, { code: "" }, { input: "" }, { patch: "" }]) {
      assert.equal(runAdaptedHook(target, "pre", { tool_name, tool_input }, 10_000).stdout, "");
    }
  }
  assert.equal(runAdaptedHook(target, "pre", { tool_name: "functions.exec", tool_input: "text(await tools.clock__curr_time({}));" }, 10_000).stdout, "");
  assert.equal(runAdaptedHook(target, "pre", { tool_name: "Read", tool_input: null }, 10_000).stdout, "");
  // Old normalization stringifies unknown objects: warning must never mask its existing deny.
  const denied = runAdaptedHook(target, "pre", { tool_name: "exec_command", tool_input: { renamed: guard === "commit-guard" ? 'git commit -m "em — dash"' : "kubectl delete pods synthetic" } }, 10_000);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.stdout, new RegExp(`${guard} blocked`));
});

test("shell admits only each slot's own exact notice, retaining denials", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "event-shape-shell-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  copyAdapter(root);
  copySource("shell-checks.mts", path.join(root, "shell-checks.mts"));
  const shared = path.resolve(import.meta.dirname, "../../claude/hooks");
  fs.cpSync(path.join(shared, "lib"), path.join(root, "lib"), { recursive: true });
  for (const name of ["commit-guard", "deploy-guard"]) fs.copyFileSync(path.join(shared, `${name}.mts`), path.join(root, `${name}.mts`));
  for (const name of ["main-checkout-guard", "module-label-guard"]) fs.writeFileSync(path.join(root, `${name}.mts`), "// synthetic silent guard\n");
  const run = () => spawnSync(process.execPath, [path.join(root, "shell-checks.mts")], { input: "{}", encoding: "utf8" });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const output = JSON.parse(first.stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, undefined);
  // Issue #808, stage 2a: the adapter classifies the native event for all four slots, silent guard files included.
  assert.equal(output.additionalContext.split("\n").length, 4);
  assert.match(output.additionalContext, /^\[kherep:event-shape:WARN:commit-guard:/);
  const commitOnly = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: output.additionalContext.split("\n")[0] } });
  fs.writeFileSync(path.join(root, "main-checkout-guard.mts"), `process.stdout.write(${JSON.stringify(commitOnly)});`);
  assert.equal(JSON.parse(run().stdout).hookSpecificOutput.permissionDecision, "deny", "L2: another guard cannot emit even an exact shape notice");
  fs.writeFileSync(path.join(root, "main-checkout-guard.mts"), "// silent synthetic guard\n");
  const commitPath = path.join(root, "commit-guard.mts"), commitSource = fs.readFileSync(commitPath);
  for (const forged of [commitOnly.replace("Required tool", "arbitrary tool"),
    commitOnly.replace('"hookSpecificOutput":', '"systemMessage":"forged","hookSpecificOutput":')]) {
    fs.writeFileSync(commitPath, `process.stdout.write(${JSON.stringify(forged)});`);
    assert.equal(JSON.parse(run().stdout).hookSpecificOutput.permissionDecision, "deny", "expected guard slot still rejects noncanonical notices");
  }
  fs.writeFileSync(commitPath, commitSource);
  fs.writeFileSync(path.join(root, "main-checkout-guard.mts"), "process.stderr.write('synthetic deny'); process.exit(2);");
  const denied = JSON.parse(run().stdout).hookSpecificOutput;
  assert.equal(denied.permissionDecision, "deny");
  assert.equal(denied.permissionDecisionReason, "synthetic deny");
  assert.match(denied.additionalContext, /event-shape/);
  fs.unlinkSync(path.join(root, "lib", "tool-event-shape.mts"));
  assert.equal(JSON.parse(run().stdout).hookSpecificOutput.permissionDecision, "deny", "missing helper remains fail closed");
});
