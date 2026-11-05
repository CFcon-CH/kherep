#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadResponseFormat, matchesSchema, type SchemaNode } from "./lib/json-schema.mts";

let pass = 0;
let fail = 0;
function check(name: string, condition: unknown): void {
  condition ? pass++ : fail++;
  console.log(`${condition ? "PASS" : "FAIL"} | ${name}`);
}

const nestedSchema: SchemaNode = {
  type: "object",
  properties: {
    items: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: {
        type: "object",
        properties: {
          label: { type: "string", minLength: 2, pattern: "^[a-z]+$" },
          count: { type: "integer", minimum: 1 },
        },
        required: ["label", "count"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "strict-schema-subset-")));
try {
  const validFile = path.join(root, "valid.json");
  fs.writeFileSync(validFile, JSON.stringify(nestedSchema), "utf8");
  let loaded = false;
  try {
    loaded = loadResponseFormat(validFile, root).responseFormat.json_schema.strict === true;
  } catch {}
  check("nested strict object and array subset loads", loaded);
  check("nested valid data matches", matchesSchema({ items: [{ label: "alpha", count: 2 }] }, nestedSchema));
  check("nested property mismatch fails", !matchesSchema({ items: [{ label: "A", count: 0 }] }, nestedSchema));
  check("nested additional property fails", !matchesSchema({ items: [{ label: "alpha", count: 2, extra: true }] }, nestedSchema));
  check("array uniqueness is enforced", !matchesSchema({ items: [
    { label: "alpha", count: 2 }, { label: "alpha", count: 2 },
  ] }, nestedSchema));

  const duplicateEnum = {
    type: "object",
    properties: { kind: { type: "string", enum: ["same", "same"] } },
    required: ["kind"],
    additionalProperties: false,
  };
  const duplicateFile = path.join(root, "duplicate-enum.json");
  fs.writeFileSync(duplicateFile, JSON.stringify(duplicateEnum), "utf8");
  let duplicateRejected = false;
  try { loadResponseFormat(duplicateFile, root); }
  catch (error) { duplicateRejected = /Invalid strict JSON schema/.test((error as Error).message); }
  check("duplicate enum values are rejected before inference", duplicateRejected);

  for (const pattern of ["[", "(?", "\\", "a{2,1}"]) {
    const schema = { type: "object", properties: { text: { type: "string", pattern } }, required: ["text"], additionalProperties: false };
    const file = path.join(root, "invalid-pattern.json");
    fs.writeFileSync(file, JSON.stringify(schema));
    let rejected = false;
    try { loadResponseFormat(file, root); }
    catch (error) { rejected = (error as Error).message === "Invalid strict JSON schema"; }
    check(`invalid regular expression is rejected before inference: ${JSON.stringify(pattern)}`, rejected);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`RESULT | pass=${pass} fail=${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
