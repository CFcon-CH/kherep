#!/usr/bin/env node
// Unit test for hook-inventory.mts: which specifiers count as a runtime import,
// and how the walk resolves, bounds and dedupes them. Pure strings and an
// in-memory source map, no file system; the contract test
// live-hook-integrity-imports.test.mts drives the same code through the hook.
// Runs on its own as `node hook-inventory.test.mts`, like every suite in CI.

import assert from "node:assert/strict";
import { test } from "node:test";

import { hookInventory, relativeSpecifiers, sameEntryPath, wiredFiles, type HookFile } from "./hook-inventory.mts";

const HOOKS = "/home/example/.claude/hooks";

// Fixture sources spell `from` (and `import(`, below) through a helper, so the
// literal text of this file holds no relative import: bootstrap/hook-require-resolution.test.mts scans
// every hook file for exactly that and would read a fixture as a real import.
const from = (specifier: string, quote = '"'): string => `from ${quote}${specifier}${quote}`;

// A source map keyed by absolute path; a missing key reads as "nothing there".
function reader(sources: Record<string, string>, calls: string[] = []) {
  return (file: string): string | null => {
    calls.push(file);
    return sources[file] ?? null;
  };
}

const root = (rel: string): HookFile => ({ file: `${HOOKS}/${rel}`, rel });

test("collects every runtime import form, in single and double quotes", () => {
  const source = [
    `import fs from "node:fs";`,
    `import { a } ${from("./lib/a.mts", "'")};`,
    `import {`,
    `  b,`,
    `  type B, // inline type: the module still loads`,
    `} ${from("./lib/b.mts")};`,
    `export { c } ${from("./lib/c.mts")};`,
    `import "./lib/side-effect.mts";`,
    `import * as d ${from("./lib/d.js")};`,
  ].join("\n");
  assert.deepEqual(relativeSpecifiers(source).sort(), [
    "./lib/a.mts", "./lib/b.mts", "./lib/c.mts", "./lib/d.js", "./lib/side-effect.mts",
  ]);
});

test("skips type-only statements, comments, non-relative and extension-less specifiers", () => {
  const source = [
    `import type { T } ${from("./lib/types-only.mts")};`,
    `export type { U } ${from("./lib/types-too.mts")};`,
    `// import { ghost } ${from("./lib/ghost.mts")};`,
    `/* import { ghost2 } ${from("./lib/ghost2.mts")}; */`,
    `/**`,
    `import { ghost3 } ${from("./lib/ghost3.mts")};`,
    ` */`,
    `import os from "os";`,
    `import abs from "/abs/x.mts";`,
    `import bare ${from("./lib/no-extension")};`,
    `import data ${from("./lib/data.json")};`,
  ].join("\n");
  assert.deepEqual(relativeSpecifiers(source), []);
});

test("a /* or // inside a string does not swallow the imports after it", () => {
  const source = `const glob = "hooks/*.mts"; const url = "http://example.test";\nimport { a } ${from("./lib/a.mts")};\n// */`;
  assert.deepEqual(relativeSpecifiers(source), ["./lib/a.mts"]);
});

test("a block comment right after ) or } is stripped too", () => {
  const source = `run()/* old wiring:\nimport { g } ${from("./lib/ghost.mts")};\n*/\nconst o = {}/*\nimport { h } ${from("./lib/ghost2.mts")};\n*/;`;
  assert.deepEqual(relativeSpecifiers(source), []);
});

test("a default import named type is a runtime import", () => {
  assert.deepEqual(relativeSpecifiers(`import type ${from("./lib/t.mts")};`), ["./lib/t.mts"]);
});

// Issue #279. PowerShell 5.1 and Notepad save UTF-8 with a BOM; it sat in front
// of the first import and hid it from the line-anchored scan.
test("a leading byte order mark does not hide the first import", () => {
  const bom = String.fromCharCode(0xfeff);
  assert.deepEqual(relativeSpecifiers(`${bom}import { a } ${from("./lib/a.mts")};`), ["./lib/a.mts"]);
  assert.deepEqual(relativeSpecifiers(`${bom}import "./lib/side.mts";`), ["./lib/side.mts"]);
});

// Spelled through a helper for the same reason as `from` above.
const dynamic = (specifier: string, quote = '"'): string => `import(${quote}${specifier}${quote})`;

test("a string-literal dynamic import is a runtime import, typeof import() is a type", () => {
  const source = [
    `const a = await ${dynamic("./lib/a.mts")};`,
    `const load = () => ${dynamic("./lib/b.mts", "'")};`,
    `type C = typeof ${dynamic("./lib/c.mts")};`,
    `type D = typeof  ${dynamic("./lib/d.mts")}["x"];`,
    `// await ${dynamic("./lib/ghost.mts")};`,
    `const e = await ${dynamic("node:fs")};`,
    "const f = await import(`./lib/${name}.mts`);",
  ].join("\n");
  assert.deepEqual(relativeSpecifiers(source).sort(), ["./lib/a.mts", "./lib/b.mts"]);
});

