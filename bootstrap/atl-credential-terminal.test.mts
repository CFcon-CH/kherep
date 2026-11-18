// Issue #965. The interactive half of bootstrap/atl-credential.mts, which
// atl-credential-verdict.test.mts could only pin structurally: with the
// terminal preload the step takes its terminal branch, reads each answer from
// fd 0 and is driven prompt by prompt. Every run ends with raw mode off again,
// also where the step exits early. Stub broker, synthetic values, temp tree.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { converse, credentialTree, type CredentialTree } from "./atl-credential-tree-fixture.mts";

const ID = "Atlassian service-account client id: ";
const SECRET = "Atlassian service-account client secret (not echoed): ";
const QUESTION = "Capture new values anyway? [y/N]: ";

function seed(tree: CredentialTree, text: string): Buffer {
  fs.mkdirSync(path.dirname(tree.target), { recursive: true });
  fs.writeFileSync(tree.target, text, { mode: 0o600 });
  return fs.readFileSync(tree.target);
}

const backups = (tree: CredentialTree): string[] => {
  const dir = path.join(path.dirname(tree.target), "_deprecated");
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => path.join(dir, name)) : [];
};

test("a host without a file captures both values, writes them and verifies them", async (t) => {
  const tree = credentialTree(t);
  const run = await converse(tree, [[ID, "synthetic-id\n"], [SECRET, "good-secret\r"]]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(tree.target, "utf8"), "client_id: synthetic-id\nclient_secret: good-secret\n");
  if (process.platform !== "win32") assert.equal(fs.statSync(tree.target).mode & 0o777, 0o600);
  assert.match(run.stdout, /KHEREP_ATL_CRED_FILE_CLAUDE written and verified, \d+ bytes \(client id 12 chars, client secret 11 chars\)/);
  assert.match(run.stdout, /KHEREP_ATL_CRED_FILE_CLAUDE is not set in this environment\. Bind it to /);
  assert.doesNotMatch(run.stdout + run.stderr, /good-secret/);
  assert.deepEqual(run.rawModes, [true, false]);
  assert.deepEqual(backups(tree), []);
});

test("a file proven wrong is replaced only by values that verify, otherwise restored from its backup", async (t) => {
  const tree = credentialTree(t);
  const before = seed(tree, "client_id: old\nclient_secret: wrong\n");
  const run = await converse(tree, [[ID, "synthetic-id\n"], [SECRET, "still-wrong\n"]]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /did not verify \(verdict FAIL\); capturing new values\./);
  assert.match(run.stderr, /FATAL: The credential at .* did not verify: broker verdict FAIL, exit 1\. The previous file was restored from /);
  assert.deepEqual(fs.readFileSync(tree.target), before, "the original file is back");
  const [backup] = backups(tree);
  assert.deepEqual(fs.readFileSync(backup), before, "and its backup stays parked");
});

test("captured values that fail on a host without a file overwrite nothing", async (t) => {
  const tree = credentialTree(t);
  const run = await converse(tree, [[ID, "synthetic-id\n"], [SECRET, "wrong\n"]]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /did not verify: broker verdict FAIL, exit 1\. Nothing was overwritten\.$/m);
  assert.deepEqual(backups(tree), []);
});

test("an unproven file is kept when the operator answers no", async (t) => {
  const tree = credentialTree(t);
  const before = seed(tree, "client_id: old\nclient_secret: unknown\n");
  const run = await converse(tree, [[QUESTION, "n\n"]]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /could not be verified \(broker verdict UNKNOWN\)/);
  assert.match(run.stderr, /FATAL: Nothing was captured: .* was left untouched on your answer/);
  assert.doesNotMatch(run.stdout, /client id: /);
  assert.deepEqual(fs.readFileSync(tree.target), before);
  assert.deepEqual(backups(tree), []);
});

test("an unproven file is backed up and replaced when the operator answers yes", async (t) => {
  const tree = credentialTree(t);
  const before = seed(tree, "client_id: old\nclient_secret: unknown\n");
  const run = await converse(tree, [[QUESTION, "yes\n"], [ID, "synthetic-id\n"], [SECRET, "good\x7fd-secret\n"]]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(tree.target, "utf8"), "client_id: synthetic-id\nclient_secret: good-secret\n");
  const [backup] = backups(tree);
  assert.deepEqual(fs.readFileSync(backup), before);
  assert.match(run.stdout, new RegExp(`previous file copied to ${backup.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("an empty client id ends the run before the secret is asked", async (t) => {
  const tree = credentialTree(t);
  const run = await converse(tree, [[ID, "   \n"]]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^FATAL: No client id given\.$/m);
  assert.doesNotMatch(run.stdout, /client secret/);
  assert.equal(fs.existsSync(tree.target), false);
});

test("an interrupt while the secret is typed ends the run with raw mode switched off", async (t) => {
  const tree = credentialTree(t);
  const run = await converse(tree, [[ID, "synthetic-id\n"], [SECRET, "partial\x03"]]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^FATAL: Reading the client secret was interrupted\.$/m);
  assert.deepEqual(run.rawModes, [true, false]);
  assert.equal(fs.existsSync(tree.target), false);
});

test("a terminal that cannot be read fails on the client id and counts as no on the question", async (t) => {
  const tree = credentialTree(t);
  const sink = path.join(tree.root, "write-only");
  const descriptor = fs.openSync(sink, "w");
  t.after(() => fs.closeSync(descriptor));
  const fresh = await converse(tree, [], descriptor);
  assert.equal(fresh.status, 1);
  assert.match(fresh.stderr, /^FATAL: Could not read the client id from the terminal\.$/m);
  assert.equal(fs.existsSync(tree.target), false);

  const before = seed(tree, "client_id: old\nclient_secret: unknown\n");
  const unproven = await converse(tree, [], descriptor);
  assert.equal(unproven.status, 1);
  assert.match(unproven.stderr, /FATAL: Nothing was captured/);
  assert.deepEqual(fs.readFileSync(tree.target), before);
});
