// Issue #973. Structural guard for .github/workflows/ci-rerun.yml (triggers, exact
// permissions, pinned actions, numeric-only environment), and the ci.yml coupling the
// rerun decision relies on: the coverage gate step and needs, the jobs with needs, and
// macOS only as macos-latest. Line-based on purpose: the repository has no YAML parser.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CI_PATH, GATE } from "./ci-rerun.mts";

const root = path.resolve(import.meta.dirname, "..");
const strip = (source: string) => source.split("\n").map((line) => line.split(" #", 1)[0]).filter((line) => !line.trim().startsWith("#"));
const code = strip(fs.readFileSync(path.join(root, ".github/workflows/ci-rerun.yml"), "utf8"));
const ciSource = fs.readFileSync(path.join(root, CI_PATH), "utf8");
const ci = strip(ciSource);

function block(lines: string[], header: string, indent: string): string[] {
  const start = lines.findIndex((line) => line === `${indent}${header}`);
  assert.ok(start >= 0, `${header} block present`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith(`${indent}  `)) break;
    if (line.trim()) body.push(line.trim());
  }
  return body;
}

// Job id -> its lines, for the top-level jobs of a workflow.
function jobs(lines: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let current = "";
  for (const line of lines.slice(lines.indexOf("jobs:") + 1)) {
    const id = /^ {2}([\w-]+):$/.exec(line);
    if (id) { current = id[1]; map.set(current, []); } else if (current) map.get(current)?.push(line);
  }
  return map;
}

test("triggers: completed CI runs, an off-the-hour sweep and a manual dispatch that defaults to a dry run", () => {
  assert.deepEqual(block(code, "on:", ""), [
    "workflow_run:", "workflows: [CI]", "types: [completed]",
    "schedule:", '- cron: "3-59/10 * * * *"',
    "workflow_dispatch:", "inputs:", "dry_run:", "description: Print the decision instead of requesting a rerun", "type: boolean", "default: true",
    "run_id:", "description: Numeric id of one CI run to evaluate; empty sweeps the last six hours", "type: number", "required: false",
  ]);
  assert.ok(!/pull_request/.test(code.join("\n")), "no pull_request or pull_request_target trigger");
  assert.deepEqual(block(code, "concurrency:", ""), ["group: ci-rerun", "cancel-in-progress: false"]);
  assert.ok(code.includes("    timeout-minutes: 5"));
});

test("permissions: none at the top, exactly actions write, checks read and contents read on the job", () => {
  assert.ok(code.includes("permissions: {}"), "top-level permissions: {}");
  assert.deepEqual(block(code, "permissions:", "    "), ["actions: write", "checks: read", "contents: read"]);
  assert.equal(code.filter((line) => line.trim().startsWith("permissions:")).length, 2);
});

test("only GitHub-owned actions, at the versions ci.yml pins, without persisted credentials", () => {
  const uses = code.filter((line) => line.includes("uses:")).map((line) => line.trim().replace(/^- uses: /, ""));
  assert.deepEqual(uses, ["actions/checkout@v7", "actions/setup-node@v7"]);
  for (const action of uses) assert.ok(ciSource.includes(`- uses: ${action}\n`), `${action} is the version ci.yml pins`);
  assert.ok(code.includes("    runs-on: ubuntu-26.04") && ciSource.includes("runs-on: ubuntu-26.04"), "same runner as ci.yml");
  assert.ok(code.includes("          persist-credentials: false"));
});

test("no secret, no install, no cache; the environment carries the token and numbers only", () => {
  const text = code.join("\n");
  assert.ok(!/secrets\.|\bnpm\b|\bnpx\b|cache:/.test(text), "no secret, install or cache");
  assert.ok(!/head_branch|head_ref|pull_request\.|display_title|head_commit/.test(text), "no pull request controlled value");
  assert.deepEqual(block(code, "env:", "        "), [
    "GITHUB_TOKEN: ${{ github.token }}",
    "CI_RERUN_DRY_RUN: ${{ github.event_name == 'workflow_dispatch' && inputs.dry_run || 'false' }}",
    "CI_RERUN_RUN_ID: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.id || inputs.run_id }}",
    "CI_RERUN_RUN_ATTEMPT: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.run_attempt || '' }}",
  ]);
  assert.equal(code.filter((line) => line.includes("${{")).length, 4, "no other expression");
  assert.equal(code.filter((line) => /^\s+(- )?run:/.test(line)).length, 1);
  assert.ok(code.includes("        run: node bootstrap/ci-rerun-main.mts"));
});

test("the job id is not a ci.yml job, so it cannot collide with a required check name", () => {
  assert.deepEqual([...jobs(code).keys()], ["ci-rerun"]);
  assert.ok(!jobs(ci).has("ci-rerun"));
  assert.ok(!code.some((line) => /^ {4}name:/.test(line)), "no job-level name overrides the check context");
});

test("ci.yml coupling: coverage-report gate step and needs match the DERIVED rule", () => {
  const coverage = jobs(ci).get(GATE.job) ?? [];
  assert.ok(coverage.includes(`      - name: ${GATE.step}`), "gate step present under its exact name");
  assert.deepEqual(coverage.filter((line) => line.startsWith("    needs:")), [`    needs: [${GATE.needs.join(", ")}]`]);
  assert.ok(GATE.needs.includes("unit"));
});

test("ci.yml coupling: the jobs with needs are exactly unit-windows-gate, smoke, coverage-report and sonar", () => {
  const withNeeds = [...jobs(ci)].filter(([, lines]) => lines.some((line) => line.startsWith("    needs:"))).map(([id]) => id);
  assert.deepEqual(new Set(withNeeds), new Set(["unit-windows-gate", "smoke", "coverage-report", "sonar"]));
});

test("ci.yml coupling: a macOS runner is requested only as macos-latest", () => {
  const runnerLines = ci.filter((line) => /^\s+(os: \[|runs-on:)/.test(line));
  const macos = runnerLines.flatMap((line) => line.match(/\bmacos[\w.-]*/g) ?? []);
  assert.equal(macos.length, 3, "contract, unit and smoke list macOS");
  assert.deepEqual(new Set(macos), new Set(["macos-latest"]));
  assert.ok(runnerLines.filter((line) => line.includes("runs-on:")).every((line) => !/macos/.test(line)), "runs-on passes matrix.os through");
});