test("the walk follows a dynamic import like a static one", () => {
  const inventory = hookInventory([root("guard.mts")], HOOKS, reader({
    [`${HOOKS}/guard.mts`]: `const m = await ${dynamic("./lib/a.mts")};`,
  }));
  assert.deepEqual(inventory.map((entry) => entry.rel), ["guard.mts", "lib/a.mts"]);
});

test("walks transitively and names every importer", () => {
  const inventory = hookInventory([root("guard.mts"), root("other.mts")], HOOKS, reader({
    [`${HOOKS}/guard.mts`]: `import { a } ${from("./lib/a.mts")};\nimport { p } ${from("./pairs.mts")};`,
    [`${HOOKS}/other.mts`]: `import { b } ${from("./lib/b.mts")};`,
    [`${HOOKS}/lib/a.mts`]: `import { b } ${from("./b.mts")};`,
    [`${HOOKS}/lib/b.mts`]: `export const b = 1;`,
  }));
  const byRel = Object.fromEntries(inventory.map((entry) => [entry.rel, entry]));
  assert.deepEqual(Object.keys(byRel).sort(), ["guard.mts", "lib/a.mts", "lib/b.mts", "other.mts", "pairs.mts"]);
  assert.equal(byRel["guard.mts"].wired, true);
  assert.equal(byRel["lib/b.mts"].wired, false);
  assert.deepEqual(byRel["lib/b.mts"].importedBy.sort(), ["lib/a.mts", "other.mts"]);
  assert.deepEqual(byRel["pairs.mts"].importedBy, ["guard.mts"]);
});

test("an in-bounds .. from lib/ and a direct import of the same file give one entry", () => {
  const inventory = hookInventory([root("guard.mts")], HOOKS, reader({
    [`${HOOKS}/guard.mts`]: `import { a } ${from("./lib/a.mts")};\nimport { s } ${from("./shared.mts")};`,
    [`${HOOKS}/lib/a.mts`]: `import { s } ${from("../shared.mts")};`,
  }));
  const shared = inventory.filter((entry) => entry.rel.endsWith("shared.mts"));
  assert.deepEqual(shared.map((entry) => entry.rel), ["shared.mts"]);
  assert.deepEqual(shared[0].importedBy.sort(), ["guard.mts", "lib/a.mts"]);
});

test("drops targets outside the hooks directory, including through ..", () => {
  const inventory = hookInventory([root("guard.mts")], HOOKS, reader({
    [`${HOOKS}/guard.mts`]: `import a ${from("../outside.mts")};\nimport b ${from("./lib/../../x.mts")};\nimport c ${from("./lib/../in.mts")};`,
  }));
  assert.deepEqual(inventory.map((entry) => entry.rel).sort(), ["guard.mts", "in.mts"]);
});

test("dedupes case-insensitively and ends a cycle", () => {
  const calls: string[] = [];
  const inventory = hookInventory([root("guard.mts"), root("GUARD.mts")], HOOKS, reader({
    [`${HOOKS}/guard.mts`]: `import { a } ${from("./lib/a.mts")};\nimport { A } ${from("./LIB/A.mts")};`,
    [`${HOOKS}/lib/a.mts`]: `import { b } ${from("./b.mts")};`,
    [`${HOOKS}/lib/b.mts`]: `import { a } ${from("./a.mts")};`,
  }, calls));
  assert.deepEqual(inventory.map((entry) => entry.rel).sort(), ["guard.mts", "lib/a.mts", "lib/b.mts"]);
  assert.equal(calls.length, 3, "every file is read once");
  const a = inventory.find((entry) => entry.rel === "lib/a.mts");
  assert.deepEqual(a && a.importedBy.sort(), ["guard.mts", "lib/b.mts"]);
});

test("a file the reader cannot supply stays in the inventory, the walk just stops there", () => {
  const inventory = hookInventory([root("guard.mts")], HOOKS, reader({
    [`${HOOKS}/guard.mts`]: `import { a } ${from("./lib/a.mts")};`,
  }));
  assert.deepEqual(inventory.map((entry) => entry.rel), ["guard.mts", "lib/a.mts"]);
});

