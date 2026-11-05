import fs from "node:fs";
import path from "node:path";

import { withCompilerEmission, type CompilerLimits } from "./typescript-output-compiler.mts";

export type { CompilerLimits } from "./typescript-output-compiler.mts";

const JAVASCRIPT = /\.(?:js|mjs|cjs)$/;

function fail(message: string): never {
  throw new Error(`Compiled output proof: ${message}`);
}

interface OutputTree {
  present: boolean;
  files: Map<string, Buffer>;
}

function outputTree(root: string): OutputTree {
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false, files: new Map() };
    return fail("output root is unreadable");
  }
  if (rootStat.isSymbolicLink()) return fail("output root is a link");
  if (!rootStat.isDirectory()) return fail("output root is not a directory");
  const found = new Map<string, Buffer>();

  function visit(directory: string, relative: string): void {
    let names: string[];
    try {
      names = fs.readdirSync(directory).sort();
    } catch {
      return fail(`output directory is unreadable: ${relative || "."}`);
    }
    for (const name of names) {
      const absolute = path.join(directory, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absolute);
      } catch {
        return fail(`output descendant is unreadable: ${childRelative}`);
      }
      if (stat.isSymbolicLink()) return fail(`output descendant is a link: ${childRelative}`);
      if (stat.isDirectory()) visit(absolute, childRelative);
      else if (stat.isFile()) {
        if (JAVASCRIPT.test(name)) found.set(childRelative, fs.readFileSync(absolute));
      } else return fail(`output descendant is non-regular: ${childRelative}`);
    }
  }

  visit(root, "");
  return { present: true, files: found };
}

function compare(actual: Map<string, Buffer>, expected: Map<string, Buffer>): void {
  for (const relative of [...expected.keys()].sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  })) {
    const bytes = actual.get(relative);
    if (!bytes) return fail(`missing generated output: ${relative}`);
    if (!bytes.equals(expected.get(relative)!)) return fail(`altered generated output: ${relative}`);
  }
  for (const relative of [...actual.keys()].sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  })) {
    if (!expected.has(relative)) return fail(`unexpected generated output: ${relative}`);
  }
}

// modulePath names a package whose dist/ tree is compiler output, relative to
// the repository root. Only byte- and path-identical output is returned.
export function verifyCompiledOutput(
  repo: string, modulePath: readonly string[], limits: CompilerLimits = {},
): Set<string> {
  const moduleRoot = path.join(repo, ...modulePath);
  const outputRoot = path.join(moduleRoot, "dist");
  const actual = outputTree(outputRoot);
  if (!actual.present) return new Set();
  const expected = withCompilerEmission(moduleRoot, limits, (emittedRoot) => outputTree(emittedRoot).files);
  compare(actual.files, expected);
  return new Set([...actual.files.keys()].map((relative) => path.posix.join(...modulePath, "dist", relative)));
}
