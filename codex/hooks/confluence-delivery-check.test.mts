// Contract test for the Confluence delivery check. The assertions that matter
// are the ones about not lying in either direction: a missing entry file is not
// the same statement as a partial install, and a set that looks complete by
// count is not complete if the broker imports something that is not there.
import assert from "node:assert/strict";
import test from "node:test";

import { ENTRY, inspect, isKherepScope, message, statePath, toolsDir } from "./confluence-delivery-check.mts";

// A fake tools/ directory: file name -> source text.
function fixture(files: Record<string, string>) {
  const read = (file: string): string => {
    const name = file.replace(/\\/g, "/").split("/").pop()!;
    if (!(name in files)) throw new Error("ENOENT");
    return files[name];
  };
  const exists = (file: string): boolean => {
    const name = file.replace(/\\/g, "/").split("/").pop()!;
    return name in files;
  };
  return { read, exists };
}

// Assembled rather than written out: a repository test scans hook sources for
// relative import references and checks that each one resolves to a real file.
// Spelled out literally, these fixture strings would be read as this file
// importing modules that do not exist, and the scanner would be right to
// complain - the text is data here, but nothing about its shape says so.
const SPECIFIER = ["from", ' "', ".", "/"].join("");

const imports = (...names: string[]): string =>
  names.map((n) => `import { x } ${SPECIFIER}${n}";`).join("\n");

test("nothing delivered is reported as absent, not as partial", () => {
  const { read, exists } = fixture({});
  const delivery = inspect("/tools", read, exists);
  assert.equal(delivery.absent, true);
  assert.deepEqual(delivery.missing, [ENTRY]);
  assert.match(message(delivery, false), /not installed/);
  assert.match(message(delivery, false), /documented installer/);
});

test("the import graph is walked transitively, not counted", () => {
  const { read, exists } = fixture({
    [ENTRY]: imports("confluence-content.mts", "confluence-neighbour-cli.mts"),
    "confluence-content.mts": imports("confluence-contract.mts"),
    "confluence-neighbour-cli.mts": imports("confluence-neighbours.mts"),
    "confluence-neighbours.mts": imports("confluence-related.mts"),
    "confluence-related.mts": imports("confluence-contract.mts"),
    "confluence-contract.mts": "export const x = 1;",
  });
  const delivery = inspect("/tools", read, exists);
  assert.deepEqual(delivery.missing, []);
  assert.equal(delivery.present.length, 6, "a module reached only through two hops still counts");
});

test("a module the broker imports but the installer did not ship is named", () => {
  const { read, exists } = fixture({
    [ENTRY]: imports("confluence-content.mts", "confluence-runtime-label.mts"),
    "confluence-content.mts": "export const x = 1;",
  });
  const delivery = inspect("/tools", read, exists);
  assert.equal(delivery.absent, false);
  assert.deepEqual(delivery.missing, ["confluence-runtime-label.mts"]);
  const line = message(delivery, false);
  assert.match(line, /incomplete/);
  assert.match(line, /confluence-runtime-label\.mts/);
  assert.doesNotMatch(line, /not installed/, "partial and absent must not read the same");
});

test("delivery lists use UTF-16 order independently of import traversal order", () => {
  const present = ["z.mts", "a.mts", "A.mts"];
  const missing = ["y.mts", "b.mts", "B.mts"];
  const files = { [ENTRY]: imports(...present, ...missing, "a.mts"),
    ...Object.fromEntries(present.map(name => [name, "export const x = 1;"])) };
  const { read, exists } = fixture(files);
  assert.deepEqual(inspect("/tools", read, exists), {
    present: [ENTRY, ...present].sort(), missing: [...missing].sort(), absent: false,
  });
});

test("a count would have passed where the graph does not", () => {
  // Nine files present, one import unmet. This is exactly the shape that a
  // check counting to nine would have waved through.
  const files: Record<string, string> = { [ENTRY]: imports("m1.mts", "missing.mts") };
  for (let i = 1; i <= 8; i += 1) files[`m${i}.mts`] = i < 8 ? imports(`m${i + 1}.mts`) : "export const x = 1;";
  const delivery = inspect("/tools", fixture(files).read, fixture(files).exists);
  assert.equal(delivery.present.length, 9);
  assert.deepEqual(delivery.missing, ["missing.mts"]);
});

test("an unreadable file counts as present rather than as missing", () => {
  const exists = (): boolean => true;
  const read = (): string => { throw new Error("EACCES"); };
  const delivery = inspect("/tools", read, exists);
  assert.deepEqual(delivery.missing, [], "a failed read is not proof of absence");
  assert.deepEqual(delivery.present, [ENTRY]);
});

test("a bare or absolute specifier is not treated as a delivered file", () => {
  const { read, exists } = fixture({
    [ENTRY]: ['import fs from "node:fs";', 'import x from "/abs/other.mts";', imports("ok.mts")].join("\n"),
    "ok.mts": "export const y = 1;",
  });
  const delivery = inspect("/tools", read, exists);
  assert.deepEqual(delivery.present, [ENTRY, "ok.mts"].sort());
  assert.deepEqual(delivery.missing, []);
});

test("the complete message is announced once and then stays silent", () => {
  const delivery = { present: [ENTRY], missing: [], absent: false };
  assert.match(message(delivery, false), /adapter import closure is installed/);
  assert.equal(message(delivery, true), "", "the state changes once; so does the announcement");
});

test("the complete message keeps native and live publication status UNKNOWN", () => {
  const line = message({ present: [ENTRY], missing: [], absent: false }, false);
  assert.match(line, /Native MCP discovery/);
  assert.match(line, /UNKNOWN/);
});

test("scope follows the configured workspace", () => {
  const env = { KHEREP_WORKSPACE: "D:/CFcon-DEV" } as NodeJS.ProcessEnv;
  assert.equal(isKherepScope({ cwd: "D:/CFcon-DEV/kherep" }, env), true);
  assert.equal(isKherepScope({ cwd: "D:/elsewhere" }, env), false);
  assert.equal(isKherepScope({}, env), false);
});

test("the paths it uses follow the configured workspace and CODEX_HOME", () => {
  const env = { KHEREP_WORKSPACE: "D:/CFcon-DEV", CODEX_HOME: "D:/home/.codex" } as NodeJS.ProcessEnv;
  assert.equal(toolsDir(env).replace(/\\/g, "/"), "D:/CFcon-DEV/tools");
  assert.equal(statePath(env).replace(/\\/g, "/"), "D:/home/.codex/orchestra/confluence-delivery.json");
});