test("wiredFiles reads through the supplied reader and ignores tokens that are no hook file", () => {
  const home = "/home/example/.claude";
  const settings = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [
    { type: "command", command: `& node "${home}/hooks/guard.mts"` },
    { type: "command", command: `node ${home}/kherep/outside.mts` },
  ] }] } });
  const missing = Object.assign(new Error("absent"), { code: "ENOENT" });
  const { files, notes, readAny } = wiredFiles(home, (name) => {
    if (name === "settings.user.json") return settings;
    throw missing;
  });
  assert.deepEqual(files, [{ file: `${home}/hooks/guard.mts`, rel: "guard.mts" }]);
  assert.deepEqual(notes, []);
  assert.equal(readAny, true);
});

// Issue #507, part 2: a command counts as coordinated only when it is exactly
// `node <entry> <mode> <main> [args]`. A shell operator could run hooks/ code
// next to the entry, so any such command makes repair unavailable.
test("only a plain entry command is coordinated; a chained one is not", () => {
  const home = "/home/example/.claude";
  const entry = `node "${home}/kherep/hook-runtime/entry.mts"`;
  const uncoordinatedOf = (command: string, claudeHome = home): string[] => wiredFiles(claudeHome, (name) => {
    if (name === "settings.user.json") return JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } });
    throw Object.assign(new Error("absent"), { code: "ENOENT" });
  }).uncoordinated;
  for (const command of [
    `${entry} reader "${home}/hooks/a.mts"`,
    `node "'${home}/kherep/hook-runtime/entry.mts'" reader "'${home}/hooks/a.mts'"`,
    `& ${entry} reader "${home}/hooks/a.mts"`,
    `${entry} pretool "${home}/hooks/guard-dispatch.mts" "${home}/hooks/commit-guard.mts" '${home}/hooks/deploy-guard.mts'`,
    `node \${CLAUDE_HOME}/kherep/hook-runtime/entry.mts writer \${CLAUDE_HOME}/hooks/live-hook-integrity.mts --trigger x`,
  ]) assert.deepEqual(uncoordinatedOf(command), [], command);
  for (const command of [
    `${entry} reader ${home}/hooks/a.mts && node ${home}/hooks/b.mts`,
    `${entry} reader ${home}/hooks/a.mts || node ${home}/hooks/b.mts`,
    `${entry} reader ${home}/hooks/a.mts; node ${home}/hooks/b.mts`,
    `${entry} reader ${home}/hooks/a.mts | node ${home}/hooks/b.mts`,
    `${entry} reader ${home}/hooks/a.mts & node ${home}/hooks/b.mts`,
    `${entry} reader ${home}/hooks/a.mts\nnode ${home}/hooks/b.mts`,
    `${entry} reader ${home}/hooks/a.mts "$(node ${home}/hooks/b.mts)"`,
    `${entry} reader ${home}/hooks/a.mts \`node ${home}/hooks/b.mts\``,
    `${entry} reader ${home}/hooks/a.mts < <(node ${home}/hooks/b.mts)`,
    `${entry} reader ${home}/hooks/a.mts > >(node ${home}/hooks/b.mts)`,
    `FOO=1 ${entry} reader ${home}/hooks/a.mts`,
    `${entry} reader ${home}/hooks/a.mts \\' ; node ${home}/hooks/b.mts ; '`,
    `${entry} reader "${home}/hooks/a.mts\\" ; node ${home}/hooks/b.mts ; "`,
  ]) assert.deepEqual(uncoordinatedOf(command), [command], command);
  const win = "C:\\Users\\Example\\.claude";
  const winCommand = `node "${win}/kherep/hook-runtime/entry.mts" reader "${win}/hooks/a.mts"`;
  assert.deepEqual(uncoordinatedOf(winCommand, "C:/Users/Example/.claude"), [], "a Windows path keeps its backslashes inside quotes");
  // P3-4 and review of bcab653 (H3): a case-differing entry path is the same entry only on
  // Windows; on a case-sensitive file system it may be another program.
  const otherCase = `node "c:/users/example/.CLAUDE/kherep/hook-runtime/entry.mts" reader "C:/Users/Example/.claude/hooks/a.mts"`;
  assert.deepEqual(uncoordinatedOf(otherCase, "C:/Users/Example/.claude"), process.platform === "win32" ? [] : [otherCase]);
  const posixOther = `node "${home}/Kherep/hook-runtime/entry.mts" reader "${home}/hooks/a.mts"`;
  assert.deepEqual(uncoordinatedOf(posixOther), process.platform === "win32" ? [] : [posixOther], "Kherep is not kherep off Windows");
});

