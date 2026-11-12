const ARGUMENTS = String.raw`Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KherepCommandLine {
  [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string value, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  public static string[] Split(string value) { int count; IntPtr memory=CommandLineToArgvW(value,out count);
    if(memory==IntPtr.Zero) throw new InvalidOperationException("command line unavailable");
    try { var result=new string[count]; for(int i=0;i<count;i++) result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory,i*IntPtr.Size)); return result; }
    finally { LocalFree(memory); }
  }
}
'@;
function Resolve-KherepExecutable([string]$value){if([IO.Path]::IsPathRooted($value)){return [IO.Path]::GetFullPath($value)};$found=Get-Command -CommandType Application -Name $value -TotalCount 1 -ErrorAction Stop;return [IO.Path]::GetFullPath([string]$found.Source)}
function Test-KherepArgs($process,$expected){if($null-eq$process.CommandLine -or $null-eq$process.ExecutablePath){return $false};try{$expectedExe=Resolve-KherepExecutable([string]$expected.executable);if(-not[StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath([string]$process.ExecutablePath),$expectedExe)){return $false};$actual=@([KherepCommandLine]::Split([string]$process.CommandLine));$wanted=@($expected.argv);if($actual.Count-ne$wanted.Count){return $false};for($i=1;$i-lt$actual.Count;$i++){if([string]$actual[$i]-cne[string]$wanted[$i]){return $false}};return $true}catch{return $false}}
function Test-KherepCandidate($process,$expected,[string]$sid){try{$expectedExe=Resolve-KherepExecutable([string]$expected.executable);$pathPlausible=$false;if($null-ne$process.ExecutablePath){if(-not[StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath([string]$process.ExecutablePath),$expectedExe)){return 'foreign'};$pathPlausible=$true};if($null-ne$process.CommandLine -and $pathPlausible){if(Test-KherepArgs $process $expected){return 'match'};return 'foreign'};if(-not$pathPlausible -and -not[StringComparer]::OrdinalIgnoreCase.Equals([string]$process.Name,[IO.Path]::GetFileName($expectedExe))){return 'foreign'};try{$owner=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop;if($owner.ReturnValue-eq0 -and -not[StringComparer]::OrdinalIgnoreCase.Equals([string]$owner.Sid,$sid)){return 'foreign'}}catch{};return 'unknown'}catch{return 'unknown'}}
function Test-KherepRetainedStart($retained,$observed){return ([Math]::Abs([long]($retained.StartTime.ToUniversalTime().Ticks)-[long]($observed.CreationDate.ToUniversalTime().Ticks)) -le 9)}
function Test-KherepOwner($process,[string]$sid){$owner=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop;return ($owner.ReturnValue-eq0 -and [StringComparer]::OrdinalIgnoreCase.Equals([string]$owner.Sid,$sid))}
function Test-KherepAncestor([int]$child,[int]$ancestor,$parents){$seen=New-Object 'Collections.Generic.HashSet[int]';$cursor=$child;while($cursor-gt0 -and $seen.Add($cursor)){if($cursor-eq$ancestor){return $true};if(-not$parents.ContainsKey($cursor)){break};$cursor=[int]$parents[$cursor]};return $false}
function Get-KherepDescendants([int]$rootPid,$all){$seen=New-Object 'Collections.Generic.HashSet[int]';[void]$seen.Add($rootPid);do{$added=0;foreach($item in $all){if($seen.Contains([int]$item.ParentProcessId)-and-not$seen.Contains([int]$item.ProcessId)){[void]$seen.Add([int]$item.ProcessId);$added++}}}while($added-gt0);return @($seen|Where-Object{$_-ne$rootPid})}`;

export const WINDOWS_PROCESS_HELPERS_SCRIPT = ARGUMENTS;

