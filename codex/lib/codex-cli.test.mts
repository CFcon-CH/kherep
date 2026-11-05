import assert from "node:assert/strict";
import test from "node:test";
import { codexEnvironment, codexInvocation, codexOutput, resolveCodexCommand } from "./codex-cli.mts";

test("resolves Codex absolutely and prefers native executables over script shims", () => {
  const command = "C:\\Tools\\codex.exe";
  assert.equal(resolveCodexCommand({ platform: "win32", env: { Path: "C:\\Shims;C:\\Tools" },
    isExecutable: (file) => file === command || file === "C:\\Shims\\codex.cmd" }), command);
  const packaged = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_fixture\\codex.exe";
  assert.equal(resolveCodexCommand({ platform: "win32", env: { PATH: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_fixture" },
    isExecutable: (file) => file === packaged }), packaged);
  assert.equal(resolveCodexCommand({ platform: "linux", env: { PATH: ".:/tools" }, isExecutable: () => true }), "/tools/codex");
  assert.throws(() => resolveCodexCommand({ platform: "win32", env: { Path: "." } }), { code: "ENOENT" });
  assert.throws(() => resolveCodexCommand({ platform: "linux", env: { PATH: "" } }), { code: "ENOENT" });
});

test("routes packaged Windows Codex executables through cmd.exe", () => {
  assert.deepEqual(
    codexInvocation(
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex.exe",
      ["plugin", "add", "fixture with spaces"],
      "win32",
      "C:\\Windows\\System32\\cmd.exe",
    ),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d", "/s", "/c",
        '"C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex.exe" plugin add "fixture with spaces"',
      ],
    },
  );
});

test("invokes native Windows Codex executables directly", () => {
  const command = "C:\\Users\\fixture\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
  assert.deepEqual(
    codexInvocation(command, ["--version"], "win32", "C:\\Windows\\System32\\cmd.exe"),
    { command, args: ["--version"] },
  );
});

test("never gives a bare Windows tool or shell to spawn or cmd", () => {
  assert.throws(() => codexInvocation("codex", ["--version"], "win32", "C:\\Windows\\System32\\cmd.exe"), /absolute/);
  assert.throws(() => codexInvocation("C:\\Tools\\codex.cmd", ["--version"], "win32", "cmd.exe"), /absolute/);
  assert.equal(codexInvocation("C:\\Tools\\codex.cmd", ["--version"], "win32", "C:\\Windows\\System32\\cmd.exe").args[3],
    '"C:\\Tools\\codex.cmd" --version');
});

test("uses direct invocation outside Windows", () => {
  assert.deepEqual(codexInvocation("codex", ["--version"], "darwin"), {
    command: "codex",
    args: ["--version"],
  });
});

test("omits the default CODEX_HOME for packaged Windows Codex", () => {
  const environment = { CODEX_HOME: "C:\\Users\\fixture\\.codex", KEEP: "yes" };
  assert.deepEqual(
    codexEnvironment(environment.CODEX_HOME, "win32", environment, "C:\\Users\\fixture"),
    { KEEP: "yes" },
  );
});

test("preserves an explicit non-default CODEX_HOME", () => {
  assert.deepEqual(
    codexEnvironment("D:\\Codex", "win32", { KEEP: "yes" }, "C:\\Users\\fixture"),
    { KEEP: "yes", CODEX_HOME: "D:\\Codex" },
  );
});

test("keeps stderr out of output that is parsed as a document", () => {
  // The warning Codex prints when CODEX_HOME lies under a temporary directory (#55).
  const stdout = '{\n  "marketplaces": []\n}\n';
  const stderr = "WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir\n";
  assert.deepEqual(JSON.parse(codexOutput(stdout, stderr, true)), { marketplaces: [] });
  assert.throws(() => JSON.parse(codexOutput(stdout, stderr)));
  assert.equal(codexOutput("out\n", "err\n"), "out\n\nerr");
  assert.equal(codexOutput(null, "err", true), "");
});
