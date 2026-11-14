import path from 'node:path';
import os from 'node:os';
import { exact, fail, GITHUB_OPERATIONS, ISSUE_OPERATIONS, object, positive, slug } from './contract.mts';
import type { Operation, Request, Runtime } from './contract.mts';
import { readProtected } from './key-access.mts';
export type Identity = { appId:number; clientId:string; botId:number; botLogin:string; installationId:number; keyRef:string; operations:Operation[]; repositories:{slug:string; id:number; moduleLabels?:string[]}[];
  allowedAuthorBotIds?:number[]; version?:1|2; authorEmails?:string[] };
export function canonicalRoot(): string {
  try { return path.join(os.userInfo().homedir, '.kherep', 'github-broker'); }
  catch { return fail('policy-disabled'); }
}
function validModuleLabels(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1 && value.length <= 100 && value.every(l => typeof l === 'string' && l.length > 0);
}
const noreply = (botId:number, botLogin:string) => `${botId}+${botLogin}@users.noreply.github.com`.toLowerCase();
/**
 * Version 1 admits the issue operations only. Version 2 adds the push, pull
 * request and run operations, `identity`, and an optional allowedAuthorBotIds per
 * runtime: the configured bots whose commits that runtime may push (default: its own).
 */
export function validatePolicy(value: unknown, runtime: Runtime, request: Request): Identity {
  try {
    const p = object(value); exact(p, ['version','enabled','runtimes']);
    if (p.enabled !== true) fail('policy-disabled');
    if (p.version !== 1 && p.version !== 2) fail('policy-invalid');
    const v2 = p.version === 2, admitted: readonly string[] = v2 ? [...ISSUE_OPERATIONS, ...GITHUB_OPERATIONS] : ISSUE_OPERATIONS;
    const runtimes = object(p.runtimes); exact(runtimes, ['claude','codex']);
    for (const v of Object.values(runtimes)) {
      const i = object(v); exact(i,['appId','clientId','botId','botLogin','installationId','keyRef','operations','repositories',...(v2?['allowedAuthorBotIds']:[])]);
      if (![i.appId,i.botId,i.installationId].every(positive) || typeof i.clientId !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(i.clientId) || typeof i.botLogin !== 'string' || !/^[A-Za-z0-9_-]{1,100}\[bot\]$/.test(i.botLogin) || typeof i.keyRef !== 'string' || !/^[A-Za-z0-9_-]{1,80}\.pem$/.test(i.keyRef)) fail('policy-invalid');
      if (!Array.isArray(i.operations) || !i.operations.length || i.operations.some(o => !admitted.includes(o))) fail('policy-invalid');
      if (!Array.isArray(i.repositories) || !i.repositories.length || i.repositories.length > 100) fail('policy-invalid');
      for (const r of i.repositories) { const repo = object(r); exact(repo,['slug','id','moduleLabels']); if (!slug(repo.slug) || !positive(repo.id) || repo.moduleLabels !== undefined && !validModuleLabels(repo.moduleLabels)) fail('policy-invalid'); }
    }
    const values = Object.values(runtimes) as Identity[];
    if (values.length === 2 && ['appId','clientId','botId','installationId','keyRef'].some(k => values[0][k as keyof Identity] === values[1][k as keyof Identity])) fail('policy-invalid');
    for (const i of values) {
      const ids = i.allowedAuthorBotIds;
      if (ids !== undefined && (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !values.some(o => o.botId === id)))) fail('policy-invalid');
    }
    const selected = runtimes[runtime] as Identity | undefined;
    if (!selected || !selected.repositories.some(r => r.slug === request.repository)) fail('policy-invalid');
    if (request.operation === 'identity' ? !v2 : request.operation !== 'verify' && !selected.operations.includes(request.operation)) fail('policy-invalid');
    const authors = (selected.allowedAuthorBotIds ?? [selected.botId]).map(id => values.find(o => o.botId === id)!);
    return {...selected, version: p.version as 1|2, authorEmails: authors.map(o => noreply(o.botId, o.botLogin))};
  } catch (e) { if (e instanceof Error && e.message === 'policy-disabled') throw e; fail('policy-invalid'); }
}
export async function loadPolicy(root: string, runtime: Runtime, request: Request): Promise<Identity> {
  try { return validatePolicy(JSON.parse((await readProtected(root, 'policy.json', 65536)).toString('utf8')), runtime, request); }
  catch (e) { if (e instanceof Error && ['policy-invalid','policy-disabled'].includes(e.message)) throw e; return fail('policy-disabled'); }
}