const NATIVE = String.raw`function Get-KherepNativeState{
  $folder=if($payload.taskPath-eq'\'){'\'}else{$payload.taskPath.TrimEnd('\')};$service=New-Object -ComObject 'Schedule.Service';$service.Connect();$registered=$service.GetFolder($folder).GetTask($payload.serviceName)
  [xml]$nativeXml=$registered.Xml;$ns=New-Object Xml.XmlNamespaceManager($nativeXml.NameTable);$ns.AddNamespace('t',$nativeXml.DocumentElement.NamespaceURI)
  $nativeActions=@($nativeXml.SelectNodes('//t:Actions/*',$ns));$nativeExec=$nativeXml.SelectSingleNode('//t:Actions/t:Exec',$ns)
  $actionMatches=($nativeActions.Count-eq1 -and $null-ne$nativeExec -and [string]$nativeExec.Command-ceq[string]$payload.action.executable -and [string]$nativeExec.Arguments-ceq[string]$payload.action.arguments -and [string]$nativeExec.WorkingDirectory-ceq[string]$payload.action.workingDirectory)
  $running=@($service.GetRunningTasks(1));$selected=@($running|Where-Object{$_.Path -ceq $registered.Path});$engine=if($selected.Count-eq1){[int]$selected[0].EnginePID}else{0};$sameEngine=@($running|Where-Object{[int]$_.EnginePID-eq$engine})
  $all=@(Get-CimInstance Win32_Process);$parents=@{};foreach($item in $all){$parents[[int]$item.ProcessId]=[int]$item.ParentProcessId};$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $wrappers=@(if($actionMatches){@($all|Where-Object{(Test-KherepArgs $_ $payload.wrapper)-and(Test-KherepAncestor ([int]$_.ProcessId) $engine $parents)})}else{@()});$wrapper=if($wrappers.Count-eq1){$wrappers[0]}else{$null};$supervisorPid=if($null-ne$wrapper){[int]$wrapper.ProcessId}else{0};$supervisorChildren=@($all|Where-Object{[int]$_.ParentProcessId-eq$supervisorPid})
  $definition=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes((Export-ScheduledTask -TaskName $payload.serviceName -TaskPath $payload.taskPath)))
  $security=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($registered.GetSecurityDescriptor(7)))
  [pscustomobject]@{service=$service;registered=$registered;actionMatches=$actionMatches;running=$running;selected=$selected;engine=$engine;sameEngine=$sameEngine;all=$all;parents=$parents;current=$current;wrappers=$wrappers;wrapper=$wrapper;supervisorPid=$supervisorPid;supervisorChildren=$supervisorChildren;definition=$definition;security=$security}
}
$native=Get-KherepNativeState;$service=$native.service;$registered=$native.registered;$actionMatches=$native.actionMatches;$running=$native.running;$selected=$native.selected;$engine=$native.engine;$sameEngine=$native.sameEngine;$all=$native.all;$parents=$native.parents;$current=$native.current;$wrappers=$native.wrappers;$wrapper=$native.wrapper;$supervisorPid=$native.supervisorPid;$supervisorChildren=$native.supervisorChildren;`;

export const WINDOWS_FINAL_STOP_WAIT_SCRIPT = String.raw`function Wait-KherepFinalStop([scriptblock]$probe,[int]$timeoutMs=30000,[int]$intervalMs=100){$clock=[Diagnostics.Stopwatch]::StartNew();while($true){$state=&$probe;if($state-ceq'clear'){return};if($state-cne'busy'){throw 'Windows final stop provenance is unknown'};if($clock.ElapsedMilliseconds-ge$timeoutMs){throw 'STOP_BLOCKED_NATIVE_DESCENDANTS'};Start-Sleep -Milliseconds ([Math]::Min($intervalMs,[Math]::Max(1,$timeoutMs-[int]$clock.ElapsedMilliseconds)))}}`;

