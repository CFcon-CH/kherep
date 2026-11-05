// Shared ACL fixture of restore-write-acl.test.mts and hook-runtime-replay.test.mts
// (issue #507, part 2). An in-place write keeps the inode's access-control list, so
// these cases put an ACL on the target leaf only and compare two reads of that same
// file, one before and one after the product call. A read that failed, came back
// partial or came back empty is null and fails the case: no ACL is ever inferred from
// silence. Windows: icacls sets the ACL for the current user's SID, resolved at run
// time; one complete Get-Acl snapshot (the Access SDDL, AreAccessRulesProtected and the
// explicit rules of that SID) reads it. Only a denial this process is measured to pass
// through, after its rule was read back with the expected rights and with the file and
// ACL unchanged by the probe, is a skip naming that fact; everything else fails. macOS chmod +a /
// ls -le and Linux setfacl / getfacl as before; there a missing tool or a root user
// skips the case.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";

const WIN = process.platform === "win32";
const system32 = (...rest: string[]): string => path.join(process.env.SystemRoot || "C:\\Windows", "System32", ...rest);
const sh = (cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, env });
// Rights masks as icacls sets them: (WD,AD) on a file, (WD) on a directory, (R).
export const WRITE_DENY = 0x6;
export const ADD_FILE_DENY = 0x2;
export const READ_DENY = 0x120089;
const posixTool = process.platform === "darwin" ? "chmod" : process.platform === "linux" ? "setfacl" : "";

