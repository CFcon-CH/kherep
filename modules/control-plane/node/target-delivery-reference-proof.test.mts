import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { targetFixture, targetId, TARGET_OWNER, TARGET_T } from './target-delivery-fixture.mts';
import { takeTurn } from './autonomy.mts';
import { claimRoute } from './target-delivery-route.mts';
import { commandProducer } from './target-delivery-producer.mts';
import { cancelUnchargedRoute, recoverUnchargedCancellation } from './target-delivery-cancel.mts';
import { storeMessage, writeJsonAtomic } from './inbox.mts';
import { writeTask, type TaskRecord } from './task-records.mts';
const ALIAS=targetId(999),TASK=targetId(998),facts={policyFingerprint:'a'.repeat(64),lifecycleGeneration:7};
const limits={perHour:20,perDay:100,spacingMs:30000};
function fixture(t:test.TestContext,original=false) {
  const f=targetFixture(t),bin=path.join(f.root,'synthetic-never-executed');fs.writeFileSync(bin,'public');
  const producer=commandProducer({codex:{findCodex:()=>bin,home:f.root}},'codex',['exec'])!;
  const op={version:1 as const,kind:'exec-resume' as const,producer,budgetOwner:TARGET_OWNER,
    execution:{runtime:'codex' as const,sessionId:ALIAS,taskId:null}};
  assert.equal(takeTurn(f.paths,TARGET_OWNER,TARGET_T,limits),'ok');
  fs.writeFileSync(f.budget+'.lock',String(process.pid));
  assert.equal(claimRoute(f.paths,f.rows,op,facts,TARGET_T+1,limits).status,'unknown-fenced');fs.unlinkSync(f.budget+'.lock');
  const handle=JSON.parse(fs.readFileSync(f.reservation,'utf8')).handle;
  assert.throws(()=>cancelUnchargedRoute(f.paths,handle,'spacing',{step:at=>{if(at==='receipt')throw Error('synthetic interruption');}}));
  // Explicitly plant the accepted alias-only contract. Ordinary reachability is UNKNOWN.
  if(!original)fs.unlinkSync(f.reservation);
  const {binding:_binding,...unbound}=f.rows[0];
  const next=storeMessage(f.paths.inbox,{...unbound,messageId:targetId(801),text:'synthetic next group'},TARGET_T);
  const task=(reference=true):TaskRecord=>({taskId:TASK,name:'task-'+TASK.slice(0,8),runtime:'codex',sessionId:ALIAS,
    local:'intercom',cwd:f.root,permissionMode:'default',state:'done',startedAt:new Date(TARGET_T).toISOString(),
    updatedAt:new Date(TARGET_T).toISOString(),deadline:new Date(TARGET_T+60000).toISOString(),...(reference?{targetAttempt:handle}:{})});
  const alias=path.join(f.paths.dir,'codex-native-pending',ALIAS+'.json');
  const receipt=path.join(f.paths.dir,'target-delivery-groups',TARGET_OWNER,handle.groupId+'.cancel.json');
  return {...f,handle,op,next,task,alias,receipt,taskFile:path.join(f.paths.tasks,TASK+'.json'),
    claim:()=>claimRoute(f.paths,[next],op,facts,TARGET_T+30001,limits)};
}
type Fixture=ReturnType<typeof fixture>;
function taskDescriptors(t:test.TestContext,f:Fixture):Set<number> {
  const fds=new Set<number>(),open=fs.openSync;
  t.mock.method(fs,'openSync',((file:unknown,...args:unknown[])=>{
    const fd=Reflect.apply(open,fs,[file,...args]);if(file===f.taskFile)fds.add(fd);else fds.delete(fd);return fd;
  }) as typeof open);return fds;
}
function snapshot(f:Fixture) {
  return [f.reservation,f.alias,f.receipt,f.budget].map(file=>fs.existsSync(file)?fs.readFileSync(file).toString('hex'):null);
}
function retained(f:Fixture,run:()=>unknown) {
  const before=snapshot(f);run();assert.deepEqual(snapshot(f),before);
  assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).turns.length,1);
}
for(const original of [false,true])for(const entry of ['direct','claim','cancel'] as const)
  for(const kind of ['message','task','malformed-task','unreadable-task','malformed-inbox','unavailable-inbox'] as const)
    if(entry!=='cancel'||original)test(`reference proof fences ${kind}, original=${original}, entry=${entry}`,t=>{
      const f=fixture(t,original);
      if(kind==='message')writeJsonAtomic(path.join(f.paths.inbox,f.rows[0].messageId+'.json'),{...f.rows[0],targetAttempt:f.handle});
      if(kind.includes('task'))writeTask(f.paths,f.task(),TARGET_T);
      if(kind==='malformed-task')fs.writeFileSync(f.taskFile,'{');
      if(kind==='malformed-inbox')fs.writeFileSync(path.join(f.paths.inbox,f.rows[0].messageId+'.json'),'{');
      const before=snapshot(f),recordFiles=[...f.rows.map(r=>path.join(f.paths.inbox,r.messageId+'.json')),f.taskFile];
      const primaryBytes=recordFiles.map(file=>fs.existsSync(file)?fs.readFileSync(file).toString('hex'):null);
      if(kind==='unreadable-task'){
        const read=fs.readFileSync,fds=taskDescriptors(t,f);t.mock.method(fs,'readFileSync',((file:unknown,...args:unknown[])=>{
          if(file===f.taskFile||typeof file==='number'&&fds.has(file))throw Object.assign(Error('synthetic private failure'),{code:'EACCES'});
          return Reflect.apply(read,fs,[file,...args]);
        }) as typeof read);
      }
      if(kind==='unavailable-inbox'){
        const read=fs.readdirSync;t.mock.method(fs,'readdirSync',((dir:unknown,...args:unknown[])=>{
          if(dir===f.paths.inbox)throw Object.assign(Error('synthetic private failure'),{code:'EACCES'});
          return Reflect.apply(read,fs,[dir,...args]);
        }) as typeof read);
      }
      if(entry==='cancel')assert.throws(()=>cancelUnchargedRoute(f.paths,f.handle,'spacing'),/^Error: (current reference exists|reference proof unavailable)$/);
      else if(entry==='direct')assert.throws(()=>recoverUnchargedCancellation(f.paths,f.handle),/^Error: (current reference exists|reference proof unavailable)$/);
      else assert.equal(f.claim().status,'unknown-fenced');
      t.mock.restoreAll();assert.deepEqual(snapshot(f),before);
      assert.deepEqual(recordFiles.map(file=>fs.existsSync(file)?fs.readFileSync(file).toString('hex'):null),primaryBytes);
      assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).turns.length,1);
    });
