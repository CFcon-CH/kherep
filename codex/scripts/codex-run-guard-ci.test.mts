// Pins the Codex run guard into ci.yml (issue #550): a deleted or reverted step
// would otherwise switch the guard off with no red signal. The workflow is
// scanned as plain text, as in bootstrap/ci-shard.test.mts; a step block runs
// from one list item at step indentation to the next one or the end of the job.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repo = path.resolve(import.meta.dirname, "../..");
const workflow = fs.readFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");
const guardRun = (platform: string) =>
  `run: node codex/scripts/codex-run-guard.mts run --platform ${platform} --tap "\${{ runner.temp }}/codex-run.tap"`;

// The body of one top-level job, up to the next job key.
function jobBlock(id: string): string {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  assert.ok(start >= 0, `ci.yml has no job "${id}"`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n {2}\S/);
  return next < 0 ? rest : rest.slice(0, next);
}

// Each step of a job as its trimmed lines.
function steps(id: string): string[][] {
  const blocks: string[][] = [];
  for (const line of jobBlock(id).split("\n")) {
    if (/^ {6}- /.test(line)) blocks.push([]);
    if (blocks.length) blocks[blocks.length - 1].push(line.trim().replace(/^- /, ""));
  }
  return blocks;
}

function guardSteps(id: string, platform: string): string[][] {
  return steps(id).filter((block) => block.includes(guardRun(platform)));
}

test("the Windows codex shard runs the guard once, with its condition and timeout", () => {
  const found = guardSteps("unit-windows", "win32");
  assert.equal(found.length, 1, "unit-windows needs exactly one win32 guard step");
  assert.ok(found[0].includes("if: matrix.suite == 'codex'"), found[0].join("\n"));
  assert.ok(found[0].includes("timeout-minutes: 60"), found[0].join("\n"));
});

test("the two ubuntu jobs that ran test:codex run the guard once each", () => {
  for (const job of ["typescript", "unit-engines-floor"]) {
    assert.equal(guardSteps(job, "linux").length, 1, `${job} needs exactly one linux guard step`);
  }
});

test("no step runs npm run test:codex any more", () => {
  assert.doesNotMatch(workflow, /^\s+(?:- )?run: npm run test:codex\b/m);
});
