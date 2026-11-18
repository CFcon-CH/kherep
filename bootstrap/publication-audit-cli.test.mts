// Issue #965. The CLI of publication-audit.mts refuses to report a clean
// result without a usable external policy, and it says nothing more than that:
// a policy may hold private terms. An import that is no CLI run scans nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const SCANNER = path.join(import.meta.dirname, "publication-audit.mts");
const REFUSAL = "Publication audit could not complete; no clean result is available.";

function scan(args: string[], cwd?: string) {
  return spawnSync(process.execPath, [SCANNER, ...args], { encoding: "utf8", cwd });
}

test("without a policy argument the audit refuses, with or without a repository argument", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-publication-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const result of [scan([]), scan([root])]) {
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim().split(/\r?\n/).at(-1), REFUSAL);
  }
});

test("a policy that is no non-empty list of non-blank strings is refused without echoing it", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-publication-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const policies: unknown[] = [[], ["private-term", "   "], ["private-term", 7], { term: "private-term" }];
  for (const [index, terms] of policies.entries()) {
    const policy = path.join(root, `policy-${index}.json`);
    fs.writeFileSync(policy, JSON.stringify(terms));
    const result = scan([root, policy]);
    assert.equal(result.status, 2, JSON.stringify(terms));
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /private-term/);
    assert.equal(result.stderr.trim().split(/\r?\n/).at(-1), REFUSAL);
  }
});

test("importing the scanner from an eval entry runs no audit", () => {
  const code = `await import(${JSON.stringify(pathToFileURL(SCANNER).href)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /Publication audit/);
});
