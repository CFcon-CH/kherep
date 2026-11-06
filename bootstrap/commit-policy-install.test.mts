// OP-1426. The real install.sh and drift-check.sh against throwaway homes: the
// commit-policy file lands next to the hook inside the transaction, carries the
// install-time values, is backed up when it changes, survives a later install
// without the variables, refuses an invalid value before any mutation and takes
// part in drift detection.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";

import { parsePolicy } from "./commit-policy.mts";

const HERE = import.meta.dirname;
// Git Bash wants /c/... on Windows; install.sh refuses a drive-letter path.
const slash = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);

interface Fixture { root: string; home: string; claude: string; ws: string; creds: string; policy: string }

function fixture(t: { after: (fn: () => void) => void }): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-op1426-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claude = path.join(root, "home", ".claude");
  const f = { root, home: path.join(root, "home"), claude, ws: path.join(root, "workspace"),
    creds: path.join(root, "credentials"), policy: path.join(claude, "kherep", "githooks", "commit-policy") };
  for (const dir of [f.claude, path.join(f.ws, ".claude"), f.creds]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(f.claude, "settings.json"), "{}\n");
  fs.writeFileSync(path.join(f.ws, ".claude", "settings.local.json"), "{}\n");
  return f;
}

function run(script: string, f: Fixture, extra: Record<string, string> = {}): { status: number | null; out: string } {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KHEREP_")));
  const env = { ...base, HOME: slash(f.home), CLAUDE_HOME: slash(f.claude), KHEREP_PROFILE: "win",
    KHEREP_WORKSPACE: slash(f.ws), KHEREP_CREDENTIALS_ROOT: slash(f.creds), KHEREP_INSTALL_SKIP_GITCONFIG: "1",
    KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE: "1", KHEREP_INSTALL_SKIP_ATL_CREDENTIAL: "1", SKIP_SECRETS: "1",
    SKIP_DEPS: "1", ...extra };
  const result = spawnSync("bash", [slash(path.join(HERE, script))], { encoding: "utf8", env, timeout: 240_000 });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

const backups = (f: Fixture): string[] => {
  const dir = path.join(f.claude, "backups", "bootstrap");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith("install-")).sort() : [];
};
const backupPolicy = (f: Fixture, name: string): string =>
  path.join(f.claude, "backups", "bootstrap", name, "kherep", "githooks", "commit-policy");

test("install writes the policy, backs up a change, keeps values and joins drift-check", (t) => {
  const f = fixture(t);
  const snapshot = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "coauthor-ban-predecessor.json"), "utf8"));
  const predecessor = snapshot.files["claude/kherep/githooks/commit-msg"] as { text: string; sha256: string };
  assert.equal(createHash("sha256").update(predecessor.text).digest("hex"), predecessor.sha256);
  const hook = path.join(f.claude, "kherep", "githooks", "commit-msg");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, predecessor.text);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: f.ws }).status, 0);
  const message = path.join(f.root, "message.txt");
  fs.writeFileSync(message, "Allow attribution\n\nCo-authored-by: Example <dev@example.com>\n");
  const hookEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KHEREP_")));
  const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: f.ws, env: hookEnv, encoding: "utf8" });
  assert.equal(toplevel.status, 0, toplevel.stderr);
  const checkHook = (required: string) => spawnSync("sh", [slash(hook), slash(message)], {
    cwd: f.ws, env: { ...hookEnv, HOME: slash(f.home), KHEREP_WORKSPACE: toplevel.stdout.trim(), KHEREP_WORK_ITEM_REQUIRED: required }, encoding: "utf8",
  });
  assert.equal(checkHook("0").status, 1, "exact predecessor denies attribution even without a required key");
  const first = run("install.sh", f, { KHEREP_WORK_ITEM_REQUIRED: "1", KHEREP_WORK_ITEM_PATTERN: "OP-[0-9]+" });
  assert.equal(first.status, 0, first.out);
  assert.deepEqual(fs.readFileSync(hook), fs.readFileSync(path.join(HERE, "..", "claude", "kherep", "githooks", "commit-msg")));
  const firstBackup = backups(f).at(-1)!;
  assert.equal(fs.readFileSync(path.join(f.claude, "backups", "bootstrap", firstBackup, "kherep", "githooks", "commit-msg"), "utf8"), predecessor.text);
  assert.equal(checkHook("0").status, 0, "installed hook accepts attribution");
  assert.equal(checkHook("1").status, 1, "missing key remains denied");
  const written = fs.readFileSync(f.policy, "utf8");
  assert.ok(!written.includes("\r"), "policy file must be LF only");
  assert.ok(written.includes(`\nworkspace=${fs.realpathSync(f.ws).replace(/\\/g, "/")}\n`), written);
  assert.deepEqual(parsePolicy(written), { required: "1", pattern: "OP-[0-9]+" });
  assert.match(first.out, /commit policy -> work_item_required=1/);

  // No KHEREP_WORK_ITEM_* at all: drift sees no change and a reinstall keeps enforcement on.
  const drift = run("drift-check.sh", f);
  assert.equal(drift.status, 0, drift.out);
  assert.match(drift.out, /ok +kherep\/githooks\/commit-policy/);
  const again = run("install.sh", f);
  assert.equal(again.status, 0, again.out);
  assert.equal(fs.readFileSync(f.policy, "utf8"), written, "install without variables changed the policy");
  assert.ok(!fs.existsSync(backupPolicy(f, backups(f).at(-1) ?? "")), "unchanged policy was swapped");

  // Turning enforcement off is an explicit value and parks the previous file.
  const off = run("install.sh", f, { KHEREP_WORK_ITEM_REQUIRED: "0" });
  assert.equal(off.status, 0, off.out);
  assert.deepEqual(parsePolicy(fs.readFileSync(f.policy, "utf8")), { required: "0", pattern: "OP-[0-9]+" });
  assert.equal(fs.readFileSync(backupPolicy(f, backups(f).at(-1) ?? ""), "utf8"), written);

  fs.appendFileSync(f.policy, "work_item_required=1\n");
  const drifted = run("drift-check.sh", f);
  assert.equal(drifted.status, 1, drifted.out);
  assert.match(drifted.out, /DRIFT +kherep\/githooks\/commit-policy/);
});

test("an invalid required value is refused before the first live mutation", (t) => {
  const f = fixture(t);
  const result = run("install.sh", f, { KHEREP_WORK_ITEM_REQUIRED: "yes" });
  assert.notEqual(result.status, 0, result.out);
  assert.match(result.out, /KHEREP_WORK_ITEM_REQUIRED must be 0 or 1/);
  assert.ok(!fs.existsSync(f.policy), "policy written despite the refusal");
  assert.deepEqual(backups(f), [], "a refused install created a transaction");
});

test("a fresh install without variables keeps the product opt-in", (t) => {
  const f = fixture(t);
  const result = run("install.sh", f);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(parsePolicy(fs.readFileSync(f.policy, "utf8")), { required: "0" });
});
