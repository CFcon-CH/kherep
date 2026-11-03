import {requireMessageEffect} from './message-admission.mts';
import type {CurrentWindowAuthority} from './target-delivery-window.mts';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_WINDOW_CONTROL, admitWindowControl, verifyWindowMessage } from './target-delivery-window.mts';
import type { Readable, Writable } from 'node:stream';

// Windows detached wrapper. A bounded local control line precedes prompt
// stdin. No inner process exists before the exact command/owner check.
export async function runWindowless(file:string,args:string[],input:Readable,output:Writable,error:Writable,
  start:typeof spawn=spawn,wrapper=import.meta.filename,controlTimeoutMs=30000,env:NodeJS.ProcessEnv=process.env,authority?:CurrentWindowAuthority):Promise<number> {
  let buffered=Buffer.alloc(0);
  const iterator=input[Symbol.asyncIterator]();
  let rest=Buffer.alloc(0),admitted:ReturnType<typeof admitWindowControl>|undefined;
  const nextControl=()=>new Promise<IteratorResult<any>>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('window control timed out')),controlTimeoutMs);
    iterator.next().then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});
  });
  for(;;) {
    const next=await nextControl();
    if(next.done)throw Error('window control incomplete');
    buffered=Buffer.concat([buffered,Buffer.from(next.value)]);
    const end=buffered.indexOf(10);
    if(end<0) {if(buffered.length>MAX_WINDOW_CONTROL)throw Error('window control exceeds bound');continue;}
    if(end>MAX_WINDOW_CONTROL)throw Error('window control exceeds bound');
    admitted=admitWindowControl(buffered.subarray(0,end).toString('utf8'),file,args,wrapper,process.execPath,env,authority);
    rest=buffered.subarray(end+1);break;
  }
  const child=start(file,args,{stdio:'pipe',windowsHide:true,env});
  child.stdin!.on('error',()=>{});
  child.stdout!.pipe(output);child.stderr!.pipe(error);
  const result=new Promise<number>(resolve=>{
    child.once('error',()=>{error.write('Codex child failed to start\n');resolve(1);});child.once('close',code=>resolve(code??1));
  });
  const verify=()=>{if(admitted?.context.kind==='message'){verifyWindowMessage(admitted.paths!,admitted.context,file,args,wrapper,process.execPath,true,env);requireMessageEffect({paths:admitted.paths!},admitted.context,'inner-input');}};
  try {
    verify();if(rest.length)child.stdin!.write(rest);
    for(;;){const next=await iterator.next();verify();if(next.done)break;child.stdin!.write(next.value);}
    child.stdin!.end();
  }catch{child.stdin!.destroy();child.kill();throw Error('window input context refused');}
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const [file,...args]=process.argv.slice(2);
  if(!file)process.exitCode=2;
  else try {process.exitCode=await runWindowless(file,args,process.stdin,process.stdout,process.stderr);}
  catch {process.stderr.write('Codex window control refused\n');process.exitCode=1;}
}
