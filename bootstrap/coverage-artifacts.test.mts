import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, openSync, closeSync, ftruncateSync, existsSync, realpathSync, readdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  assert.deepEqual([...producers].sort(), ["unit", "unit-macos", ...["hooks", "control-plane", ...SHARDS].map(s => `unit-windows-${s}`), "typescript", "probe", "worker"].sort());
  assert.equal(producers.length, 14);
});
test("failed-only rerun selects one latest numeric attempt per producer", t => {
  const f = fixture(t); f.add("unit", "2"); f.add("unit", "10");
  const selected = readArtifacts(f.root, identity);
  assert.equal(selected.length, 14); assert.equal(selected.find(a => a.manifest.producer === "unit")!.manifest.attempt, "10");
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
  assert.equal((windows.match(/NODE_V8_COVERAGE:/g) ?? []).length, 4);
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

test("Codex is functional only and cannot appear as a coverage artifact", t => {
  assert.throws(() => validateManifest(manifest("unit-windows-codex"), { ...identity, attempt: "1" }), /manifest/);
  const f = fixture(t); f.add("unit-windows-codex");
  assert.throws(() => readArtifacts(f.root, identity), /artifact name/);
});
test("Codex-only functional rerun reuses all fourteen earlier producer attempts", t => {
  const f = fixture(t), selected = readArtifacts(f.root, identity);
  assert.equal(selected.length, 14); assert(selected.every(value => value.manifest.attempt === "1"));
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /needs: \[unit, unit-windows, typescript, control-plane-worker, client-binding-probe\]/);
  assert.match(ci, /test "\$WINDOWS" = success/);
  const required = /test "\$WINDOWS" = (\w+)/.exec(ci)![1];
  const gateAllows = (result: string) => result === required;
  assert.equal(gateAllows("failure"), false); assert.equal(gateAllows("success"), true);
  assert.equal(producers.includes("unit-windows-codex"), false);
});

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { normalizeLcovPaths, relocateV8Report } from "./coverage-paths.mts";
type LcovRow = { file: string; LF: number; LH: number; BRF: number; BRH: number };
function metricRows(text: string): LcovRow[] {
  return text.split("end_of_record").filter(row => row.trim()).map(row => ({
    file: /^SF:(.+)$/m.exec(row)![1],
    LF: Number(/^LF:(\d+)$/m.exec(row)![1]), LH: Number(/^LH:(\d+)$/m.exec(row)![1]),
    BRF: Number(/^BRF:(\d+)$/m.exec(row)![1]), BRH: Number(/^BRH:(\d+)$/m.exec(row)![1]),
  }));
}
test("reserved real-source deletion preserves file universe but can raise branch percentage", { skip: !existsSync(resolve("node_modules/c8/bin/c8.js")) && "c8 unavailable in dependency-free compatibility job" }, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coverage-reserved-metric-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const raw = join(root, "raw"), filtered = join(root, "filtered");
  for (const dir of ["src", "raw", "filtered"]) mkdirSync(join(root, dir));
  const source = "export function decide(x) {\n let value = 0;\n" + Array.from({ length: 10 }, (_, i) => " if (x === " + i + ") value += " + (i + 1) + ";").join("\n") + "\n return value;\n}\n";
  writeFileSync(join(root, "src/real.mjs"), source);
  writeFileSync(join(root, "src/keep.mjs"), "export function other() { return 17; }\n");
  writeFileSync(join(root, "src/never.mjs"), "export const never = 1;\n");
  const main = "const keep = await import('./src/keep.mjs'); keep.other(); const real = await import('./src/real.mjs?node-test-mock=7'); real.decide(-1);";
  const execution = spawnSync(process.execPath, ["--input-type=module", "-e", main], { cwd: root, env: { ...process.env, NODE_V8_COVERAGE: raw }, encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  let ignored = 0;
  for (const name of readdirSync(raw).filter(name => name.endsWith(".json"))) {
    const result = relocateV8Report(JSON.parse(readFileSync(join(raw, name), "utf8")), pathToFileURL(root + "/").href, root);
    ignored += result.ignored; writeFileSync(join(filtered, name), JSON.stringify(result.report));
  }
  assert(ignored > 0);
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ all: true, extension: [".mjs"], include: ["src/*.mjs"], exclude: [], reporter: ["lcovonly"] }));
  const outputs: LcovRow[][] = [];
  for (const [label, input] of [["before", raw], ["after", filtered]]) {
    const conversion = spawnSync(process.execPath, [resolve("node_modules/c8/bin/c8.js"), "report", "--config", config, "--all", "--temp-directory", input, "--reports-dir", join(root, label)], { cwd: root, encoding: "utf8" });
    assert.equal(conversion.status, 0, conversion.stderr);
    outputs.push(metricRows(normalizeLcovPaths(readFileSync(join(root, label, "lcov.info"), "utf8"), root)));
  }
  const [before, after] = outputs;
  assert.deepEqual(before.map(row => row.file).sort(), ["src/keep.mjs", "src/never.mjs", "src/real.mjs"]);
  assert.deepEqual(after.map(row => row.file).sort(), before.map(row => row.file).sort());
  assert.deepEqual(after.map(row => [row.file, row.LF]).sort(), before.map(row => [row.file, row.LF]).sort());
  assert.deepEqual(after.find(row => row.file === "src/keep.mjs"), before.find(row => row.file === "src/keep.mjs"));
  for (const rows of outputs) assert.equal(rows.find(row => row.file === "src/never.mjs")!.LH, 0);
  const sum = (rows: LcovRow[], key: "LF" | "LH" | "BRF" | "BRH") => rows.reduce((total, row) => total + row[key], 0);
  assert(sum(after, "LH") < sum(before, "LH")); assert(sum(after, "BRF") < sum(before, "BRF"));
  assert(sum(after, "BRH") <= sum(before, "BRH"));
  assert(sum(after, "BRH") / sum(after, "BRF") > sum(before, "BRH") / sum(before, "BRF"));
  console.log(JSON.stringify({ metricPolicyDiscontinuity: true, before: { LF: sum(before, "LF"), LH: sum(before, "LH"), BRF: sum(before, "BRF"), BRH: sum(before, "BRH") }, after: { LF: sum(after, "LF"), LH: sum(after, "LH"), BRF: sum(after, "BRF"), BRH: sum(after, "BRH") } }));
});

