import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execute } from './broker.mts';
import type { Dependencies } from './broker.mts';
import type { Runtime } from './contract.mts';
export function entry(runtime:Runtime) {return (text:string,deps:Dependencies={})=>execute(runtime,text,deps);}
function isMainModule(url: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return url === pathToFileURL(path.resolve(entry)).href
      || url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}
export async function start(runtime:Runtime, url:string):Promise<void> {
  if (!isMainModule(url)) return;
  if (process.argv.length!==2) {process.stdout.write('{"ok":false,"error":"invalid-request"}\n');process.exitCode=1;return;}
  let bytes=0;const chunks:Buffer[]=[];
  try {
    for await (const chunk of process.stdin) {const b=Buffer.from(chunk);bytes+=b.length;if(bytes>65536) throw new Error();chunks.push(b);}
    const result=await execute(runtime,Buffer.concat(chunks).toString('utf8'));
    process.stdout.write(`${JSON.stringify(result)}\n`);process.exitCode=result.ok?0:1;
  } catch {process.stdout.write('{"ok":false,"error":"invalid-request"}\n');process.exitCode=1;}
}
