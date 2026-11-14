import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, openSync, closeSync, ftruncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { producers, readArtifacts, rawFiles, validateManifest, validateProducers } from "./coverage-artifacts.mts";
import { SHARDS } from "./ci-shard.mts";
const identity = { runId: "123", attempt: "10", checkoutSha: "a".repeat(40) };
const manifest = (producer: string, attempt = "1") => ({ ...identity, producer, attempt, testOutcome: "success", sourceRootUrl: "file:///D:/a/kherep/" });
function fixture(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "coverage-artifacts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const add = (producer: string, attempt = "1", changes = {}) => {
    const dir = join(root, `coverage-${producer}-123-${attempt}`); mkdirSync(dir);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest(producer, attempt), ...changes }));
    if (producer === "worker") writeFileSync(join(dir, "lcov.info"), "fixture");
    else { mkdirSync(join(dir, "raw")); writeFileSync(join(dir, "raw/report.json"), "{}"); }
    return dir;
  };
  for (const producer of producers) add(producer);
  return { root, add };
}
test("native producers derive all bootstrap members from SHARDS", () => {
  assert.deepEqual([...producers].sort(), ["unit", "unit-macos", ...["hooks", "control-plane", ...SHARDS, "codex"].map(s => `unit-windows-${s}`), "typescript", "probe", "worker"].sort());
  assert.equal(producers.length, 15);
});
test("failed-only rerun selects one latest numeric attempt per producer", t => {
  const f = fixture(t); f.add("unit", "2"); f.add("unit", "10");
  const selected = readArtifacts(f.root, identity);
  assert.equal(selected.length, 15); assert.equal(selected.find(a => a.manifest.producer === "unit")!.manifest.attempt, "10");
  assert.equal(selected.find(a => a.manifest.producer === "worker")!.manifest.attempt, "1");
});
for (const outcome of ["failure", "cancelled", "skipped"]) test(`newest ${outcome} never falls back`, t => {
  const f = fixture(t); f.add("unit", "2", { testOutcome: outcome });
  assert.throws(() => readArtifacts(f.root, identity), /testOutcome/);
});
test("older failure may precede newer success", t => {
  const f = fixture(t); const file = join(f.root, "coverage-unit-123-1/manifest.json");
  writeFileSync(file, JSON.stringify({ ...manifest("unit"), testOutcome: "failure" })); f.add("unit", "2");
  assert.equal(readArtifacts(f.root, identity).find(a => a.manifest.producer === "unit")!.manifest.attempt, "2");
});
for (const [label, changes] of Object.entries({ sha: { checkoutSha: "b".repeat(40) }, run: { runId: "999" }, future: { attempt: "11" }, invalid: { attempt: "02" }, producer: { producer: "unknown" }, root: { sourceRootUrl: "file://host/share/" }, extra: { extra: true } })) test(`rejects ${label} manifest`, t => {
  const f = fixture(t); f.add("unit", "2", changes); assert.throws(() => readArtifacts(f.root, identity));
});
test("rejects malformed newest, missing producer and unexpected entries", t => {
  const f = fixture(t); const dir = f.add("unit", "2"); writeFileSync(join(dir, "manifest.json"), "{");
  assert.throws(() => readArtifacts(f.root, identity)); rmSync(dir, { recursive: true });
  rmSync(join(f.root, "coverage-worker-123-1"), { recursive: true }); assert.throws(() => readArtifacts(f.root, identity), /missing producer/);
  writeFileSync(join(f.root, "unexpected"), "x"); assert.throws(() => readArtifacts(f.root, identity), /unexpected/);
});
test("exact manifest command identity remains strict", () => {
  assert.throws(() => validateManifest(manifest("unit"), identity), /attempt mismatch/);
  assert.throws(() => validateProducers([manifest("unit")], identity), /missing producer/);
});

