// Issue #833. module-label-guard as a process, against a synthetic repository.
// It only judges: no command here is run, and no gh is involved.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const hook = path.join(import.meta.dirname, "module-label-guard.mts");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-module-label-guard-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function repository(name: string, rule?: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, ".github"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git"), "gitdir: /elsewhere\n");
  if (rule !== undefined) fs.writeFileSync(path.join(dir, ".github", "module-labels.json"), rule);
  return dir;
}
const labelled = repository("labelled", JSON.stringify({ version: 1, repository: "example/project", labels: ["cp:intercom", "bootstrap"] }));

function run(input: unknown): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [hook], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}
const shell = (command: string, cwd = labelled, tool = "Bash") => run({ tool_name: tool, tool_input: { command }, cwd });

for (const tool of ["Bash", "PowerShell"]) {
  test(`${tool}: no label blocks, naming the rule, the file and the marker`, () => {
    const { status, stderr } = shell("gh issue create -t x -b y", labelled, tool);
    assert.equal(status, 2);
    assert.match(stderr, /^module-label-guard blocked this command:/);
    assert.match(stderr, /CONTRIBUTING\.md/);
    assert.match(stderr, /module-labels\.json/);
    assert.match(stderr, /KHEREP_MODULE_LABEL=none/);
    assert.match(stderr, /--web/);
  });
  test(`${tool}: a module label passes, an extra label does not`, () => {
    assert.equal(shell("gh issue create -t x --label cp:intercom", labelled, tool).status, 0);
    assert.equal(shell("gh pr create --fill -lbootstrap", labelled, tool).status, 0);
    assert.equal(shell("gh issue create -t x --label bug", labelled, tool).status, 2);
  });
}

test("no rule file passes: a user's own repository is never refused", () => {
  assert.equal(shell("gh issue create -t x", repository("own")).status, 0);
  assert.equal(shell("gh issue create -t x", root).status, 0);
});

test("an invalid rule file blocks even a labelled command, naming the file", () => {
  const { status, stderr } = shell("gh issue create -t x --label cp:intercom", repository("broken", "{"));
  assert.equal(status, 2);
  assert.match(stderr, /module-labels\.json/);
  assert.match(stderr, /JSON/);
});

test("--web, --help, the marker and another repository pass", () => {
  for (const command of ["gh issue create --web", "gh pr create --help", "KHEREP_MODULE_LABEL=none gh issue create -t x",
    "$env:KHEREP_MODULE_LABEL='none'; gh issue create -t x", "gh issue create -t x -R other/repo"]) {
    const { status, stderr } = shell(command);
    assert.equal(status, 0, `${command}: ${stderr}`);
  }
});

test("the marker is never read from the environment", () => {
  const result = spawnSync(process.execPath, [hook], { encoding: "utf8", env: { ...process.env, KHEREP_MODULE_LABEL: "none" },
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh issue create -t x" }, cwd: labelled }) });
  assert.equal(result.status, 2);
});

test("the segment's directory decides, not the session's", () => {
  assert.equal(shell(`cd "${labelled}" && gh issue create -t x`, root).status, 2);
  assert.equal(shell(`cd "${root}" && gh issue create -t x`).status, 0);
});

test("a message, an echo and other tools are data", () => {
  for (const command of ['git commit -m "gh pr create"', "echo gh issue create"]) assert.equal(shell(command).status, 0, command);
  assert.equal(run({ tool_name: "Read", tool_input: { command: "gh issue create" }, cwd: labelled }).status, 0);
});

test("the other spellings of the create form are judged the same", () => {
  for (const command of ["gh issue new -t x", "gh pr new --fill", "gh -R example/project issue create", "gh issue -R example/project create",
    "env gh issue create", "command gh pr create --fill", "GH_REPO=example/project gh issue create", "env GH_REPO=EXAMPLE/project gh pr new"]) {
    assert.equal(shell(command).status, 2, command);
    assert.equal(shell(`${command} --label cp:intercom`).status, 0, `${command} with a label`);
  }
});

test("a visible GH_REPO for another repository passes like -R", () => {
  for (const command of ["GH_REPO=other/repo gh issue create", "env GH_REPO=other/repo gh issue new", "gh -R other/repo pr new"]) {
    const { status, stderr } = shell(command);
    assert.equal(status, 0, `${command}: ${stderr}`);
  }
});

test("the deny text says a GH_REPO set elsewhere is not visible, next to the marker", () => {
  const { status, stderr } = shell("export GH_REPO=other/repo; gh issue create -t x");
  assert.equal(status, 2);
  assert.match(stderr, /GH_REPO[^\n]*KHEREP_MODULE_LABEL=none/);
});

test("other gh commands and git messages stay unaffected", () => {
  for (const command of ["gh issue list -R x", "gh pr view 1", 'git commit -m "gh issue new"', "command -v gh"]) {
    const { status, stderr } = shell(command);
    assert.equal(status, 0, `${command}: ${stderr}`);
  }
});

test("an empty or malformed payload passes", () => {
  assert.equal(run({}).status, 0);
  assert.equal(run("not json").status, 0);
  assert.equal(run({ tool_name: "Bash", tool_input: {} }).status, 0);
});
