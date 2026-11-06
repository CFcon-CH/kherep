// Issue #833. .github/module-labels.json is what the guards read; the table in
// CONTRIBUTING.md is what people read. The two must name the same labels.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ruleFor } from "../claude/hooks/lib/module-label.mts";

const repo = path.resolve(import.meta.dirname, "..");
const read = (name: string): string => fs.readFileSync(path.join(repo, name), "utf8");

function tableLabels(): string[] {
  const lines = read("CONTRIBUTING.md").split(/\r?\n/);
  const header = lines.indexOf("| Label | Area |");
  assert.ok(header >= 0, "CONTRIBUTING.md has the module label table");
  const rows = lines.slice(header + 2);
  const end = rows.findIndex((line) => !line.startsWith("|"));
  return rows.slice(0, end).flatMap((row) => [...row.split("|")[1]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!));
}

const source = JSON.parse(read(".github/module-labels.json")) as { version: unknown; repository: unknown; labels: string[] };

test("the JSON names exactly the labels of the CONTRIBUTING.md table", () => {
  assert.deepEqual([...source.labels].sort(), tableLabels().sort());
});

test("the broker module has a label, and the extras do not count as module labels", () => {
  assert.ok(source.labels.includes("github-broker"));
  for (const extra of ["flaky-test", "documentation"]) assert.ok(!source.labels.includes(extra), extra);
});

test("the JSON is version 1 for this repository", () => {
  assert.equal(source.version, 1);
  assert.equal(source.repository, "CFcon-CH/kherep");
});

test("the guards accept the committed file as a rule for this repository", () => {
  const rule = ruleFor(repo);
  assert.equal(rule.kind, "rule");
  assert.equal(ruleFor(repo, "cfcon-ch/KHEREP").kind, "rule");
  assert.equal(ruleFor(repo, "example/project").kind, "none");
});

test("CONTRIBUTING.md points the rule at the file the guards read", () => {
  assert.match(read("CONTRIBUTING.md"), /`\.github\/module-labels\.json`/);
});
