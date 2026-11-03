import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { CLAUDE_CLIENT_GRAPH,stageClaudeClient,verifyClaudeClient } from './claude-mcp-client.mts';

const repo=path.resolve(import.meta.dirname,'../../..');

const require=createRequire(import.meta.url);
const ts=require(process.env.KHEREP_TEST_TYPESCRIPT??'typescript') as any;
function runtimeImports(text:string):string[]{
 const source=ts.createSourceFile('fixture.mts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),found:string[]=[];
 const literal=(node:any|undefined)=>{if(node&&ts.isStringLiteralLike(node)&&node.text.startsWith('.'))found.push(node.text);};
 function visit(node:any):void {
  if(ts.isImportDeclaration(node)){
   const clause=node.importClause,named=clause?.namedBindings;
   if(!clause?.isTypeOnly&&!(clause&&!clause.name&&named&&ts.isNamedImports(named)&&named.elements.length>0&&named.elements.every((x:any)=>x.isTypeOnly)))literal(node.moduleSpecifier);
  }else if(ts.isExportDeclaration(node)){
   if(!node.isTypeOnly&&!(node.exportClause&&ts.isNamedExports(node.exportClause)&&node.exportClause.elements.length>0&&node.exportClause.elements.every((x:any)=>x.isTypeOnly)))literal(node.moduleSpecifier);
  }else if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword){assert.equal(node.arguments.length,1);literal(node.arguments[0]);}
  ts.forEachChild(node,visit);
 }visit(source);return found;
}
function closure(base:string,entries:string[]):Set<string>{const files=new Set<string>();function collect(relative:string):void{if(files.has(relative))return;files.add(relative);for(const spec of runtimeImports(fs.readFileSync(path.join(base,relative),'utf8'))){const resolved=path.normalize(path.join(path.dirname(relative),spec));assert.ok(!resolved.startsWith('..')&&fs.statSync(path.join(base,resolved)).isFile());collect(resolved);}}for(const entry of entries)collect(entry);return files;}
test('runtime closure parser excludes erased types and includes static dynamic and side effects',()=>{
 assert.deepEqual(runtimeImports(`import type {A} from './a.mts';export type {B} from './b.mts';import {type C} from './c.mts';import './d.mts';import {type D,E} from './e.mts';await import('./f.mts');`),['./d.mts','./e.mts','./f.mts']);
});

const digest=(bytes:Buffer)=>crypto.createHash('sha256').update(bytes).digest('hex');
// Copy current candidate bytes, including new files. Import-only never runs a
// hook main, service, installer, native helper or profile discovery.
test('current daemon hook fork and windowless consumers have an actual staged import closure',async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'706-current-consumers-'));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const entries=['daemon','deliver-hook','deliver-codex','wake-hook','codex-fork-process','codex-windowless'];
  const files=closure(repo,entries.map(entry=>`modules/control-plane/node/${entry}.mts`));files.add('package.json');
  const manifest:Record<string,{sha256:string;size:number;mode:number}>={};
  for(const relative of [...files].sort()){
    const bytes=fs.readFileSync(path.join(repo,relative)),to=path.join(temp,relative);
    fs.mkdirSync(path.dirname(to),{recursive:true});fs.writeFileSync(to,bytes);fs.chmodSync(to,fs.statSync(path.join(repo,relative)).mode&511);assert.equal(fs.statSync(to).mode&511,fs.statSync(path.join(repo,relative)).mode&511);
    assert.equal(digest(fs.readFileSync(to)),digest(bytes));manifest[relative]={sha256:digest(bytes),size:bytes.length,mode:fs.statSync(to).mode&511};
  }
  for(const entry of entries)await import(pathToFileURL(path.join(temp,`modules/control-plane/node/${entry}.mts`)).href);
  assert.ok(files.has('modules/control-plane/node/target-delivery-launch.mts'));
  assert.ok(files.has('modules/control-plane/node/target-delivery-cancel.mts'));
  assert.ok(files.has('modules/control-plane/node/message-admission.mts'));
  assert.ok(files.has('modules/control-plane/node/message-admission-policy.mts'));
  for(const name of ['target-resume-run','target-resume-completion','target-resume-completion-store','target-delivery-successor','target-resume-state','target-resume-fence'])assert.ok(files.has(`modules/control-plane/node/${name}.mts`));
  assert.ok(files.has('modules/control-plane/node/message-grant.mts'));
  process.stdout.write(`STAGED-MANIFEST:${JSON.stringify({consumer:'daemon-hooks-fork-windowless',entries,files:manifest})}\n`);
});
test('both optional MCP client staged graphs retain exact runtime imports',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'706-client-consumers-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const discovered=closure(path.join(repo,'modules/control-plane'),['node/mcp-local.mts','node/mcp-intent-hook.mts','node/mcp-stdio-bridge.mts']);
 process.stdout.write('RUNTIME-CLOSURE:'+JSON.stringify([...discovered].sort())+'\n');
 assert.equal(new Set(CLAUDE_CLIENT_GRAPH).size,CLAUDE_CLIENT_GRAPH.length);assert.deepEqual([...discovered].sort(),[...CLAUDE_CLIENT_GRAPH].sort());
 const clientRoot=path.join(temp,'client'),outputRoot=path.join(temp,'candidate'),configRoot=path.join(temp,'config');fs.mkdirSync(configRoot);
 const staged=stageClaudeClient({outputRoot,clientRoot,configRoot,nodeCommand:process.execPath});
 for(const relative of CLAUDE_CLIENT_GRAPH){const a=path.join(repo,'modules/control-plane',relative),b=path.join(outputRoot,'control-plane',relative);assert.deepEqual(fs.readFileSync(a),fs.readFileSync(b));assert.equal(fs.statSync(a).mode&511,fs.statSync(b).mode&511);}
 assert.ok(staged);assert.ok(verifyClaudeClient(outputRoot,clientRoot));
 for(const entry of ['mcp-local','mcp-intent-hook','mcp-stdio-bridge'])await import(pathToFileURL(path.join(outputRoot,'control-plane','node',entry+'.mts')).href);
 const missing=path.join(temp,'missing');fs.cpSync(outputRoot,missing,{recursive:true});fs.unlinkSync(path.join(missing,'control-plane','node','target-resume-fence.mts'));await assert.rejects(import(pathToFileURL(path.join(missing,'control-plane','node','mcp-local.mts')).href));
 const transitive=path.join(outputRoot,'control-plane','node','target-resume-fence.mts'),original=fs.readFileSync(transitive);fs.unlinkSync(transitive);assert.throws(()=>verifyClaudeClient(outputRoot));fs.writeFileSync(transitive,original);assert.ok(verifyClaudeClient(outputRoot));fs.appendFileSync(transitive,'// wrong bytes');assert.throws(()=>verifyClaudeClient(outputRoot));
 assert.notDeepEqual([...discovered].filter(x=>x!=='node/target-resume-fence.mts').concat('node/undeclared.mts').sort(),[...CLAUDE_CLIENT_GRAPH].sort());
});