test("an entry path matches case-insensitively on Windows only", () => {
  const a = "/home/example/.claude/kherep/hook-runtime/entry.mts";
  const b = "/home/example/.claude/Kherep/hook-runtime/entry.mts";
  assert.equal(sameEntryPath(a, a, "linux"), true);
  assert.equal(sameEntryPath(a, b, "linux"), false);
  assert.equal(sameEntryPath(a, b, "darwin"), false);
  assert.equal(sameEntryPath("C:/Users/X/.claude/kherep/hook-runtime/entry.mts", "c:/users/x/.CLAUDE/kherep/hook-runtime/entry.mts", "win32"), true);
});

// Issue #524. Node loads a linked hook from its real path, so its relative imports
// resolve from the real directory, bounded by the real hooks directory, and are named
// at the same place under the wired hooks directory. A reader names the real path by
// returning { text, real }; a plain string resolves from the alias as before.
type Read = string | { text: string; real?: string } | null;
const linked = (sources: Record<string, Read>) => (file: string): Read => sources[file] ?? null;
const relsOf = (inventory: { rel: string }[]): string[] => inventory.map((entry) => entry.rel);

test("a file link: its imports resolve from the target's directory, not the alias's", () => {
  const inventory = hookInventory([root("alias/guard.mts")], HOOKS, linked({
    [`${HOOKS}/alias/guard.mts`]: { text: `import { x } ${from("./dep.mts")};`, real: `${HOOKS}/real/guard.mts` },
    [`${HOOKS}/alias/dep.mts`]: `import { y } ${from("./leaf-alias.mts")};`,
    [`${HOOKS}/real/dep.mts`]: { text: `import { y } ${from("./leaf-real.mts")};`, real: `${HOOKS}/real/dep.mts` },
  }), HOOKS);
  assert.deepEqual(relsOf(inventory), ["alias/guard.mts", "real/dep.mts", "real/leaf-real.mts"]);
  assert.deepEqual(inventory.find((entry) => entry.rel === "real/dep.mts")?.importedBy, ["alias/guard.mts"]);
});

test("a directory link: a .. resolves from the real directory", () => {
  const inventory = hookInventory([root("alias/link/guard.mts")], HOOKS, linked({
    [`${HOOKS}/alias/link/guard.mts`]: { text: `import { x } ${from("../dep.mts")};`, real: `${HOOKS}/real/sub/guard.mts` },
  }), HOOKS);
  assert.deepEqual(relsOf(inventory), ["alias/link/guard.mts", "real/dep.mts"]);
});

test("a linked hooks root with another basename: a .. is resolved in the real namespace", () => {
  const home = "/home/example/hooks";
  const inventory = hookInventory([{ file: `${home}/guard.mts`, rel: "guard.mts" }], home, linked({
    [`${home}/guard.mts`]: {
      text: `import { x } ${from("../managed-hooks/dep.mts")};\nimport { y } ${from("../hooks/other.mts")};`,
      real: "/srv/managed-hooks/guard.mts",
    },
    [`${home}/dep.mts`]: { text: "export {}", real: "/srv/managed-hooks/dep.mts" },
  }), "/srv/managed-hooks");
  assert.deepEqual(relsOf(inventory), ["guard.mts", "dep.mts"]);
  assert.equal(inventory[1]?.file, `${home}/dep.mts`);
  assert.deepEqual(inventory[1]?.importedBy, ["guard.mts"]);
});

test("a file whose real path lies outside the real hooks directory contributes no imports", () => {
  const inventory = hookInventory([root("guard.mts")], HOOKS, linked({
    [`${HOOKS}/guard.mts`]: { text: `import { a } ${from("./lib/a.mts")};`, real: "/srv/elsewhere/guard.mts" },
  }), HOOKS);
  assert.deepEqual(relsOf(inventory), ["guard.mts"]);
  const transitive = hookInventory([root("guard.mts")], HOOKS, linked({
    [`${HOOKS}/guard.mts`]: `import { a } ${from("./lib/a.mts")};`,
    [`${HOOKS}/lib/a.mts`]: { text: `import { b } ${from("./b.mts")};`, real: "/srv/elsewhere/lib/a.mts" },
  }), HOOKS);
  assert.deepEqual(relsOf(transitive), ["guard.mts", "lib/a.mts"]);
});

test("a plain-string reader resolves from the alias directory in the four-argument form too", () => {
  const sources = {
    [`${HOOKS}/guard.mts`]: `import { a } ${from("./lib/a.mts")};\nimport { o } ${from("../outside.mts")};`,
    [`${HOOKS}/lib/a.mts`]: `import { s } ${from("../shared.mts")};`,
  };
  const three = hookInventory([root("guard.mts")], HOOKS, reader(sources));
  const four = hookInventory([root("guard.mts")], HOOKS, reader(sources), "/srv/managed-hooks");
  assert.deepEqual(four, three);
  assert.deepEqual(relsOf(four), ["guard.mts", "lib/a.mts", "shared.mts"]);
});
