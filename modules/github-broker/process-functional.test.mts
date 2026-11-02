import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
const sourceRoot=import.meta.dirname;
const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
type Runtime='claude'|'codex';
type Phase='normal'|'pending'|'effect'|'known'|'reader'|'reader-fail';
type Reply=Record<string,unknown>;
const matrix:Record<string,unknown>[]=[];
const cleanup:Record<string,unknown>[]=[];
const originalHome=process.env.HOME,originalCodexHome=process.env.CODEX_HOME;
function fixture(t:TestContext) {
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'kherep-732-process-')));
  const root=path.join(home,'.kherep','github-broker');fs.mkdirSync(path.join(root,'keys'),{recursive:true,mode:0o700});
  const runtimes=Object.fromEntries(['claude','codex'].map((runtime,index)=>[runtime,{appId:10+index,clientId:`Iv.fixture${index}`,botId:20+index,botLogin:`fixture${index}[bot]`,installationId:30+index,keyRef:`fixture${index}.pem`,operations:['issue.create','issue.comment','issue.update'],repositories:[{slug:'example/project',id:40}]}]));
  fs.writeFileSync(path.join(root,'policy.json'),JSON.stringify({version:1,enabled:true,runtimes}),{mode:0o600});
  for(const name of ['fixture0.pem','fixture1.pem'])fs.writeFileSync(path.join(root,'keys',name),key,{mode:0o600});
  const children:ReturnType<typeof spawn>[]=[];
  const lines=(name:string):Reply[]=>{const file=path.join(home,`${name}.jsonl`);return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];};
  const receipts=():Reply[]=>{const dir=path.join(root,'receipts');return fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'))):[];};
  async function launch(runtime:Runtime,request:Reply,phase:Phase='normal') {
    const child=spawn(process.execPath,['--import',path.join(sourceRoot,'process-functional.fixture.mts'),path.join(sourceRoot,`github-${runtime}.mts`)],{env:{},stdio:['pipe','pipe','pipe','ipc']});children.push(child);
    let stdout='',stderr='',closed=false;
    const events:string[]=[];child.on('message',(message:unknown)=>{if(message&&typeof message==='object'&&'event'in message)events.push(String(message.event));});
    child.stdout!.on('data',chunk=>{stdout+=String(chunk);if(stdout.length>16384)child.kill('SIGKILL');});
    child.stderr!.on('data',chunk=>{stderr+=String(chunk);if(stderr.length>8192)child.kill('SIGKILL');});
    const completed=new Promise<{code:number|null;signal:NodeJS.Signals|null;reply:Reply}>(resolve=>{
      child.once('error',()=>resolve({code:86,signal:null,reply:{error:'owned-child-launch-failed'}}));
      child.once('close',(code,signal)=>{closed=true;let reply:Reply={};try{reply=JSON.parse(stdout);}catch{/* A killed child has no invented receipt. */}resolve({code,signal,reply});});
    });
    const timer=setTimeout(()=>{if(!closed)child.kill('SIGKILL');},15000);completed.finally(()=>clearTimeout(timer));
    async function event(name:string):Promise<void> {
      const deadline=Date.now()+10000;
      while(!events.includes(name)&&!closed&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
      assert.ok(events.includes(name),`missing owned fixture event ${name}; closed=${closed}; stderrBytes=${stderr.length}`);
    }
    const instance=randomUUID();
    child.send({home,sourceRoot,phase,instance});await event('isolated');
    assert.equal(lines('calls').filter(c=>c.instance===instance).length,0,'no provider access before import acknowledgement');
    // No production code can import until this explicit parent acknowledgement.
    assert.equal(events.includes('fixture-failed'),false);assert.equal(stdout,'');assert.equal(stderr,'');
    child.send('import');child.stdin!.end(JSON.stringify(request));
    return {child,event,events,completed,isClosed:()=>closed,async result(){const value=await completed;assert.equal(stderr.length,0,'unexpected child stderr');return value;},async terminate(){assert.ok(child.pid);assert.equal(child.kill('SIGKILL'),true);const value=await completed;assert.equal(value.signal,'SIGKILL');return value;}};
  }
  t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'close');}fs.rmSync(home,{recursive:true,force:true});cleanup.push({ownedChildren:children.length,allClosed:children.every(child=>child.exitCode!==null||child.signalCode!==null),fixtureRemoved:!fs.existsSync(home)});});
  function snapshot(){const dir=path.join(root,'receipts');return fs.existsSync(dir)?fs.readdirSync(dir).sort().map(name=>{const file=path.join(dir,name),st=fs.lstatSync(file);return {name,bytes:fs.readFileSync(file,'utf8'),ino:st.ino,dev:st.dev};}):[];}
  return {home,root,lines,receipts,launch,children,snapshot};
}
const create=(operationId=randomUUID(),title='Synthetic'):Reply=>({operationId,repository:'example/project',operation:'issue.create',title,body:'Body'});
const verify=(request:Reply):Reply=>({operationId:request.operationId,repository:request.repository,operation:'verify'});
for(const runtime of ['claude','codex'] as const) {
  test(`${runtime}: real concurrent duplicate admits one mutation and exact conflict`,{timeout:30000},async t=>{
    const f=fixture(t),request=create(),first=await f.launch(runtime,request,'pending');await first.event('pending');
    assert.equal(f.receipts()[0].status,'pending');assert.equal(f.lines('effects').length,0);
    const second=await(await f.launch(runtime,request)).result();assert.equal(second.reply.error,'operation-busy');assert.equal(f.lines('effects').length,0);
    first.child.send('continue');const completed=await first.result();assert.equal(completed.code,0);assert.equal(completed.reply.status,'verified');
    const repeated=await(await f.launch(runtime,request)).result();assert.equal(repeated.reply.ok,true);
    const conflict=await(await f.launch(runtime,{...request,title:'Changed'})).result();assert.equal(conflict.reply.error,'operation-conflict');
    assert.equal(f.lines('effects').length,1);assert.deepEqual(f.lines('effects')[0].body,{title:'Synthetic',body:'Body'});
    matrix.push({runtime,case:'concurrent duplicate',status:'PASS',mutations:1,second:second.reply.error,conflict:conflict.reply.error});
  });
  for(const phase of ['pending','effect','known'] as const)test(`${runtime}: owned termination at ${phase} boundary preserves truthful no replay`,{timeout:30000},async t=>{
    const f=fixture(t),request=create(),owned=await f.launch(runtime,request,phase);await owned.event(phase);
    const before=f.receipts()[0];assert.equal(before.status,phase==='known'?'known':'pending');assert.equal(f.lines('effects').length,phase==='pending'?0:1);
    if(phase==='known'){assert.equal(before.targetId,runtime==='claude'?90:91);assert.equal(before.issueNumber,7);}
    const saved=f.snapshot();await owned.terminate();assert.deepEqual(f.snapshot(),saved);const callsBefore=f.lines('calls').length;
    const attempt=await f.launch(runtime,phase==='known'?verify(request):request),retry=await attempt.result();
    assert.equal(f.lines('effects').length,phase==='pending'?0:1);
    if(phase==='known'){assert.equal(retry.code,0);assert.equal(retry.reply.ok,true);assert.equal(retry.reply.status,'verified');assert.equal(retry.reply.targetId,before.targetId);assert.equal(retry.reply.issueNumber,7);assert.equal(attempt.events.some(e=>e.startsWith('state-write:')),false);}
    else {assert.equal(retry.reply.status,undefined);const count=f.lines('calls').length,reader=await f.launch(runtime,verify(request)),unknown=await reader.result();assert.equal(unknown.reply.error,'outcome-unknown');assert.equal(unknown.reply.targetId,undefined);assert.equal(unknown.reply.issueNumber,undefined);assert.equal(f.lines('calls').length,count);assert.equal(reader.events.some(e=>e.startsWith('state-write:')),false);}
    assert.deepEqual(f.snapshot(),saved);
    const repeat=await(await f.launch(runtime,request)).result();assert.equal(repeat.reply.error,'operation-busy');
    const retryCalls=f.lines('calls').slice(callsBefore);
    // A different operation remains usable even while the crashed operation's
    // lock is retained. This does not remove, steal or modify the stale lock.
    const unaffected=await(await f.launch(runtime,create())).result();assert.equal(unaffected.reply.ok,true);
    const row={runtime,case:phase,status:'PASS',persistedStatus:before.status,preservedId:before.targetId??null,retryError:retry.reply.error??null,outcome:phase==='known'?'fresh verified result; disk remains known':'UNKNOWN',mutationCountBeforeControl:phase==='pending'?0:1,freshReadbackCalls:retryCalls.filter(c=>c.method==='GET'&&String(c.endpoint).includes('/issues/')).length,unaffectedOperation:'PASS'};
    matrix.push(row);
    if(phase==='known') {
      // Required recovery outcome: fresh read-only verify must return the known
      // target. A stale lock blocking it is a real failure, never success.
      assert.equal(retry.reply.ok,true,'known target must permit fresh read-only verification after owned process termination');
      assert.equal(retry.reply.targetId,before.targetId);assert.ok(retryCalls.some(c=>c.method==='GET'&&c.endpoint==='/repos/example/project/issues/7'));
    } else {assert.equal(retry.reply.ok,false);assert.ok(['outcome-unknown','operation-busy'].includes(String(retry.reply.error)));}
  });
  test(`${runtime}: active pending owner permits UNKNOWN reader without changing admission`,{timeout:30000},async t=>{
    const f=fixture(t),request=create(),writer=await f.launch(runtime,request,'pending');await writer.event('pending');const saved=f.snapshot(),count=f.lines('calls').length;
    const reader=await f.launch(runtime,verify(request)),result=await reader.result();assert.equal(result.reply.error,'outcome-unknown');assert.equal(result.reply.targetId,undefined);assert.equal(result.reply.status,undefined);assert.equal(f.lines('calls').length,count);assert.deepEqual(f.snapshot(),saved);assert.equal(reader.events.some(e=>e.startsWith('state-write:')),false);assert.equal(writer.isClosed(),false);
    writer.child.send('continue');await writer.event('released:pending');assert.equal((await writer.result()).reply.ok,true);assert.equal(f.lines('effects').length,1);matrix.push({runtime,case:'active pending reader',status:'PASS'});
  });
  test(`${runtime}: reader finishes before active known writer`,{timeout:30000},async t=>{
    const f=fixture(t),request=create(),writer=await f.launch(runtime,request,'known');await writer.event('known');const saved=f.snapshot();
    const reader=await f.launch(runtime,verify(request)),result=await reader.result();assert.equal(result.reply.status,'verified');assert.equal(result.reply.targetId,f.receipts()[0].targetId);assert.equal(writer.isClosed(),false);assert.deepEqual(f.snapshot(),saved);assert.equal(reader.events.some(e=>e.startsWith('state-write:')),false);
    assert.equal((await(await f.launch(runtime,request)).result()).reply.error,'operation-busy');writer.child.send('continue');await writer.event('released:known');assert.equal((await writer.result()).reply.ok,true);assert.equal(f.receipts()[0].status,'verified');assert.equal(f.lines('effects').length,1);matrix.push({runtime,case:'reader before writer',status:'PASS'});
  });
  for(const phase of ['reader','reader-fail'] as const)test(`${runtime}: active writer finishes before ${phase}`,{timeout:30000},async t=>{
    const f=fixture(t),request=create(),writer=await f.launch(runtime,request,'known');await writer.event('known');const reader=await f.launch(runtime,verify(request),phase);await reader.event('reader');
    writer.child.send('continue');await writer.event('released:known');assert.equal((await writer.result()).reply.ok,true);const saved=f.snapshot();assert.equal(f.receipts()[0].status,'verified');
    reader.child.send('continue');await reader.event('released:reader');const result=await reader.result();assert.equal(result.reply.ok,phase==='reader');
    if(phase==='reader')assert.equal(result.reply.status,'verified');else for(const key of ['targetId','issueNumber','status','attribution'])assert.equal(result.reply[key],undefined);
    assert.deepEqual(f.snapshot(),saved);assert.equal(reader.events.some(e=>e.startsWith('state-write:')),false);assert.equal(f.lines('effects').length,1);matrix.push({runtime,case:'writer before '+phase,status:'PASS'});
  });
  test(`${runtime}: dual readers independently verify a retained known snapshot`,{timeout:30000},async t=>{
    const f=fixture(t),request=create(),writer=await f.launch(runtime,request,'known');await writer.event('known');await writer.terminate();const saved=f.snapshot();
    const a=await f.launch(runtime,verify(request),'reader'),b=await f.launch(runtime,verify(request),'reader');await Promise.all([a.event('reader'),b.event('reader')]);
    for(const reader of [a,b])reader.child.send('continue');for(const reader of [a,b]){await reader.event('released:reader');assert.equal((await reader.result()).reply.status,'verified');assert.equal(reader.events.some(e=>e.startsWith('state-write:')),false);}
    assert.deepEqual(f.snapshot(),saved);assert.equal(f.lines('effects').length,1);matrix.push({runtime,case:'dual retained-lock readers',status:'PASS'});
  });
  test(`${runtime}: missing directory and receipt verification creates no local state`,{timeout:30000},async t=>{
    const f=fixture(t),request=verify(create()),dir=path.join(f.root,'receipts');
    for(const exists of [false,true]){if(exists)fs.mkdirSync(dir,{mode:0o700});const reader=await f.launch(runtime,request),result=await reader.result();assert.equal(result.reply.error,'receipt-invalid');assert.equal(result.reply.targetId,undefined);assert.equal(result.reply.issueNumber,undefined);assert.equal(fs.existsSync(dir),exists);if(exists)assert.deepEqual(fs.readdirSync(dir),[]);assert.equal(reader.events.some(e=>e.startsWith('state-write:')),false);assert.equal(f.lines('calls').length,0);}
    matrix.push({runtime,case:'missing readonly state',status:'PASS',writes:0,providerCalls:0});
  });
  test(`${runtime}: unaffected normal operation completes through the real CLI`,{timeout:15000},async t=>{
    const f=fixture(t),result=await(await f.launch(runtime,create())).result();assert.equal(result.code,0);assert.equal(result.reply.ok,true);assert.equal(f.receipts()[0].status,'verified');assert.equal(f.lines('effects').length,1);
    matrix.push({runtime,case:'normal completion',status:'PASS',mutations:1});
  });
}
test('one UUID uses the separately approved runtime/App namespaces',{timeout:30000},async t=>{
  const f=fixture(t),request=create();for(const runtime of ['claude','codex'] as const){const result=await(await f.launch(runtime,request)).result();assert.equal(result.reply.ok,true);assert.equal(result.reply.runtime,runtime);}
  assert.equal(f.receipts().length,2);assert.equal(f.lines('effects').length,2);matrix.push({case:'separate runtime/App namespaces',status:'PASS',businessEffects:2});
});
test('preload refusal prevents production import and leaves parent environment untouched',{timeout:15000},async t=>{
  const f=fixture(t),child=spawn(process.execPath,['--import',path.join(sourceRoot,'process-functional.fixture.mts'),path.join(sourceRoot,'github-claude.mts')],{env:{},stdio:['pipe','pipe','pipe','ipc']});f.children.push(child);
  let outputBytes=0,failed=false;child.stdout!.on('data',b=>{outputBytes+=b.length;});child.stderr!.on('data',b=>{outputBytes+=b.length;});child.on('message',(m:unknown)=>{if(m&&typeof m==='object'&&'event'in m&&m.event==='fixture-failed')failed=true;});
  const done=once(child,'close'),timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  child.send({home:'/__forbidden_fixture_canary__',sourceRoot,phase:'normal'});child.stdin!.end(JSON.stringify(create()));
  const [code]=await done;clearTimeout(timer);assert.equal(code,86);assert.equal(failed,true);assert.equal(outputBytes,0);assert.equal(f.receipts().length,0);assert.equal(f.lines('effects').length,0);assert.ok(process.env.HOME===originalHome&&process.env.CODEX_HOME===originalCodexHome,'parent environment unchanged');
  matrix.push({case:'preload refusal',status:'PASS',productionImported:false,mutations:0});
});
test.after(()=>{process.stdout.write(`PROCESS-CASE-MATRIX ${JSON.stringify(matrix)}\nPROCESS-CLEANUP ${JSON.stringify(cleanup)}\n`);});
