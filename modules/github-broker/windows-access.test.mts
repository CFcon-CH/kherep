import assert from 'node:assert/strict';
import test from 'node:test';
import { checkWindowsAccess, WINDOWS_ACL_SCRIPT } from './windows-access.mts';
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
test('native Windows ACL positive and negative shapes remain an explicit separate gate',{skip:'native provisioning is not authorized by source/mock scope'},()=>{
  // Synthetic native provisioning needs separate explicit authority. Never turn
  // the fixed-status mock above into actual ACL-enforcement evidence.
  assert.fail('native fixture provisioning is not authorized by the source/mock brief');
});
