import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {successorNode} from './target-resume-fixture.mts';
import {deliver,missListings,SESSION} from './closed-fixture.mts';
import {deliverToClosed} from './closed-delivery.mts';
import {advanceTargetResume} from './target-resume.mts';
import {getMessage} from './inbox.mts';
import {runMsg} from './msg-cli.mts';
import {recordCodexSession} from './codex-sessions.mts';
import path from 'node:path';
import {withRoute} from './target-delivery-route.mts';
import {budgetFile} from './budget-store.mts';
import {killSwitch} from './wake-hook.mts';
import type {TargetResumePort} from './target-resume-port.mts';

test('oversized first original member refuses complete input before any native effect',async t=>{
 const n=successorNode(t,'claude-code'),body='COMPLETE-START-'+ 'x'.repeat(8192)+'-COMPLETE-END';
 const id=deliver(n,{text:body});await deliverToClosed(n.deps());
 const result=await advanceTargetResume(n.deps(),SESSION);
 assert.equal(n.control.effects,0);assert.deepEqual(n.control.inputs,[]);assert.equal(n.queues.length,0);
 assert.equal(result.status,'refused');assert.equal(result.reason,'original-input-incomplete');
 assert.equal(getMessage(n.paths.inbox,id)?.state,'accepted');
});

for(const initial of ['original-processing','unavailable','unknown'] as const)test('direct original '+initial+' retries only proven no-effect exclusion',async t=>{
 const n=successorNode(t,'claude-code'),prepare=n.deps().targetResumePort.prepare.bind(n.deps().targetResumePort);
 let inspections=0,blocked=true;
 const port:TargetResumePort={async prepare(target){const p=await prepare(target);if(p.status!=='prepared')return p;return {...p,async withRetiredPointerFence(expected,consume){inspections++;return blocked?{status:initial}:p.withRetiredPointerFence!(expected,consume);}};}};
 const deps=()=>({...n.deps(),targetResumePort:port}),id=deliver(n,{text:'RETRY-COMPLETE-MEMBER'});
 await deliverToClosed(deps());assert.equal(n.control.effects,0);assert.equal(n.control.inputs.length,0);
 const h=getMessage(n.paths.inbox,id)!.targetAttempt!,budget=withRoute(n.paths,h,s=>s.budget);
 blocked=false;const result=await advanceTargetResume(deps(),SESSION);
 assert.equal(result.status,initial==='unknown'?'unknown-fenced':'resumed-original-awaiting-completion');
 assert.equal(inspections,initial==='unknown'?1:2);assert.equal(n.control.effects,initial==='unknown'?0:1);
 if(initial!=='unknown')assert.ok(n.control.inputs[0].includes('RETRY-COMPLETE-MEMBER'));
 await advanceTargetResume(deps(),SESSION);assert.equal(n.control.effects,initial==='unknown'?0:1);
 assert.equal(n.queues.length,0);assert.deepEqual(withRoute(n.paths,h,s=>s.budget),budget);
});

test('direct no-effect retry rechecks fresh kill guard before a native effect',async t=>{
 const n=successorNode(t,'claude-code'),prepare=n.deps().targetResumePort.prepare.bind(n.deps().targetResumePort);let blocked=true;
 const port:TargetResumePort={async prepare(target){const p=await prepare(target);if(p.status!=='prepared')return p;return {...p,async withRetiredPointerFence(expected,consume){return blocked?{status:'original-processing'}:p.withRetiredPointerFence!(expected,consume);}};}};
 deliver(n);await deliverToClosed({...n.deps(),targetResumePort:port});blocked=false;fs.writeFileSync(killSwitch(n.paths),'');
 assert.equal((await advanceTargetResume({...n.deps(),targetResumePort:port},SESSION)).status,'unknown-fenced');assert.equal(n.control.effects,0);assert.deepEqual(n.control.inputs,[]);
});

