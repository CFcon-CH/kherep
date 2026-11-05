import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { containedFile } from "./coverage-paths.mts";
import { copyDeclarationsFile } from "./coverage-copies.mts";

/** Declare only unchanged copies. A test that edits its copy after this check must not declare it. */
export function declareCopy(original: string, copy: string): void {
  const bytes = readFileSync(original);
  if (!bytes.equals(readFileSync(copy))) throw new Error("copy bytes differ from original");
  const directory = process.env.NODE_V8_COVERAGE;
  if (!directory) return;
  const root = realpathSync(resolve(import.meta.dirname, ".."));
  const source = containedFile(root, original);
  const declaration = {
    copyUrl: pathToFileURL(realpathSync(copy)).href,
    original: relative(root, source).split(sep).join("/"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  mkdirSync(directory, { recursive: true });
  appendFileSync(join(directory, copyDeclarationsFile), JSON.stringify(declaration) + "\n");
}
