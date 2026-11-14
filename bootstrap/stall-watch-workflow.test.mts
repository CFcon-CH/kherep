// Issue #744. Structural guard for .github/workflows/stall-watch.yml: a
// schedule and no pull request trigger, least-privilege permissions, no secret,
// no install step, and only the GitHub-owned actions at the versions ci.yml
// pins. Line-based on purpose: the repository has no YAML parser dependency.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const workflows = path.resolve(import.meta.dirname, "../.github/workflows");
const source = fs.readFileSync(path.join(workflows, "stall-watch.yml"), "utf8");
const ci = fs.readFileSync(path.join(workflows, "ci.yml"), "utf8");
const lines = source.split("\n");
const code = lines.map((line) => line.split(" #", 1)[0]).filter((line) => !line.trim().startsWith("#"));

function block(header: string, indent: string): string[] {
  const start = code.findIndex((line) => line === `${indent}${header}`);
  assert.ok(start >= 0, `${header} block present`);
  const body: string[] = [];
  for (const line of code.slice(start + 1)) {
    if (line.trim() && !line.startsWith(`${indent}  `)) break;
    if (line.trim()) body.push(line.trim());
  }
  return body;
}

test("triggers: schedule off the hour and manual dispatch, never a pull request event", () => {
  assert.deepEqual(block("on:", ""), [
    "schedule:", '- cron: "7-59/10 * * * *"', "workflow_dispatch:", "inputs:", "dry_run:",
    "description: Print what would be posted instead of posting it", "type: boolean", "default: true",
  ]);
  assert.ok(!/pull_request/.test(code.join("\n")), "no pull_request or pull_request_target trigger");
});

test("permissions: none at the top, exactly three on the job", () => {
  assert.ok(code.includes("permissions: {}"), "top-level permissions: {}");
  assert.deepEqual(block("permissions:", "    "), ["contents: read", "checks: read", "pull-requests: write"]);
  assert.equal(code.filter((line) => line.trim().startsWith("permissions:")).length, 2);
});

test("only GitHub-owned actions, at the versions ci.yml pins, without persisted credentials", () => {
  const uses = code.filter((line) => line.includes("uses:")).map((line) => line.trim().replace(/^- uses: /, ""));
  assert.deepEqual(uses, ["actions/checkout@v7", "actions/setup-node@v7"]);
  for (const action of uses) assert.ok(ci.includes(`- uses: ${action}\n`), `${action} is the version ci.yml pins`);
  assert.ok(ci.includes("runs-on: ubuntu-26.04") && code.includes("    runs-on: ubuntu-26.04"), "same runner as ci.yml");
  assert.ok(code.includes("          persist-credentials: false"));
});

test("no secret, no install, no pull request data; the script runs from the checkout", () => {
  const text = code.join("\n");
  assert.ok(!/secrets\./.test(text), "no repository secret");
  assert.ok(!/\bnpm\b|\bnpx\b/.test(text), "no dependency install");
  assert.ok(!/github\.event\.pull_request|github\.head_ref/.test(text), "no pull request controlled value");
  assert.ok(code.includes("        run: node bootstrap/stall-watch.mts"));
  assert.ok(code.includes("          GITHUB_TOKEN: ${{ github.token }}"));
});

test("the job id is not a ci.yml job, so it cannot collide with a required check name", () => {
  const jobs = block("jobs:", "").filter((line) => /^[\w-]+:$/.test(line));
  assert.deepEqual(jobs.filter((line) => line === "stall-watch:"), ["stall-watch:"]);
  assert.ok(!/^ {2}stall-watch:$/m.test(ci), "ci.yml has no stall-watch job");
  assert.ok(!code.some((line) => /^ {4}name:/.test(line)), "no job-level name overrides the check context");
});