test("selected producer order is stable under forced root enumeration and reverse creation", t => {
  const f = fixture(t); f.add("unit", "2"); f.add("unit", "10");
  const reverse = mkdtempSync(join(tmpdir(), "coverage-reverse-")); t.after(() => rmSync(reverse, { recursive: true, force: true }));
  for (const name of readdirSync(f.root).reverse()) cpSync(join(f.root, name), join(reverse, name), { recursive: true });
  const expected = [...producers].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map(p => [p, p === "unit" ? "10" : "1"]);
  const script = [
    'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";',
    'const root = process.argv[1], order = process.argv[2], original = fs.readdirSync;',
    'fs.readdirSync = (path, ...args) => { const entries = original(path, ...args); if (path !== root) return entries;',
    'entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);',
    'return order === "reverse" ? entries.reverse() : order === "rotate" ? entries.slice(3).concat(entries.slice(0, 3)) : entries; };',
    'syncBuiltinESMExports();',
    'try { const { readArtifacts } = await import(' + JSON.stringify(pathToFileURL(resolve("bootstrap/coverage-artifacts.mts")).href) + ');',
    'console.log(JSON.stringify(readArtifacts(root, ' + JSON.stringify(identity) + ').map(a => [a.manifest.producer, a.manifest.attempt])));',
    '} finally { fs.readdirSync = original; syncBuiltinESMExports(); }',
  ].join("\n");
  for (const root of [f.root, reverse]) for (const mode of ["forward", "reverse", "rotate"]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, root, mode], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), expected, mode);
  }
});