for(const entry of ['direct','claim'] as const)test(`clean alias recovery with unrelated valid records and sidecars succeeds once via ${entry}`,t=>{
  const f=fixture(t);writeTask(f.paths,f.task(false),TARGET_T);
  const unrelated={...f.handle,reservationId:targetId(772)};
  writeJsonAtomic(path.join(f.paths.inbox,f.rows[0].messageId+'.json'),{...f.rows[0],targetAttempt:unrelated});
  for(const dir of ['receipts','progress','proxied'])fs.mkdirSync(path.join(f.paths.inbox,dir));
  if(entry==='direct'){
    assert.equal(recoverUnchargedCancellation(f.paths,f.handle),true);assert.equal(fs.existsSync(f.alias),false);
    assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).turns.length,1);
  }else{
    assert.equal(f.claim().status,'granted');assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).turns.length,2);
    assert.notEqual(JSON.parse(fs.readFileSync(f.alias,'utf8')).handle.groupId,f.handle.groupId);
    assert.notEqual(f.claim().status,'granted');assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).turns.length,2);
  }
});
for(const kind of ['invalid-handle','invalid-task-metadata','ambiguous-file','oversize-record','capped-population','disappearing-record','changing-record','changing-directory'] as const)
  test(`incomplete reference proof retains all bytes: ${kind}`,t=>{
    const f=fixture(t);writeTask(f.paths,f.task(false),TARGET_T);
    if(kind==='invalid-handle')writeTask(f.paths,{...f.task(false),targetAttempt:{...f.handle,attemptToken:'invalid'}},TARGET_T);
    if(kind==='invalid-task-metadata')fs.writeFileSync(f.taskFile,JSON.stringify({taskId:TASK}));
    if(kind==='ambiguous-file')fs.writeFileSync(path.join(f.paths.tasks,'unknown.json'),'{}');
    if(kind==='oversize-record')fs.writeFileSync(f.taskFile,' '.repeat(128*1024+1));
    if(kind==='capped-population'){
      const read=fs.readdirSync;t.mock.method(fs,'readdirSync',((dir:unknown,...args:unknown[])=>dir===f.paths.tasks?
        Array.from({length:4097},(_,i)=>targetId(i+10000)+'.json'):Reflect.apply(read,fs,[dir,...args])) as typeof read);
    }
    if(kind==='disappearing-record'||kind==='changing-record'){
      const read=fs.readFileSync,fds=taskDescriptors(t,f);let changed=false;t.mock.method(fs,'readFileSync',((file:unknown,...args:unknown[])=>{
        const bytes=Reflect.apply(read,fs,[file,...args]);
        if((file===f.taskFile||typeof file==='number'&&fds.has(file))&&!changed){changed=true;
          if(kind==='disappearing-record')fs.unlinkSync(f.taskFile);else writeTask(f.paths,f.task(),TARGET_T);}
        return bytes;
      }) as typeof read);
    }
    if(kind==='changing-directory'){
      const read=fs.readdirSync;let calls=0;t.mock.method(fs,'readdirSync',((dir:unknown,...args:unknown[])=>{
        const names=Reflect.apply(read,fs,[dir,...args]);
        return dir===f.paths.tasks&&++calls>1?[...names,targetId(771)+'.json']:names;
      }) as typeof read);
    }
    retained(f,()=>assert.equal(f.claim().status,'unknown-fenced'));t.mock.restoreAll();
  });
