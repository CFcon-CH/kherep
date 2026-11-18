// Copies of claude/hooks and claude/kherep sources that the suites run from temporary
// homes (issue #965). Each non-test .mts copy is declared byte-unchanged with
// declareCopy, so the coverage a copy earns credits its original (issue #964).
// A copy that a suite alters afterwards must stay undeclared: name it in `edited`,
// relative to the copied directory, or copy it with plain fs.
import fs from "node:fs";
import path from "node:path";

import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";

const declarable = (file: string): boolean => file.endsWith(".mts") && !file.endsWith(".test.mts");

// One file, its directory created; declared when it is non-test .mts source.
export function copyDeclared(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  if (declarable(source)) declareCopy(source, target);
}

// A directory tree; every non-test .mts regular file declared except the `edited` ones (slash-separated).
export function copyTreeDeclared(sourceDir: string, targetDir: string, edited: readonly string[] = []): void {
  fs.cpSync(sourceDir, targetDir, { recursive: true });
  for (const rel of fs.readdirSync(sourceDir, { recursive: true, encoding: "utf8" })) {
    const source = path.join(sourceDir, rel);
    if (declarable(rel) && !edited.includes(rel.split(path.sep).join("/")) && fs.lstatSync(source).isFile()) {
      declareCopy(source, path.join(targetDir, rel));
    }
  }
}
