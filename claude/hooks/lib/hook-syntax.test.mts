#!/usr/bin/env node
// Unit test for hook-syntax.mts (issues #278 and #284). Pure strings into
// syntaxVerdict, except where Node itself needs a file: the CLI, the stderr
// checks and the loader-hook fixture, which use one mkdtemp directory. The
// node --check confirmation of .js and .cjs is in hook-syntax-check.test.mts.
// Runs on its own as `node hook-syntax.test.mts`, like every suite in CI.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

import { cjsParses, linkFailureVerdict, syntaxVerdict, type SyntaxVerdict } from "./hook-syntax.mts";

const LIB = path.join(import.meta.dirname, "hook-syntax.mts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hook-syntax-"));
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

// Fixture sources spell `from` through this helper, so the literal text of this
// file holds no relative from-clause: bootstrap/hook-require-resolution.test.mts scans
// every hook file for exactly that and would read a fixture as a real import.
const from = (specifier: string): string => `from "${specifier}"`;

const detailOf = (v: SyntaxVerdict): string => (v.state === "OK" ? "" : v.detail);

async function expectDefekt(name: string, source: string, needle: string): Promise<void> {
  const v = await syntaxVerdict(name, source);
  assert.equal(v.state, "DEFEKT", `${JSON.stringify(source)}: ${detailOf(v)}`);
  assert.ok(detailOf(v).includes(needle), `${JSON.stringify(source)}: ${detailOf(v)} lacks ${needle}`);
}

async function expectOk(name: string, source: string): Promise<void> {
  const v = await syntaxVerdict(name, source);
  assert.equal(v.state, "OK", `${JSON.stringify(source)}: ${detailOf(v)}`);
}

test("the ESM error shapes node --check passes are DEFEKT", async () => {
  for (const source of ["export const x = ;\n", "export {}; }\n", `import fs ${from("node:fs")};\nexport const x = (;\n`]) {
    await expectDefekt("hook.mts", source, "ERR_INVALID_TYPESCRIPT_SYNTAX");
  }
});

