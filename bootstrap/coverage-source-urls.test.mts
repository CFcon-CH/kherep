import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { relocateV8Report } from "./coverage-paths.mts";
function fixtureRoot(prefix: string, parent = tmpdir()): string {
  return realpathSync(mkdtempSync(join(parent, prefix)));
}

test("foreign native producer roots relocate scripts and nested map sources without changing V8 counts", t => {
  const root = fixtureRoot("coverage-urls-"); t.after(() => rmSync(root, { recursive: true, force: true }));
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
  const root = fixtureRoot("coverage-url-negative-"); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "x.mts"), "export const n = 1;\n");
  const producer = "file:///D:/a/repo/", url = producer + "x.mts";
  assert.throws(() => relocateV8Report({ result: [{ url: producer + "absent.mts", functions: [] }] }, producer, root));
  for (const source of ["https://example.org/x.mts", "../../outside.mts", "%2e%2e/x.mts", "node_modules/x.mts"]) {
    assert.throws(() => relocateV8Report({ result: [{ url, functions: [] }], "source-map-cache": { [url]: { data: { sources: [source], mappings: "AAAA", names: [], version: 3 } } } }, producer, root), /source map|file URL/);
  }
});

test("nested source map location and sourceRoot resolve before relocation", t => {
  const root = fixtureRoot("coverage-nested-map-"); t.after(() => rmSync(root, { recursive: true, force: true }));
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
  const root = fixtureRoot("coverage-bad-map-"); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "x.mts"), "export const n = 1;\n");
  const producer = "file:///D:/a/repo/", url = producer + "x.mts";
  for (const entry of [{ data: null }, { data: {} }, { url: 42, data: { version: 3, sources: ["x.mts"] } }, { data: { version: 2, sources: ["x.mts"] } }]) assert.throws(() => relocateV8Report({ result: [{ url, functions: [] }], "source-map-cache": { [url]: entry } }, producer, root), /source map/);
});


test("fixture relocation and cached maps use canonical roots through a directory alias", t => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "coverage-url-alias-")));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const physical = join(parent, "physical"), alias = join(parent, "alias");
  mkdirSync(physical);
  symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir");
  const root = fixtureRoot("workspace-", alias);
  writeFileSync(join(root, "x.mts"), "export const x: number = 1;\n");
  const producer = "file:///D:/a/repo/", url = producer + "x.mts";
  const value = { result: [{ url, functions: [] }], "source-map-cache": { [url]: { url: "x.mts.map", data: { version: 3, sources: ["x.mts"], names: [], mappings: "AAAA" } } } };
  const result = relocateV8Report(value, producer, root), local = pathToFileURL(join(root, "x.mts")).href;
  assert.equal(result.report.result[0].url, local);
  const entry = result.report["source-map-cache"]![local] as { url: string; data: { sources: string[] } };
  assert.equal(entry.url, pathToFileURL(join(root, "x.mts.map")).href);
  assert.deepEqual(entry.data.sources, [local]);
});

import { createHash } from "node:crypto";
import { readCopyDeclarations } from "./coverage-copies.mts";
import { validateManifest } from "./coverage-artifacts.mts";
const isolatedProducer = "file:///D:/a/repo/";
const isolatedUrl = "file:///D:/temporary/module.mts?isolated=1";
const v8Script = (url: string) => ({ url, functions: [{ functionName: "value", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 20, count: 3 }, { startOffset: 5, endOffset: 10, count: 0 }] }] });

test("numeric isolated queries discard only true outside-root scripts once", () => {
  for (const [producer, external] of [[isolatedProducer, isolatedUrl], ["file:///home/runner/repo/", "file:///tmp/module.mts?isolated=001"], ["file:///Users/runner/repo/", "file:///private/tmp/module.mts?isolated=9"], [isolatedProducer, "file:///E:/temporary/module.mts?isolated=1"], [isolatedProducer, "file:///D:/a/repo-other/module.mts?isolated=1"], [isolatedProducer, "file:///D:/temporary/Spaced%20%C3%BC.mts?isolated=1"]]) {
    const input = { result: [v8Script(external), v8Script(external.slice(0, external.indexOf("?")))] }, used = new Set<string>();
    input.result[0].functions.push(structuredClone(input.result[0].functions[0]));
    const before = structuredClone(input);
    const result = relocateV8Report(input, producer, process.cwd(), new Map(), used);
    assert.equal(result.ignored, 2); assert.deepEqual(result.report.result, []); assert.equal(used.size, 0);
    assert.equal(result.report["source-map-cache"], undefined); assert.deepEqual(input, before);
    assert.throws(() => canonicalFileUrl(external));
  }
});

