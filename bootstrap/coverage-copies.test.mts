import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { rawFiles } from "./coverage-artifacts.mts";
import { readCopyDeclarations } from "./coverage-copies.mts";
import { relocateV8Report } from "./coverage-paths.mts";

const cli = resolve("bootstrap/coverage-report.mts"), sidecar = "coverage-copies.jsonl";
const identity = ["--run-id", "792", "--attempt", "1", "--checkout-sha", "a".repeat(40)];
const source = "export function value(n: number): number {\n  if (n > 0) {\n    return n + 1;\n  }\n  return 0;\n}\nconsole.log(value(2));\n";
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture(t: import("node:test").TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coverage-copy-")));
  const external = realpathSync(mkdtempSync(join(tmpdir(), "coverage-external-")));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(external, { recursive: true, force: true }); });
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src/original.mts"), source);
  const copy = join(external, "copy.mts"); copyFileSync(join(root, "src/original.mts"), copy);
  const input = join(root, "inputs");
  for (const producer of ["unit", "typescript", "probe", "worker"]) {
    const dir = join(input, producer); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ producer, runId: "792", attempt: "1", checkoutSha: "a".repeat(40), testOutcome: "success" }));
    if (producer === "worker") {
      mkdirSync(join(root, "modules/control-plane/worker/src"), { recursive: true });
      writeFileSync(join(root, "modules/control-plane/worker/src/fixture.mts"), "export const fixture = 1;\n");
      writeFileSync(join(dir, "lcov.info"), "SF:src/fixture.mts\nDA:1,1\nend_of_record\n");
    } else { mkdirSync(join(dir, "raw")); writeFileSync(join(dir, "raw/report.json"), JSON.stringify({ result: [] })); }
  }
  const raw = join(input, "unit/raw"), declaration = { copyUrl: pathToFileURL(copy).href, original: "src/original.mts", sha256: digest(source) };
  const declare = (value = declaration) => writeFileSync(join(raw, sidecar), JSON.stringify(value) + "\n");
  const assemble = () => spawnSync(process.execPath, [cli, "assemble", "--root", root, "--artifacts", input, "--output", join(root, "coverage"), ...identity], { encoding: "utf8" });
  return { root, input, copy, raw, declaration, declare, assemble };
}

test("raw validator accepts transported declarations without treating them as V8 reports", t => {
  const f = fixture(t); f.declare();
  assert.deepEqual(rawFiles(join(f.input, "unit")), ["report.json"]);
});

test("declareCopy checks bytes with no coverage variable and appends only when already enabled", async t => {
  const f = fixture(t), original = resolve("bootstrap/coverage-paths.mts");
  copyFileSync(original, f.copy);
  const helper = pathToFileURL(resolve("bootstrap/coverage-copy-fixture.mts")).href;
  const script = `import { declareCopy } from ${JSON.stringify(helper)}; declareCopy(${JSON.stringify(original)}, ${JSON.stringify(f.copy)});`;
  const env = { ...process.env }; delete env.NODE_V8_COVERAGE;
  const run = (environment: NodeJS.ProcessEnv) => spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: environment });
  assert.equal(run(env).status, 0); assert.equal(existsSync(join(f.raw, sidecar)), false);
  const enabled = run({ ...env, NODE_V8_COVERAGE: f.raw }); assert.equal(enabled.status, 0, enabled.stderr);
  const declaration = JSON.parse(readFileSync(join(f.raw, sidecar), "utf8"));
  assert.deepEqual(declaration, { copyUrl: pathToFileURL(f.copy).href, original: "bootstrap/coverage-paths.mts", sha256: digest(readFileSync(original)) });
  writeFileSync(f.copy, "different bytes\n"); const refused = run(env);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /copy bytes differ/);
  console.log(`different bytes: exit ${refused.status}, copy bytes differ; unset coverage: no declaration`);
});

test("real V8 copy hits land on the original and preserve zero lines and branches", { skip: !existsSync(resolve("node_modules/c8/bin/c8.js")) && "c8 unavailable in dependency-free compatibility job" }, t => {
  const f = fixture(t); f.declare();
  const execution = spawnSync(process.execPath, [f.copy], { env: { ...process.env, NODE_V8_COVERAGE: f.raw }, encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  const result = f.assemble(); assert.equal(result.status, 0, result.stderr);
  const lcov = readFileSync(join(f.root, "coverage/node/lcov.info"), "utf8");
  const record = lcov.split("end_of_record").find(value => value.includes("SF:src/original.mts"))!;
  assert.match(record, /DA:3,[1-9]\d*/); assert.match(record, /DA:5,0/); assert.match(record, /BRDA:\d+,[^,]+,[^,]+,0/);
  assert.doesNotMatch(lcov, /SF:.*copy\.mts/);
  console.log("copy integration: assemble exit 0; SF:src/original.mts line 3 hit, line 5 zero, untaken branch zero");
});

for (const failure of ["sha mismatch", "traversal"]) {
  test(`assembly refuses ${failure}`, t => {
    const f = fixture(t);
    f.declare({ ...f.declaration, ...(failure === "sha mismatch" ? { sha256: "b".repeat(64) } : failure === "traversal" ? { original: "../escape.mts" } : {}) });
    const result = f.assemble(); assert.notEqual(result.status, 0);
    assert.match(result.stderr, failure === "sha mismatch" ? /sha256 mismatch/ : /traversal|outside/);
    console.log(`${failure}: exit ${result.status}, ${result.stderr.trim()}`);
  });
}

test("an undeclared same-basename URL stays ignored and cannot consume a declaration", t => {
  const f = fixture(t); f.declare();
  const other = join(f.copy, "..", "elsewhere", "copy.mts");
  const raw = { result: [{ url: pathToFileURL(other).href, functions: [] }] };
  writeFileSync(join(f.raw, "report.json"), JSON.stringify(raw));
  const declarations = readCopyDeclarations(JSON.stringify(f.declaration), f.root);
  const used = new Set<string>();
  const relocated = relocateV8Report(raw, f.root, f.root, declarations, used);
  assert.equal(relocated.ignored, 1); assert.deepEqual(relocated.report.result, []); assert.equal(used.size, 0);
  // A declared copy without a report is no data, not a failure: a killed child must not block every merge.
  const result = f.assemble(); assert.match(result.stdout, /1 declared copies without a report/); assert.doesNotMatch(result.stderr, /declar/);
});

test("malformed and conflicting declaration lines fail visibly", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "src/other.mts"), source);
  for (const text of ["{broken\n", JSON.stringify({ ...f.declaration, extra: true }), [f.declaration, { ...f.declaration, original: "src/other.mts" }].map(value => JSON.stringify(value)).join("\n")]) {
    writeFileSync(join(f.raw, sidecar), text);
    const result = f.assemble(); assert.notEqual(result.status, 0); assert.match(result.stderr, /coverage:/);
  }
  console.log("invalid declarations: malformed JSON, unknown fields and conflicting URL mappings refused");
});
