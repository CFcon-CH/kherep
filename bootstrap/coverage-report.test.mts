import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, realpathSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { normalizeLcovPaths, relocateV8Report, validateLcov } from "./coverage-paths.mts";

const cli = resolve("bootstrap/coverage-report.mts");
const sha = "a".repeat(40);
function run(args: string[], cwd = process.cwd()) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}
function identity() { return ["--run-id", "123", "--attempt", "2", "--checkout-sha", sha]; }
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kherep-coverage-")));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/typed.mts"), "export function typed(value: number): number {\n  if (value > 0) {\n    return value + 1;\n  }\n  return 0;\n}\nconsole.log(typed(2));\n");
  writeFileSync(join(root, "src/child.mts"), "const child: number = 42;\nconsole.log(child);\n");
  const worker = join(root, "modules/control-plane/worker/src");
  mkdirSync(join(worker, "first"), { recursive: true }); mkdirSync(join(worker, "second"));
  for (const d of ["first", "second"]) writeFileSync(join(worker, d, "same.mts"), "export const n: number = 1;\n");
  return root;
}
function artifacts(root: string) {
  const input = join(root, "inputs"); mkdirSync(input);
  for (const producer of ["unit", "typescript", "probe", "worker"]) {
    const dir = join(input, producer); mkdirSync(dir);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ producer, runId: "123", attempt: "2", checkoutSha: sha, testOutcome: "success" }));
    if (producer === "worker") {
      writeFileSync(join(dir, "lcov.info"), "SF:src/first/same.mts\nDA:1,1\nLF:1\nLH:1\nend_of_record\nSF:src/second/same.mts\nDA:1,0\nLF:1\nLH:0\nend_of_record\n");
    } else { mkdirSync(join(dir, "raw")); writeFileSync(join(dir, "raw/report.json"), JSON.stringify({ result: [] })); }
  }
  return input;
}