test("TypeScript-only errors are DEFEKT", async () => {
  await expectDefekt("hook.mts", "export const y: = 2;\n", "ERR_INVALID_TYPESCRIPT_SYNTAX");
  await expectDefekt("hook.mts", "export enum E { A }\n", "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
});

test("early errors only V8 finds are DEFEKT, with V8's message", async () => {
  await expectDefekt("hook.mts", "export const a = 1; export { a };\n", "Duplicate export");
  await expectDefekt("hook.mts", "export { nope };\n", "is not defined in module");
  await expectDefekt("hook.mts", "const a = 1; const a = 2; export {};\n", "has already been declared");
});

test("valid sources are OK, including typed code without import or export", async () => {
  await expectOk("hook.mts", "const x: number = 1;\nconsole.log(x);\n");
  await expectOk("hook.mts", `import fs ${from("node:fs")};\nexport const x: number = fs.constants.F_OK;\n`);
  await expectOk("hook.mts", "#!/usr/bin/env node\r\nexport const x: string = \"crlf\";\r\n");
  await expectOk("hook.mts", "﻿export const x = 1;\n");
  await expectOk("hook.mts", "export const x = 1; // trailing comment, no newline");
  await expectOk("hook.mts", "const t = `a${1}b`;\nconst r = /[/]+/g;\nexport default { t, r };\n");
  // Resolution is not this check's business: a missing relative import is OK.
  await expectOk("hook.mts", `import { y } ${from("./does-not-exist.mts")};\nexport const x = y;\n`);
});

test("a checked module is never executed", async () => {
  const marker = "__kherepHookSyntaxProbe";
  const before = process.exitCode;
  const source = `import fs ${from("node:fs")};\n(globalThis as Record<string, unknown>).${marker} = fs;\nprocess.exitCode = 99;\nexport const x = 1;\n`;
  await expectOk("hook.mts", source);
  assert.equal((globalThis as Record<string, unknown>)[marker], undefined);
  assert.equal(process.exitCode, before);
});

test("an unknown resolution failure is UNGEPRUEFT, never OK", () => {
  // A request that fails with a code outside the known link failures proves
  // neither a parse nor a non-parse. Tested on synthetic errors: which failing
  // request Node reports first differs between versions.
  const coded = (code: string) => Object.assign(new Error(code), { code });
  assert.equal(linkFailureVerdict(coded("ERR_UNKNOWN_BUILTIN_MODULE")).state, "UNGEPRUEFT");
  assert.equal(linkFailureVerdict(new Error("no code")).state, "UNGEPRUEFT");
  assert.equal(linkFailureVerdict(coded("ERR_UNSUPPORTED_ESM_URL_SCHEME")).state, "OK");
  assert.equal(linkFailureVerdict(new SyntaxError("Unexpected token")).state, "DEFEKT");
});

test("a Node without module.stripTypeScriptTypes gives UNGEPRUEFT, never OK", async () => {
  const holder = module as { stripTypeScriptTypes?: unknown };
  const original = holder.stripTypeScriptTypes;
  holder.stripTypeScriptTypes = undefined;
  try {
    const v = await syntaxVerdict("hook.mts", "export const x = 1;\n");
    assert.equal(v.state, "UNGEPRUEFT", detailOf(v));
  } finally {
    holder.stripTypeScriptTypes = original;
  }
});

// Issue #576: Node's message stays, every absolute path in it is reduced to its file name.
test("parser messages keep Node's text and name no absolute path", async () => {
  assert.equal(detailOf(linkFailureVerdict(new SyntaxError("/Users/x/hooks/a.mts: boom"))), "rejected by Node's parser: a.mts: boom");
  assert.equal(detailOf(linkFailureVerdict(new SyntaxError("Identifier 'a' has already been declared"))), "rejected by Node's parser: Identifier 'a' has already been declared");
  const unresolved = Object.assign(new Error("Cannot find module '/Users/x/a.mts' imported from \\\\srv\\share\\b.mts"), { code: "ERR_UNKNOWN_BUILTIN_MODULE" });
  assert.equal(detailOf(linkFailureVerdict(unresolved)), "ERR_UNKNOWN_BUILTIN_MODULE: Cannot find module 'a.mts' imported from b.mts");
  const holder = module as { stripTypeScriptTypes?: unknown };
  const original = holder.stripTypeScriptTypes;
  const thrower = (error: Error) => () => { throw error; };
  try {
    holder.stripTypeScriptTypes = thrower(Object.assign(new Error("C:\\Users\\x\\a.mts: bad"), { code: "ERR_INVALID_TYPESCRIPT_SYNTAX" }));
    assert.equal(detailOf(await syntaxVerdict("hook.mts", "export const x = 1;\n")), "rejected by Node's parser: ERR_INVALID_TYPESCRIPT_SYNTAX: a.mts: bad");
    holder.stripTypeScriptTypes = thrower(new Error("~/.claude/x.mts: odd"));
    assert.equal(detailOf(await syntaxVerdict("hook.mts", "export const x = 1;\n")), "type stripping failed (no code: x.mts: odd)");
  } finally {
    holder.stripTypeScriptTypes = original;
  }
});

test("0 bytes is DEFEKT, other extensions are dispatched or left unchecked", async () => {
  await expectDefekt("hook.mts", "", "0 bytes");
  await expectOk("hook.mjs", "export const x = 1;\n");
  await expectDefekt("hook.mjs", "export const x: number = 1;\n", "rejected by Node's parser");
  assert.equal((await syntaxVerdict("hook.sh", "echo hi\n")).state, "UNGEPRUEFT");
  assert.equal((await syntaxVerdict("hook.ts", "export const x = 1;\n")).state, "UNGEPRUEFT");
});

// Node 24.1 also prints its own type-stripping ExperimentalWarning for any .mts
// a child loads (see 7ed7c75), so stderr is never asserted to be empty: only the
// stripper's own warning must be gone, and unrelated ones must still print. The
// child re-emits the text of Node's type-stripping warning itself, so its
// survival is proven on Node versions that no longer print it on their own.
const NODE_STRIP_WARNING = "Type Stripping is an experimental feature and might change at any time";
function warningRun(viaLib: boolean): string {
  const script = [
    // The control calls the stripper directly: the warning exists in this Node.
    viaLib ? `const m = await import(${JSON.stringify(pathToFileURL(LIB).href)});\nawait m.syntaxVerdict("hook.mts", "export const x: number = 1;\\n");`
      : 'const { default: m } = await import("node:module");\nm.stripTypeScriptTypes("const x: number = 1;");',
    `process.emitWarning(${JSON.stringify(NODE_STRIP_WARNING)}, "ExperimentalWarning");`,
    'process.emitWarning("kherep unrelated deprecation", "DeprecationWarning");',
  ].join("\n");
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }).stderr;
}

