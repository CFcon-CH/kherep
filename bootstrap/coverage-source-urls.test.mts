import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { relocateV8Report } from "./coverage-paths.mts";
test("foreign native producer roots relocate scripts and nested map sources without changing V8 counts", t => {
  const root = mkdtempSync(join(tmpdir(), "coverage-urls-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src/typed.mts"), "export const n: number = 1;\n");
  for (const producer of ["file:///D:/a/kherep/", "file:///Users/runner/work/kherep/", "file:///home/runner/kherep/"]) {
    const url = producer + "src/typed.mts"; const functions = [{ functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 20, count: 3 }] }];
    const input = { result: [{ url, functions }], "source-map-cache": { [url]: { url: "typed.mts.map", lineLengths: [26], data: { version: 3, sourceRoot: "./", sources: ["typed.mts"], sourcesContent: ["export const n: number = 1;\n"], names: [], mappings: "AAAA" } } } };
    const result = relocateV8Report(input, producer, root); const local = pathToFileURL(join(root, "src/typed.mts")).href;
    assert.equal(result.report.result.length, 1); assert.equal(result.report.result[0].url, local); assert.deepEqual(result.report.result[0].functions, functions);
    const entry = result.report["source-map-cache"]![local] as { data: { sources: string[]; sourceRoot: string } };
    assert.deepEqual(entry.data.sources, [local]); assert.equal(entry.data.sourceRoot, "");
  }
});
import { canonicalFileUrl, repositoryPathFromUrl } from "./coverage-source-urls.mts";

test("URL containment preserves filename case, spaces, Unicode and drive-only case folding", () => {
  for (const root of ["file:///D:/a/repo/", "file:///Users/runner/repo/", "file:///home/runner/repo/"]) {
    assert.equal(repositoryPathFromUrl(root + "one/same.mts", root), "one/same.mts");
    assert.equal(repositoryPathFromUrl(root + "two/same.mts", root), "two/same.mts");
    assert.equal(repositoryPathFromUrl(root + "Spaced%20%C3%BC.mts", root), "Spaced ü.mts");
    assert.equal(repositoryPathFromUrl(root + "node_modules/x.mts", root), null);
    assert.equal(repositoryPathFromUrl(root + "readme.md", root), null);
    assert.equal(repositoryPathFromUrl(root.slice(0, -1) + "-other/x.mts", root), null);
  }
  assert.equal(repositoryPathFromUrl("file:///d:/a/repo/A.mts", "file:///D:/a/repo/"), "A.mts");
  assert.equal(repositoryPathFromUrl("file:///D:/a/Repo/A.mts", "file:///D:/a/repo/"), null);
  assert.equal(repositoryPathFromUrl("file:///a/repo/A.mts", "file:///D:/a/repo/"), null);
});
for (const path of ["file://host/share/x.mts", "file:////host/share/x.mts", "file:///repo/../x.mts", "file:///repo/./x.mts", "file:///repo/%2e%2e/x.mts", "file:///repo/%2fx.mts", "file:///repo/%5cx.mts", "file:///repo/x.mts?x=1", "file:///repo/x.mts#frag", "file:///repo/%00.mts", "file:///repo/%bad.mts", "file:///repo/back\\slash.mts"]) test(`rejects unsafe producer URL ${path}`, () => {
  assert.throws(() => canonicalFileUrl(path));
});
test("retained script rejects absent local files and unsupported mapped sources", t => {
  const root = mkdtempSync(join(tmpdir(), "coverage-url-negative-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "x.mts"), "export const n = 1;\n");
  const producer = "file:///D:/a/repo/", url = producer + "x.mts";
  assert.throws(() => relocateV8Report({ result: [{ url: producer + "absent.mts", functions: [] }] }, producer, root));
  for (const source of ["https://example.org/x.mts", "../../outside.mts", "%2e%2e/x.mts", "node_modules/x.mts"]) {
    assert.throws(() => relocateV8Report({ result: [{ url, functions: [] }], "source-map-cache": { [url]: { data: { sources: [source], mappings: "AAAA", names: [], version: 3 } } } }, producer, root), /source map|file URL/);
  }
});

test("nested source map location and sourceRoot resolve before relocation", t => {
  const root = mkdtempSync(join(tmpdir(), "coverage-nested-map-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["src", "build"]) mkdirSync(join(root, dir));
  writeFileSync(join(root, "src/typed.mts"), "export const n: number = 1;\n");
  writeFileSync(join(root, "build/run.mjs"), "export const n = 1;\n");
  const producer = "file:///D:/a/repo/", url = producer + "build/run.mjs";
  const value = { result: [{ url, functions: [] }], "source-map-cache": { [url]: { url: "../maps/run.map", data: { version: 3, sources: ["typed.mts"], sourceRoot: "../src/", names: ["n"], mappings: "AAAA", sourcesContent: ["export const n: number = 1;\n"] }, lineLengths: [19] } } };
  const result = relocateV8Report(value, producer, root), local = pathToFileURL(join(root, "build/run.mjs")).href;
  const entry = result.report["source-map-cache"]![local] as { url: string; data: { sources: string[]; names: string[]; mappings: string }; lineLengths: number[] };
  assert.equal(entry.url, pathToFileURL(join(root, "maps/run.map")).href);
  assert.deepEqual(entry.data.sources, [pathToFileURL(join(root, "src/typed.mts")).href]);
  assert.deepEqual(entry.data.names, ["n"]); assert.equal(entry.data.mappings, "AAAA"); assert.deepEqual(entry.lineLengths, [19]);
});

test("retained scripts refuse cached maps without usable parsed data", t => {
  const root = mkdtempSync(join(tmpdir(), "coverage-bad-map-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "x.mts"), "export const n = 1;\n");
  const producer = "file:///D:/a/repo/", url = producer + "x.mts";
  for (const entry of [{ data: null }, { data: {} }, { url: 42, data: { version: 3, sources: ["x.mts"] } }, { data: { version: 2, sources: ["x.mts"] } }]) assert.throws(() => relocateV8Report({ result: [{ url, functions: [] }], "source-map-cache": { [url]: entry } }, producer, root), /source map/);
});
