// Issue #965. The hook adapter run from the checkout: a PostToolUse phase without an absolute
// guard or a JSON payload is silent, a guard's output and exit code pass through, and importing
// the module runs no hook.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const ADAPTER = path.join(import.meta.dirname, "hook-adapter.mts");
const run = (args: string[], input: string) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", ADAPTER, ...args],
  { input, encoding: "utf8", windowsHide: true, timeout: 30_000 });

test("PostToolUse: no absolute guard or no JSON payload is silent; a guard's output and status pass through", (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-adapter-entry-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const guard = path.join(dir, "post-guard.mts");
  fs.writeFileSync(guard, "process.stdout.write('seen'); process.stderr.write('note'); process.exitCode = 3;\n");
  const payload = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/x" } });
  for (const [args, input] of [[["post-guard.mts", "post"], payload], [[guard, "post"], "{not json"], [["", "post"], payload]] as [string[], string][]) {
    const result = run(args, input);
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, "", ""], args.join(" "));
  }
  const result = run([guard, "post"], payload);
  assert.deepEqual([result.status, result.stdout, result.stderr], [3, "seen", "note"]);
});

test("imported, with an argv[1] that is no file, the adapter runs no hook", () => {
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e",
    `await import(${JSON.stringify(pathToFileURL(ADAPTER).href)});`, "no-such-entry.mts"], { input: "{}", encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, "", ""]);
});
