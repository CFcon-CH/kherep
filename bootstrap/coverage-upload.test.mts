import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { producers, readArtifacts } from "./coverage-artifacts.mts";

const identity = { runId: "123", attempt: "2", checkoutSha: "a".repeat(40) };
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const blocks = ci.split(/\n      - name: /);
const uploads = blocks.filter(block => /^Upload coverage \(/.test(block));
// A bounded interpreter of the terminal upload condition, not an Actions runner.
function uploadAllowed(block: string, outcome: string, cancelled = false): boolean {
  const expression = /\n        if: ([^\n]+)/.exec(block)![1];
  return expression.split(" && ").every(term => {
    if (term === "always()") return true;
    if (term === "!cancelled()") return !cancelled;
    if (term === "matrix.os == 'ubuntu-latest'") return true;
    if (term === "steps.coverage-manifest.outcome == 'success'") return outcome === "success";
    assert.fail(`unsupported upload predicate: ${term}`);
  });
}

test("every raw producer upload requires successful manifest generation", () => {
  assert.equal(uploads.length, 5);
  const manifests = blocks.filter(block => /^Coverage manifest \(/.test(block));
  assert.equal(manifests.length, 5);
  for (const block of manifests) {
    assert.match(block, /\n        id: coverage-manifest\n/);
    assert.doesNotMatch(block, /continue-on-error/);
    assert.match(block, /if: always\(\) && !cancelled\(\)/);
  }
  for (const block of uploads) {
    assert.equal(uploadAllowed(block, "failure"), false, block.split("\n")[0]);
    assert.equal(uploadAllowed(block, "skipped"), false);
    assert.equal(uploadAllowed(block, "success"), true);
    assert.equal(uploadAllowed(block, "success", true), false);
  }
});

test("failed manifest payload is not uploaded and a later attempt recovers without relaxing history validation", t => {
  const root = mkdtempSync(join(tmpdir(), "coverage-upload-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const partial = join(root, "coverage-unit-123-1");
  mkdirSync(join(partial, "raw"), { recursive: true });
  writeFileSync(join(partial, "raw/report.json"), "");
  const manifest = spawnSync(process.execPath, [resolve("bootstrap/coverage-report.mts"), "manifest", "--producer", "unit", "--artifact", partial, "--run-id", "123", "--attempt", "1", "--checkout-sha", identity.checkoutSha, "--test-outcome", "success"], { encoding: "utf8" });
  assert.equal(manifest.status, 1, manifest.stderr);
  assert.equal(existsSync(join(partial, "manifest.json")), false);
  for (const producer of producers) {
    const attempt = producer === "unit" ? "2" : "1", dir = join(root, `coverage-${producer}-123-${attempt}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...identity, producer, attempt, testOutcome: "success", sourceRootUrl: "file:///D:/a/repo/" }));
    if (producer === "worker") writeFileSync(join(dir, "lcov.info"), "fixture");
    else { mkdirSync(join(dir, "raw")); writeFileSync(join(dir, "raw/report.json"), '{"result":[]}'); }
  }
  // Reproduce the historical partial-artifact failure before simulating suppression.
  assert.throws(() => readArtifacts(root, identity), /ENOENT/);
  assert.equal(uploadAllowed(uploads[0], "failure"), false);
  rmSync(partial, { recursive: true });
  const selected = readArtifacts(root, identity);
  assert.equal(selected.length, 15);
  assert.equal(selected.find(a => a.manifest.producer === "unit")!.manifest.attempt, "2");
});

test("a successful manifest still uploads failure provenance after tests fail", t => {
  const root = mkdtempSync(join(tmpdir(), "coverage-failed-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "raw")); writeFileSync(join(root, "raw/report.json"), '{"result":[]}');
  const result = spawnSync(process.execPath, [resolve("bootstrap/coverage-report.mts"), "manifest", "--producer", "unit", "--artifact", root, "--run-id", "123", "--attempt", "2", "--checkout-sha", identity.checkoutSha, "--test-outcome", "failure"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).testOutcome, "failure");
  for (const block of uploads) assert.equal(uploadAllowed(block, "success"), true);
});
