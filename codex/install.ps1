[CmdletBinding()]
param(
  [string]$CodexHome,
  [string]$ClaudeConfigDir,
  [string]$McpRegistry,
  [string]$Workspace,
  [switch]$AuthorizeObservationPublishing,
  [switch]$EnableMessagingClient
)

$ErrorActionPreference = "Stop"
$node = Get-Command node -ErrorAction Stop
$arguments = @((Join-Path $PSScriptRoot "install.mts"))
if ($CodexHome) { $arguments += @("--codex-home", $CodexHome) }
if ($ClaudeConfigDir) { $arguments += @("--claude-config-dir", $ClaudeConfigDir) }
if ($McpRegistry) { $arguments += @("--mcp-registry", $McpRegistry) }
if ($Workspace) { $arguments += @("--workspace", $Workspace) }
if ($AuthorizeObservationPublishing) { $arguments += "--authorize-observation-publishing" }
if ($EnableMessagingClient) { $arguments += "--enable-messaging-client" }

# Der Space-Schritt stand frueher hier und lief gegen orchestra/confluence.json.
# Er liegt jetzt in install.mts, neben dem Credential-Schritt, und schreibt nach
# <codex-home>/kherep/confluence.json - dorthin, wo die Agent-Definition ihn
# sucht. Dieser Aufruf fuehrt install.mts aus, der Schritt laeuft also weiterhin
# auf diesem Host, nur genau einmal und mit genau einem Schreiber fuer die Datei.
& $node.Source @arguments
$installExitCode = $LASTEXITCODE
if ($installExitCode -ne 0) {
  throw "Kherep Codex Maestro installer failed with exit code $installExitCode"
}
