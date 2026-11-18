import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ModelSelectionRefusal } from "./model-selection-git.mts";
import { refuseStart } from "./start-model-policy.mts";

export interface DesktopStart {
  home: string;
  probe(): Promise<string>;
  activate(executable: string): Promise<void>;
}

export type DesktopExec = (file: string, args: string[], options: {
  encoding: "utf8"; maxBuffer: number; timeout: number; windowsHide: boolean; env: NodeJS.ProcessEnv;
}) => Promise<{ stdout: string }>;

interface DesktopRuntime {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exec: DesktopExec;
}

// The fixed installed-only Windows activation surface. This script reports
// only the package's own CLI path to the launcher, or one bounded exit code.
// Native application activation is via IApplicationActivationManager, not
// via a command or link that could offer to install an absent app.
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $package = @(Get-AppxPackage -Name 'OpenAI.Codex')
  if ($package.Count -ne 1 -or $package[0].PackageFamilyName -cne 'OpenAI.Codex_2p2nqsd0c76g0' -or $package[0].Status -ne 'Ok') { exit 20 }
  $manifest = Get-AppxPackageManifest -Package $package[0].PackageFullName
  $apps = @($manifest.Package.Applications.Application | Where-Object { $_.Id -ceq 'App' })
  if ($apps.Count -ne 1 -or [IO.Path]::GetFileName($apps[0].Executable) -ine 'ChatGPT.exe') { exit 20 }
  $executable = Join-Path $package[0].InstallLocation 'app\resources\codex.exe'
  if (!(Test-Path -LiteralPath $executable -PathType Leaf)) { exit 20 }
  if ([Diagnostics.Process]::GetProcessesByName('ChatGPT').Length -gt 0) { exit 21 }
  if (!$env:KHEREP_CODEX_EXPECTED_DESKTOP_CLI) {
    @{ executable = $executable } | ConvertTo-Json -Compress
    exit 0
  }
  if ($executable -ine $env:KHEREP_CODEX_EXPECTED_DESKTOP_CLI) { exit 22 }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class KherepDesktopActivation
{
    [ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationActivationManager
    {
        [PreserveSig]
        int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
    }

    [DllImport("ole32.dll", ExactSpelling = true)]
    private static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint context, ref Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out IApplicationActivationManager activation);

    public static void OpenInstalledApp()
    {
        var clsid = new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C");
        var iid = typeof(IApplicationActivationManager).GUID;
        IApplicationActivationManager activation;
        const uint localServer = 4;
        Marshal.ThrowExceptionForHR(CoCreateInstance(ref clsid, IntPtr.Zero, localServer, ref iid, out activation));
        try
        {
            uint pid;
            Marshal.ThrowExceptionForHR(activation.ActivateApplication("OpenAI.Codex_2p2nqsd0c76g0!App", null, 0, out pid));
            if (pid == 0) throw new InvalidOperationException();
        }
        finally { Marshal.ReleaseComObject(activation); }
    }
}
'@
  if ([Diagnostics.Process]::GetProcessesByName('ChatGPT').Length -gt 0) { exit 21 }
  [KherepDesktopActivation]::OpenInstalledApp()
  Write-Output 'activated'
} catch { exit 23 }
`;

const expectedExecutable = "KHEREP_CODEX_EXPECTED_DESKTOP_CLI";
const run = promisify(execFile);
const refusalCodes = new Map([
  [20, "desktop-package-unsupported"], [21, "desktop-running"],
  [22, "desktop-package-changed"], [23, "desktop-access-or-activation-failed"],
]);

export function windowsDesktop({ platform = process.platform, env = process.env, home = os.homedir(), exec = run }: Partial<DesktopRuntime> = {}): DesktopStart {
  if (platform !== "win32") refuseStart("desktop-platform-unsupported");
  const systemRoot = env.SystemRoot;
  if (!systemRoot || !/^[A-Za-z]:\\/u.test(systemRoot)) refuseStart("desktop-access-or-activation-failed");
  // Explorer activation may inherit a different process environment. This
  // companion is for Windows' standard signed-in ChatGPT provider context.
  if (["OPENAI_BASE_URL", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_IDENTITY_TOKEN_FILE"].some((key) => Boolean(env[key]))) {
    refuseStart("desktop-provider-environment-unsupported");
  }
  if (!/^[A-Za-z]:[\\/]/u.test(home)) refuseStart("desktop-home-unsupported");
  const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  const invoke = async (expected = ""): Promise<string> => {
    try {
      const result = await exec(powershell, args, {
        encoding: "utf8", maxBuffer: 8192, timeout: 20_000, windowsHide: true,
        env: { ...env, [expectedExecutable]: expected },
      });
      return result.stdout.trim();
    } catch (error) {
      const code = (error as { code?: string | number }).code;
      return refuseStart(typeof code === "number" ? refusalCodes.get(code) ?? "desktop-access-or-activation-failed" : "desktop-access-or-activation-failed");
    }
  };
  return {
    home: path.win32.join(home, ".codex"),
    async probe() {
      const text = await invoke();
      let executable: unknown;
      try { executable = (JSON.parse(text) as { executable?: unknown }).executable; }
      catch { throw new ModelSelectionRefusal("codex-start-desktop-package-unsupported"); }
      if (typeof executable !== "string" || !path.win32.isAbsolute(executable) || !/[\\/]app[\\/]resources[\\/]codex\.exe$/iu.test(executable)) {
        refuseStart("desktop-package-unsupported");
      }
      return executable;
    },
    async activate(executable) {
      if (await invoke(executable) !== "activated") refuseStart("desktop-access-or-activation-failed");
    },
  };
}
