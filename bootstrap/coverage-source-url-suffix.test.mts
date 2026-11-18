// Issue #969: Node's type stripping appends a sourceURL comment, so one source has a different
// top-level range end at every path. The same source must merge as one script after relocation.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { producers } from "./coverage-artifacts.mts";
import { relocateV8Report } from "./coverage-paths.mts";
import { sourceUrlSuffixLength, trimSourceUrlSuffix } from "./coverage-source-url-suffix.mts";

const c8Skip = !existsSync(resolve("node_modules/c8/bin/c8.js")) && "c8 unavailable in dependency-free compatibility job";
const url = "file:///r/src/a.mts", length = 40, suffix = sourceUrlSuffixLength(url);
const fn = (...ranges: [number, number, number][]) => ({ functionName: "", ranges: ranges.map(([startOffset, endOffset, count]) => ({ startOffset, endOffset, count })) });

test("the suffix length is the sourceURL comment Node appends in strip mode", () => {
  assert.equal(sourceUrlSuffixLength("file:///a/b.mts"), 31);
  assert.equal(sourceUrlSuffixLength("file:///p/%C3%A4.mts"), 36);
});

test("ranges within the source stay as they are", () => {
  const functions = [fn([0, length, 1], [10, 20, 0])];
  assert.equal(trimSourceUrlSuffix(url, functions, length), functions);
});

test("an exact suffix excess is trimmed back to the source length, without touching the input", () => {
  const functions = [fn([0, length + suffix, 1], [30, length + suffix, 0]), fn([5, 9, 2])];
  assert.deepEqual(trimSourceUrlSuffix(url, functions, length), [fn([0, length, 1], [30, length, 0]), fn([5, 9, 2])]);
  assert.equal(functions[0].ranges[0].endOffset, length + suffix);
});

test("any other excess leaves the script untouched for the caller to count", () => {
  for (const end of [length + suffix - 1, length + suffix + 1]) assert.equal(trimSourceUrlSuffix(url, [fn([0, end, 1])], length), null);
});

test("a range starting inside the suffix is dropped, never kept", () => {
  const blockInSuffix = [fn([0, length + suffix, 1], [length, length + suffix, 0])];
  assert.deepEqual(trimSourceUrlSuffix(url, blockInSuffix, length), [fn([0, length, 1])]);
  const functionInSuffix = [fn([0, length + suffix, 1]), fn([length + 2, length + 9, 1])];
  assert.deepEqual(trimSourceUrlSuffix(url, functionInSuffix, length), [fn([0, length, 1])]);
});

test("relocation trims by the script's own URL and counts an unmatched excess", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coverage-suffix-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src/a.mts"), "x".repeat(length));
  const producer = "file:///D:/a/repo/", own = producer + "src/a.mts";
  const matched = { url: own, functions: [fn([0, length + sourceUrlSuffixLength(own), 1])] };
  const foreign = { url: own, functions: [fn([0, length + suffix, 1])] };
  const result = relocateV8Report({ result: [matched, foreign] }, producer, root);
  assert.deepEqual(result.report.result.map(s => s.functions), [[fn([0, length, 1])], foreign.functions]);
  assert.equal(result.untrimmed, 1); assert.equal(result.ignored, 0);
});

const source = "const mode: string = process.argv[2] ?? \"none\";\nif (mode === \"a\") {\n  console.log(\"a\");\n}\nif (mode === \"b\") {\n  console.log(\"b\");\n}\nif (mode === \"c\") {\n  console.log(\"c\");\n}\nif (mode === \"never\") {\n  console.log(\"never\");\n}\n";

test("real reports from three path lengths merge into the union of executed lines", { skip: c8Skip }, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coverage-suffix-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A second checkout with a longer root and a declared copy with a longer path give three suffix lengths.
  const other = join(root, "a-much-longer-second-checkout-root"), external = join(root, "external/with/a/longer/copy/path");
  for (const dir of [join(root, "src"), join(other, "src"), external]) mkdirSync(dir, { recursive: true });
  for (const file of [join(root, "src/modes.mts"), join(other, "src/modes.mts"), join(external, "modes-copy.mts")]) writeFileSync(file, source);
  const input = join(root, "inputs"), raw = (producer: string) => join(input, `coverage-${producer}-969-1`, "raw");
  const execute = (file: string, mode: string, producer: string) => {
    const run = spawnSync(process.execPath, [file, mode], { encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: raw(producer) } });
    assert.equal(run.status, 0, run.stderr);
  };
  for (const producer of producers) {
    const dir = join(input, `coverage-${producer}-969-1`); mkdirSync(dir, { recursive: true });
    const sourceRoot = producer === "unit-macos" ? other : root;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ producer, runId: "969", attempt: "1", checkoutSha: "a".repeat(40), testOutcome: "success", sourceRootUrl: pathToFileURL(sourceRoot + "/").href }));
    if (producer === "worker") {
      mkdirSync(join(root, "modules/control-plane/worker/src"), { recursive: true });
      writeFileSync(join(root, "modules/control-plane/worker/src/fixture.mts"), "export const fixture = 1;\n");
      writeFileSync(join(dir, "lcov.info"), "SF:src/fixture.mts\nDA:1,1\nend_of_record\n");
    } else if (producer === "unit-macos") execute(join(other, "src/modes.mts"), "b", producer);
    else execute(join(root, "src/modes.mts"), "a", producer);
  }
  const copy = join(external, "modes-copy.mts");
  writeFileSync(join(raw("unit"), "coverage-copies.jsonl"), JSON.stringify({ copyUrl: pathToFileURL(copy).href, original: "src/modes.mts", sha256: createHash("sha256").update(source).digest("hex") }) + "\n");
  execute(copy, "c", "unit");
  const output = join(root, "coverage");
  const assembled = spawnSync(process.execPath, [resolve("bootstrap/coverage-report.mts"), "assemble", "--root", root, "--artifacts", input, "--output", output, "--run-id", "969", "--attempt", "1", "--checkout-sha", "a".repeat(40)], { encoding: "utf8" });
  assert.equal(assembled.status, 0, assembled.stderr);
  const record = readFileSync(join(output, "node/lcov.info"), "utf8").split("end_of_record").find(value => value.includes("SF:src/modes.mts"))!;
  for (const line of [3, 6, 9]) assert.match(record, new RegExp(`^DA:${line},[1-9]\\d*$`, "m"), `line ${line} ran in one report only`);
  assert.match(record, /^DA:12,0$/m);
  const branches = record.split("\n").filter(value => value.startsWith("BRDA:"));
  // One script range, one `??` branch and one block per `if`: each listed once, not once per path.
  assert.deepEqual(branches.map(value => value.split(",")[0]), ["BRDA:1", "BRDA:1", "BRDA:2", "BRDA:5", "BRDA:8", "BRDA:11"]);
  for (const index of [2, 3, 4]) assert.match(branches[index], /,[1-9]\d*$/);
  assert.match(branches[5], /,0$/);
  const summary = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
  assert(summary.producers.every((p: { untrimmed: number }) => p.untrimmed === 0));
  console.log(`three suffix lengths: lines 3, 6, 9 hit, line 12 zero; branches ${branches.join(" ")}`);
});
