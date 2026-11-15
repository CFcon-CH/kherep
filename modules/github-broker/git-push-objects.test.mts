// Git does not verify an object's hash when it reads it during a traversal. A forged loose object
// under the name of a real commit or tree must not change what the preflight decides: the broker
// recomputes every hash it relies on, so forged bytes are refused before any push.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { email, stubWindowsAcl } from './flow.fixture.mts';
import { answering, g, isolateProcess, pushSetup, refused } from './git-push.fixture.mts';
import type { T } from './git-push.fixture.mts';
stubWindowsAcl();
isolateProcess();
const OPERATOR='operator@example.com';
const objectFile=(work:string, oid:string)=>path.join(work,'.git','objects',oid.slice(0,2),oid.slice(2));
/** The genuine body of a loose object of the work clone. */
const body=(work:string, oid:string, type:'commit'|'tree')=>execFileSync('git',['cat-file',type,oid],{cwd:work,windowsHide:true});
/** Overwrites the loose object `oid` with `type` and `content`, keeping its name. */
function forge(work:string, oid:string, type:'commit'|'tree', content:Buffer):void {
  const file=objectFile(work,oid);fs.chmodSync(file,0o644);
  fs.writeFileSync(file,zlib.deflateSync(Buffer.concat([Buffer.from(`${type} ${content.length}\0`),content])));
}
/** A foreign commit with a bot commit on top, and the foreign commit's object rewritten to carry the bot's email. */
async function forgedAncestor(t:T) {
  const p=await pushSetup(t,'claude'), foreign=p.r.commit('src/f.txt',OPERATOR), bot=p.r.commit('src/b.txt');
  const genuine=fs.readFileSync(objectFile(p.r.work,foreign));
  forge(p.r.work,foreign,'commit',Buffer.from(body(p.r.work,foreign,'commit').toString('utf8').replaceAll(OPERATOR,email(0))));
  assert.deepEqual(g(p.r.work,'log','--format=%ae%n%ce',bot,'--not',p.r.main).split('\n'),Array(6).fill(email(0)),'git itself reads the forged bytes without error');
  return {p,foreign,bot,genuine};
}
test('a forged loose commit under a foreign commit\'s name cannot pass the preflight',async t=>{
  const {p,bot}=await forgedAncestor(t);
  await refused(p,bot);
});
test('restoring the genuine object when git asks for the credential cannot push a foreign commit',async t=>{
  const {p,foreign,bot,genuine}=await forgedAncestor(t), file=objectFile(p.r.work,foreign);
  fs.writeFileSync(path.join(p.r.base,'helper.mjs'),`import fs from 'node:fs';
if(process.argv[3]==='get'){fs.chmodSync(${JSON.stringify(file)},0o644);fs.writeFileSync(${JSON.stringify(file)},Buffer.from('${genuine.toString('base64')}','base64'));}
${answering()}`);
  await refused(p,bot);
});
test('a forged root tree cannot hide a workflow change',async t=>{
  const p=await pushSetup(t,'claude'), workflow=p.r.commit('.github/workflows/ci.yml');
  forge(p.r.work,g(p.r.work,'rev-parse',`${workflow}^{tree}`),'tree',body(p.r.work,g(p.r.work,'rev-parse',`${p.sha}^{tree}`),'tree'));
  assert.equal(g(p.r.work,'log','--name-only','--format=',workflow,'--not',p.r.main).includes('.github'),false,'git itself reads the forged tree');
  await refused(p,workflow);
});
test('a forged ancestor of the base cannot remove a foreign commit from the range',async t=>{
  const p=await pushSetup(t,'claude'), r=p.r;
  g(r.work,'reset','-q','--hard',r.main);const tip=r.commit('src/main.txt',OPERATOR);g(r.work,'push','-q',r.bare,'HEAD:main');
  const foreign=r.commit('src/f.txt',OPERATOR), bot=r.commit('src/b.txt');
  // The root commit of main now names the foreign commit as its parent.
  forge(r.work,r.main,'commit',Buffer.from(body(r.work,r.main,'commit').toString('utf8').replace(/^(tree [0-9a-f]{40}\n)/,`$1parent ${foreign}\n`)));
  assert.deepEqual(g(r.work,'log','--format=%H',bot,'--not',tip).split('\n'),[bot],'git itself drops the foreign commit from the range');
  await refused(p,bot);
});
/** A commit object on top of `parent` with its tree, bot author and committer, and `extra` header lines after the committer. */
function literalCommit(work:string, parent:string, extra:string[]):string {
  const ident=`synthetic <${email(0)}> 1700000000 +0000`;
  const text=[`tree ${g(work,'rev-parse',`${parent}^{tree}`)}`,`parent ${parent}`,`author ${ident}`,`committer ${ident}`,...extra,'','synthetic',''].join('\n');
  return execFileSync('git',['hash-object','-w','-t','commit','--literally','--stdin'],{cwd:work,input:text,encoding:'utf8',windowsHide:true}).trim();
}
test('a second author header after the committer cannot pass the preflight',async t=>{
  const p=await pushSetup(t,'claude'), tip=literalCommit(p.r.work,p.sha,[`author Foreign <${OPERATOR}> 1700000000 +0000`]);
  assert.equal(g(p.r.work,'log','-1','--format=%ae',tip),OPERATOR,'git itself shows the last author header');
  await refused(p,tip);
  const committer=literalCommit(p.r.work,p.sha,[`committer Foreign <${OPERATOR}> 1700000000 +0000`]);
  await refused(p,committer);
});
test('a signed bot commit, its signature continued on space-led lines after the committer, is pushed',async t=>{
  const p=await pushSetup(t,'claude');
  const signed=literalCommit(p.r.work,p.sha,['gpgsig -----BEGIN PGP SIGNATURE-----',' ',' author synthetic',' -----END PGP SIGNATURE-----']);
  const result=await p.push({sha:signed});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(p.r.remote('feat/x'),signed);
});
