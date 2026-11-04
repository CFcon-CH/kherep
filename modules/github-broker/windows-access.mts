import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fail } from './contract.mts';
/** Per-level decision. Pure: takes a RawSecurityDescriptor and flags, throws 'refused'. */
export const WINDOWS_ACL_EVALUATOR = String.raw`
function Test-KherepLevel($raw, $me, $private, $isRoot, $directory, $receiptFile) {
  $trusted = @($me, 'S-1-5-18', 'S-1-5-32-544')
  $owners = $trusted
  if ($isRoot) { $owners = $trusted + 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464' }
  if (([int]$raw.ControlFlags -band 4) -eq 0 -or $null -eq $raw.DiscretionaryAcl -or $raw.DiscretionaryAcl.Count -gt 64) { throw 'refused' }
  $owner = $raw.Owner.Value
  if (($private -and $owner -ne $me) -or (!$private -and $owners -notcontains $owner)) { throw 'refused' }
  if ($private -and !$receiptFile -and (([int]$raw.ControlFlags -band 4096) -eq 0)) { throw 'refused' }
  $canRead = $false
  foreach ($ace in $raw.DiscretionaryAcl) {
    if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or ([int]$ace.AceType -ne 0 -and [int]$ace.AceType -ne 1) -or (([int]$ace.AceFlags -band 224) -ne 0)) { throw 'refused' }
    $mask = ([int64]$ace.AccessMask -band 4294967295L)
    $inheritOnly = (([int]$ace.AceFlags -band 8) -ne 0)
    if ([int]$ace.AceType -eq 0) {
      $sid = $ace.SecurityIdentifier.Value
      $allowed = 2685534377L
      if ($isRoot -and $sid -eq 'S-1-5-11' -and (([int]$ace.AceFlags -band 31) -eq 0)) { $allowed = $allowed -bor 4L }
      if ($private -and $trusted -notcontains $ace.SecurityIdentifier.Value) { throw 'refused' }
      if (!$private -and !$inheritOnly -and $trusted -notcontains $sid -and ($mask -band (4294967295L -bxor $allowed)) -ne 0) { throw 'refused' }
      if (!$inheritOnly -and $ace.SecurityIdentifier.Value -eq $me -and ($mask -band 2415919105L) -ne 0) { $canRead = $true }
    }
  }
  if ($private -and !$directory -and !$canRead) { throw 'refused' }
}
`;
/** Fixed metadata-only script. It neither reads content nor changes ACLs. */
export const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
` + WINDOWS_ACL_EVALUATOR + String.raw`
try {
  $target = [Console]::In.ReadToEnd()
  if ($target.Length -gt 4096 -or $target -notmatch '^[A-Za-z]:\\' -or $target.Substring(2).Contains(':')) { throw 'refused' }
  $target = [IO.Path]::GetFullPath($target)
  $matches = [regex]::Matches($target, '\\\.kherep\\github-broker(?=\\|$)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($matches.Count -ne 1) { throw 'refused' }
  $privateRoot = $target.Substring(0, $matches[0].Index + $matches[0].Length)
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $current = $target
  $depth = 0
  while ($true) {
    $depth += 1
    if ($depth -gt 64) { throw 'refused' }
    $attributes = [IO.File]::GetAttributes($current)
    if (([int]$attributes -band 1024) -ne 0) { throw 'refused' }
    $directory = (([int]$attributes -band 16) -ne 0)
    $private = $current.Equals($privateRoot, [StringComparison]::OrdinalIgnoreCase) -or $current.StartsWith($privateRoot + '\', [StringComparison]::OrdinalIgnoreCase)
    $driveRoot = [IO.Path]::GetPathRoot($current)
    $isRoot = $current.Equals($driveRoot, [StringComparison]::OrdinalIgnoreCase)
    $acl = Get-Acl -LiteralPath $current -ErrorAction Stop
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    $receiptFile = !$directory -and $current.StartsWith($privateRoot + '\receipts\', [StringComparison]::OrdinalIgnoreCase)
    Test-KherepLevel $raw $me $private $isRoot $directory $receiptFile
    if ($isRoot) { break }
    $parent = [IO.Directory]::GetParent($current)
    if ($null -eq $parent) { throw 'refused' }
    $current = $parent.FullName
  }
  [Console]::Out.Write('ok')
  exit 0
} catch {
  [Console]::Out.Write('refused')
  exit 1
}
`;
const WINDOWS = 'C:\\Windows';
type NativeResult = {status:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string;error?:Error};
type NativeOptions = {input:string;encoding:'utf8';windowsHide:true;timeout:number;maxBuffer:number;env:NodeJS.ProcessEnv};
export type NativeSpawn = (command:string,args:string[],options:NativeOptions)=>NativeResult;
export function checkWindowsAccess(target:string, privateRoot:string, run:NativeSpawn=spawnSync):void {
  try {
    const full=path.win32.normalize(target), root=path.win32.normalize(privateRoot);
    if (full.length>4096 || full!==target || !/^[A-Za-z]:\\/.test(full) || full.slice(2).includes(':') || !full.toLowerCase().startsWith(`${root.toLowerCase()}\\`) && full.toLowerCase()!==root.toLowerCase() || !/\\\.kherep\\github-broker$/i.test(root)) fail('key-access-denied');
    const result=run(path.win32.join(WINDOWS,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',WINDOWS_ACL_SCRIPT],{
      input:target,encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:4096,
      env:{SystemRoot:WINDOWS,WINDIR:WINDOWS,PSModulePath:path.win32.join(WINDOWS,'System32','WindowsPowerShell','v1.0','Modules')},
    });
    if (result.status!==0 || result.signal || result.error || result.stderr || result.stdout!=='ok') fail('key-access-denied');
  } catch {fail('key-access-denied');}
}