// This final, mutation-free decision uses retained handles, never a new lookup by PID.
export const WINDOWS_FINAL_STOP_PROOF_SCRIPT = String.raw`function Complete-KherepStopProof($supervisorRetained,$daemonRetained,[scriptblock]$confirmFamily,$expected){
  if($null-eq$supervisorRetained -or -not$supervisorRetained.HasExited -or ($null-ne$daemonRetained -and -not$daemonRetained.HasExited)){throw 'retained service instance exit is unproven'}
  $family=&$confirmFamily;if($family-isnot[string] -or $family-cne'clear'){throw 'selected task family absence is unproven'}
  @{version=1;stopped=$true;daemonExited=$true;supervisorExited=$true;familyAbsent=$true;expected=$expected}|ConvertTo-Json -Compress
}`;

export const WINDOWS_PROCESS_PROVENANCE_SCRIPT = ARGUMENTS + NATIVE + String.raw`$p=$all|Where-Object{[int]$_.ProcessId-eq[int]$payload.pid}|Select-Object -First 1;if($null-eq$p){'{"missing":true}';exit};$owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop;if($owner.ReturnValue-ne0){throw 'process owner is unresolved'};$supervisorOwner=if($null-ne$wrapper){Test-KherepOwner $wrapper $current}else{$false};$descendants=@(Get-KherepDescendants ([int]$p.ProcessId) $all);@{missing=$false;executable=$p.ExecutablePath;commandLine=$p.CommandLine;created=$p.CreationDate.ToUniversalTime().ToString('o');supervisorCreated=if($null-ne$wrapper){$wrapper.CreationDate.ToUniversalTime().ToString('o')}else{$null};ownerSid=[string]$owner.Sid;currentSid=$current;selectedInstances=$selected.Count;enginePid=$engine;engineInAncestry=(Test-KherepAncestor ([int]$p.ProcessId) $engine $parents);matchingEngineTasks=$sameEngine.Count;supervisorPid=$supervisorPid;supervisorOwner=$supervisorOwner;daemonDirectChild=([int]$p.ParentProcessId -eq $supervisorPid);supervisorChildren=$supervisorChildren.Count;daemonDescendants=$descendants.Count}|ConvertTo-Json -Compress`;