// The control records, never asserts, whether this Node still warns: a Node that
// stabilises the stripper makes the filter dead code, not the suite red (#292).
test("only the stripper's ExperimentalWarning is filtered", () => {
  const stillWarns = /ExperimentalWarning: stripTypeScriptTypes/.test(warningRun(false));
  console.log(`MEASURED | node ${process.version} stripTypeScriptTypes ExperimentalWarning: ${stillWarns ? "present" : "absent"}`);
  const quiet = warningRun(true);
  if (stillWarns) assert.doesNotMatch(quiet, /stripTypeScriptTypes/);
  assert.ok(quiet.includes(`ExperimentalWarning: ${NODE_STRIP_WARNING}`), quiet);
  assert.match(quiet, /DeprecationWarning: kherep unrelated deprecation/);
});

test("the CLI prints the verdict and exits 0, 1 or 2", () => {
  const cases: [string, string, number, string][] = [
    ["ok.mts", "const x: number = 1;\nexport { x };\n", 0, "OK"],
    ["bad.mts", "export const x = ;\n", 1, "DEFEKT"],
    ["script.sh", "echo hi\n", 2, "UNGEPRUEFT"],
  ];
  for (const [name, source, status, word] of cases) {
    const file = path.join(TMP, name); // a native path, so a Windows path on win32
    fs.writeFileSync(file, source);
    const run = spawnSync(process.execPath, [LIB, file], { encoding: "utf8" });
    assert.equal(run.status, status, `${name}: ${run.stdout}${run.stderr}`);
    assert.equal(run.stdout.split(/\s/)[0], word, name);
    assert.doesNotMatch(run.stderr, /stripTypeScriptTypes/, name);
  }
  const missing = spawnSync(process.execPath, [LIB, path.join(TMP, "absent.mts")], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /^UNGEPRUEFT unreadable/);
});

// Records whether Node still has the gap; the only assertion is that the run ended,
// so a Node release that closes the gap never turns the suite red.
test("records whether node --check still passes an ESM syntax error in .mts", () => {
  const file = path.join(TMP, "gap.mts");
  fs.writeFileSync(file, "export const x = ;\n");
  const status = spawnSync(process.execPath, ["--check", file]).status;
  assert.ok(status === null || Number.isInteger(status), `node --check ended with ${String(status)}`);
  console.log(`MEASURED | node ${process.version} --check on "export const x = ;" (.mts) exits ${status}`);
});

// ---- issue #284 ----

