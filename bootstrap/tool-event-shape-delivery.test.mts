import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Match the install fixtures: Git Bash needs /c/... rather than native drive paths.
const slash = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);

test("isolated Claude preview installs helper and wired chain and preserves operator files", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shape-delivery-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), candidate = path.join(root, "candidate"), workspace = path.join(root, "workspace");
  for (const dir of [home, candidate, workspace]) fs.mkdirSync(dir);
  const gitconfig = path.join(root, "gitconfig");
  const operator = "[user]\n\tname = Synthetic\n";
  fs.writeFileSync(gitconfig, operator);
  const env = { PATH: process.env.PATH, HOME: slash(home), CLAUDE_HOME: slash(candidate), KHEREP_WORKSPACE: slash(workspace),
    KHEREP_CREDENTIALS_ROOT: slash(path.join(root, "integration-config")), KHEREP_INSTALL_PREVIEW: "1",
    KHEREP_PROFILE: process.platform === "win32" ? "win" : "mac", SKIP_SECRETS: "1", SKIP_DEPS: "1", GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_SYSTEM: path.join(root, "system-gitconfig") };
  const install = () => spawnSync("bash", [slash(path.join(import.meta.dirname, "install.sh"))], { env, encoding: "utf8", timeout: 300_000 });
  const first = install();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const helper = path.join(candidate, "hooks/lib/tool-event-shape.mts");
  assert.deepEqual(fs.readFileSync(helper), fs.readFileSync(path.resolve(import.meta.dirname, "../claude/hooks/lib/tool-event-shape.mts")));
  assert.deepEqual(fs.readFileSync(path.join(candidate, "hooks/lib/tool-event-contract.mts")),
    fs.readFileSync(path.resolve(import.meta.dirname, "../claude/hooks/lib/tool-event-contract.mts")));
  const settings = fs.readFileSync(path.join(candidate, "settings.json"));
  const json = JSON.parse(settings.toString());
  const pre = json.hooks.PreToolUse.find((group: { matcher?: string }) => group.matcher === "Bash");
  assert.ok(pre);
  const command = pre.hooks.find((hook: { command: string }) => hook.command.includes("guard-dispatch.mts")).command;
  const r = spawnSync("bash", ["-c", command], { input: "{}", encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(doc.permissionDecision, undefined);
  for (const guard of ["commit-guard", "deploy-guard"]) assert.ok(doc.additionalContext.includes(`WARN:${guard}:TOOL_NAME_MISSING`));
  const again = install();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(fs.readFileSync(path.join(candidate, "settings.json")), settings);
  assert.equal(fs.readFileSync(gitconfig, "utf8"), operator);
});
