// Preload only: install and prove isolation before allowing the real CLI import.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
type Config = {home:string;sourceRoot:string;instance:string;phase:'normal'|'pending'|'effect'|'known'|'reader'|'reader-fail'};
const refuse = ():never => {throw new Error('fixture-boundary-refused');};
const ensure = (value:unknown):void => {if(!value) refuse();};
const send = (event:string) => process.send?.({event});
async function command():Promise<unknown> {return (await once(process,'message'))[0];}
async function setup():Promise<void> {
  os.userInfo=refuse;os.homedir=refuse;
  globalThis.fetch=async()=>refuse();
  for(const [owner,names] of [[net,['connect','createConnection']],[http,['request','get']],[https,['request','get']],[tls,['connect']],[childProcess,['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']]] as const) {
    for(const name of names) (owner as unknown as Record<string,unknown>)[name]=refuse;
  }
  net.Server.prototype.listen=refuse;
  syncBuiltinESMExports();
  const config=await command() as Config;
  ensure(config && typeof config.instance==='string' && /^[a-f0-9-]{36}$/.test(config.instance) && ['normal','pending','effect','known','reader','reader-fail'].includes(config.phase));
  ensure(path.isAbsolute(config.home) && /^kherep-732-process-/.test(path.basename(config.home)));
  ensure(fs.realpathSync(config.home)===config.home && fs.lstatSync(config.home).isDirectory());
  const cli=path.resolve(process.argv[1]??'');
  ensure(path.dirname(cli)===config.sourceRoot && /^github-(claude|codex)\.mts$/.test(path.basename(cli)));
  const ancestors=new Set<string>();let ancestor=config.home;
  while(true) {ancestors.add(ancestor);const parent=path.dirname(ancestor);if(parent===ancestor) break;ancestor=parent;}
  const sourceFiles=new Set(fs.readdirSync(config.sourceRoot).filter(n=>/^[a-z-]+\.mts$/.test(n)).map(n=>path.join(config.sourceRoot,n)));
  const descriptors=new Set<number>();
  const stateRoot=path.join(config.home,'.kherep','github-broker','receipts');
  function observe(name:string,value:unknown):void {
    const target=typeof value==='number'?'descriptor':String(value);
    if(target===stateRoot||target.startsWith(stateRoot+path.sep)) send('state-write:'+name);
  }
  function allowed(value:unknown,metadata=false,sourceRead=false):void {
    if(typeof value==='number') {ensure(descriptors.has(value));return;}
    const target=path.resolve(value instanceof URL?fileURLToPath(value):String(value));
    ensure(target===config.home || target.startsWith(`${config.home}${path.sep}`) || sourceRead&&sourceFiles.has(target) || metadata&&ancestors.has(target));
  }
  const syncMethods=['readFileSync','writeFileSync','appendFileSync','mkdirSync','readdirSync','renameSync','unlinkSync','rmdirSync','rmSync','statSync','lstatSync','realpathSync','existsSync','accessSync','openSync'];
  for(const name of syncMethods) {
    const owner=fs as unknown as Record<string,unknown>, original=owner[name] as (...args:unknown[])=>unknown;
    owner[name]=(...args:unknown[])=>{
      const metadata=['statSync','lstatSync','existsSync','accessSync','realpathSync'].includes(name);
      const flags=args[1];
      const readOpen=name==='openSync'&&(typeof flags==='number'?(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_APPEND|fs.constants.O_TRUNC))===0:typeof flags==='string'&&flags.startsWith('r')&&!flags.includes('+'));
      allowed(args[0],metadata,metadata||name==='readFileSync'||readOpen);
      if(!metadata&&name!=='readFileSync'&&!(name==='openSync'&&readOpen)&&name!=='readdirSync')observe(name,args[0]);
      if(name==='renameSync') allowed(args[1]);
      const result=Reflect.apply(original,fs,args);
      if(name==='openSync') descriptors.add(result as number);
      return result;
    };
  }
  for(const name of ['fstatSync','fsyncSync','readSync','closeSync']) {
    const owner=fs as unknown as Record<string,unknown>, original=owner[name] as (...args:unknown[])=>unknown;
    owner[name]=(...args:unknown[])=>{allowed(args[0]);const value=Reflect.apply(original,fs,args);if(name==='closeSync')descriptors.delete(args[0] as number);return value;};
  }
  for(const name of ['readFile','writeFile','appendFile','open','stat','lstat','readdir','realpath','access','mkdir','rename','unlink','rm']) {
    const owner=fs.promises as unknown as Record<string,unknown>,original=owner[name] as (...args:unknown[])=>unknown;
    owner[name]=async(...args:unknown[])=>{allowed(args[0],['stat','lstat','realpath','access'].includes(name),['readFile','stat','lstat','realpath','access'].includes(name));if(name==='rename')allowed(args[1]);return Reflect.apply(original,fs.promises,args);};
  }
  for(const name of ['readFile','open','stat','lstat','readdir','realpath','access','createReadStream','createWriteStream','opendir','opendirSync','readlink','readlinkSync']) (fs as unknown as Record<string,unknown>)[name]=refuse;
  syncBuiltinESMExports();
  for(const probe of [()=>os.userInfo(),()=>fs.readFileSync('/__forbidden_fixture_canary__'),()=>fs.lstatSync('/__forbidden_fixture_canary__'),()=>fs.writeFileSync(cli,'forbidden source mutation'),()=>net.connect(1),()=>childProcess.spawnSync(process.execPath,[])]) {
    let blocked=false;try{probe();}catch(e){blocked=e instanceof Error&&e.message==='fixture-boundary-refused';}ensure(blocked);
  }
  let blocked=false;try{await fetch('https://example.invalid/fixture-canary');}catch(e){blocked=e instanceof Error&&e.message==='fixture-boundary-refused';}ensure(blocked);
  os.userInfo=(()=>({homedir:config.home,uid:process.getuid?.()??0,gid:process.getgid?.()??0,username:'synthetic',shell:null})) as typeof os.userInfo;
  os.homedir=()=>config.home;
  const calls=path.join(config.home,'calls.jsonl'),effects=path.join(config.home,'effects.jsonl');
  const append=(file:string,value:unknown)=>{const fd=fs.openSync(file,'a',0o600);try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
  const records=()=>fs.existsSync(effects)?fs.readFileSync(effects,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as Record<string,unknown>):[];
  const index=path.basename(cli)==='github-claude.mts'?0:1;
  const actor={id:20+index,login:`fixture${index}[bot]`,type:'Bot'};
  async function pause(phase:string):Promise<void> {send(phase);ensure(await command()==='continue');send('released:'+phase);}
  globalThis.fetch=async(url,init)=>{
    const address=new URL(String(url)),endpoint=address.pathname,method=init?.method??'GET';
    ensure(address.origin==='https://api.github.com');append(calls,{method,endpoint,instance:config.instance});
    if(endpoint==='/app')return Response.json({id:10+index,client_id:`Iv.fixture${index}`,slug:`fixture${index}`,permissions:{issues:'write'}});
    if(endpoint.endsWith('/installation'))return Response.json({id:30+index,app_id:10+index,suspended_at:null,permissions:{issues:'write'}});
    if(endpoint.endsWith('/access_tokens')) {
      ensure(JSON.stringify(JSON.parse(String(init?.body)))===JSON.stringify({repository_ids:[40],permissions:{issues:'write'}}));
      return Response.json({token:'synthetic-memory-only',expires_at:new Date(Date.now()+60000).toISOString()});
    }
    if(endpoint.startsWith('/users/'))return Response.json(actor);
    if(endpoint==='/repos/example/project')return Response.json({id:40,full_name:'example/project',private:false});
    if(method==='POST'&&endpoint==='/repos/example/project/issues') {
      if(config.phase==='pending')await pause('pending');
      const body=JSON.parse(String(init?.body)), effect={method,endpoint,body,index,id:90+index,number:7};append(effects,effect);
      if(config.phase==='effect')await pause('effect');
      return Response.json({id:effect.id,number:effect.number});
    }
    if(method==='GET'&&endpoint==='/repos/example/project/issues/7') {
      if(config.phase==='known')await pause('known');
      if(config.phase==='reader'||config.phase==='reader-fail')await pause('reader');
      if(config.phase==='reader-fail')return new Response('synthetic-error-canary',{status:503});
      const effect=records().filter(r=>r.index===index).at(-1);ensure(effect);
      return Response.json({id:effect!.id,number:7,...effect!.body as object,repository_url:'https://api.github.com/repos/example/project',user:actor});
    }
    return refuse();
  };
  syncBuiltinESMExports();
  send('isolated');ensure(await command()==='import');
  process.channel?.unref();
}
try {await setup();}catch {send('fixture-failed');process.exit(86);}