for(const runtime of ['codex','claude-code'] as const)test('actual '+runtime+' original input carries exact offers usable ACK and completes without inbox fetch',async t=>{
 const n=successorNode(t,runtime),bodies=['FIRST-COMPLETE-MEMBER','SECOND-COMPLETE-MEMBER'],ids=bodies.map(text=>deliver(n,{text}));
 await deliverToClosed(n.deps());if(runtime==='codex'){n.tick(600000);missListings(n,3,n.deps().now!());assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'resumed-original-awaiting-completion');}
 const h=getMessage(n.paths.inbox,ids[0])!.targetAttempt!,budget=fs.readFileSync(budgetFile(n.paths,SESSION));
 assert.equal(n.control.inputs.length,1);const input=n.control.inputs[0];for(const body of bodies)assert.ok(input.includes(body));
 for(const id of ids)assert.ok(input.includes(id));assert.ok(Buffer.byteLength(input)<=6*1024);
 assert.ok(ids.every(id=>getMessage(n.paths.inbox,id)?.state==='offered'));
 n.control.completed=true;assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'resumed-original-awaiting-completion');
 const command=input.match(/msg inbox --ack ([0-9a-f-]{36}) --from ([0-9a-f-]{36})/);assert.ok(command,'actual resumed input must provide its usable exact ACK');
 assert.equal(command[2],SESSION);
 const unrelated=deliver(n,{text:'UNRELATED-LATER-MEMBER'}),unrelatedBefore=fs.readFileSync(path.join(n.paths.inbox,unrelated+'.json'));
 if(runtime==='codex')recordCodexSession(n.paths,SESSION,n.workspace,n.deps().now!(),'auto','SessionStart');
 n.control.completed=false;
 const env=runtime==='codex'?{CODEX_THREAD_ID:SESSION}:{CLAUDE_CODE_SESSION_ID:SESSION};
 const args=['inbox','--ack',command[1],'--from',command[2]];
 for(let round=0;round<2;round++)assert.equal(await runMsg(args,{paths:n.paths,env,now:n.deps().now,out:()=>{},err:()=>{},processTable:()=>null}),0);
 assert.deepEqual(fs.readFileSync(path.join(n.paths.inbox,unrelated+'.json')),unrelatedBefore);
 assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'resumed-original-awaiting-completion');
 n.control.completed=true;
 assert.ok(ids.every(id=>getMessage(n.paths.inbox,id)?.state==='delivered'));
 assert.equal((await advanceTargetResume(n.deps(),SESSION)).status,'completed-original');assert.equal(n.control.effects,1);
 assert.deepEqual(fs.readFileSync(budgetFile(n.paths,SESSION)),budget);
 assert.throws(()=>withRoute(n.paths,h,s=>s));
});

