import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("LCOV drops only parser-proven whole-file erased types and records the dropped paths", { skip: !existsSync(resolve("node_modules/typescript")) && "TypeScript parser unavailable in dependency-free compatibility job" }, async t => {
  const { dropErasedTypes } = await import("./coverage-erased-types.mts");
  const root = mkdtempSync(join(tmpdir(), "coverage-types-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  const fixtures = {
    "contracts.mts": readFileSync(resolve("codex/lib/contracts.mts"), "utf8"),
    "mixed.mts": "export interface Contract {}\nexport const runtime = 1;\n",
    "constant.mts": "export const runtime = 1;\n",
    "value-import.mts": "import { runtime } from './constant.mts';\nexport type Value = typeof runtime;\n",
    "named-type-import.mts": "import { type Contract } from './contracts.mts';\n",
    "unknown.mts": "export enum Runtime { Value }\n",
    "broken.mts": "export interface Broken {\n",
    "empty.mts": "// no statements\n",
  };
  const records = Object.entries(fixtures).map(([name, source]) => {
    writeFileSync(join(root, "src", name), source);
    return `SF:src/${name}\nDA:1,0\nLF:1\nLH:0\nend_of_record\n`;
  });
  const result = dropErasedTypes(records.join(""), root);
  assert.deepEqual(result.dropped, ["src/contracts.mts"]);
  assert.equal(result.lcov, records.slice(1).join(""));
  console.log("types-only: contracts.mts dropped; mixed, runtime constant, value import, unknown syntax, parse failure and empty file kept unchanged");
});
