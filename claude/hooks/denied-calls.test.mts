// Issue #504. The renderer CLI as an operator runs it: render with its exit codes, list, prune,
// the home derived from where it is installed (Claude hooks/ and Codex hooks/kherep-maestro/).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";

import { homeOf } from "./denied-calls.mts";
import { journalPaths } from "./lib/denial-journal.mts";

const CLI = path.join(import.meta.dirname, "denied-calls.mts");
const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
function home(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "denied-calls-cli-")));
  roots.push(root);
  fs.mkdirSync(journalPaths(root, "a1").dir, { recursive: true });
  return root;
}
const cli = (args: string[], script = CLI) => {
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script, ...args], { encoding: "utf8", windowsHide: true });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
};
const line = (kind: string, extra: object) => `${JSON.stringify({ v: 1, kind, at: new Date().toISOString(), ...extra })}\n`;
const callWith = (denials: object[]) => line("call", { id: "t1", tool: "Edit", agent_type: "kherep-builder", decision: denials.length ? "deny" : "none", denials });

test("render: a count with its lines, none, and unknown codes with exit 3", () => {
  const root = home();
  const { journal, marker } = journalPaths(root, "a1");
  fs.writeFileSync(journal, callWith([{ guard: "privacy-boundary", target: "<withheld>", reason: "[privacy-boundary] Private paths may not enter Claude file tools.", broken: false }]));
  let run = cli(["--home", root, "render", "a1"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^DENIED-CALLS: 1\n- Edit <withheld> \[privacy-boundary\] Private paths may not enter Claude file tools\.\nstatus: no delivery recorded/);
  fs.writeFileSync(journal, callWith([]) + line("delivered", { id: "h1" }));
  run = cli(["--home", root, "render", "a1"]);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /^DENIED-CALLS: none\nstatus: delivered \d{4}-/);
  for (const [id, code] of [["b2", "journal-missing"], ["bad/id", "no-agent-id"]] as const) {
    run = cli(["--home", root, "render", id]);
    assert.deepEqual([run.status, run.stdout.split("\n")[0]], [3, `DENIED-CALLS: unknown (${code})`]);
  }
  assert.equal(cli(["--home", root, "render"]).stdout.split("\n")[0], "DENIED-CALLS: unknown (no-agent-id)");
  fs.writeFileSync(marker, "append\n");
  run = cli(["--home", root, "render", "a1"]);
  assert.deepEqual([run.status, run.stdout.split("\n")[0]], [3, "DENIED-CALLS: unknown (capture-failed)"]);
});

test("list and prune; a malformed command is usage with exit 2", () => {
  const root = home();
  fs.writeFileSync(journalPaths(root, "a1").journal, callWith([]));
  const listed = cli(["--home", root, "list", "--minutes", "5"]);
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, /^# operator diagnostic only, never acceptance evidence\na1 kherep-builder \S+ 0 denied not delivered\n$/);
  const old = new Date(Date.now() - 25 * 3_600_000);
  fs.utimesSync(journalPaths(root, "a1").journal, old, old);
  assert.equal(cli(["--home", root, "prune"]).stdout, "pruned 1\n");
  assert.equal(fs.existsSync(journalPaths(root, "a1").journal), false);
  for (const args of [[], ["list", "--minutes", "x"], ["render", "a", "b"], ["nope"]]) assert.equal(cli(["--home", root, ...args]).status, 2);
});

test("the home is the installation's: parent of hooks/, or of hooks/kherep-maestro/ for the Codex copy", () => {
  assert.equal(homeOf(path.join("/h", ".claude", "hooks", "denied-calls.mts")), path.resolve("/h/.claude"));
  assert.equal(homeOf(path.join("/h", ".codex", "hooks", "kherep-maestro", "denied-calls.mts")), path.resolve("/h/.codex"));
  const root = home();
  const hooks = path.join(root, "hooks", "kherep-maestro");
  fs.mkdirSync(path.join(hooks, "lib"), { recursive: true });
  fs.copyFileSync(CLI, path.join(hooks, "denied-calls.mts"));
  for (const lib of ["denial-report.mts", "denial-journal.mts", "workspace-scope.mts"]) {
    fs.copyFileSync(path.join(import.meta.dirname, "lib", lib), path.join(hooks, "lib", lib));
    if (lib === "denial-journal.mts") declareCopy(path.join(import.meta.dirname, "lib", lib), path.join(hooks, "lib", lib));
  }
  fs.writeFileSync(journalPaths(root, "a1").journal, callWith([]));
  const run = cli(["render", "a1"], path.join(hooks, "denied-calls.mts"));
  assert.equal(run.stdout.split("\n")[0], "DENIED-CALLS: none", run.stderr);
});
