import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { run as claude } from './github-claude.mts';
import { run as codex } from './github-codex.mts';
const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const key=pair.privateKey.export({type:'pkcs8',format:'pem'});
const now=Date.now();
function fixture(t: {after:(fn:()=>void)=>void}, selected:'claude'|'codex') {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'github-broker-functional-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'keys'),{mode:0o700});
  const runtimes=Object.fromEntries(['claude','codex'].map((runtime,i)=>[runtime,{appId:11+i,clientId:`Iv.synthetic${i}`,botId:33+i,botLogin:`synthetic${i}[bot]`,installationId:44+i,keyRef:`synthetic${i}.pem`,operations:['issue.create','issue.comment','issue.update'],repositories:[{slug:'example/project',id:55}]}]));
  const identity=runtimes[selected];fs.writeFileSync(path.join(root,'policy.json'),JSON.stringify({version:1,enabled:true,runtimes}),{mode:0o600});
  // Only selected key exists. A cross-runtime fallback cannot pass.
  fs.writeFileSync(path.join(root,'keys',identity.keyRef),key,{mode:0o600});
  const issue={id:81,number:7,title:'Synthetic',body:'Body',state:'open',repository_url:'https://api.github.com/repos/example/project',user:{id:identity.botId,login:identity.botLogin,type:'Bot'}};
  const comment={id:82,body:'Body',issue_url:'https://api.github.com/repos/example/project/issues/7',user:issue.user};
  const calls:{method:string;url:string;body:unknown}[]=[];
  const control={ambiguous:false,wrongActor:false,privateRepo:false,pr:false,readbackFail:false,scope:false,expired:false,suspended:false,wrongInstall:false,wrongRepo:false,wrongBot:false,wrongLogin:false,wrongType:false,wrongApp:false,wrongClient:false,wrongSlug:false,wrongTarget:false,wrongAssociation:false,wrongFields:false,installationOverride:0};
  const fetcher:typeof fetch=async(url,init)=>{
    const endpoint=new URL(String(url)).pathname, method=init?.method??'GET', body=init?.body?JSON.parse(String(init.body)):undefined;
    calls.push({method,url:endpoint,body});assert.equal(new URL(String(url)).origin,'https://api.github.com');
    const auth=(init?.headers as Record<string,string>).Authorization.slice(7);
    if (endpoint==='/app') {
      const [a,b,c]=auth.split('.');assert.equal(verify('RSA-SHA256',Buffer.from(`${a}.${b}`),pair.publicKey,Buffer.from(c,'base64url')),true);
      assert.equal(JSON.parse(Buffer.from(b,'base64url').toString()).iss,identity.clientId);
      return Response.json({id:control.wrongApp?999:identity.appId,client_id:control.wrongClient?'wrong':identity.clientId,slug:control.wrongSlug?'wrong':identity.botLogin.slice(0,-5),permissions:{issues:'write'}});
    }
    if(endpoint.endsWith('/installation')) return Response.json({id:control.wrongInstall?999:control.installationOverride||identity.installationId,app_id:identity.appId,suspended_at:control.suspended?'synthetic':null,permissions:{issues:'write'}});
    if(endpoint.endsWith('/access_tokens')) {assert.deepEqual(body,{repository_ids:[55],permissions:{issues:'write'}});return Response.json({token:'synthetic-memory-only',expires_at:new Date(now+(control.expired?-1000:60000)).toISOString(),permissions:{issues:'write',...(control.scope?{contents:'write'}:{})}});}
    assert.equal(auth,'synthetic-memory-only');
    if(endpoint.startsWith('/users/')) return Response.json({id:control.wrongBot?999:identity.botId,login:control.wrongLogin?'wrong[bot]':identity.botLogin,type:control.wrongType?'User':'Bot'});
    if(endpoint==='/repos/example/project') return Response.json({id:control.wrongRepo?999:55,full_name:'example/project',private:control.privateRepo});
    if(method==='POST'||method==='PATCH') {
      if(control.ambiguous) throw new Error('secret-canary');
      if(method==='PATCH') Object.assign(issue,body,{user:{id:999,login:'original-author',type:'User'}});
      return Response.json(endpoint.endsWith('/comments')?comment:issue);
    }
    if(control.readbackFail) return new Response('secret-canary',{status:503});
    const item=endpoint.includes('/comments/')?comment:issue;
    return Response.json({...item,...(control.wrongTarget?{id:999}:{}),...(control.wrongAssociation?{repository_url:'https://api.github.com/repos/other/project',issue_url:'https://api.github.com/repos/other/project/issues/7'}:{}),...(control.wrongFields?{title:'Wrong',body:'Wrong'}:{}),...(control.pr?{pull_request:{url:'synthetic'}}:{}),...(control.wrongActor?{user:{id:999,login:'wrong[bot]',type:'Bot'}}:{})});
  };
  return {root,fetch:fetcher,now:()=>now,calls,control};
}
for(const [runtime,run] of [['claude',claude],['codex',codex]] as const) {
  for(const operation of ['issue.create','issue.comment','issue.update'] as const) test(`${runtime} actual entrypoint ${operation} uses production signing, loader and exact readback`,async(t)=>{
    const f=fixture(t,runtime), operationId=randomUUID();
    const request={operationId,repository:'example/project',operation,...(operation==='issue.create'?{title:'Synthetic',body:'Body'}:operation==='issue.comment'?{issueNumber:7,body:'Body'}:{issueNumber:7,title:'Changed',state:'closed'})};
    const result=await run(JSON.stringify(request),f);assert.equal(result.ok,true);assert.equal(result.runtime,runtime);assert.equal(result.targetId,operation==='issue.comment'?82:81);
    const mutations=()=>f.calls.filter(c=>c.method==='PATCH'||c.method==='POST'&&!c.url.endsWith('/access_tokens'));
    assert.equal(mutations().length,1);assert.deepEqual(mutations()[0].body,operation==='issue.create'?{title:'Synthetic',body:'Body'}:operation==='issue.comment'?{body:'Body'}:{title:'Changed',state:'closed'});
    assert.equal((await run(JSON.stringify(request),f)).ok,true);assert.equal(mutations().length,1);
    assert.equal((await run(JSON.stringify({...request,...(operation==='issue.comment'?{body:'Conflict'}:{title:'Conflict'})}),f)).error,'operation-conflict');
    const before=f.calls.length;assert.equal((await run(JSON.stringify({operationId,repository:'example/project',operation:'verify'}),f)).ok,true);
    assert.ok(f.calls.length>before,'verify must freshly read the known target');assert.equal(mutations().length,1);
    const disk=fs.readdirSync(path.join(f.root,'receipts')).map(n=>fs.readFileSync(path.join(f.root,'receipts',n),'utf8')).join('');
    for(const secret of ['synthetic-memory-only','PRIVATE KEY','Body','Changed','Synthetic']) assert.equal(disk.includes(secret),false);
  });
}
test('ambiguous POST never replays and errors contain no canary',async(t)=>{
  const f=fixture(t,'claude');f.control.ambiguous=true;
  const request={operationId:randomUUID(),repository:'example/project',operation:'issue.create',title:'Synthetic'};
  assert.equal((await claude(JSON.stringify(request),f)).error,'outcome-unknown');const count=f.calls.length;
  const repeated=await claude(JSON.stringify(request),f);assert.equal(repeated.error,'outcome-unknown');assert.equal(f.calls.length,count);assert.equal(JSON.stringify(repeated).includes('secret-canary'),false);
});
test('known ID survives wrong actor and later verify performs no issue mutation',async(t)=>{
  const f=fixture(t,'codex');f.control.wrongActor=true;const operationId=randomUUID();
  const result=await codex(JSON.stringify({operationId,repository:'example/project',operation:'issue.create',title:'Synthetic'}),f);assert.equal(result.error,'verification-failed');assert.equal(result.targetId,81);
  f.control.wrongActor=false;const before=f.calls.length;assert.equal((await codex(JSON.stringify({operationId,repository:'example/project',operation:'verify'}),f)).ok,true);
  assert.equal(f.calls.slice(before).filter(c=>c.method!=='GET'&&!c.url.endsWith('/access_tokens')).length,0);
});
for(const [runtime,run] of [['claude',claude],['codex',codex]] as const) for(const refusal of ['privateRepo','pr','scope','expired','suspended','wrongInstall','wrongRepo','wrongBot','wrongLogin','wrongType','wrongApp','wrongClient','wrongSlug'] as const) test(`${runtime} refuses ${refusal} before issue mutation`,async(t)=>{
  const f=fixture(t,runtime);f.control[refusal]=true;
  const result=await run(JSON.stringify({operationId:randomUUID(),repository:'example/project',operation:'issue.comment',issueNumber:7,body:'Body'}),f);
  assert.equal(result.ok,false);assert.equal(f.calls.filter(c=>c.method!=='GET'&&!c.url.endsWith('/access_tokens')).length,0);
});
test('known target ID is retained when provider readback fails',async(t)=>{
  const f=fixture(t,'claude');f.control.readbackFail=true;
  const request={operationId:randomUUID(),repository:'example/project',operation:'issue.create',title:'Synthetic'};
  const result=await claude(JSON.stringify(request),f);assert.equal(result.error,'transport-failed');assert.equal(result.targetId,81);assert.equal(result.issueNumber,7);
  f.control.readbackFail=false;assert.equal((await claude(JSON.stringify({...request,operation:'verify',title:undefined}),f)).ok,true);
  assert.equal(f.calls.filter(c=>c.method!=='GET'&&!c.url.endsWith('/access_tokens')).length,1);
});
test('disabled/unauthorized policy and malformed requests cause zero provider calls',async(t)=>{
  const f=fixture(t,'codex');
  for(const request of [{operationId:randomUUID(),repository:'other/project',operation:'issue.create',title:'Synthetic'},{operationId:randomUUID(),repository:'example/project',operation:'issue.create',title:'Synthetic',runtime:'claude'}]) {
    assert.equal((await codex(JSON.stringify(request),f)).ok,false);assert.equal(f.calls.length,0);
  }
  const policy=JSON.parse(fs.readFileSync(path.join(f.root,'policy.json'),'utf8'));policy.enabled=false;fs.writeFileSync(path.join(f.root,'policy.json'),JSON.stringify(policy));
  fs.unlinkSync(path.join(f.root,'keys','synthetic1.pem'));
  assert.equal((await codex(JSON.stringify({operationId:randomUUID(),repository:'example/project',operation:'issue.create',title:'Synthetic'}),f)).error,'policy-disabled');assert.equal(f.calls.length,0);
});