const STOP_BODY = ARGUMENTS + NATIVE + WINDOWS_FINAL_STOP_WAIT_SCRIPT + WINDOWS_FINAL_STOP_PROOF_SCRIPT + String.raw`
$supervisorRetained=$null;$daemonRetained=$null;
try{
  if($null-eq$payload.expected -and $selected.Count-eq0){
    $detachedWrappers=@($all|Where-Object{(Test-KherepCandidate $_ $payload.wrapper $current)-ne'foreign'});$detachedDaemons=@($all|Where-Object{(Test-KherepCandidate $_ $payload.daemon $current)-ne'foreign'})
    if(-not$actionMatches -or [int]$registered.State-ne3 -or $detachedWrappers.Count-ne0 -or $detachedDaemons.Count-ne0){throw 'expected stopped task process absence differs'}
    '{"stopped":true,"quiescent":true}';exit
  }
  if($selected.Count-ne1 -or $engine-le0 -or $sameEngine.Count-ne1 -or $null-eq$wrapper){throw 'expected supervisor task provenance differs'}
  $supervisorRetained=[Diagnostics.Process]::GetProcessById($supervisorPid);if($supervisorRetained.Handle-eq[IntPtr]::Zero){throw 'expected supervisor handle is unavailable'}
  $wrapperFresh=Get-CimInstance Win32_Process -Filter ('ProcessId='+$supervisorPid) -ErrorAction Stop
  if($null-eq$wrapperFresh -or -not(Test-KherepRetainedStart $supervisorRetained $wrapper) -or -not(Test-KherepRetainedStart $supervisorRetained $wrapperFresh)){throw 'expected supervisor start provenance differs'}
  if(-not(Test-KherepOwner $wrapperFresh $current)-or-not(Test-KherepArgs $wrapperFresh $payload.wrapper)){throw 'expected supervisor owner differs'}
  $supervisorCreated=$wrapperFresh.CreationDate.ToUniversalTime().ToString('o');$daemonCreated=$null;$daemonPid=0;$descendantCount=0
  $daemon=$null;if($null-ne$payload.expected){$daemon=$all|Where-Object{[int]$_.ProcessId-eq[int]$payload.expected.pid}|Select-Object -First 1}
  if($null-ne$daemon){
    $daemonRetained=[Diagnostics.Process]::GetProcessById([int]$payload.expected.pid);if($daemonRetained.Handle-eq[IntPtr]::Zero){throw 'expected daemon handle is unavailable'}
    $daemonFresh=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$payload.expected.pid) -ErrorAction Stop
    if($null-eq$daemonFresh -or -not(Test-KherepRetainedStart $daemonRetained $daemon) -or -not(Test-KherepRetainedStart $daemonRetained $daemonFresh)){throw 'expected daemon start provenance differs'}
    $created=$daemonFresh.CreationDate.ToUniversalTime();$expectedStart=[DateTimeOffset]::Parse([string]$payload.expected.startedAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind).UtcDateTime
    if([Math]::Abs(($created-$expectedStart).TotalMilliseconds)-gt60000){throw 'expected daemon start provenance differs'}
    if(-not(Test-KherepOwner $daemonFresh $current)-or-not(Test-KherepArgs $daemonFresh $payload.daemon)-or[int]$daemonFresh.ParentProcessId-ne$supervisorPid){throw 'expected daemon provenance differs'}
    $daemonCreated=$created.ToString('o');$daemonPid=[int]$daemon.ProcessId;$descendantCount=@(Get-KherepDescendants $daemonPid $all).Count
    if($supervisorChildren.Count-ne1){throw 'STOP_BLOCKED_NATIVE_DESCENDANTS'}
  }elseif($supervisorChildren.Count-ne0){throw 'expected daemon is unavailable while the supervisor has another child'}
  if($payload.checkOnly){@{stopped=$false;owned=$true;busy=($descendantCount-gt0);daemonPid=$daemonPid;daemonCreated=$daemonCreated;supervisorPid=$supervisorPid;supervisorCreated=$supervisorCreated}|ConvertTo-Json -Compress;exit}
  $baselineDefinition=[string]$payload.definition;$baselineSecurity=[string]$payload.security;$baselineEngine=$engine;$baselineCurrent=$current
  Wait-KherepFinalStop {
    $final=Get-KherepNativeState
    if([string]$final.definition-cne$baselineDefinition -or [string]$final.security-cne$baselineSecurity -or -not$final.actionMatches){throw 'Scheduled Task definition changed during final stop'}
    if($final.selected.Count-ne1 -or [int]$final.engine-ne$baselineEngine -or $final.sameEngine.Count-ne1 -or [string]$final.current-cne$baselineCurrent){throw 'Scheduled Task instance changed during final stop'}
    if($null-eq$final.wrapper -or [int]$final.supervisorPid-ne$supervisorPid -or -not(Test-KherepAncestor $supervisorPid $baselineEngine $final.parents)){throw 'expected supervisor task provenance changed during final stop'}
    if(-not(Test-KherepRetainedStart $supervisorRetained $final.wrapper)-or-not(Test-KherepOwner $final.wrapper $baselineCurrent)-or-not(Test-KherepArgs $final.wrapper $payload.wrapper)){throw 'expected supervisor identity changed during final stop'}
    if($null-ne$daemonRetained){
      $finalDaemon=$final.all|Where-Object{[int]$_.ProcessId-eq$daemonPid}|Select-Object -First 1
      if($null-eq$finalDaemon -or -not(Test-KherepRetainedStart $daemonRetained $finalDaemon)-or-not(Test-KherepOwner $finalDaemon $baselineCurrent)-or-not(Test-KherepArgs $finalDaemon $payload.daemon)-or[int]$finalDaemon.ParentProcessId-ne$supervisorPid){throw 'expected daemon identity changed during final stop'}
      # Refresh after the native, owner and argv checks. A discovery helper can
      # start during those calls; deciding from $final.all would miss it.
      $freshAll=@(Get-CimInstance Win32_Process);$freshParents=@{};foreach($item in $freshAll){$freshParents[[int]$item.ProcessId]=[int]$item.ParentProcessId}
      $freshWrapper=$freshAll|Where-Object{[int]$_.ProcessId-eq$supervisorPid}|Select-Object -First 1
      $freshDaemon=$freshAll|Where-Object{[int]$_.ProcessId-eq$daemonPid}|Select-Object -First 1
      if($null-eq$freshWrapper -or -not(Test-KherepRetainedStart $supervisorRetained $freshWrapper)-or-not(Test-KherepArgs $freshWrapper $payload.wrapper)-or-not(Test-KherepAncestor $supervisorPid $baselineEngine $freshParents)){throw 'expected supervisor identity changed during final stop'}
      if($null-eq$freshDaemon -or -not(Test-KherepRetainedStart $daemonRetained $freshDaemon)-or-not(Test-KherepArgs $freshDaemon $payload.daemon)-or[int]$freshDaemon.ParentProcessId-ne$supervisorPid){throw 'expected daemon identity changed during final stop'}
      $freshChildren=@($freshAll|Where-Object{[int]$_.ParentProcessId-eq$supervisorPid});if($freshChildren.Count-ne1){throw 'STOP_BLOCKED_NATIVE_DESCENDANTS'}
      if(@(Get-KherepDescendants $daemonPid $freshAll).Count-gt0){return 'busy'}
      return 'clear'
    }
    $freshAll=@(Get-CimInstance Win32_Process);$freshParents=@{};foreach($item in $freshAll){$freshParents[[int]$item.ProcessId]=[int]$item.ParentProcessId}
    $freshWrapper=$freshAll|Where-Object{[int]$_.ProcessId-eq$supervisorPid}|Select-Object -First 1
    if($null-eq$freshWrapper -or -not(Test-KherepRetainedStart $supervisorRetained $freshWrapper)-or-not(Test-KherepArgs $freshWrapper $payload.wrapper)-or-not(Test-KherepAncestor $supervisorPid $baselineEngine $freshParents)){throw 'expected supervisor identity changed during final stop'}
    if(@($freshAll|Where-Object{[int]$_.ParentProcessId-eq$supervisorPid}).Count-ne0 -or @($freshAll|Where-Object{[int]$_.ProcessId-eq[int]$payload.expected.pid}).Count-ne0){throw 'expected daemon absence changed during final stop'}
    return 'clear'
  } 30000 100
  $kherepStopPhase='effects-possible'
  Stop-ScheduledTask -TaskName $payload.serviceName -TaskPath $payload.taskPath
  if(-not$supervisorRetained.HasExited){$supervisorRetained.Kill();if(-not$supervisorRetained.WaitForExit(10000)){throw 'expected supervisor did not exit'}}
  $after=@(Get-CimInstance Win32_Process|Where-Object{[int]$_.ParentProcessId-eq$supervisorPid});$allowed=if($null-ne$daemonRetained){[int]$payload.expected.pid}else{0}
  if(@($after|Where-Object{[int]$_.ProcessId-ne$allowed}).Count-ne0){throw 'replacement daemon appeared while stopping the supervisor'}
  if($null-ne$daemonRetained -and -not$daemonRetained.HasExited){$daemonRetained.Kill();if(-not$daemonRetained.WaitForExit(10000)){throw 'expected daemon did not exit'}}
  if(@(Get-CimInstance Win32_Process|Where-Object{[int]$_.ParentProcessId-eq$supervisorPid}).Count-ne0){throw 'expected supervisor child absence is unknown'}
  Complete-KherepStopProof $supervisorRetained $daemonRetained {
  $finalStopped=Get-KherepNativeState
  if($finalStopped.selected.Count-ne0 -or [int]$finalStopped.registered.State-ne3 -or -not$finalStopped.actionMatches -or [string]$finalStopped.definition-cne$baselineDefinition -or [string]$finalStopped.security-cne$baselineSecurity){throw 'selected task final absence is unproven'}
  $remainingWrappers=@($finalStopped.all|Where-Object{(Test-KherepCandidate $_ $payload.wrapper $baselineCurrent)-ne'foreign'})
  $remainingDaemons=@($finalStopped.all|Where-Object{(Test-KherepCandidate $_ $payload.daemon $baselineCurrent)-ne'foreign'})
  if($remainingWrappers.Count-ne0 -or $remainingDaemons.Count-ne0){throw 'selected task family absence is unproven'}
  return 'clear'
  } $payload.expected
}finally{if($null-ne$daemonRetained){$daemonRetained.Dispose()};if($null-ne$supervisorRetained){$supervisorRetained.Dispose()}}`;