test("workflow native producer matrix and accepted identity stay aligned", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const sonar = readFileSync(new URL("../.github/workflows/sonar.yml", import.meta.url), "utf8");
  const unit = ci.split("\n  unit:\n")[1].split("\n  unit-windows:\n")[0];
  const windows = ci.split("\n  unit-windows:\n")[1].split("\n  unit-windows-gate:\n")[0];
  const matrix = /suite: \[([^\]]+)\]/.exec(windows)![1].split(", ");
  assert.deepEqual(matrix.sort(), ["hooks", "control-plane", ...SHARDS, "codex"].sort());
  assert.match(unit, /matrix\.os == 'ubuntu-latest' && 'unit' \|\| 'unit-macos'/);
  assert.equal((unit.match(/NODE_V8_COVERAGE:/g) ?? []).length, 3);
  assert.equal((windows.match(/NODE_V8_COVERAGE:/g) ?? []).length, 5);
  assert.doesNotMatch(ci, /continue-on-error: true/);
  assert.match(windows, /Coverage manifest \(Windows shard\)/);
  assert.match(windows, /Upload coverage \(Windows shard\)/);
  assert.match(windows, /shell: bash/);
  assert.match(ci, /needs: \[unit, unit-windows, typescript, control-plane-worker, client-binding-probe\]/);
  assert.match(ci, /test "\$WINDOWS" = success/);
  assert.equal((ci.match(/^  coverage-report:/gm) ?? []).length, 1);
  assert.match(ci, /pattern: coverage-\*-\$\{\{ github\.run_id \}\}-\*/);
  assert.match(ci, /merge-multiple: false\n          digest-mismatch: error/);
  assert.match(ci, /coverage-attempt: \$\{\{ needs\.coverage-report\.outputs\.coverage-attempt \}\}/);
  assert.match(ci, /coverage-artifact: \$\{\{ needs\.coverage-report\.outputs\.coverage-artifact \}\}/);
  assert.doesNotMatch(ci, /--source-root/);
  assert.match(sonar, /--consumer-attempt/); assert.match(sonar, /--artifact-name/);
  assert(sonar.indexOf("Verify coverage identity") < sonar.indexOf("- uses: SonarSource/"));
  assert.match(ci, /name: unit \(windows-latest\)/);
  for (const workflow of [ci, sonar]) {
    assert.match(workflow, /permissions:\n  contents: read/);
    assert.doesNotMatch(workflow, /persist-credentials: true|github-token:|repository:|run-id:/);
  }
});

test("selected artifacts reject extra entries and symlink producer directories", t => {
  const f = fixture(t), unit = join(f.root, "coverage-unit-123-1");
  writeFileSync(join(unit, "extra"), "unexpected");
  assert.throws(() => readArtifacts(f.root, identity), /unexpected artifact content/);
  rmSync(join(unit, "extra"));
  try { symlinkSync(unit, join(f.root, "coverage-unit-123-2"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("directory symlink unavailable"); throw error; }
  assert.throws(() => readArtifacts(f.root, identity), /unexpected artifact entry/);
});
test("raw payload bounds reject empty, oversized and linked input", t => {
  const f = fixture(t), unit = join(f.root, "coverage-unit-123-1"), report = join(unit, "raw/report.json");
  writeFileSync(report, ""); assert.throws(() => rawFiles(unit), /empty/);
  const fd = openSync(report, "w"); try { ftruncateSync(fd, 512 * 1024 * 1024 + 1); } finally { closeSync(fd); }
  assert.throws(() => rawFiles(unit), /oversized/);
  rmSync(join(unit, "raw"), { recursive: true });
  const target = join(f.root, "target"); mkdirSync(target); writeFileSync(join(target, "report.json"), "{}");
  try { symlinkSync(target, join(unit, "raw"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("directory symlink unavailable"); throw error; }
  assert.throws(() => rawFiles(unit), /symlink raw/);
});

test("rejects exact artifact name/manifest disagreement and a future named attempt", t => {
  const f = fixture(t), dir = f.add("unit", "2", { producer: "unit-macos" });
  assert.throws(() => readArtifacts(f.root, identity), /name\/manifest/);
  rmSync(dir, { recursive: true }); f.add("unit", "11");
  assert.throws(() => readArtifacts(f.root, identity), /future attempt/);
});
