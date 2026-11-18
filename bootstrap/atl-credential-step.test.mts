// Issue #965. The unattended outcomes of bootstrap/atl-credential.mts against a
// stub broker: a verified file is kept, with the binding hint only where no
// variable named it; a missing broker and a broker ended by a signal are named;
// and backUp refuses a backup that is the file itself or a copy that fails.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { credentialTree, runStep, type CredentialTree } from "./atl-credential-tree-fixture.mts";

function seed(tree: CredentialTree, text: string): Buffer {
  fs.mkdirSync(path.dirname(tree.target), { recursive: true });
  fs.writeFileSync(tree.target, text, { mode: 0o600 });
  return fs.readFileSync(tree.target);
}

test("a verified file named only by --out is kept, with a hint to bind the variable", (t) => {
  const tree = credentialTree(t);
  const before = seed(tree, "client_id: id\nclient_secret: good\n");
  const run = runStep(tree, ["--out", tree.target]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`^atl credential: KHEREP_ATL_CRED_FILE_CLAUDE verified unchanged, ${before.length} bytes -> `, "m"));
  assert.match(run.stdout, /^atl credential: KHEREP_ATL_CRED_FILE_CLAUDE is not set in this environment\. Bind it to /m);
  assert.deepEqual(fs.readFileSync(tree.target), before);
  assert.equal(fs.existsSync(path.join(path.dirname(tree.target), "_deprecated")), false);
});

test("a verified file named by the variable is kept without a hint and --out is never written", (t) => {
  const tree = credentialTree(t);
  seed(tree, "client_id: id\nclient_secret: good\n");
  const other = path.join(tree.root, "unused", "cred.txt");
  const run = runStep(tree, ["--out", other], { env: { KHEREP_ATL_CRED_FILE_CLAUDE: tree.target } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /verified unchanged/);
  assert.doesNotMatch(run.stdout, /Bind it to/);
  assert.equal(fs.existsSync(other), false);
});

test("a tree without the broker refuses before it looks at any file", (t) => {
  const tree = credentialTree(t, { broker: false });
  const run = runStep(tree, ["--out", tree.target]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^FATAL: Jira broker not found at .*atl-jira-ccoder\.mts\.$/m);
});

test("a broker ended by a signal proves nothing and changes nothing", (t) => {
  const tree = credentialTree(t);
  const before = seed(tree, "client_id: id\nclient_secret: killed\n");
  const run = runStep(tree, ["--out", tree.target]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /names no verified credential file \(.*: verdict NO-VERDICT\)\. That verdict does not say the file is wrong/);
  assert.deepEqual(fs.readFileSync(tree.target), before);
});

test("a broker stopped on its own configuration is named and nothing is asked", (t) => {
  const tree = credentialTree(t);
  const before = seed(tree, "client_id: id\nclient_secret: misconfigured\n");
  const run = runStep(tree, ["--out", tree.target]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /The broker could not run its check: KHEREP_ATL_SITE is not set for this test\./);
  assert.deepEqual(fs.readFileSync(tree.target), before);
});

// backUp ends its process on a refusal, so it runs in a child of its own.
function backUp(tree: CredentialTree, target: string, backup: string) {
  const code = `import { backUp } from ${JSON.stringify(pathToFileURL(tree.step).href)}; backUp(process.argv[1], process.argv[2]);`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code, target, backup], { encoding: "utf8", timeout: 30_000 });
}

test("backUp refuses a backup path that resolves to the file itself", (t) => {
  const tree = credentialTree(t);
  const before = seed(tree, "client_id: id\nclient_secret: good\n");
  const same = path.join(path.dirname(tree.target), ".", path.basename(tree.target));
  const run = backUp(tree, tree.target, same);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^FATAL: Refusing to run: the backup path resolves to the file itself/m);
  assert.deepEqual(fs.readFileSync(tree.target), before);
});

test("backUp names the error code when the copy fails for another reason than an existing backup", (t) => {
  const tree = credentialTree(t);
  const absent = path.join(tree.root, "absent.txt");
  const backup = path.join(tree.root, "_deprecated", "absent.txt.pre-x");
  const run = backUp(tree, absent, backup);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^FATAL: Could not copy .*absent\.txt to .* \(ENOENT\); .*absent\.txt was not changed\.$/m);
  assert.equal(fs.existsSync(backup), false);
});
