// Issue #507, part 4. The Codex shell dispatcher's one integer clock: it ends
// 1.5 s before the rendered `timeout = 40` of its group and bounds stdin, every
// guard and the re-check. Attribution runs after the re-check, uncapped and
// in-process, so the final answer has no end-to-end deadline (case d documents
// that order; it asserts no deadline).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { renderHooks } from "../lib/parity-config.mts";
import { copyAdapter } from "./hook-adapter.fixture.mts";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const SOURCE = path.join(import.meta.dirname, "shell-checks.mts");
const PAYLOAD = { hook_event_name: "PreToolUse", tool_name: "shell_command", tool_input: { command: "git status" } };
const GUARDS = ["commit-guard", "deploy-guard", "main-checkout-guard", "module-label-guard"];
const now = "performance.timeOrigin + performance.now()";

// Installed (<root>/hooks/kherep-maestro) or flat; guards and the re-check fixture trace into trace.jsonl.
function box(t: TestContext, { installed, guard, integrity, attribution }: { installed: boolean; guard: string; integrity?: string; attribution?: string }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-shell-budget-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = installed ? path.join(root, "hooks", "kherep-maestro") : root;
  const trace = path.join(root, "trace.jsonl");
  const line = (who: string): string => `fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ who: ${JSON.stringify(who)}, t: ${now} }) + "\\n");`;
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync(SOURCE, path.join(dir, installed ? "codex-shell-checks.mts" : "shell-checks.mts"));
  for (const name of ["hook-adapter.mts", ...(installed ? ["codex-hook-adapter.mts"] : [])]) copyAdapter(dir, name);
  fs.copyFileSync(path.join(REPO, "claude", "hooks", "lib", "guard-recheck.mts"), path.join(dir, "lib", "guard-recheck.mts"));
  for (const name of GUARDS) fs.writeFileSync(path.join(dir, `${name}.mts`), `import fs from "node:fs";\n${line(name)}\n${guard}\n`);
  if (integrity !== undefined) fs.writeFileSync(path.join(dir, "codex-hook-integrity.mts"), `import fs from "node:fs";\n${line("recheck-start")}\n${integrity}\n${line("recheck-end")}\n`);
  let hook: string | undefined;
  if (attribution !== undefined) {
    hook = path.join(root, "attribution", "attribution-hook.mts");
    fs.mkdirSync(path.dirname(hook));
    fs.writeFileSync(hook, `import fs from "node:fs";\nexport function handleAttributionHook() { ${line("attribution-start")} ${attribution} ${line("attribution-end")} }\n`);
    fs.writeFileSync(path.join(path.dirname(hook), "config.mts"), "export const nodePaths = () => ({});\n");
  }
  const rows = (): { who: string; t: number }[] => fs.existsSync(trace)
    ? fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((row) => JSON.parse(row)) : [];
  const run = () => {
    const begin = Date.now();
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(dir, "codex-shell-checks.mts"), ...(hook ? [hook, "--runtime", "codex"] : [])],
      { input: JSON.stringify(PAYLOAD), encoding: "utf8", windowsHide: true, timeout: 60_000 });
    return { ...result, ms: Date.now() - begin, end: Date.now() };
  };
  return { dir, rows, run };
}

test("T8a HOOK_TIMEOUT_MS equals the rendered shell timeout with and without the Control Plane hook; margin 1 500 ms", () => {
  const source = fs.readFileSync(SOURCE, "utf8");
  const pinned = Number(/^const HOOK_TIMEOUT_MS = ([\d_]+);/m.exec(source)?.[1]?.replaceAll("_", ""));
  assert.equal(Number(/^const SAFETY_MARGIN_MS = ([\d_]+);/m.exec(source)?.[1]?.replaceAll("_", "")), 1500);
  for (const controlPlaneHook of [undefined, "/synthetic/repo/modules/control-plane/node/deliver-hook.mts"]) {
    const config = renderHooks({ contextHook: "/synthetic/context.mts", hookDir: "/synthetic/hooks", node: "node", controlPlaneHook } as Parameters<typeof renderHooks>[0]);
    const entry = config.split(/^\[\[hooks\.PreToolUse\.hooks\]\]$/m).find((block) => /^command = .*codex-shell-checks\.mts/m.test(block))!;
    assert.equal(Number(/^timeout = (\d+)$/m.exec(entry)?.[1]) * 1000, pinned);
  }
});

test("T8b four slow guards and a re-check that never ends: one answer, the re-check reported, inside 40 s", (t) => {
  const b = box(t, { installed: true, guard: "process.on('SIGTERM', () => {}); setTimeout(() => {}, 7_000);",
    integrity: "await new Promise((resolve) => setTimeout(resolve, 10_000));" });
  const run = b.run();
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.ms < 40_000, `took ${run.ms} ms`);
  const doc = JSON.parse(run.stdout) as { hookSpecificOutput: { permissionDecision?: string; additionalContext?: string } };
  assert.match(String(doc.hookSpecificOutput.additionalContext), /\n {2}- (?:skipped, \d+ ms left of the hook budget|timed out after \d+ ms)/);
  assert.deepEqual(b.rows().map((row) => row.who).slice(0, 4), GUARDS);
});

test("T8c an exhausted deadline denies before any guard starts", async (t) => {
  const b = box(t, { installed: false, guard: "" });
  const { shellChecks } = await import(pathToFileURL(path.join(b.dir, "shell-checks.mts")).href) as typeof import("./shell-checks.mts");
  const output = await (shellChecks as (...args: unknown[]) => Promise<string>)(PAYLOAD, undefined, { deadline: Date.now() + 50 });
  const reason = String((JSON.parse(output) as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason);
  assert.match(reason, /cannot run \(budget exhausted before item 1 of 1/);
  assert.deepEqual(b.rows(), []);
});

test("T8d order documented, no deadline asserted: a slow attribution after a finished re-check delays the deny", (t) => {
  const b = box(t, { installed: true, guard: "", integrity: "", attribution: "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1800);" });
  fs.writeFileSync(path.join(b.dir, "commit-guard.mts"), "process.stderr.write('synthetic deny'); process.exit(2);\n");
  const run = b.run();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecisionReason, "synthetic deny");
  const order = b.rows();
  assert.deepEqual(order.map((row) => row.who), ["deploy-guard", "main-checkout-guard", "module-label-guard", "recheck-start", "recheck-end", "attribution-start", "attribution-end"]);
  for (let i = 1; i < order.length; i++) assert.ok(order[i]!.t >= order[i - 1]!.t);
  assert.ok(order.at(-1)!.t - order.at(-2)!.t >= 1700, "attribution took its 1.8 s after the re-check");
  assert.ok(run.ms >= 1800, `the answer came after attribution (${run.ms} ms)`);
});