function isolatedFixture(t: import("node:test").TestContext) {
  const root = fixtureRoot("coverage-isolated-"); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = "export const value: number = 1;\n"; writeFileSync(join(root, "module.mts"), source);
  const url = isolatedProducer + "module.mts", copyUrl = "file:///D:/temporary/verified.mts";
  const declaration = { copyUrl, original: "module.mts", sha256: createHash("sha256").update(source).digest("hex") };
  const copies = readCopyDeclarations(JSON.stringify(declaration), root);
  const map = { data: { version: 3, sources: ["module.mts"], names: ["value"], mappings: "AAAA", sourcesContent: [source] }, lineLengths: [31] };
  return { root, url, copyUrl, declaration, copies, map };
}
test("discard policies cannot alter retained ranges, maps or verified copy attribution", t => {
  const f = isolatedFixture(t), baseline = { result: [v8Script(f.url), v8Script(f.copyUrl)], "source-map-cache": { [f.url]: f.map } };
  const input = { ...baseline, result: [...baseline.result, v8Script(isolatedUrl), v8Script(f.url + "?node-test-mock=1")] }, before = structuredClone(input);
  const expectedUsed = new Set<string>(), used = new Set<string>();
  const expected = relocateV8Report(baseline, isolatedProducer, f.root, f.copies, expectedUsed), actual = relocateV8Report(input, isolatedProducer, f.root, f.copies, used);
  assert.deepEqual(actual.report, expected.report); assert.equal(actual.ignored, expected.ignored + 2);
  assert.deepEqual(used, expectedUsed); assert.deepEqual([...used], [f.copyUrl]); assert.deepEqual(input, before);
  assert.equal(actual.report.result.length, 2); assert.deepEqual(actual.report.result[0].functions, baseline.result[0].functions);
});
const queryRefusals = [
  isolatedProducer + "module.mts", isolatedProducer + "missing.mts", isolatedProducer + "readme.md", isolatedProducer + "node_modules/x.mts",
  isolatedProducer, "file:///d:/a/repo/module.mts", "file:///D:/A/REPO/module.mts", "file:///tmp/module.mts",
  "file://host/share/module.mts", "file:////host/share/module.mts", "file:/D:/temporary/module.mts",
  "file:///D:/temporary/../module.mts", "file:///D:/temporary/./module.mts", "file:///D:/temporary/%2e%2e/module.mts",
  "file:///D:/temporary/%2E/module.mts", "file:///D:/temporary/%2fmodule.mts", "file:///D:/temporary/%5Cmodule.mts",
  "file:///D:/temporary/%00.mts", "file:///D:/temporary/back\\slash.mts", "file:///D:/temporary/raw\0.mts",
  "file:///D:/temporary/%bad.mts", "file:///D:/temporary/module.mts#frag", "file:///D:/temporary//module.mts", "file:///D:/temporary/",
];
for (const [i, base] of queryRefusals.entries()) test("isolated query refuses unsafe or non-external path " + i, () => {
  assert.throws(() => relocateV8Report({ result: [v8Script(base + "?isolated=1")] }, isolatedProducer, process.cwd()));
  assert.throws(() => canonicalFileUrl(base + "?isolated=1"));
});
for (const [i, query] of ["?", "?isolated=", "?other=1", "?isolated=1&x=2", "?isolated=1&isolated=2", "?isolated=x", "?isolated=-1", "?isolated=+1", "?isolated=1.0", "?%69solated=1", "?isolated=%31", "?isolated=1 ", "?isolated=1\n", "?isolated=1?", "?isolated=1#frag"].entries()) test("isolated query grammar refuses extra or nonnumeric input " + i, () => {
  const url = "file:///D:/temporary/module.mts" + query;
  assert.throws(() => relocateV8Report({ result: [v8Script(url)] }, isolatedProducer, process.cwd())); assert.throws(() => canonicalFileUrl(url));
});
test("numeric query refuses mixed dialect, ambiguous directories and root spelling", () => {
  for (const [root, url] of [["file:///a/repo/", "file:///D:/temporary/module.mts?isolated=1"], ["file:///a/repo/", "file:///A/REPO/module.mts?isolated=1"], ["file:///a//repo/", "file:///tmp/module.mts?isolated=1"], ["file:///a/repo", "file:///tmp/module.mts?isolated=1"], [isolatedProducer, isolatedProducer.slice(0, -1) + "?isolated=1"]]) assert.throws(() => relocateV8Report({ result: [v8Script(url)] }, root, process.cwd()));
});
test("numeric isolated copy references refuse exact full and base collisions without marking use", t => {
  const f = isolatedFixture(t), query = f.copyUrl + "?isolated=1";
  for (const copies of [f.copies, new Map([[query, pathToFileURL(join(f.root, "module.mts")).href]])]) {
    const used = new Set<string>(); assert.throws(() => relocateV8Report({ result: [v8Script(query)] }, isolatedProducer, f.root, copies, used), /copy/); assert.equal(used.size, 0);
  }
  assert.throws(() => readCopyDeclarations(JSON.stringify({ ...f.declaration, copyUrl: query }), f.root), /file URL/);
});
test("numeric isolated cache keys and retained map references stay strict", t => {
  const f = isolatedFixture(t);
  for (const result of [[], [v8Script(isolatedUrl)], [v8Script(f.url)]]) {
    assert.throws(() => relocateV8Report({ result, "source-map-cache": { [isolatedUrl]: f.map } }, isolatedProducer, f.root), /file URL/);
    assert.throws(() => relocateV8Report({ result, "source-map-cache": { [f.url + "?isolated=1"]: f.map } }, isolatedProducer, f.root), /file URL/);
  }
  for (const map of [{ ...f.map, url: isolatedUrl }, { data: { ...f.map.data, sources: [isolatedUrl] } }, { data: { ...f.map.data, sourceRoot: isolatedUrl } }]) assert.throws(() => relocateV8Report({ result: [v8Script(f.url), v8Script(isolatedUrl)], "source-map-cache": { [f.url]: map } }, isolatedProducer, f.root), /source map|file URL/);
});
test("ignorable isolated script structure is validated before discard", () => {
  for (const script of [{ url: isolatedUrl }, { url: isolatedUrl, functions: {} }, { url: isolatedUrl, functions: [null] }, { url: isolatedUrl, functions: [{ ranges: [] }] }, { url: isolatedUrl, functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: -1 }] }] }]) assert.throws(() => relocateV8Report({ result: [script] }, isolatedProducer, process.cwd()), /malformed V8/);
});
test("query-free encoded filenames and strict manifest roots retain their contracts", t => {
  const root = fixtureRoot("coverage-query-ordinary-"); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [encoded, name] of [["Spaced%20%C3%BC.mts", "Spaced ü.mts"], ["literal%3Fname.mts", "literal?name.mts"], ["double%252e.mts", "double%2e.mts"]]) {
    // Windows cannot create a literal question-mark filename; URL containment is still portable.
    assert.equal(repositoryPathFromUrl(isolatedProducer + encoded, isolatedProducer), name);
    if (name.includes("?")) continue;
    writeFileSync(join(root, name), "export const n = 1;\n");
    assert.equal(relocateV8Report({ result: [v8Script(isolatedProducer + encoded)] }, isolatedProducer, root).report.result.length, 1);
  }
  const identity = { runId: "1", attempt: "1", checkoutSha: "a".repeat(40) };
  assert.throws(() => validateManifest({ producer: "unit", ...identity, testOutcome: "success", sourceRootUrl: isolatedProducer + "?isolated=1" }, identity), /file URL/);
});