// #838 A2: each literal throw of the stop script maps to one fixed reason code; any other exception is native-error.
// The adapter (service-windows-stop-code.mts) classifies by reason and phase only, never by the message.
export const STOP_SCRIPT_REASONS: ReadonlyArray<readonly [string, string]> = [
  ["expected stopped task process absence differs", "stopped-absence-differs"],
  ["expected supervisor task provenance differs", "supervisor-provenance"],
  ["expected supervisor handle is unavailable", "supervisor-handle"],
  ["expected supervisor start provenance differs", "supervisor-provenance"],
  ["expected supervisor owner differs", "supervisor-owner"],
  ["expected daemon handle is unavailable", "daemon-handle"],
  ["expected daemon start provenance differs", "daemon-provenance"],
  ["expected daemon provenance differs", "daemon-provenance"],
  ["expected daemon is unavailable while the supervisor has another child", "supervisor-child"],
  ["STOP_BLOCKED_NATIVE_DESCENDANTS", "descendants-busy"],
  ["Windows final stop provenance is unknown", "provenance-unknown"],
  ["Scheduled Task definition changed during final stop", "definition-changed"],
  ["Scheduled Task instance changed during final stop", "instance-changed"],
  ["expected supervisor task provenance changed during final stop", "supervisor-provenance"],
  ["expected supervisor identity changed during final stop", "supervisor-identity"],
  ["expected daemon identity changed during final stop", "daemon-identity"],
  ["expected daemon absence changed during final stop", "daemon-identity"],
  ["expected supervisor did not exit", "supervisor-exit"],
  ["replacement daemon appeared while stopping the supervisor", "replacement-daemon"],
  ["expected daemon did not exit", "daemon-exit"],
  ["expected supervisor child absence is unknown", "family-unproven"],
  ["retained service instance exit is unproven", "instance-exit"],
  ["selected task family absence is unproven", "family-unproven"],
  ["selected task final absence is unproven", "task-absence"],
];
export const STOP_SCRIPT_REPORT_STATUS = 70;
const REASON_TABLE = STOP_SCRIPT_REASONS.map(([message, reason]) => `@('${message}','${reason}')`).join(",");
// The phase turns to effects-possible on the line before Stop-ScheduledTask. A caught failure prints one fixed
// report and exits with the dedicated status; a killed or timed-out script prints nothing parseable.
const STOP_REPORT = String.raw`}catch{$kherepMessage=[string]$_.Exception.Message;$kherepReason='native-error';foreach($kherepPair in $kherepReasons){if($kherepMessage-ceq$kherepPair[0]){$kherepReason=$kherepPair[1];break}};@{ok=$false;phase=$kherepStopPhase;reason=$kherepReason;hresult=[int]$_.Exception.HResult}|ConvertTo-Json -Compress;exit ${STOP_SCRIPT_REPORT_STATUS}}`;
export const WINDOWS_STOP_SCRIPT = `$kherepReasons=@(${REASON_TABLE});$kherepStopPhase='pre-effect';try{` + STOP_BODY + STOP_REPORT;
