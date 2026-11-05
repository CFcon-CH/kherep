import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { withoutTypeStrippingWarning } from "../lib/node-warning-fixture.mts";
import { declareCopy } from "../../bootstrap/coverage-copy-fixture.mts";

const CATALOG = { complete: true, models: [{ id: "gpt-6-sol", model: "gpt-6-sol", hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: "high" }],
}] };

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "kherep-catalog-entry-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const script = path.join(root, "scripts", "model-catalog.mts");
  const reader = path.join(root, "lib", "model-catalog-process.mts");
  const marker = path.join(root, "reader-calls.txt");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.mkdirSync(path.dirname(reader));
  fs.copyFileSync(new URL("./model-catalog.mts", import.meta.url), script);
  declareCopy(path.join(import.meta.dirname, "model-catalog.mts"), script);
  fs.writeFileSync(reader, `import fs from "node:fs";
export async function readAvailableModels() {
  fs.appendFileSync(${JSON.stringify(marker)}, "called\\n");
  return ${JSON.stringify(CATALOG)};
}
`);
  const run = (entry: string) => {
    const result = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(withoutTypeStrippingWarning(result.stderr, 1), "");
    return result.stdout;
  };
  return { root, script, marker, run };
}

test("normal model-catalog CLI invocation emits the offline reader's catalog once", (t) => {
  const f = fixture(t);
  const stdout = f.run(f.script);
  assert.deepEqual(JSON.parse(stdout), CATALOG);
  assert.equal(stdout, `${JSON.stringify(CATALOG)}\n`);
  assert.equal(fs.readFileSync(f.marker, "utf8"), "called\n");
});

test("a symlink main invocation emits the same catalog as the direct CLI path", (t) => {
  const f = fixture(t);
  const alias = path.join(f.root, "catalog-alias.mts");
  try { fs.symlinkSync(f.script, alias, "file"); }
  catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Windows does not permit this test user to create a file symlink");
      return;
    }
    throw error;
  }
  const direct = f.run(f.script);
  const linked = f.run(alias);
  assert.equal(linked, direct);
  assert.deepEqual(JSON.parse(linked), CATALOG);
  assert.equal(fs.readFileSync(f.marker, "utf8"), "called\ncalled\n");
});

test("importing model-catalog as a module never starts the reader", (t) => {
  const f = fixture(t);
  const importer = path.join(f.root, "import-only.mts");
  fs.writeFileSync(importer, `await import(${JSON.stringify(pathToFileURL(f.script).href)});\nprocess.stdout.write("imported\\n");\n`);
  assert.equal(f.run(importer), "imported\n");
  assert.equal(fs.existsSync(f.marker), false);
});
