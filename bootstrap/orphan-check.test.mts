// Issue #13. Every Claude install writes `broker` into confluence.json and the
// space keys only once the space step resolved, so a file with `broker` alone
// is a host without a knowledge space: the check skips it. Only a file it
// cannot read is a check that could not run (exit 2), never a silent skip.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { toBashPath } from "./render-profile-paths.mts";

const SCRIPT = path.join(import.meta.dirname, "orphan-check.sh").replace(/\\/g, "/");

function check(home: string): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_HOME: toBashPath(home) };
  delete env.KHEREP_PROFILE;
  return spawnSync("bash", [SCRIPT], { encoding: "utf8", env });
}

test("a broker-only file skips the check, an unreadable file cannot run it", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-orphan-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "kherep"));
  const config = path.join(home, "kherep", "confluence.json");

  fs.writeFileSync(config, JSON.stringify({ broker: "node /w/tools/atl-confluence-ccoder.mts" }));
  const skipped = check(home);
  assert.equal(skipped.status, 0, `${skipped.stdout}${skipped.stderr}`);
  assert.match(String(skipped.stdout), /^SKIP: no knowledge space configured on this host$/m);

  fs.writeFileSync(config, "not json");
  const failed = check(home);
  assert.equal(failed.status, 2, `${failed.stdout}${failed.stderr}`);
  assert.match(String(failed.stdout), /^FATAL: .*confluence\.json could not be read$/m);
});

test("only a measured count of zero reads as a clean space", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-orphan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bootstrap = path.join(root, "bootstrap");
  const brokers = path.join(root, "modules", "atl-jira-brokers");
  fs.mkdirSync(bootstrap);
  fs.mkdirSync(brokers, { recursive: true });
  for (const file of ["orphan-check.sh", "profile.sh"]) {
    fs.copyFileSync(path.join(import.meta.dirname, file), path.join(bootstrap, file));
  }
  fs.writeFileSync(path.join(brokers, "atl-confluence-ccoder.mts"), 'console.log(`count: ${process.env.STUB_COUNT}`);\n');
  fs.mkdirSync(path.join(root, "kherep"));
  fs.writeFileSync(path.join(root, "kherep", "confluence.json"), JSON.stringify({ spaceKey: "EXAMPLE" }));

  for (const [count, expected] of [["0", 0], ["3", 1], ["not-a-number", 1]] as const) {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_HOME: toBashPath(root), STUB_COUNT: count };
    delete env.KHEREP_PROFILE;
    const script = path.join(bootstrap, "orphan-check.sh").replace(/\\/g, "/");
    const run = spawnSync("bash", [script], { encoding: "utf8", env });
    assert.equal(run.status, expected, `count ${count}: ${run.stdout}${run.stderr}`);
  }
});
