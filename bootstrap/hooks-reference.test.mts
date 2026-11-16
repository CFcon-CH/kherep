// Issues #587 and #588. docs/HOOKS.md is the hook reference: one table row per
// wired hook. These checks run bootstrap/hooks-reference.mts against the
// repository and fail when a wired hook has no row or two, when a row names a
// hook nothing wires, or when a row's cells break the vocabulary. README.md must
// link the reference from its Documentation table and its Security model
// section. In-process only: no install, no child process, no network. The
// rules themselves are pinned in bootstrap/hooks-reference-fixtures.test.mts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  cellProblems, cellsOf, claudeInventory, inventory, read, readmeLinkProblems, REFERENCE, referenceRows, repo, type Row,
} from "./hooks-reference.mts";
import { TOOL_EVENT_CONTRACT } from "../claude/hooks/lib/tool-event-contract.mts";

function loadReference(): Row[] {
  if (!fs.existsSync(path.join(repo, REFERENCE))) assert.fail(`${REFERENCE} is missing: it must hold one table row per wired hook`);
  return referenceRows(read(REFERENCE));
}

test("every wired template command is classified", () => {
  assert.deepEqual(claudeInventory().errors, []);
});

test("every wired hook has exactly one row in docs/HOOKS.md", () => {
  const wired = inventory();
  const present = fs.existsSync(path.join(repo, REFERENCE));
  const counts = new Map<string, number>();
  for (const row of present ? loadReference() : []) counts.set(row.stem, (counts.get(row.stem) ?? 0) + 1);
  const width = Math.max(...[...wired.keys()].map((stem) => stem.length));
  const lines = [...wired].flatMap(([stem, { sources }]) => {
    const n = counts.get(stem) ?? 0;
    return n === 0 ? [`${stem.padEnd(width)}  ${sources.join("; ")}`] : n > 1 ? [`${stem.padEnd(width)}  rows ${n}`] : [];
  });
  if (!lines.length) return;
  assert.fail([present ? `${REFERENCE}: ${lines.length} of ${wired.size} wired hooks lack exactly one row:`
    : `${REFERENCE} is missing; ${lines.length} of ${wired.size} wired hooks have no row:`, ...lines,
  "Fix: add one table row for <stem> to docs/HOOKS.md (first cell: the stem in backticks)."].join("\n"));
});

test("no row in docs/HOOKS.md names a hook nothing wires", () => {
  const wired = inventory();
  const stale = loadReference().filter((row) => !wired.has(row.stem))
    .map((row) => `stale row ${row.stem}: no source wires it; remove the row or re-wire the hook`);
  assert.deepEqual(stale, []);
});

test("every row of docs/HOOKS.md has valid cells", () => {
  const wired = inventory();
  assert.deepEqual(loadReference().flatMap((row) => cellProblems(row, wired.get(row.stem)?.runtimes)), []);
});

test("README.md links the hook reference from Documentation and Security model", () => {
  assert.deepEqual(readmeLinkProblems(read("README.md")), []);
});

// Issue #808. The event shape coverage table: one row per contract row plus the two wired
// Codex guards without one, each cell derived from the contract and the wiring.
test("the event shape coverage table of docs/HOOKS.md matches the tool event contract", () => {
  const lines = read(REFERENCE).split("\n");
  const start = lines.indexOf("| Guard | Claude | Codex |");
  assert.ok(start >= 0 && lines[start + 1] === "|---|---|---|", "docs/HOOKS.md needs the coverage table header and separator");
  const table: string[][] = [];
  for (let i = start + 2; lines[i]?.startsWith("|"); i++) table.push(cellsOf(lines[i]!));
  const wired = inventory();
  const on = (stem: string, runtime: string): boolean => wired.get(stem)?.runtimes.has(runtime) ?? false;
  const expected = [
    ...Object.entries(TOOL_EVENT_CONTRACT).map(([guard, row]) => [`\`${guard}\``, on(guard, "Claude") ? "guard warns" : "not wired",
      "codex" in row ? "adapter warns (native event)" : on(guard, "Codex") ? "guard warns" : "not wired"]),
    ["`codex-dispatch-contract-guard`", "not wired", "denies"],
    ["`mcp-intent-hook`", "not wired", "unproven"],
  ];
  assert.deepEqual(table, expected);
  for (const stem of ["codex-dispatch-contract-guard", "mcp-intent-hook"]) assert.ok(on(stem, "Codex"), `${stem} is wired in Codex`);
});

