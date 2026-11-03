import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { githubBrokerFiles, copyGithubBroker } from '../lib/github-broker-projection.mts';
import { InstallTransaction } from '../codex/lib/install-transaction.mts';
import { toBashPath } from './render-profile-paths.mts';
const repo=path.resolve(import.meta.dirname,'..');
test('shared exact projection imports both staged CLIs, idempotence and rollback',async(t)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'github-broker-projection-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const files=githubBrokerFiles(repo);assert.ok(files.includes('github-claude.mts'));assert.ok(files.includes('github-codex.mts'));assert.ok(files.includes('key-access.mts'));assert.equal(files.some(f=>f.includes('.test.')),false);
  const workspace=path.join(root,'workspace'), tx=new InstallTransaction(workspace,path.join(root,'backup'));
  const targets=copyGithubBroker(repo,workspace,tx);assert.equal(targets.length,files.length);
  for(const runtime of ['claude','codex']) {
    const staged=await import(pathToFileURL(path.join(workspace,'tools','github-broker',`github-${runtime}.mts`)).href);
    assert.equal(typeof staged.run,'function');
  }
  const first=targets.map(f=>fs.readFileSync(f,'utf8'));copyGithubBroker(repo,workspace,tx);assert.deepEqual(targets.map(f=>fs.readFileSync(f,'utf8')),first);
  tx.rollback();assert.equal(targets.some(f=>fs.existsSync(f)),false);
});
test('missing closure dependency refuses before any copy',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'github-broker-missing-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source');fs.cpSync(path.join(repo,'modules','github-broker'),path.join(source,'modules','github-broker'),{recursive:true});
  fs.unlinkSync(path.join(source,'modules','github-broker','auth.mts'));
  let writes=0;assert.throws(()=>copyGithubBroker(source,path.join(root,'workspace'),{copyFile(){writes++;return '';}}));assert.equal(writes,0);
});

test('actual bootstrap transaction projects the closure and rolls back an interrupted broker update', async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'github-broker-bootstrap-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const home=path.join(root,'home with space'), workspace=path.join(root,'workspace');
  fs.mkdirSync(home);fs.mkdirSync(workspace);
  const env={PATH:process.env.PATH,HOME:toBashPath(home),CLAUDE_HOME:toBashPath(path.join(home,'.claude')),
    KHEREP_WORKSPACE:toBashPath(workspace),KHEREP_CREDENTIALS_ROOT:toBashPath(path.join(root,'synthetic-config')),
    KHEREP_PROFILE:'win',KHEREP_INSTALL_PREVIEW:'1',SKIP_DEPS:'1',SKIP_SECRETS:'1',
    GIT_CONFIG_GLOBAL:path.join(root,'git-global'),GIT_CONFIG_SYSTEM:path.join(root,'git-system')};
  const install=(extra:Record<string,string>={})=>spawnSync('bash',[toBashPath(path.join(repo,'bootstrap','install.sh'))],{encoding:'utf8',env:{...env,...extra},timeout:120000});
  const first=install();assert.equal(first.status,0,first.stdout+first.stderr);
  const directory=path.join(workspace,'tools','github-broker');
  for(const file of githubBrokerFiles(repo)) assert.deepEqual(fs.readFileSync(path.join(directory,file)),fs.readFileSync(path.join(repo,'modules','github-broker',file)));
  for(const runtime of ['claude','codex']) assert.equal(typeof(await import(pathToFileURL(path.join(directory,`github-${runtime}.mts`)).href)).run,'function');
  assert.equal(fs.existsSync(path.join(home,'.kherep','github-broker')),false);
  const target=path.join(directory,'github-claude.mts');fs.writeFileSync(target,'prior synthetic entrypoint');
  const failed=install({KHEREP_BOOTSTRAP_TEST_FAIL_AFTER_LABEL:'project/tools/github-broker/github-claude.mts'});
  assert.notEqual(failed.status,0);assert.equal(fs.readFileSync(target,'utf8'),'prior synthetic entrypoint');
});