const OTHER='aaaa0000-0000-4000-8000-000000000099';
async function claudeInput(t:test.TestContext){
 const n=successorNode(t,'claude-code'),id=deliver(n);await deliverToClosed(n.deps());
 const command=n.control.inputs[0].match(/msg inbox --ack ([0-9a-f-]{36}) --from ([0-9a-f-]{36})/);assert.ok(command);
 const token=command[1],h=getMessage(n.paths.inbox,id)!.targetAttempt!;
 const call=(args:string[],env:NodeJS.ProcessEnv,table:()=>import('./launch-mode.mts').ProcessTable|null=()=>null)=>runMsg(['inbox',...args],{paths:n.paths,env,now:n.deps().now,out:()=>{},err:()=>{},processTable:table});
 const snapshot=()=>JSON.stringify([fs.readFileSync(path.join(n.paths.inbox,id+'.json'),'utf8'),fs.readFileSync(path.join(n.paths.inbox,'codex-offers',token+'.json'),'utf8'),withRoute(n.paths,h,s=>s),fs.readFileSync(budgetFile(n.paths,SESSION),'utf8')]);
 return {...n,id,token,h,call,snapshot};
}
for(const fault of ['missing-from','mismatch-recorded-codex','alias','absent','undecided','inherited-claude','receive','listing','owner','generation','fingerprint','address'] as const)test('actual Claude ACK rejects '+fault+' without mutations',async t=>{
 const n=await claudeInput(t);let args=['--ack',n.token,'--from',SESSION],env:NodeJS.ProcessEnv={CLAUDE_CODE_SESSION_ID:SESSION};let table:()=>import('./launch-mode.mts').ProcessTable|null=()=>null;
 if(fault==='missing-from')args=['--ack',n.token];
 if(fault==='mismatch-recorded-codex'){env={CLAUDE_CODE_SESSION_ID:OTHER};recordCodexSession(n.paths,SESSION,n.workspace,n.deps().now!(),'auto','SessionStart');}
 if(fault==='alias'){fs.writeFileSync(n.paths.sessions,JSON.stringify({sessions:[{sessionId:SESSION,name:'synthetic-alias'}]}));args=['--ack',n.token,'--from','synthetic-alias'];}
 if(fault==='absent')env={};
 if(fault==='undecided')env={CLAUDE_CODE_SESSION_ID:SESSION,CODEX_THREAD_ID:OTHER,CLAUDE_PID:'200'};
 if(fault==='inherited-claude'){env={CLAUDE_CODE_SESSION_ID:SESSION,CODEX_THREAD_ID:OTHER,CLAUDE_PID:'200'};table=()=>new Map([[process.pid,{ppid:100,args:'node'}],[100,{ppid:200,args:'/synthetic/codex'}],[200,{ppid:1,args:'claude'}]]);}
 if(fault==='receive')args=['--receive','--from',SESSION];
 if(fault==='listing')args=['--from',SESSION];
 if(fault==='owner'){const file=path.join(n.paths.inbox,'codex-offers',n.token+'.json'),r=JSON.parse(fs.readFileSync(file,'utf8'));fs.writeFileSync(file,JSON.stringify({...r,owner:OTHER}));}
 if(['generation','fingerprint','address'].includes(fault)){const file=path.join(n.paths.inbox,n.id+'.json'),r=JSON.parse(fs.readFileSync(file,'utf8'));if(fault==='generation')r.codexOffer.generation=OTHER;if(fault==='fingerprint')r.text+=' altered';if(fault==='address')r.toSession=OTHER;fs.writeFileSync(file,JSON.stringify(r));}
 const before=n.snapshot();assert.equal(await n.call(args,env,table),1);assert.equal(n.snapshot(),before);assert.equal(n.control.effects,1);assert.equal(n.queues.length,0);
});
test('actual ACK uses resolved nested Claude identity and preserves separate recorded Codex fallback',async t=>{
 const n=await claudeInput(t),env={CLAUDE_CODE_SESSION_ID:SESSION,CODEX_THREAD_ID:OTHER,CLAUDE_PID:'200'};
 const table=()=>new Map([[process.pid,{ppid:200,args:'node'}],[200,{ppid:300,args:'claude'}],[300,{ppid:1,args:'/synthetic/codex'}]]);
 assert.equal(await n.call(['--ack',n.token,'--from',SESSION],env,table),0);assert.equal(getMessage(n.paths.inbox,n.id)?.state,'delivered');
 const c=successorNode(t),id=deliver(c);await deliverToClosed(c.deps());c.tick(600000);missListings(c,3,c.deps().now!());await advanceTargetResume(c.deps(),SESSION);
 const token=c.control.inputs[0].match(/msg inbox --ack ([0-9a-f-]{36}) --from /)![1];recordCodexSession(c.paths,SESSION,c.workspace,c.deps().now!(),'auto','SessionStart');
 assert.equal(await runMsg(['inbox','--ack',token,'--from',SESSION],{paths:c.paths,env:{CLAUDE_CODE_SESSION_ID:OTHER,CODEX_THREAD_ID:SESSION,CLAUDE_PID:'200'},now:c.deps().now,out:()=>{},err:()=>{},processTable:()=>null}),0);
 assert.equal(getMessage(c.paths.inbox,id)?.state,'delivered');assert.equal(n.control.effects,1);assert.equal(c.control.effects,1);
});
