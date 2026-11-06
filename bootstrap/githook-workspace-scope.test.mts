// Issue #816. Git Bash's /tmp mount and drive paths must compare alike.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

const hooks = path.resolve(import.meta.dirname, "..", "claude", "kherep", "githooks");
const names = ["commit-msg", "post-checkout", "pre-push"] as const;
const slash = (value: string): string => value.replace(/\\/g, "/");
const unixDrive = (value: string): string => slash(value)
  .replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);

function fixture(t: TestContext, location = "workspace") {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "kherep-hook-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const repo = path.join(root, location);
  const noHooks = path.join(root, "no-hooks");
  for (const dir of [home, workspace, repo, noHooks]) fs.mkdirSync(dir, { recursive: true });
  const globalConfig = path.join(home, "gitconfig");
  fs.writeFileSync(globalConfig, "");
  const base = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(KHEREP_|GIT_)/i.test(key)));
  const env: NodeJS.ProcessEnv = { ...base, HOME: unixDrive(home), USERPROFILE: home,
    XDG_CONFIG_HOME: slash(home), GIT_CONFIG_GLOBAL: slash(globalConfig), GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: slash(noHooks) };
  const init = spawnSync("git", ["init", "-q"], { cwd: repo, env, encoding: "utf8", timeout: 15_000 });
  assert.equal(init.status, 0, init.stderr);
  const message = path.join(root, "message.txt");
  fs.writeFileSync(message, "Subject without a key\n");
  return { root, workspace, repo, message, env };
}

function run(f: ReturnType<typeof fixture>, name: typeof names[number], workspace: string) {
  const args = name === "commit-msg" ? [slash(f.message)] : name === "post-checkout"
    ? ["1".repeat(40), "2".repeat(40), "1"] : ["origin", "https://example.com/synthetic/repo.git"];
  const result = spawnSync("sh", [slash(path.join(hooks, name)), ...args], {
    cwd: f.repo, env: { ...f.env, KHEREP_WORKSPACE: workspace,
      KHEREP_WORK_ITEM_REQUIRED: "1", KHEREP_WORK_ITEM_PATTERN: "OP-[0-9]+" },
    input: name === "pre-push" ? `refs/heads/main ${"1".repeat(40)} refs/heads/main ${"0".repeat(40)}\n` : "",
    encoding: "utf8", timeout: 15_000,
  });
  assert.ifError(result.error);
  return result;
}

test("canonical_dir is byte-identical in all three hooks", () => {
  const functions = names.map((name) => {
    const source = fs.readFileSync(path.join(hooks, name), "utf8");
    const match = source.match(/^canonical_dir\(\) \{\n[\s\S]*?^\}/m);
    assert.ok(match, name);
    return Buffer.from(match[0]);
  });
  assert.deepEqual(functions[0], functions[1]);
  assert.deepEqual(functions[0], functions[2]);
});

for (const form of ["/c drive mount", "/tmp mount", "drive letter", "nested repository"]) {
  test(`Windows Git Bash enforces commit policy for ${form}`, { skip: process.platform !== "win32" }, (t) => {
    const f = fixture(t, form === "nested repository" ? "workspace/nested/repo" : "workspace");
    let workspace = form === "drive letter" ? slash(f.workspace) : unixDrive(f.workspace);
    if (form === "/tmp mount") {
      const converted = spawnSync("cygpath", ["-u", slash(f.workspace)], {
        env: f.env, encoding: "utf8", timeout: 15_000,
      });
      assert.equal(converted.status, 0, converted.stderr);
      workspace = converted.stdout.trim();
      if (!workspace.startsWith("/tmp/")) {
        const mount = spawnSync("cygpath", ["-w", "/tmp"], { env: f.env, encoding: "utf8", timeout: 15_000 });
        assert.equal(mount.status, 0, mount.stderr);
        const relative = path.relative(fs.realpathSync(mount.stdout.trim()), f.workspace);
        assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "workspace is below /tmp");
        workspace = `/tmp/${slash(relative)}`;
      }
      assert.match(workspace, /^\/tmp\//, "the temp workspace must exercise Git Bash's /tmp mount");
    }
    const result = run(f, "commit-msg", workspace);
    assert.equal(result.status, 1, `${form}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /requires the subject to start with the configured work-item key/);
  });
}

for (const location of ["outside/repo", "workspace-sibling"]) {
  test(`commit policy stays silent outside the workspace: ${location}`, (t) => {
    const f = fixture(t, location);
    const result = run(f, "commit-msg", unixDrive(f.workspace));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, "");
  });
}

for (const name of names) {
  test(`${name} reports an unresolvable workspace with its promised exit status`, (t) => {
    const f = fixture(t);
    const result = run(f, name, unixDrive(path.join(f.root, "missing-workspace")));
    assert.equal(result.status, name === "commit-msg" ? 1 : 0, result.stderr);
    assert.equal(result.stdout, "");
    if (name === "commit-msg") {
      assert.match(result.stderr,
        /Kherep commit policy could not resolve KHEREP_WORKSPACE\. Check the configured directory\./);
    } else {
      assert.equal(result.stderr,
        `Kherep ${name} could not compare the repository with the workspace; its check did not run.\n`);
    }
  });
}
