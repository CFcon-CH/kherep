import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
for (const runtime of ['claude','codex']) test(`${runtime} subprocess CLI performs create/comment/update with only synthetic HTTP`,t=>{
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'github-broker-cli-')));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const root=path.join(home,'.kherep','github-broker');fs.mkdirSync(path.join(root,'keys'),{recursive:true,mode:0o700});
  const runtimes=Object.fromEntries(['claude','codex'].map((r,i)=>[r,{appId:10+i,clientId:`Iv.fixture${i}`,botId:20+i,botLogin:`fixture${i}[bot]`,installationId:30+i,keyRef:`fixture${i}.pem`,operations:['issue.create','issue.comment','issue.update'],repositories:[{slug:'example/project',id:40}]}]));
  fs.writeFileSync(path.join(root,'policy.json'),JSON.stringify({version:1,enabled:true,runtimes}),{mode:0o600});
  for(const name of ['fixture0.pem','fixture1.pem']) fs.writeFileSync(path.join(root,'keys',name),key,{mode:0o600});
  const preload=path.join(home,'fixture.mjs');
  fs.writeFileSync(preload,`import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
os.userInfo=()=>({homedir:import.meta.dirname});
let i;
const issue={id:90,number:7,title:'Synthetic',body:'Body',state:'open',repository_url:'https://api.github.com/repos/example/project'};
globalThis.fetch=async(url,init)=>{
 const endpoint=new URL(url).pathname,method=init.method,body=init.body?JSON.parse(init.body):undefined;
 fs.appendFileSync(path.join(import.meta.dirname,'calls.jsonl'),JSON.stringify({endpoint,method})+'\\n');
 if(endpoint==='/app') {const claims=JSON.parse(Buffer.from(init.headers.Authorization.split('.')[1],'base64url'));i=Number(claims.iss.slice(-1));return Response.json({id:10+i,client_id:claims.iss,slug:'fixture'+i,permissions:{issues:'write'}});}
 if(endpoint.endsWith('/installation'))return Response.json({id:30+i,app_id:10+i,suspended_at:null,permissions:{issues:'write'}});
 if(endpoint.endsWith('/access_tokens')) {if(JSON.stringify(body)!==JSON.stringify({repository_ids:[40],permissions:{issues:'write'}}))throw Error();return Response.json({token:'synthetic-only',expires_at:new Date(Date.now()+60000).toISOString()});}
 if(endpoint.startsWith('/users/'))return Response.json({id:20+i,login:'fixture'+i+'[bot]',type:'Bot'});
 if(endpoint==='/repos/example/project')return Response.json({id:40,full_name:'example/project',private:false});
 if(method==='PATCH')Object.assign(issue,body);
 const user={id:20+i,login:'fixture'+i+'[bot]',type:'Bot'};
 if(endpoint.includes('/comments'))return Response.json({id:91,body:'Body',issue_url:'https://api.github.com/repos/example/project/issues/7',user});
 return Response.json({...issue,user});
};
`);
  for(const operation of ['issue.create','issue.comment','issue.update']) {
    const input={operationId:randomUUID(),repository:'example/project',operation,...(operation==='issue.create'?{title:'Synthetic',body:'Body'}:operation==='issue.comment'?{issueNumber:7,body:'Body'}:{issueNumber:7,title:'Changed'})};
    const result=spawnSync(process.execPath,['--import',preload,path.join(import.meta.dirname,`github-${runtime}.mts`)],{input:JSON.stringify(input),encoding:'utf8',env:{PATH:process.env.PATH},timeout:30000});
    assert.equal(result.status,0,result.stdout+result.stderr);const receipt=JSON.parse(result.stdout);assert.equal(receipt.ok,true);assert.equal(receipt.runtime,runtime);assert.equal(receipt.bot,`fixture${runtime==='claude'?0:1}[bot]`);assert.equal(result.stderr,'');
  }
  const calls=fs.readFileSync(path.join(home,'calls.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
  assert.equal(calls.filter(c=>c.method==='PATCH'||c.method==='POST'&&!c.endpoint.endsWith('/access_tokens')).length,3);
});