for(const [runtime,run] of [['claude',claude],['codex',codex]] as const) {
  for(const operation of ['issue.create','issue.comment','issue.update'] as const)test(`${runtime} readonly verify freshly checks ${operation} without persistence`,async t=>{
    const f=fixture(t,runtime),operationId=randomUUID();
    const request={operationId,repository:'example/project',operation,...(operation==='issue.create'?{title:'Synthetic',body:'Body'}:operation==='issue.comment'?{issueNumber:7,body:'Body'}:{issueNumber:7,title:'Changed'})};
    assert.equal((await run(JSON.stringify(request),f)).ok,true);
    const dir=path.join(f.root,'receipts'),file=path.join(dir,fs.readdirSync(dir)[0]);
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));fs.writeFileSync(file+'.lock','retained',{mode:0o600});
    for(const status of ['known','verified']) {saved.status=status;fs.writeFileSync(file,JSON.stringify(saved));
    const before=fs.readFileSync(file,'utf8'),lock=fs.lstatSync(file+'.lock');
    for(let i=0;i<2;i++){const count=f.calls.length,result=await run(JSON.stringify({operationId,repository:'example/project',operation:'verify'}),f);assert.equal(result.ok,true);assert.equal(result.status,'verified');assert.equal(result.targetId,saved.targetId);assert.ok(f.calls.slice(count).some(c=>c.method==='GET'&&c.url.includes('/issues/')));assert.equal(f.calls.slice(count).filter(c=>c.method!=='GET'&&!c.url.endsWith('/access_tokens')).length,0);assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.lstatSync(file+'.lock').ino,lock.ino);assert.equal(fs.readFileSync(file+'.lock','utf8'),'retained');}
    }
  });
  for(const refusal of ['wrongInstall','wrongRepo','privateRepo','wrongBot','wrongTarget','wrongAssociation','pr','wrongFields','readbackFail'] as const)test(`${runtime} readonly ${refusal} failure exposes no saved IDs`,async t=>{
    const f=fixture(t,runtime),operationId=randomUUID();assert.equal((await run(JSON.stringify({operationId,repository:'example/project',operation:'issue.create',title:'Synthetic',body:'Body'}),f)).ok,true);
    const dir=path.join(f.root,'receipts'),file=path.join(dir,fs.readdirSync(dir)[0]),before=fs.readFileSync(file,'utf8'),count=f.calls.length;f.control[refusal]=true;
    const result=await run(JSON.stringify({operationId,repository:'example/project',operation:'verify'}),f);assert.equal(result.ok,false);
    for(const field of ['targetId','issueNumber','status','attribution','bot'])assert.equal(result[field],undefined);assert.equal(JSON.stringify(result).includes('secret-canary'),false);assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(f.calls.slice(count).filter(c=>c.method!=='GET'&&!c.url.endsWith('/access_tokens')).length,0);
  });
  test(`${runtime} readonly verify uses current policy without historical installation claims`,async t=>{
    const f=fixture(t,runtime),operationId=randomUUID();assert.equal((await run(JSON.stringify({operationId,repository:'example/project',operation:'issue.create',title:'Synthetic'}),f)).ok,true);
    const file=path.join(f.root,'policy.json'),p=JSON.parse(fs.readFileSync(file,'utf8'));p.runtimes[runtime].installationId=77;fs.writeFileSync(file,JSON.stringify(p));f.control.installationOverride=77;
    assert.equal((await run(JSON.stringify({operationId,repository:'example/project',operation:'verify'}),f)).ok,true);
  });
  for(const kind of ['disabled','unauthorized','app-namespace','other-runtime','malformed','unsafe'] as const)test(`${runtime} readonly ${kind} refuses without IDs or persistence`,async t=>{
    const f=fixture(t,runtime),operationId=randomUUID();assert.equal((await run(JSON.stringify({operationId,repository:'example/project',operation:'issue.create',title:'Synthetic'}),f)).ok,true);
    const policyFile=path.join(f.root,'policy.json'),p=JSON.parse(fs.readFileSync(policyFile,'utf8')),dir=path.join(f.root,'receipts'),file=path.join(dir,fs.readdirSync(dir)[0]);
    if(kind==='disabled')p.enabled=false;if(kind==='unauthorized')p.runtimes[runtime].repositories=[{slug:'other/project',id:55}];if(kind==='app-namespace')p.runtimes[runtime].appId=999;fs.writeFileSync(policyFile,JSON.stringify(p));
    if(kind==='malformed')fs.writeFileSync(file,'{"secret":"secret-canary"}');if(kind==='unsafe')fs.chmodSync(file,0o644);
    const before=fs.readFileSync(file,'utf8'),count=f.calls.length,selected=kind==='other-runtime'?(runtime==='claude'?codex:claude):run;
    const result=await selected(JSON.stringify({operationId,repository:'example/project',operation:'verify'}),f);assert.equal(result.ok,false);for(const field of ['targetId','issueNumber','status','attribution'])assert.equal(result[field],undefined);assert.equal(f.calls.length,count);assert.equal(fs.readFileSync(file,'utf8'),before);
  });
}

for(const [runtime,run] of [['claude',claude],['codex',codex]] as const)test(`${runtime} pending partial IDs and bad saved hashes do not leak verification IDs`,async t=>{
  const f=fixture(t,runtime),operationId=randomUUID();assert.equal((await run(JSON.stringify({operationId,repository:'example/project',operation:'issue.create',title:'Synthetic'}),f)).ok,true);
  const dir=path.join(f.root,'receipts'),file=path.join(dir,fs.readdirSync(dir)[0]),saved=JSON.parse(fs.readFileSync(file,'utf8'));
  for(const pending of [true,false]){saved.status=pending?'pending':'known';saved.fieldHashes.title='0'.repeat(64);fs.writeFileSync(file,JSON.stringify(saved));const before=fs.readFileSync(file,'utf8'),count=f.calls.length,result=await run(JSON.stringify({operationId,repository:'example/project',operation:'verify'}),f);assert.equal(result.ok,false);assert.equal(result.error,pending?'outcome-unknown':'verification-failed');for(const field of ['targetId','issueNumber','status','attribution'])assert.equal(result[field],undefined);assert.equal(fs.readFileSync(file,'utf8'),before);if(pending)assert.equal(f.calls.length,count);}
});