for(const kind of ['foreign-alias','changed-receipt','stored-debit','changed-budget-id','older-budget-revision'] as const)
  test(`cancellation retains existing identity/debit fence: ${kind}`,t=>{
    const f=fixture(t,true);
    if(kind==='foreign-alias')fs.writeFileSync(f.alias,JSON.stringify({version:4,owner:ALIAS,handle:{...f.handle,reservationId:targetId(773)}}));
    if(kind==='changed-receipt'){
      const read=fs.readFileSync;let calls=0;t.mock.method(fs,'readFileSync',((file:unknown,...args:unknown[])=>{
        const bytes=Reflect.apply(read,fs,[file,...args]);
        if(file===f.receipt&&++calls===3){const r=JSON.parse(bytes.toString());r.reason='exhausted';return JSON.stringify(r);}
        return bytes;
      }) as typeof read);
    }else if(kind!=='foreign-alias'){
      const b=JSON.parse(fs.readFileSync(f.budget,'utf8'));
      if(kind==='stored-debit')b.groupDebits.push({groupId:f.handle.groupId,groupFingerprint:f.handle.groupFingerprint,reservationId:f.handle.reservationId,chargedAt:TARGET_T});
      if(kind==='changed-budget-id')b.budgetId=targetId(774);
      if(kind==='older-budget-revision'){const r=JSON.parse(fs.readFileSync(f.receipt,'utf8'));r.proof.revision=b.revision+1;fs.writeFileSync(f.receipt,JSON.stringify(r));}
      fs.writeFileSync(f.budget,JSON.stringify(b));
    }
    retained(f,()=>assert.equal(f.claim().status,'unknown-fenced'));t.mock.restoreAll();
  });