// Item 1: the filter must not rewrap listeners. A `once` listener fires once, a
// listener attached after quietStripWarning() never sees the stripper's warning
// and the printer stays installed (listener count unchanged). Counted, not
// compared as a list: Node 24.1 may emit its own warning for the .mts import.
test("the warning filter leaves listeners alone: once fires once, a late listener is shielded", () => {
  const script = [
    `const m = await import(${JSON.stringify(pathToFileURL(LIB).href)});`,
    'const seen = []; process.once("warning", (w) => seen.push("once:" + w.name)); const before = process.listeners("warning").length;',
    'm.quietStripWarning(); process.on("warning", (w) => seen.push("late:" + w.message.split(" ")[0]));',
    'await m.syntaxVerdict("hook.mts", "export const x: number = 1;\\n");',
    'process.emitWarning("kherep one", "DeprecationWarning"); process.emitWarning("kherep two", "DeprecationWarning");',
    'await new Promise((r) => setTimeout(r, 20)); console.log(JSON.stringify({ before, after: process.listeners("warning").length, seen }));',
  ].join("\n");
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  const out = JSON.parse(run.stdout.trim().split(/\r?\n/).pop() || "{}");
  const seen: string[] = out.seen || [];
  assert.equal(out.after, out.before, run.stdout + run.stderr);
  assert.equal(seen.filter((s) => s.startsWith("once:")).length, 1, seen.join());
  assert.equal(seen.filter((s) => s === "late:kherep").length, 2, seen.join());
  assert.ok(!seen.some((s) => s.includes("stripTypeScriptTypes")), seen.join());
});

// Item 3: a customization hook that resolves the probe specifier must not let
// the module evaluate; the verdict is UNGEPRUEFT and names the hook. The fixture
// has one module request, the probe, so the reported failure is deterministic.
test("a loader hook that resolves the probe gives UNGEPRUEFT before anything runs", () => {
  const hook = path.join(TMP, "resolve-probe.mjs");
  fs.writeFileSync(hook, [
    `import { registerHooks } ${from("node:module")};`,
    'const stub = "data:text/javascript," + encodeURIComponent("globalThis.__kherepStubRan = true;");',
    'registerHooks({ resolve(specifier, context, next) { return specifier.startsWith("kherep-syntax-probe:") ? { url: stub, format: "module", shortCircuit: true } : next(specifier, context); } });',
  ].join("\n"));
  const script = [
    `const m = await import(${JSON.stringify(pathToFileURL(LIB).href)});`,
    'const v = await m.syntaxVerdict("hook.mts", "globalThis.__kherepHookRan = true;\\nexport const x: number = 1;\\n");',
    'console.log(JSON.stringify({ v, hookRan: globalThis.__kherepHookRan === true, stubRan: globalThis.__kherepStubRan === true }));',
  ].join("\n");
  const run = spawnSync(process.execPath, [`--import=${pathToFileURL(hook).href}`, "--input-type=module", "-e", script], { encoding: "utf8" });
  const out = JSON.parse(run.stdout.trim().split(/\r?\n/).pop() || "{}");
  assert.equal(out.hookRan, false, run.stdout + run.stderr);
  assert.equal(out.stubRan, false);
  assert.equal(out.v.state, "UNGEPRUEFT");
  assert.match(out.v.detail, /customization hook/);
});

// Issue #507, part 2 (P2): the CommonJS wrapper parse the final proof uses on the snapshot.
test("cjsParses parses a source as the function body Node's CommonJS loader compiles", () => {
  assert.equal(cjsParses("return 1;\n", "x.js").state, "OK");
  assert.equal(cjsParses("require(\"node:fs\");\n", "x.js").state, "OK");
  assert.deepEqual(cjsParses("const x = ;\n", "x.js"), { state: "DEFEKT", detail: "rejected by Node's parser: Unexpected token ';'" });
  assert.equal(cjsParses("let require;\n", "x.js").state, "DEFEKT", "the wrapper declares require");
  assert.equal(cjsParses("export const x = 1;\n", "x.js").state, "DEFEKT");
  assert.equal(cjsParses("await 1;\n", "x.js").state, "DEFEKT");
});
