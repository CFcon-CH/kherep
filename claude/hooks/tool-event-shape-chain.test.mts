import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { copyDeclared, copyTreeDeclared } from "./copy-declare-fixture.mts";
import { cleanup, runtimeHome, entry } from "./hook-runtime-fixture.mts";
import { plantHeartbeat } from "./guard-dispatch-fixture.mts";

after(cleanup);
const guards = ["commit-guard", "deploy-guard"] as const;
const cases: [unknown, string][] = [
  [{}, "TOOL_NAME_MISSING"], [{ name: "Bash", secret: "SYNTHETIC_PRIVATE" }, "TOOL_NAME_MISSING"],
  ...[null, false, 12, {}, [], "", "  "].map(value => [{ tool_name: value }, "TOOL_NAME_INVALID"] as [unknown, string]),
  [{ tool_name: "Bash" }, "TOOL_INPUT_MISSING"], [{ tool_name: "Bash", tool_input: null }, "TOOL_INPUT_MISSING"],
  ...[false, 12, "text", []].map(value => [{ tool_name: "Bash", tool_input: value }, "TOOL_INPUT_INVALID"] as [unknown, string]),
  [{ tool_name: "Bash", tool_input: {} }, "COMMAND_MISSING"],
  ...[null, false, 12, {}, []].map(value => [{ tool_name: "Bash", tool_input: { command: value } }, "COMMAND_INVALID"] as [unknown, string]),
  ...[null, [], 12, false, "text"].map(value => [value, "EVENT_ENVELOPE_INVALID"] as [unknown, string]),
];
for (const guard of guards) test(`${guard}: direct malformed fields warn without a permission decision or payload leak`, () => {
  for (const [payload, reason] of cases) {
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(import.meta.dirname, `${guard}.mts`)], {
      input: JSON.stringify(payload), encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout, `${guard} ${reason} must warn`);
    const doc = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(doc), ["hookSpecificOutput"]);
    assert.deepEqual(Object.keys(doc.hookSpecificOutput), ["hookEventName", "additionalContext"]);
    assert.match(doc.hookSpecificOutput.additionalContext, new RegExp(`^\\[kherep:event-shape:WARN:${guard}:${reason}\\]`));
    assert.equal(r.stderr, `${doc.hookSpecificOutput.additionalContext}\n`);
    assert.doesNotMatch(r.stdout + r.stderr, /SYNTHETIC_PRIVATE/);
  }
  for (const raw of ["", "{broken"]) {
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, `${guard}.mts`)], { input: raw, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /EVENT_ENVELOPE_INVALID/);
  }
});

for (const guard of guards) test(`${guard}: unrelated names and valid empty commands remain exactly silent`, () => {
  for (const payload of [{ tool_name: "Read", tool_input: 42 }, { tool_name: " Bash", tool_input: null },
    ...["", " ", "git status"].map(command => ({ tool_name: "Bash", tool_input: { command } }))]) {
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(import.meta.dirname, `${guard}.mts`)], {
      input: JSON.stringify(payload), encoding: "utf8",
    });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
  }
});

test("Claude runtime and dispatcher transport both warnings and preserve a concurrent deny", () => {
  const home = runtimeHome("event-shape-chain-");
  copyTreeDeclared(path.join(import.meta.dirname, "lib"), path.join(home.hooks, "lib"));
  for (const file of ["guard-dispatch.mts", "commit-guard.mts", "deploy-guard.mts"])
    copyDeclared(path.join(import.meta.dirname, file), path.join(home.hooks, file));
  const target = path.join(home.hooks, "guard-dispatch.mts");
  plantHeartbeat(home.root);
  const args = ["commit-guard.mts", "deploy-guard.mts"].map(file => path.join(home.hooks, file));
  const r = entry("pretool", target, args, "{}", 40_000, { ...process.env, NODE_NO_WARNINGS: "1" });
  assert.equal(r.status, 0, r.stderr);
  const output = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, undefined);
  assert.match(output.additionalContext, /WARN:commit-guard:TOOL_NAME_MISSING/);
  assert.match(output.additionalContext, /WARN:deploy-guard:TOOL_NAME_MISSING/);
  fs.writeFileSync(path.join(home.hooks, "synthetic-deny.mts"), "process.stderr.write('synthetic policy deny'); process.exit(2);");
  const denied = entry("pretool", target, [...args, path.join(home.hooks, "synthetic-deny.mts")], "{}", 40_000, { ...process.env, NODE_NO_WARNINGS: "1" });
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.stdout, /synthetic policy deny/);
  for (const raw of ["null", "[]", "{broken"]) {
    const bad = entry("pretool", target, args, raw);
    assert.equal(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision, "deny");
  }
});