test("coverage manifest rejects missing and zero-byte producer data", () => {
  const root = fixture();
  try {
    for (const name of ["missing", "zero-byte"]) {
      const artifact = join(root, name); mkdirSync(join(artifact, "raw"), { recursive: true });
      if (name === "zero-byte") writeFileSync(join(artifact, "raw/report.json"), "");
      const result = run(["manifest", "--producer", "unit", "--artifact", artifact, ...identity(), "--test-outcome", "success"]);
      assert.notEqual(result.status, 0, name); assert.match(result.stderr, /coverage:/);
      console.log(`negative ${name}: exit ${result.status}, ${result.stderr.trim()}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("coverage assembly rejects malformed, wrong checkoutSha, wrong attempt and duplicate producer", () => {
  for (const name of ["malformed", "wrong checkoutSha", "wrong attempt", "duplicate producer"]) {
    const root = fixture();
    try {
      const input = artifacts(root); const file = join(input, "unit/manifest.json");
      if (name === "malformed") writeFileSync(file, "{");
      if (name === "wrong checkoutSha") { const m = JSON.parse(readFileSync(file, "utf8")); m.checkoutSha = "b".repeat(40); writeFileSync(file, JSON.stringify(m)); }
      if (name === "wrong attempt") { const m = JSON.parse(readFileSync(file, "utf8")); m.attempt = "1"; writeFileSync(file, JSON.stringify(m)); }
      if (name === "duplicate producer") cpSync(join(input, "unit"), join(input, "duplicate"), { recursive: true });
      const result = run(["assemble", "--artifacts", input, "--output", join(root, "coverage"), "--root", root, ...identity()]);
      assert.notEqual(result.status, 0, name); assert.match(result.stderr, /coverage:/);
      console.log(`negative ${name}: exit ${result.status}, ${result.stderr.trim()}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("coverage rejects traversal and retains same basename in different worker folders", () => {
  const root = fixture();
  try {
    assert.throws(() => normalizeLcovPaths("SF:../../outside.mts\nDA:1,1\nend_of_record\n", root, join(root, "modules/control-plane/worker")), /traversal|outside/);
    assert.throws(() => relocateV8Report({ result: [{ url: pathToFileURL(root).href + "/../outside.mts", functions: [] }] }, root, root), /traversal/);
    console.log("negative path traversal: rejected LCOV and V8 traversal");
    const input = artifacts(root);
    const normalized = normalizeLcovPaths(readFileSync(join(input, "worker/lcov.info"), "utf8"), root, join(root, "modules/control-plane/worker"));
    assert.match(normalized, /SF:modules\/control-plane\/worker\/src\/first\/same.mts/);
    assert.match(normalized, /SF:modules\/control-plane\/worker\/src\/second\/same.mts/);
    assert.equal(validateLcov(normalized, root).files, 2);
    console.log("same basename: two distinct repository-relative worker SF records");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real type-stripped V8 union maps typed lines, unexecuted branch and spawned child", { skip: existsSync(resolve("node_modules/c8/bin/c8.js")) ? false : "c8 dependency unavailable in this dependency-free compatibility job" }, () => {
  const root = fixture();
  try {
    const input = artifacts(root); const raw = join(input, "unit/raw");
    const main = join(root, "runner.mts");
    writeFileSync(main, `import './src/typed.mts';\nimport { spawnSync } from 'node:child_process';\nconst child = spawnSync(process.execPath, ['src/child.mts'], { stdio: 'inherit' });\nif (child.status !== 0) process.exit(1);\n`);
    const execution = spawnSync(process.execPath, [main], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: raw } });
    assert.equal(execution.status, 0, execution.stderr);
    const output = join(root, "coverage");
    const result = run(["assemble", "--artifacts", input, "--output", output, "--root", root, ...identity()]);
    assert.equal(result.status, 0, result.stderr);
    const lcov = readFileSync(join(output, "node/lcov.info"), "utf8");
    const typed = lcov.split("end_of_record").find(s => s.includes("SF:src/typed.mts"))!;
    const child = lcov.split("end_of_record").find(s => s.includes("SF:src/child.mts"))!;
    assert.match(typed, /DA:3,[1-9]\d*/); assert.match(typed, /DA:5,0/);
    assert.match(child, /DA:1,[1-9]\d*/);
    const verification = run(["verify", "--output", output, "--root", root, ...identity()]);
    assert.equal(verification.status, 0, verification.stderr);
    console.log("typed mapping: typed.mts line 3 hit; line 5 zero; spawned child.mts line 1 hit; assemble/verify exit 0");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("coverage rejects malformed function records and source line overflow", () => {
  const root = fixture();
  try {
    for (const record of ["FN:garbage", "FNDA:garbage", "FN:999,overflow", "DA:999,1"]) {
      assert.throws(() => validateLcov(`SF:src/typed.mts\nDA:3,1\n${record}\nend_of_record\n`, root), /LCOV/);
      console.log(`negative malformed LCOV: rejected ${record}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("coverage assembly rejects malformed raw JSON and failed tests", () => {
  for (const name of ["malformed raw", "failed test"]) {
    const root = fixture();
    try {
      const input = artifacts(root);
      if (name === "malformed raw") writeFileSync(join(input, "unit/raw/report.json"), "{");
      else { const path = join(input, "unit/manifest.json"); const m = JSON.parse(readFileSync(path, "utf8")); m.testOutcome = "failure"; writeFileSync(path, JSON.stringify(m)); }
      const result = run(["assemble", "--artifacts", input, "--output", join(root, "coverage"), "--root", root, ...identity()]);
      assert.notEqual(result.status, 0); assert.match(result.stderr, /coverage:/);
      console.log(`negative ${name}: exit ${result.status}, ${result.stderr.trim()}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("coverage rejects phantom EOF lines and same-file aliases", () => {
  const root = fixture();
  try {
    const source = "modules/control-plane/worker/src/first/same.mts";
    for (const record of ["DA:2,1", "FN:2,overflow", "BRDA:2,0,0,1"]) {
      assert.throws(() => validateLcov(`SF:${source}\nDA:1,1\n${record}\nend_of_record\n`, root), /LCOV/);
      console.log(`negative EOF overflow: rejected ${record}`);
    }
    const first = `SF:${source}\nDA:1,1\nend_of_record\n`;
    assert.throws(() => validateLcov(first + `SF:./${source}\nDA:1,1\nend_of_record\n`, root), /LCOV/);
    symlinkSync(join(root, source), join(root, "src/alias.mts"));
    assert.throws(() => validateLcov(first + "SF:src/alias.mts\nDA:1,1\nend_of_record\n", root), /LCOV/);
    console.log("negative same-file aliases: rejected dot-relative and internal symlink aliases");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("coverage rejects inconsistent function and branch totals", () => {
  const root = fixture();
  try {
    for (const records of ["FNF:0\nFNH:9", "BRF:0\nBRH:9", "FN:1,f\nFNDA:1,f\nFNF:2\nFNH:1", "BRDA:1,0,0,1\nBRF:1\nBRH:0"]) {
      assert.throws(() => validateLcov(`SF:src/typed.mts\nDA:3,1\n${records}\nend_of_record\n`, root), /LCOV/);
      console.log(`negative inconsistent totals: rejected ${records.replaceAll("\n", " ")}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scanner verification rejects identity mismatch and absent or empty reports", () => {
  const root = fixture();
  try {
    const input = artifacts(root); const output = join(root, "coverage");
    mkdirSync(join(output, "node"), { recursive: true }); mkdirSync(join(output, "worker"));
    writeFileSync(join(output, "manifest.json"), JSON.stringify({ producers: ["unit", "typescript", "probe", "worker"].map(p => JSON.parse(readFileSync(join(input, p, "manifest.json"), "utf8"))) }));
    writeFileSync(join(output, "node/lcov.info"), "SF:src/typed.mts\nDA:3,1\nend_of_record\n");
    writeFileSync(join(output, "worker/lcov.info"), normalizeLcovPaths(readFileSync(join(input, "worker/lcov.info"), "utf8"), root, join(root, "modules/control-plane/worker")));
    for (const [key, value] of [["--checkout-sha", "b".repeat(40)], ["--attempt", "3"], ["--run-id", "999"]]) {
      const args = identity(); args[args.indexOf(key) + 1] = value;
      const result = run(["verify", "--output", output, "--root", root, ...args]);
      assert.notEqual(result.status, 0); assert.match(result.stderr, /mismatch/);
      console.log(`negative scanner ${key}: exit ${result.status}, ${result.stderr.trim()}`);
    }
    for (const name of ["zero-byte", "missing"]) {
      if (name === "zero-byte") writeFileSync(join(output, "worker/lcov.info"), ""); else rmSync(join(output, "worker/lcov.info"));
      const result = run(["verify", "--output", output, "--root", root, ...identity()]);
      assert.notEqual(result.status, 0); console.log(`negative scanner ${name}: exit ${result.status}, ${result.stderr.trim()}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
