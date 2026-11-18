import assert from "node:assert/strict";
import { test } from "node:test";

import { windowsDesktop, type DesktopExec } from "./start-windows-desktop.mts";

const systemRoot = String.raw`C:\Windows`;
const home = String.raw`C:\Example User`;
const executable = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_fixture\app\resources\codex.exe`;
const desktopHome = String.raw`C:\Example User\.codex`;

function fixture(exec: DesktopExec, env: NodeJS.ProcessEnv = { SystemRoot: systemRoot }) {
  const desktop = windowsDesktop({ platform: "win32", env, home, exec });
  // Until the test uses the supplied port, never call the real OS boundary.
  assert.equal(desktop.home, desktopHome);
  return desktop;
}

test("probes and activates the installed app through the same fixed Windows command", async () => {
  const requests: Parameters<DesktopExec>[] = [];
  const desktop = fixture(async (...args) => {
    requests.push(args);
    return { stdout: requests.length === 1 ? `\r\n${JSON.stringify({ executable })}\r\n` : "activated\r\n" };
  }, { SystemRoot: systemRoot, TEST_CONTEXT: "synthetic" });
  assert.equal(await desktop.probe(), executable);
  await desktop.activate(executable);
  assert.equal(requests.length, 2);
  const [[command, args, options], [activationCommand, activationArgs, activationOptions]] = requests as [Parameters<DesktopExec>, Parameters<DesktopExec>];
  assert.equal(command, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  assert.equal(activationCommand, command);
  assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.equal(args.length, 4);
  assert.deepEqual(activationArgs, args);
  const script = Buffer.from(args[3]!, "base64").toString("utf16le");
  assert.match(script, /Get-AppxPackage -Name 'OpenAI\.Codex'/);
  assert.match(script, /\[Diagnostics\.Process\]::GetProcessesByName\('ChatGPT'\)/);
  assert.match(script, /ActivateApplication\("OpenAI\.Codex_2p2nqsd0c76g0!App", null, 0, out pid\)/);
  assert.doesNotMatch(script, /Start-Process|ms-windows-store:/i);
  assert.deepEqual(options, {
    encoding: "utf8", maxBuffer: 8192, timeout: 20_000, windowsHide: true,
    env: { SystemRoot: systemRoot, TEST_CONTEXT: "synthetic", KHEREP_CODEX_EXPECTED_DESKTOP_CLI: "" },
  });
  assert.deepEqual(activationOptions, { ...options, env: { ...options.env, KHEREP_CODEX_EXPECTED_DESKTOP_CLI: executable } });
});

test("refuses unsupported Windows contexts before starting a subprocess", () => {
  const exec = async () => { assert.fail("subprocess must not start"); };
  assert.throws(() => windowsDesktop({ platform: "linux", env: {}, home, exec }), /^ModelSelectionRefusal: codex-start-desktop-platform-unsupported$/);
  for (const env of [{}, { SystemRoot: "Windows" }]) {
    assert.throws(() => windowsDesktop({ platform: "win32", env, home, exec }), /^ModelSelectionRefusal: codex-start-desktop-access-or-activation-failed$/);
  }
  for (const invalidHome of ["relative", String.raw`C:drive-relative`, String.raw`\\fixture\share\home`]) {
    assert.throws(() => windowsDesktop({ platform: "win32", env: { SystemRoot: systemRoot }, home: invalidHome, exec }),
      { message: "codex-start-desktop-home-unsupported" });
  }
  for (const name of ["OPENAI_BASE_URL", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_IDENTITY_TOKEN_FILE"]) {
    assert.throws(() => windowsDesktop({ platform: "win32", env: { SystemRoot: systemRoot, [name]: "synthetic" }, home, exec }),
      /^ModelSelectionRefusal: codex-start-desktop-provider-environment-unsupported$/);
  }
});

test("normalizes native refusal codes and drops native diagnostic text", async () => {
  const refusals = [
    [20, "package-unsupported"], [21, "running"], [22, "package-changed"],
    [23, "access-or-activation-failed"], [29, "access-or-activation-failed"], ["ENOENT", "access-or-activation-failed"],
  ] as const;
  for (const [code, suffix] of refusals) {
    const desktop = fixture(async () => { throw Object.assign(new Error("private diagnostic fixture"), { code }); });
    await assert.rejects(desktop.probe(), { message: `codex-start-desktop-${suffix}` });
  }
});

test("refuses malformed discovery and activation results", async () => {
  for (const stdout of ["invalid JSON", "null", "{}", JSON.stringify({ executable: 11 }),
    JSON.stringify({ executable: "app/resources/codex.exe" }), JSON.stringify({ executable: String.raw`C:\native\codex.exe` })]) {
    const desktop = fixture(async () => ({ stdout }));
    await assert.rejects(desktop.probe(), { message: "codex-start-desktop-package-unsupported" });
  }
  const desktop = fixture(async () => ({ stdout: "private activation fixture" }));
  await assert.rejects(desktop.activate(executable), { message: "codex-start-desktop-access-or-activation-failed" });
});
