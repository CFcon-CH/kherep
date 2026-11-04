import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { checkWindowsAccess, WINDOWS_ACL_EVALUATOR, WINDOWS_ACL_SCRIPT } from './windows-access.mts';
const target='C:\\Users\\Synthetic\\.kherep\\github-broker\\keys\\selected.pem';
const root='C:\\Users\\Synthetic\\.kherep\\github-broker';
test('Windows adapter bounds the fixed native invocation and keeps paths on stdin',()=>{
  let calls=0;
  checkWindowsAccess(target,root,(command,args,options)=>{
    calls++;assert.equal(command,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.ok(args.includes('-NoProfile'));assert.ok(args.includes('-NonInteractive'));assert.equal(args.at(-1),WINDOWS_ACL_SCRIPT);
    assert.equal(args.join('').includes(target),false);assert.equal(JSON.stringify(options.env).includes(target),false);assert.equal(options.input,target);
    assert.equal(Object.keys(options.env).some(k=>/TOKEN|KEY|SECRET|HOME|PROFILE/.test(k)),false);
    assert.equal(options.timeout,5000);return {status:0,signal:null,stdout:'ok',stderr:''};
  });assert.equal(calls,1);
});
test('Windows launch, stderr, timeout, malformed and missing status all fail closed',()=>{
  for(const result of [{status:1,signal:null,stdout:'ok',stderr:''},{status:0,signal:null,stdout:'ok',stderr:'secret-canary'},{status:0,signal:null,stdout:'',stderr:''},{status:0,signal:null,stdout:'{"ok":true}',stderr:''},{status:null,signal:'SIGTERM' as const,stdout:'',stderr:''}]) assert.throws(()=>checkWindowsAccess(target,root,()=>result),{message:'key-access-denied'});
  assert.throws(()=>checkWindowsAccess(target,root,()=>{throw new Error('private-canary');}),{message:'key-access-denied'});
});
test('Windows rejects UNC, alternate streams, relative and outside-root paths before subprocess',()=>{
  for(const bad of ['\\\\server\\share\\key.pem',`${target}:stream`,'relative.pem','C:\\other\\key.pem']) assert.throws(()=>checkWindowsAccess(bad,root,()=>{assert.fail('must not launch');}),{message:'key-access-denied'});
});
test('native end-to-end walk on a real tree stays an explicit separate gate',{skip:'the walk on a real tree is measured on a Windows node per #788 acceptance 4; the descriptor evaluator tests below cover the per-level decision'},()=>{
  // Synthetic native provisioning needs separate explicit authority. Never turn
  // the fixed-status mock above into actual ACL-enforcement evidence.
  assert.fail('native fixture provisioning is not authorized by the source/mock brief');
});

// Synthetic identities, plus the well-known SIDs of a default Windows drive root.
const ME='S-1-5-21-1111111111-2222222222-3333333333-1001',OTHER='S-1-5-21-1111111111-2222222222-3333333333-1002';
const TI='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const BA='S-1-5-32-544',SY='S-1-5-18',BU='S-1-5-32-545',AU='S-1-5-11',WD='S-1-1-0';
const CAPABILITY='S-1-15-3-65536-1888954469-739942743-1668119174-2468466756-4239452838-1296943325-355587736-700089176';
const FA=0x1F01FF,RX=0x1200A9,MODIFY_GENERIC=0xE0010000,GENERIC_RX=0xA0000000,OICI=3,OICIIO=11,CI=2;
// SE_SELF_RELATIVE|SE_DACL_PROTECTED|SE_DACL_AUTO_INHERITED|SE_DACL_PRESENT, as in the capture below.
const CONTROL=0x9404,NO_DACL=0x9400,UNPROTECTED=0x8404;
type Ace={flags:number;mask:number;sid:string};
type Shape={owner:string;control?:number;aces:Ace[]};
const ace=(sid:string,flags:number,mask:number):Ace=>({flags,mask,sid});
/**
 * Default C:\ descriptor captured read-only on a real Windows node by the Windows
 * session on 2026-11-05, as relayed in #788. One node's capture, not a claim about
 * every Windows build. It holds no machine or user SID. No rule depends on the
 * capability SID: that ACE passes only because its mask lies inside the ancestor mask.
 * SDDL: O:<TI>G:<TI>D:PAI(A;;LC;;;AU)(A;OICIIO;SDGXGWGR;;;AU)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)(A;;0x1000a1;;;<capability>)
 */
const CAPTURED_C_ROOT='AQAElBQAAAA0AAAAAAAAAFQAAAABBgAAAAAABVAAAAC1ifs4GYTCy1xsI21XAHduwAJkhwEGAAAAAAAFUAAAALWJ+zgZhMLLXGwjbVcAd27AAmSHAgCsAAYAAAAAABQABAAAAAEBAAAAAAAFCwAAAAALFAAAAAHgAQEAAAAAAAULAAAAAAMUAP8BHwABAQAAAAAABRIAAAAAAxgA/wEfAAECAAAAAAAFIAAAACACAAAAAxgAqQASAAECAAAAAAAFIAAAACECAAAAADgAoQAQAAEKAAAAAAAPAwAAAAAAAQBlKJdwV6EaLIZ6bWNE0CGTpuqw/N3ITU2Y1jEVWIO6KQ==';
const ROOT_ACES=[ace(AU,0,4),ace(AU,OICIIO,MODIFY_GENERIC),ace(SY,OICI,FA),ace(BA,OICI,FA),ace(BU,OICI,RX),ace(CAPABILITY,0,0x1000A1)];
const USERS_ACES=[ace(SY,OICI,FA),ace(BA,OICI,FA),ace(BU,0,RX),ace(BU,OICIIO,GENERIC_RX),ace(WD,0,RX),ace(WD,OICIIO,GENERIC_RX)];
const PRIVATE_ACES=[ace(ME,OICI,FA),ace(SY,OICI,FA),ace(BA,OICI,FA)];
function binarySid(value:string):Buffer {
  const [,revision,authority,...subs]=value.split('-').map(Number);
  const out=Buffer.alloc(8+subs.length*4);
  out[0]=revision;out[1]=subs.length;out.writeUIntBE(authority,2,6);
  subs.forEach((sub,index)=>out.writeUInt32LE(sub,8+index*4));
  return out;
}
/** Self-relative SECURITY_DESCRIPTOR_RELATIVE, the binary form the product parses. */
function descriptor({owner,control=CONTROL,aces}:Shape):string {
  const records=aces.map(({flags,mask,sid})=>{
    const id=binarySid(sid),header=Buffer.alloc(8);
    header[1]=flags;header.writeUInt16LE(8+id.length,2);header.writeUInt32LE(mask,4);
    return Buffer.concat([header,id]);
  });
  const acl=Buffer.alloc(8);
  acl[0]=2;acl.writeUInt16LE(8+records.reduce((sum,record)=>sum+record.length,0),2);acl.writeUInt16LE(aces.length,4);
  const ownerId=binarySid(owner),header=Buffer.alloc(20),present=(control&4)!==0;
  header[0]=1;header.writeUInt16LE(control,2);header.writeUInt32LE(20,4);header.writeUInt32LE(20+ownerId.length,8);
  if(present) header.writeUInt32LE(20+2*ownerId.length,16);
  return Buffer.concat([header,ownerId,ownerId,...(present?[acl,...records]:[])]).toString('base64');
}
const WINDOWS='C:\\Windows',POWERSHELL=`${WINDOWS}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,onWindows=process.platform==='win32';
function powershell(script:string,input:string) {
  return spawnSync(onWindows?POWERSHELL:'pwsh',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{
    input,encoding:'utf8',windowsHide:true,timeout:60000,
    // The product's bounded environment: a PSModulePath inherited from pwsh breaks Windows PowerShell.
    env:onWindows?{SystemRoot:WINDOWS,WINDIR:WINDOWS,PSModulePath:`${WINDOWS}\\System32\\WindowsPowerShell\\v1.0\\Modules`}:process.env,
  });
}
// Parsing stays outside the evaluator's try and only its own refusal counts, so a
// broken fixture or harness cannot pass a negative row by accident.
const HARNESS=`$ErrorActionPreference='Stop'
${WINDOWS_ACL_EVALUATOR}
$i=[Console]::In.ReadToEnd()|ConvertFrom-Json
try { $raw=[Security.AccessControl.RawSecurityDescriptor]::new([Convert]::FromBase64String($i.sd),0) } catch { [Console]::Out.Write('unparsed'); exit 0 }
try { Test-KherepLevel $raw $i.me $i.private $i.isRoot $i.directory $i.receiptFile; [Console]::Out.Write('ok') } catch { if ($_.Exception.Message -ceq 'refused') { [Console]::Out.Write('refused') } else { [Console]::Out.Write('error:' + $_.Exception.Message) } }
`;
type Level={isRoot?:boolean;private?:boolean;directory?:boolean;};
function evaluate(shape:Shape|string,level:Level={}):string {
  const sd=typeof shape==='string'?shape:descriptor(shape);
  const result=powershell(HARNESS,JSON.stringify({sd,me:ME,private:false,isRoot:false,directory:true,receiptFile:false,...level}));
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
  return result.stdout;
}
/** Windows must run these: only a non-Windows host may skip, and only for a stated reason. */
function evaluatorSkip():string|false {
  if(onWindows) return false;
  const probe=powershell(`[Console]::Out.Write([Security.AccessControl.RawSecurityDescriptor]::new([Convert]::FromBase64String('${CAPTURED_C_ROOT}'),0).Owner.Value)`,'');
  if(probe.error) return 'no pwsh on PATH; these tests are authoritative on Windows PowerShell';
  return probe.stdout===TI?false:'this pwsh cannot parse binary security descriptors; these tests are authoritative on Windows PowerShell';
}
const skip=evaluatorSkip();
const rootShape=(...extra:Ace[]):Shape=>({owner:TI,aces:[...ROOT_ACES,...extra]});
const ROOT={isRoot:true};

test('script text keeps the trusted list and scopes both exceptions to the root (text, not behaviour)',()=>{
  assert.ok(WINDOWS_ACL_SCRIPT.includes(WINDOWS_ACL_EVALUATOR));
  assert.equal(WINDOWS_ACL_SCRIPT.split(`$trusted = @($me, 'S-1-5-18', 'S-1-5-32-544')`).length,2);
  for(const literal of [`'${TI}'`,`'${AU}'`]) {
    const lines=WINDOWS_ACL_SCRIPT.split('\n').filter(line=>line.includes(literal));
    assert.equal(lines.length,1,literal);assert.ok(lines[0].includes('if ($isRoot'),literal);
  }
  assert.equal(WINDOWS_ACL_SCRIPT.includes('S-1-15-'),false,'no rule may depend on the capability SID');
  assert.equal(WINDOWS_ACL_SCRIPT.includes('"'),false,'the script travels on the command line');
});
test('descriptor encoder reproduces the captured drive root byte for byte',()=>{
  assert.equal(descriptor({owner:TI,aces:ROOT_ACES}),CAPTURED_C_ROOT);
});
test('captured default drive root passes at root level',{skip},()=>{
  assert.equal(evaluate(CAPTURED_C_ROOT,ROOT),'ok');
});
test('root variants that add no authority pass',{skip},()=>{
  const merged=[...ROOT_ACES.filter(({sid})=>sid!==AU),ace(AU,0,RX|4)];
  const rows:[string,Shape][]=[['inherit-only add-file',rootShape(ace(AU,OICIIO,2))],['merged Authenticated Users ACE',{owner:TI,aces:merged}],['no capability ACE',{owner:TI,aces:ROOT_ACES.filter(({sid})=>sid!==CAPABILITY)}]];
  for(const [name,shape] of rows) assert.equal(evaluate(shape,ROOT),'ok',name);
});
test('default C:\\Users shape keeps passing',{skip},()=>{
  assert.equal(evaluate({owner:SY,aces:USERS_ACES}),'ok');
});
test('root exceptions do not apply below the root',{skip},()=>{
  assert.equal(evaluate(CAPTURED_C_ROOT,{isRoot:false}),'refused','captured root evaluated as an ordinary ancestor');
  assert.equal(evaluate({owner:SY,aces:[...USERS_ACES,ace(AU,0,4)]}),'refused','create-folder right alone, with a trusted owner');
  assert.equal(evaluate({owner:TI,aces:USERS_ACES}),'refused','TrustedInstaller owner alone');
});
test('broader or differently scoped grants on the root still refuse',{skip},()=>{
  const rows:[string,Shape][]=[
    ['untrusted owner',{owner:OTHER,aces:ROOT_ACES}],
    ['add-file',rootShape(ace(AU,0,2))],['add-file and create-folder',rootShape(ace(AU,0,6))],['generic write',rootShape(ace(AU,0,0x40000000))],
    ['delete child',rootShape(ace(AU,0,0x40))],['write DAC',rootShape(ace(AU,0,0x40000))],
    ['Users',rootShape(ace(BU,0,4))],['Everyone',rootShape(ace(WD,0,4))],['other SID',rootShape(ace(OTHER,0,4))],['capability SID',rootShape(ace(CAPABILITY,0,4))],
    ['container inherit',rootShape(ace(AU,CI,4))],['object and container inherit',rootShape(ace(AU,OICI,4))],['inherited flag',rootShape(ace(AU,0x10,4))],
  ];
  for(const [name,shape] of rows) assert.equal(evaluate(shape,ROOT),'refused',name);
});
test('malformed root shapes fail closed in the evaluator or the parser',{skip},()=>{
  const rows:[string,Shape][]=[['no DACL',{owner:TI,control:NO_DACL,aces:[]}],['65 ACEs',{owner:TI,aces:Array(65).fill(ace(SY,OICI,FA))}],['audit flag',rootShape(ace(SY,0x40,RX))]];
  for(const [name,shape] of rows) assert.match(evaluate(shape,ROOT),/^(refused|unparsed)$/,name);
});
test('private tree rules are unchanged',{skip},()=>{
  const level={private:true};
  assert.equal(evaluate({owner:ME,aces:PRIVATE_ACES},level),'ok','private directory');
  assert.equal(evaluate({owner:ME,aces:[...PRIVATE_ACES,ace(AU,0,4)]},level),'refused','create-folder right');
  assert.equal(evaluate({owner:OTHER,aces:PRIVATE_ACES},level),'refused','other owner');
  assert.equal(evaluate({owner:ME,control:UNPROTECTED,aces:PRIVATE_ACES},level),'refused','unprotected DACL');
  assert.equal(evaluate({owner:ME,aces:[ace(ME,0,RX)]},{private:true,directory:false}),'ok','readable private file');
  assert.equal(evaluate({owner:ME,aces:[ace(SY,0,FA)]},{private:true,directory:false}),'refused','unreadable private file');
});