for(const namespace of ['inbox','tasks'] as const)for(const kind of ['missing','read-failed','malformed-shape','symlink','directory-replaced','absent-then-created','deadline','known-temp'] as const)
  test(`namespace proof ${namespace}: ${kind}`,t=>{
    const f=fixture(t),dir=f.paths[namespace];
    if(namespace==='tasks')writeTask(f.paths,f.task(false),TARGET_T);
    const file=path.join(dir,namespace==='tasks'?TASK+'.json':f.rows[0].messageId+'.json');
    if(kind==='missing'||kind==='absent-then-created')fs.rmSync(dir,{recursive:true});
    if(kind==='malformed-shape')fs.writeFileSync(file,JSON.stringify({unrelated:'metadata unavailable'}));
    if(kind==='symlink'){const real=dir+'-real';fs.renameSync(dir,real);fs.symlinkSync(real,dir,'dir');}
    if(kind==='read-failed'){
      const read=fs.readdirSync;t.mock.method(fs,'readdirSync',((value:unknown,...args:unknown[])=>{
        if(value===dir)throw Object.assign(Error('synthetic private details'),{code:'EIO'});return Reflect.apply(read,fs,[value,...args]);
      }) as typeof read);
    }
    if(kind==='directory-replaced'||kind==='absent-then-created'){
      const stat=fs.lstatSync;let reads=0;t.mock.method(fs,'lstatSync',((value:unknown,...args:unknown[])=>{
        if(value===dir&&++reads===2){
          if(kind==='directory-replaced')fs.renameSync(dir,dir+'-old');fs.mkdirSync(dir);
        }
        return Reflect.apply(stat,fs,[value,...args]);
      }) as typeof stat);
    }
    if(kind==='deadline'){let at=0;t.mock.method(performance,'now',()=>at+=1001);}
    if(kind==='known-temp')fs.writeFileSync(path.join(dir,`.${TASK}.json.${targetId(760)}.tmp`),'incomplete sidecar');
    const before=snapshot(f);
    if(kind==='missing'||kind==='known-temp')assert.equal(recoverUnchargedCancellation(f.paths,f.handle),true);
    else assert.throws(()=>recoverUnchargedCancellation(f.paths,f.handle),/^Error: reference proof unavailable$/);
    t.mock.restoreAll();
    if(kind!=='missing'&&kind!=='known-temp')assert.deepEqual(snapshot(f),before);
    assert.equal(JSON.parse(fs.readFileSync(f.budget,'utf8')).turns.length,1);
  });

for(const changed of ['owner','alias','receipt'] as const)test(`replacement during reference proof is fenced before any cancellation write: ${changed}`,t=>{
  const f=fixture(t,true),read=fs.readFileSync,fds=taskDescriptors(t,f);writeTask(f.paths,f.task(false),TARGET_T);
  const before=snapshot(f);let replacement:Buffer|undefined;
  const file=changed==='owner'?f.reservation:changed==='alias'?f.alias:f.receipt;
  t.mock.method(fs,'readFileSync',((value:unknown,...args:unknown[])=>{
    const bytes=Reflect.apply(read,fs,[value,...args]);
    if(typeof value==='number'&&fds.has(value)&&!replacement){
      const record=JSON.parse(Reflect.apply(read,fs,[file,'utf8']).toString());
      if(changed==='receipt')record.reason='exhausted';else record.handle.reservationId=targetId(763);
      replacement=Buffer.from(JSON.stringify(record));fs.writeFileSync(file,replacement);
    }
    return bytes;
  }) as typeof read);
  assert.equal(f.claim().status,'unknown-fenced');t.mock.restoreAll();assert.ok(replacement);
  const after=snapshot(f);before[[f.reservation,f.alias,f.receipt].indexOf(file)]=replacement.toString('hex');
  assert.deepEqual(after,before);
});
test('aggregate byte bound cannot turn a partial population into absence',t=>{
  const f=fixture(t);fs.mkdirSync(f.paths.tasks);t.mock.method(performance,'now',()=>0);
  for(let i=0;i<260;i++){const id=targetId(10000+i);
    fs.writeFileSync(path.join(f.paths.tasks,id+'.json'),JSON.stringify({...f.task(false),taskId:id,padding:'x'.repeat(130000)}));}
  retained(f,()=>assert.throws(()=>recoverUnchargedCancellation(f.paths,f.handle),/^Error: reference proof unavailable$/));
});