const reservedUrl = isolatedProducer + "module.mts?node-test-mock=1";
test("reserved numeric mock spelling discards genuine in-root source without credit", t => {
  const f = isolatedFixture(t);
  for (const [root, base] of [[isolatedProducer, f.url], ["file:///home/runner/repo/", "file:///home/runner/repo/source.mts"], ["file:///Users/runner/repo/", "file:///Users/runner/repo/source.mts"], [isolatedProducer, "file:///d:/a/repo/source.mts"], [isolatedProducer, isolatedProducer + "node_modules/x.mts"], [isolatedProducer, isolatedProducer + "missing.txt"], [isolatedProducer, isolatedProducer + "Spaced%20%C3%BC.mts"], [isolatedProducer, isolatedProducer + "double%252e.mts"]]) {
    const used = new Set<string>(), input = { result: [v8Script(base + "?node-test-mock=001")] }, before = structuredClone(input);
    const output = relocateV8Report(input, root, f.root, new Map(), used);
    assert.equal(output.ignored, 1); assert.deepEqual(output.report.result, []); assert.equal(used.size, 0);
    assert.deepEqual(input, before); assert.equal(output.report["source-map-cache"], undefined);
    assert.throws(() => canonicalFileUrl(base + "?node-test-mock=001"));
  }
});
const reservedBadBases = [
  "file:///D:/temporary/module.mts", "file:///E:/a/repo/module.mts", "file:///D:/a/repo-other/module.mts",
  "file:///D:/A/REPO/module.mts", "file:///tmp/module.mts", isolatedProducer, isolatedProducer.slice(0, -1),
  ...queryRefusals.slice(8).map(url => url.replace("D:/temporary", "D:/a/repo")),
];
for (const [i, base] of reservedBadBases.entries()) test("reserved query refuses non-inside or unsafe base " + i, () => {
  assert.throws(() => relocateV8Report({ result: [v8Script(base + "?node-test-mock=1")] }, isolatedProducer, process.cwd()));
});
for (const [i, suffix] of ["", "x", "-1", "+1", "1.0", "%31", "1&other=2", "1&node-test-mock=2", "1?", "1#fragment", "1 ", "1\n"].entries()) test("reserved query grammar refuses nonnumeric or extra form " + i, () => {
  assert.throws(() => relocateV8Report({ result: [v8Script(isolatedProducer + "module.mts?node-test-mock=" + suffix)] }, isolatedProducer, process.cwd()));
});
test("reserved spelling keeps exact copy, manifest, cache and map interfaces strict", t => {
  const f = isolatedFixture(t), query = f.url + "?node-test-mock=1";
  for (const key of [f.url, query]) {
    const used = new Set<string>();
    assert.throws(() => relocateV8Report({ result: [v8Script(query)] }, isolatedProducer, f.root, new Map([[key, pathToFileURL(join(f.root, "module.mts")).href]]), used), /copy/);
    assert.equal(used.size, 0);
  }
  assert.throws(() => readCopyDeclarations(JSON.stringify({ ...f.declaration, copyUrl: query }), f.root), /file URL/);
  for (const result of [[], [v8Script(query)], [v8Script(f.url)]]) assert.throws(() => relocateV8Report({ result, "source-map-cache": { [query]: f.map } }, isolatedProducer, f.root), /file URL/);
  for (const map of [{ ...f.map, url: query }, { data: { ...f.map.data, sources: [query] } }, { data: { ...f.map.data, sourceRoot: query } }]) assert.throws(() => relocateV8Report({ result: [v8Script(f.url), v8Script(query)], "source-map-cache": { [f.url]: map } }, isolatedProducer, f.root), /source map|file URL/);
  const id = { runId: "1", attempt: "1", checkoutSha: "a".repeat(40) };
  assert.throws(() => validateManifest({ ...id, producer: "unit", testOutcome: "success", sourceRootUrl: isolatedProducer + "?node-test-mock=1" }, id), /file URL/);
  for (const bad of ["?%6eode-test-mock=1", "?node-test-mock=%30"]) assert.throws(() => relocateV8Report({ result: [v8Script(f.url + bad)] }, isolatedProducer, f.root));
});
test("reserved discard validates functions and ranges before policy classification", () => {
  for (const functions of [null, [null], [{ ranges: [] }], [{ ranges: [{ startOffset: 2, endOffset: 1, count: 1 }] }]]) assert.throws(() => relocateV8Report({ result: [{ url: reservedUrl, functions }] }, isolatedProducer, process.cwd()), /malformed V8/);
});

test("reserved policy refuses mixed dialect and ambiguous POSIX namespace", () => {
  for (const [root, url] of [["file:///a/repo/", reservedUrl], ["file:///a/repo/", "file:///A/REPO/file.mts?node-test-mock=1"], ["file:///a//repo/", "file:///a/repo/file.mts?node-test-mock=1"], [isolatedProducer + "?node-test-mock=1", reservedUrl]]) assert.throws(() => relocateV8Report({ result: [v8Script(url)] }, root, process.cwd()));
});