let sidOnce = "";
function userSid(): string {
  if (!sidOnce) {
    const out = sh(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
    const sid = out.status === 0 ? /"(S-1-\d+(?:-\d+)+)"\s*$/.exec(out.stdout.trim())?.[1] : undefined;
    if (!sid) assert.fail(`the current user's SID could not be read (whoami exit ${out.status})`);
    sidOnce = sid;
  }
  return sidOnce;
}

// One complete Get-Acl snapshot: the Access SDDL, AreAccessRulesProtected, the type and
// rights mask of each explicit (not inherited) rule for the SID in KHEREP_ACL_SID, read
// as SecurityIdentifier so that no account name or SDDL alias decides, and the number
// of inherited rules.
const SNAPSHOT = "$ProgressPreference = 'SilentlyContinue'; try { $a = Get-Acl -LiteralPath $env:KHEREP_ACL_PATH -ErrorAction Stop; "
  + "$a.GetSecurityDescriptorSddlForm('Access'); $a.AreAccessRulesProtected; "
  + "$r = @($a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); "
  + "'own=' + ((@($r | Where-Object { -not $_.IsInherited -and $_.IdentityReference.Value -eq $env:KHEREP_ACL_SID }) "
  + "| ForEach-Object { [string]$_.AccessControlType + ':' + [int]$_.FileSystemRights + ':' "
  + "+ [int]$_.PropagationFlags.HasFlag([System.Security.AccessControl.PropagationFlags]::InheritOnly) }) -join ','); "
  + "'inherited=' + @($r | Where-Object { $_.IsInherited }).Count } catch { exit 3 }";

export interface WindowsAcl { text: string; protectedRules: boolean; own: { type: string; mask: number; inheritOnly: boolean }[]; inherited: number }

// The snapshot as Windows PowerShell printed it, or null unless it is complete and consistent.
export function parseWindowsSnapshot(status: number | null, stdout: string, stderr: string): WindowsAcl | null {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
  if (status !== 0 || stderr || lines.length !== 4) return null;
  const [access, protectedRules, own, inherited] = lines as [string, string, string, string];
  if (!/^D:[A-Z]*(\([^()]+\))+$/.test(access) || !/^(True|False)$/.test(protectedRules)) return null;
  if ((protectedRules === "True") !== /^D:[A-Z]*P/.test(access)) return null;
  if (!/^own=((Allow|Deny):\d+:[01](,(Allow|Deny):\d+:[01])*)?$/.test(own) || !/^inherited=\d+$/.test(inherited)) return null;
  const rules = own.slice(4).split(",").filter(Boolean).map((rule) => rule.split(":"));
  return { text: lines.join("\n"), protectedRules: protectedRules === "True",
    own: rules.map(([type, mask, io]) => ({ type: type!, mask: Number(mask), inheritOnly: io === "1" })), inherited: Number(inherited.slice(10)) };
}

// true when the snapshot has an explicit rule of that type, exactly that rights mask
// (when given) and effect on the object itself (not InheritOnly).
export const hasRule = (acl: WindowsAcl | null, type: "Allow" | "Deny", mask?: number): boolean =>
  !!acl?.own.some((rule) => rule.type === type && !rule.inheritOnly && (mask === undefined || rule.mask === mask));

// The Windows ACL of a file or directory, with the explicit rules of `sid` (default: the
// current user), or null when the read failed or is not complete.
export function windowsAcl(file: string, sid: string = userSid()): WindowsAcl | null {
  // Windows PowerShell builds its own module path; one inherited from PowerShell 7
  // points at modules it cannot load, and Get-Acl would never autoload.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
  const out = sh(system32("WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", SNAPSHOT],
    { ...env, KHEREP_ACL_PATH: path.resolve(file), KHEREP_ACL_SID: sid });
  return parseWindowsSnapshot(out.status, out.stdout, out.stderr);
}

// The ACL of file, or null when the read failed or is not complete.
export function readAcl(file: string): string | null {
  if (WIN) return windowsAcl(file)?.text ?? null;
  if (process.platform === "darwin") {
    const out = sh("ls", ["-le", file]);
    return lsAcl(out.status, out.stdout);
  }
  const out = sh("getfacl", ["-cp", file]);
  return out.status === 0 && out.stdout.trim() ? out.stdout : null;
}

// macOS `ls -le <file>`: the long-listing line, then one line per ACE ("<n>: ..."). Only a
// run that exited 0 with that line and at least one ACE line, nothing else, is a read: ls
// prints the listing line alone both for a file without an ACL and when it could not read
// the ACL (file_cmds ls.c, acl_get_link_np), so no ACE proves nothing and is null. The
// cases give every file they compare an ACE. Neither the listing line nor its mode flag
// (@ or +) is part of the ACL.
export function lsAcl(status: number | null, stdout: string): string | null {
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const [head, ...aces] = lines;
  if (status !== 0 || !head || !/^[-bcdlps][-rwxsStT]{9}[@+]?\s/.test(head)) return null;
  if (aces.some((line) => !/^\s*\d+: \S/.test(line))) return null;
  return aces.length ? aces.join("\n") : null;
}

// The code a write open of file fails with under this process's token, "" when it opens.
export function writeOpenError(file: string): string {
  try {
    fs.closeSync(fs.openSync(file, fs.constants.O_WRONLY));
    return "";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code || "unknown";
  }
}

function setAcl(file: string, deny: boolean): boolean {
  if (WIN) {
    const sid = userSid();
    const args = deny ? [file, "/deny", `*${sid}:(WD,AD)`]
      : [file, "/inheritance:r", "/grant:r", `*${sid}:(R,W)`, "/grant", "*S-1-5-32-545:(R)"];
    return sh(system32("icacls.exe"), args).status === 0;
  }
  // A POSIX ACL grants the file owner through its owner entry (u::), never through a
  // named entry for the same user, so the Linux deny case narrows u:: and keeps a
  // named entry and the mask, which makes the ACL an extended one.
  return sh(posixTool, process.platform === "darwin" ? ["+a", `group:everyone ${deny ? "deny write" : "deny delete"}`, file]
    : ["-m", deny ? "u::r--,u:nobody:r--,m::r--" : "u:nobody:r--", file]).status === 0;
}

function resetAcl(file: string): boolean {
  if (WIN) return sh(system32("icacls.exe"), [file, "/reset"]).status === 0;
  return sh(posixTool, process.platform === "darwin" ? ["-N", file] : ["-b", file]).status === 0;
}

// true only when file is proven gone (ENOENT), not when it merely could not be seen.
function removed(file: string): boolean {
  try {
    fs.lstatSync(file);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export interface Applied { before: string; denied: string }

// Puts a restricting or a write-denying ACL on file, proves it took effect, and returns
// it as read back with the code a write open now fails with ("" when restricting).
// null when this platform cannot run the case (never on Windows).
export function applyAcl(t: TestContext, file: string, deny: boolean): Applied | null {
  if (!WIN && (!posixTool || process.getuid?.() === 0)) {
    t.skip("no ACL tool for this platform");
    return null;
  }
  // Before the first change, which may land half: a leaf that is still there is lifted
  // and checked, so the tree can go; one whose removal was proven needs nothing.
  let lift = true;
  t.after(() => { if (lift && !removed(file)) liftAcl(file); });
  if (!setAcl(file, deny)) {
    if (WIN) assert.fail(`icacls could not set the ${deny ? "deny" : "restricting"} ACL`);
    lift = false; // the POSIX tool refused the entry: nothing to lift
    t.skip("no ACL tool for this platform");
    return null;
  }
  const before = readAcl(file);
  if (!before) assert.fail("the ACL could not be read completely before the call");
  if (WIN) {
    // From the access rules by SID, not from the SDDL text, which may write the user as an
    // alias. Booleans and fixed messages only: no SDDL and no SID reaches any assertion output.
    const acl = windowsAcl(file);
    assert.ok(deny ? hasRule(acl, "Deny", WRITE_DENY) : hasRule(acl, "Allow"), `the ${deny ? "deny" : "allow"} ACE for the current user is in place`);
    assert.equal(acl!.protectedRules, !deny, "the inheritance is as set");
    if (!deny) assert.equal(acl!.inherited, 0, "no inherited ACE is left");
  }
  const held = { id: identity(file), bytes: fs.readFileSync(file) };
  const denied = writeOpenError(file);
  if (WIN && deny && !denied) {
    // Measured only: the same file, bytes and ACL as read before the open.
    assert.ok(identity(file) === held.id && fs.readFileSync(file).equals(held.bytes) && readAcl(file) === before,
      "the file and its ACL are unchanged by the write open");
    t.skip("this process opens for writing a file its DACL denies writing");
    return null;
  }
  if (deny) assert.ok(denied === "EPERM" || denied === "EACCES", `a write open under the deny ACL is refused, got ${denied || "an open file"}`);
  else assert.equal(denied, "", "a write open under the restricting ACL succeeds");
  fs.readFileSync(file); // the file stays readable
  return { before, denied };
}

// The ACL of file is still the one read before the call.
export function sameAcl(file: string, before: string): void {
  const now = readAcl(file);
  if (!now) assert.fail("the ACL could not be read completely after the call");
  assert.ok(now === before, "the ACL is the one read before the call");
}

// Lifts the ACL and proves it is gone: on Windows the inherited ACL is back and no
// deny ACE is left; everywhere a write open succeeds again. Linux setfacl -b keeps the
// narrowed owner entry of the deny case, so the owner's write bit is given back.
export function liftAcl(file: string): void {
  assert.ok(resetAcl(file), "the ACL could be reset");
  if (process.platform === "linux") fs.chmodSync(file, fs.statSync(file).mode | 0o200);
  if (WIN) {
    const now = windowsAcl(file);
    if (!now) assert.fail("the ACL could not be read completely after the reset");
    assert.ok(!now.protectedRules && !now.own.length && !now.text.includes("(D;"), "the reset restored inheritance and left no deny ACE");
  }
  assert.equal(writeOpenError(file), "", "a write open succeeds after the reset");
}

// A directory change of the publication cases (restore-write-acl.test.mts): `inherit` and
// `inheritOther` give dir one of two different, harmless inheritable allow entries, so a
// file created in it has an ACE of its own and differs from one created in a directory
// with the other entry; `noNewNames` takes away the right to add a name to dir (the hooks
// directory), its subdirectories untouched. The cleanup is registered before the change
// and checked. null when this platform cannot run the case (never on Windows).
export function changeDirectory(t: TestContext, dir: string, change: "inherit" | "inheritOther" | "noNewNames"): true | null {
  if (!WIN && (!posixTool || process.getuid?.() === 0)) {
    t.skip("no ACL tool for this platform");
    return null;
  }
  const darwin = process.platform === "darwin";
  const originalMode = !WIN && change === "noNewNames" ? fs.statSync(dir).mode & 0o7777 : undefined;
  const undo = (): boolean => {
    if (WIN) return sh(system32("icacls.exe"), [dir, "/reset"]).status === 0;
    if (change === "noNewNames") {
      fs.chmodSync(dir, originalMode!);
      return true;
    }
    return sh(posixTool, darwin ? ["-N", dir] : ["-k", dir]).status === 0;
  };
  t.after(() => assert.ok(undo(), "the directory change could be undone"));
  let done: boolean;
  const other = change === "inheritOther";
  if (WIN) {
    const ace = change === "noNewNames" ? `*${userSid()}:(WD)` : `*S-1-5-32-545:(OI)(CI)(${other ? "RA" : "R"})`;
    done = sh(system32("icacls.exe"), [dir, change === "noNewNames" ? "/deny" : "/grant", ace]).status === 0;
  } else if (change === "noNewNames") {
    fs.chmodSync(dir, 0o500);
    done = true;
  } else {
    done = sh(posixTool, darwin ? ["+a", `everyone allow ${other ? "readattr" : "readextattr"},file_inherit`, dir]
      : ["-d", "-m", `u:nobody:${other ? "x" : "r"}`, dir]).status === 0;
  }
  if (WIN) assert.ok(done, "icacls could change the directory");
  else if (!done) {
    t.skip("no ACL tool for this platform");
    return null;
  }
  if (change === "noNewNames") {
    const acl = WIN ? windowsAcl(dir) : null;
    if (WIN) assert.ok(hasRule(acl, "Deny", ADD_FILE_DENY), "the deny entry for the current user is in place");
    const id = identity(dir);
    addsName(dir, "create");
    // The publication adds its name by a hard link: only that operation decides.
    if (addsName(dir, "link")) {
      assert.ok(identity(dir) === id && (!WIN || windowsAcl(dir)?.text === acl!.text), "the directory and its ACL are unchanged by the probes");
      t.skip("this process adds a hard link to a directory whose ACL denies adding names");
      return null;
    }
  }
  return true;
}

// The (dev, ino) of a path that must be a directory or a regular file, as one string.
export function identity(p: string): string {
  const st = fs.lstatSync(p, { bigint: true });
  assert.ok(st.isFile() || st.isDirectory(), "the path is a regular file or a directory");
  return `${st.dev}:${st.ino}`;
}

// true when this process can still add a name to dir by creating a file or a hard link;
// false when the OS refused it (EPERM or EACCES, anything else fails the case).
function addsName(dir: string, how: "create" | "link"): boolean {
  const source = path.join(path.dirname(dir), ".acl-probe-source");
  const probe = path.join(dir, `.acl-probe-${how}`);
  if (how === "link") fs.writeFileSync(source, "");
  try {
    if (how === "link") fs.linkSync(source, probe);
    else fs.closeSync(fs.openSync(probe, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    assert.ok(code === "EPERM" || code === "EACCES", `adding a name is refused by the OS, got ${code}`);
    return false;
  } finally {
    if (how === "link") fs.rmSync(source);
  }
  fs.rmSync(probe);
  return true;
}
